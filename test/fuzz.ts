/**
 * Properties over the readers that take input nobody here wrote.
 *
 * The example tests beside these pin one crafted input each. A property states what must hold for
 * every input and lets the generator hunt for the one that breaks it, which is how the cases nobody
 * thought to craft turn up: a header cut across a chunk boundary, a body whose bytes and characters
 * count differently, an archive entry the filesystem would place on another drive. A failure is
 * reported with the seed and the shrunken input that reproduce it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import fc from 'fast-check';

import { extract } from '../scripts/install-godot.js';
import { type Frame, FrameReader, frame, MAX_MESSAGE_BYTES, OversizedStreamError } from '../src/framing.js';
import { GameLog } from '../src/game-log.js';
import { MalformedReportError, parseJUnit } from '../src/junit.js';
import { isWithinRoot, resolveWithinProject } from '../src/paths.js';
import { parseProjectGodot } from '../src/resources.js';
import { sweep } from './support/sweep.js';
import { buildZip, DEFLATED, STORED, type ZipEntrySpec } from './support/zip.js';

const WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Content-Length framing
// ---------------------------------------------------------------------------------------------

/** The bytes cut at the given points, so a stream can arrive in any number of pieces. */
function chunked(bytes: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))]
    .filter((cut) => cut > 0 && cut < bytes.length)
    .sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let from = 0;
  for (const to of [...points, bytes.length]) {
    chunks.push(bytes.subarray(from, to));
    from = to;
  }
  return chunks;
}

/** What JSON can carry of a value: -0 and the like arrive as what they serialise to. */
function carried(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function received(reader: FrameReader, chunks: readonly Buffer[]): Frame[] {
  return chunks.flatMap((chunk) => reader.push(chunk));
}

const jsonValue = fc.jsonValue({ stringUnit: 'grapheme', maxDepth: 3 });
const cuts = fc.array(fc.nat(), { maxLength: 32 });

function framesRoundTripUnderAnyChunking(): void {
  fc.assert(
    fc.property(fc.array(jsonValue, { maxLength: 8 }), cuts, (messages, points) => {
      const reader = new FrameReader();
      const frames = received(reader, chunked(Buffer.concat(messages.map(frame)), points));
      assert.deepEqual(
        frames,
        messages.map((message) => ({
          kind: 'message',
          value: carried(message),
          byteLength: Buffer.byteLength(JSON.stringify(message), 'utf8'),
        })),
      );
      assert.equal(reader.buffered, 0);
    }),
    { numRuns: 500 },
  );
}

interface HeaderSpelling {
  readonly name: string;
  readonly separator: string;
  readonly trailing: string;
  readonly before: string;
  readonly after: string;
  readonly ahead: string;
}

/** The header forms a peer may legitimately use, and the blocks it may send that carry no message. */
const headerSpelling = fc.record<HeaderSpelling>({
  name: fc.constantFrom('Content-Length', 'content-length', 'CONTENT-LENGTH'),
  separator: fc.constantFrom(': ', ':', ':\t', ' : '),
  trailing: fc.constantFrom('', ' ', '\t'),
  before: fc.constantFrom('', 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'),
  after: fc.constantFrom('', 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'),
  ahead: fc.constantFrom('', '\r\n\r\n', 'X-Keepalive: 1\r\n\r\n', 'Content-Length: not-a-number\r\n\r\n'),
});

function spelled(message: unknown, spelling: HeaderSpelling): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header =
    `${spelling.ahead}${spelling.before}` +
    `${spelling.name}${spelling.separator}${body.length}${spelling.trailing}\r\n` +
    `${spelling.after}\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

function everyHeaderSpellingIsRead(): void {
  fc.assert(
    fc.property(fc.array(fc.tuple(jsonValue, headerSpelling), { maxLength: 6 }), cuts, (messages, points) => {
      const reader = new FrameReader();
      const wire = Buffer.concat(messages.map(([message, spelling]) => spelled(message, spelling)));
      const values = received(reader, chunked(wire, points)).map((found) => {
        if (found.kind !== 'message') assert.fail(`a malformed frame: ${found.reason}`);
        return found.value;
      });
      assert.deepEqual(
        values,
        messages.map(([message]) => carried(message)),
      );
      assert.equal(reader.buffered, 0);
    }),
    { numRuns: 300 },
  );
}

/** Bytes shaped enough like the protocol to reach every branch of the reader. */
const wirePiece = fc.oneof(
  fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes)),
  fc
    .constantFrom(
      'Content-Length: ',
      '\r\n',
      '\r\n\r\n',
      '{',
      '}',
      '"',
      '\\',
      '0',
      '12',
      '99999999999',
      'Content-Length: 2\r\n\r\n{}',
      'Content-Length: 5\r\n\r\n"é"',
    )
    .map((text) => Buffer.from(text, 'utf8')),
);

function junkNeverEscapesTheContract(): void {
  fc.assert(
    fc.property(fc.array(wirePiece, { maxLength: 64 }), (pieces) => {
      const reader = new FrameReader();
      for (const piece of pieces) {
        let frames: Frame[];
        try {
          frames = reader.push(piece);
        } catch (error) {
          assert.ok(
            error instanceof OversizedStreamError,
            `only the ceiling may throw, not ${String(error)}`,
          );
          return;
        }
        for (const found of frames) {
          assert.ok(found.byteLength >= 0 && found.byteLength <= MAX_MESSAGE_BYTES);
          if (found.kind === 'malformed') assert.notEqual(found.reason, '');
        }
      }
    }),
    { numRuns: 1000 },
  );
}

function theCeilingHoldsOnBothSides(): void {
  const announced = new FrameReader();
  assert.throws(
    () => announced.push(Buffer.from(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`, 'ascii')),
    OversizedStreamError,
  );

  const headerless = new FrameReader();
  assert.throws(() => headerless.push(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x20)), OversizedStreamError);

  // A body of exactly the ceiling is a message, however it is cut.
  const largest = frame('a'.repeat(MAX_MESSAGE_BYTES - 2));
  const patient = new FrameReader();
  const half = Math.floor(largest.length / 2);
  assert.deepEqual(patient.push(largest.subarray(0, half)), []);
  const [only, ...rest] = patient.push(largest.subarray(half));
  assert.ok(only);
  assert.deepEqual(rest, []);
  assert.equal(only.kind, 'message');
  assert.equal(only.byteLength, MAX_MESSAGE_BYTES);
  assert.equal(patient.buffered, 0);
}

// ---------------------------------------------------------------------------------------------
// project.godot
// ---------------------------------------------------------------------------------------------

const hostileKey = fc.constantFrom(
  '__proto__',
  'constructor',
  'prototype',
  'polluted',
  'toString',
  'hasOwnProperty',
);

/** Lines of a project file, most of them wrong in some way. */
const projectLine = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.tuple(hostileKey, fc.string({ unit: 'binary', maxLength: 20 })).map(([key, value]) => `${key}=${value}`),
  hostileKey.map((key) => `[${key}]`),
  fc.constantFrom('[', ']', '=', '"', "'", '{', '(', '\\', '; comment', '# comment', '', '   ', '[]', '=1'),
);

function projectFileNeverThrowsOrPollutes(): void {
  const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).sort();

  fc.assert(
    fc.property(fc.array(projectLine, { maxLength: 24 }), fc.constantFrom('\n', '\r\n'), (lines, eol) => {
      const parsed = parseProjectGodot(lines.join(eol));

      assert.equal(Object.getPrototypeOf(parsed), null);
      assert.ok(Object.hasOwn(parsed, 'root'));
      for (const section of Object.values(parsed)) {
        assert.equal(Object.getPrototypeOf(section), null);
        for (const value of Object.values(section)) {
          assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
          if (typeof value === 'number') assert.ok(Number.isFinite(value));
        }
      }

      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeBefore);
      assert.equal(Object.getPrototypeOf({}), Object.prototype);
    }),
    { numRuns: 1000 },
  );

  const hostile = parseProjectGodot('[__proto__]\npolluted=1\n[constructor]\nprototype="x"');
  assert.ok(Object.hasOwn(hostile, '__proto__'));
  assert.equal(Object.getPrototypeOf(hostile), null);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
}

type IniValue = string | number | boolean | null;

interface WrittenValue {
  /** The value as a project file spells it; `\n` where it spans lines. */
  readonly text: string;
  /** What reading that text must give back. */
  readonly value: IniValue;
}

const identifier = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,11}$/);
const sectionName = fc.stringMatching(/^[a-z_][a-z0-9_.]{0,11}$/).filter((name) => name !== 'root');
const settingKey = fc.stringMatching(/^[a-z_][a-z0-9_/]{0,15}$/);

const writtenValue: fc.Arbitrary<WrittenValue> = fc.oneof(
  fc.integer().map((n) => ({ text: String(n), value: n })),
  fc
    .integer({ min: -1_000_000_000, max: 1_000_000_000 })
    .filter((n) => n % 1000 !== 0)
    .map((n) => ({ text: (n / 1000).toString(), value: n / 1000 })),
  fc.boolean().map((flag) => ({ text: String(flag), value: flag })),
  fc.constant({ text: 'null', value: null }),
  fc
    .string({ unit: 'grapheme', maxLength: 30 })
    .filter((text) => !text.includes('"') && !text.includes('\\'))
    .map((text) => ({ text: `"${text}"`, value: text })),
  fc
    .string({ unit: 'grapheme', maxLength: 30 })
    .filter((text) => !/["'\\{}[\]()]/.test(text))
    .map((text) => ({ text: `'${text}'`, value: text })),
  fc
    .stringMatching(/^[A-Z][a-z]{1,8}\([0-9]{1,3}(, [0-9]{1,3}){0,2}\)$/)
    .map((text) => ({ text, value: text })),
  // A dictionary spread over lines, the way Godot writes input maps and autoloads.
  fc.array(fc.tuple(identifier, fc.integer()), { minLength: 1, maxLength: 3 }).map((pairs) => {
    const inner = pairs.map(([key, value]) => `"${key}": ${value},`);
    return {
      text: `{\n${inner.map((line) => `  ${line}`).join('\n')}\n}`,
      value: `{\n${inner.join('\n')}\n}`,
    };
  }),
  // Written past what a double holds, so the text is what must come back.
  fc.stringMatching(/^-?[1-9][0-9]{16,40}$/).map((text) => ({ text, value: text })),
);

const settings = fc.uniqueArray(fc.tuple(settingKey, writtenValue), {
  selector: ([key]) => key,
  maxLength: 6,
});
const noise = fc.constantFrom('', '', '; a comment', '# another', '   ');

interface WrittenProject {
  readonly text: string;
  readonly expected: Record<string, Record<string, IniValue>>;
}

const writtenProject: fc.Arbitrary<WrittenProject> = fc
  .tuple(
    settings,
    fc.uniqueArray(fc.tuple(sectionName, settings), { selector: ([name]) => name, maxLength: 5 }),
    fc.constantFrom('=', ' = '),
    fc.constantFrom('\n', '\r\n'),
    fc.array(noise, { minLength: 40, maxLength: 40 }),
  )
  .map(([rootSettings, sections, equals, eol, noiseLines]) => {
    const lines: string[] = [];
    const root: Record<string, IniValue> = {};
    const expected: Record<string, Record<string, IniValue>> = { root };
    let noiseAt = 0;
    const filler = (): string => noiseLines[noiseAt++ % noiseLines.length] ?? '';

    // Defined rather than assigned, because `__proto__` is a key the pattern allows and assigning
    // it on a plain object sets the prototype instead of a property: the parser keeps it as an own
    // key, as it must, and the model silently had no such key to compare against.
    const write = (
      into: Record<string, IniValue>,
      pairs: readonly (readonly [string, WrittenValue])[],
    ): void => {
      for (const [key, { text, value }] of pairs) {
        lines.push(filler(), `${key}${equals}${text}`);
        Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
      }
    };

    write(root, rootSettings);
    for (const [name, pairs] of sections) {
      const section: Record<string, IniValue> = {};
      expected[name] = section;
      lines.push(filler(), `[${name}]`);
      write(section, pairs);
    }
    lines.push(filler());

    return { text: lines.join('\n').split('\n').join(eol), expected };
  });

/** Own enumerable data of a record tree, so it can be compared with a literal. */
function plain(parsed: Record<string, Record<string, IniValue>>): Record<string, Record<string, IniValue>> {
  return Object.fromEntries(Object.entries(parsed).map(([name, section]) => [name, { ...section }]));
}

function projectFilesRoundTrip(): void {
  fc.assert(
    fc.property(writtenProject, ({ text, expected }) => {
      assert.deepEqual(plain(parseProjectGodot(text)), expected);
    }),
    { numRuns: 500 },
  );

  // Held on purpose rather than left to the generator, which found it once in a great many runs:
  // a setting named `__proto__` reads back as a key of that name, in the root and in a section.
  const named = plain(parseProjectGodot('__proto__=1\n[a]\n__proto__="x"\n'));
  assert.deepEqual(named, {
    root: Object.fromEntries([['__proto__', 1]]),
    a: Object.fromEntries([['__proto__', 'x']]),
  });
}

// ---------------------------------------------------------------------------------------------
// Paths inside the project
// ---------------------------------------------------------------------------------------------

const projectRoot = resolve(tmpdir(), 'gdharness-fuzz-project');

const pathFragment = fc.constantFrom(
  '..',
  '.',
  '',
  '/',
  '\\',
  'res://',
  'C:',
  'D:/',
  '//host/share',
  'file://',
  'user://',
  'scenes',
  'main.tscn',
  '..config',
  ' ',
  '\0',
  'é',
);

const candidatePath = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc.array(pathFragment, { maxLength: 8 }).map((fragments) => fragments.join('')),
);

function anyPathIsJudgedWithoutThrowing(): void {
  fc.assert(
    fc.property(candidatePath, (path) => {
      const judged = resolveWithinProject(projectRoot, path);
      if (!judged.ok) {
        assert.notEqual(judged.reason, '');
        return;
      }

      assert.ok(!path.includes('\0'));
      assert.ok(judged.absolutePath.startsWith(`${projectRoot}${sep}`));
      assert.ok(isWithinRoot(projectRoot, judged.absolutePath));
      assert.equal(resolve(projectRoot, judged.relativePath), judged.absolutePath);
      assert.ok(!judged.relativePath.startsWith('/'));
      assert.ok(!judged.relativePath.endsWith('/'));
      if (WINDOWS) assert.ok(!judged.relativePath.includes('\\'));
      for (const segment of judged.relativePath.split('/')) {
        assert.ok(segment !== '' && segment !== '.' && segment !== '..');
      }
    }),
    { numRuns: 2000 },
  );
}

const segmentName = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,7}$/),
  fc.constantFrom('..config', '.hidden', 'archive..old.gd', '...'),
);

function segmentsAreJudgedByWhereTheyLand(): void {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(segmentName, fc.constant('..')), { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      (segments, prefixed) => {
        const landed: string[] = [];
        let escaped = false;
        for (const segment of segments) {
          if (segment !== '..') {
            landed.push(segment);
          } else if (landed.length === 0) {
            escaped = true;
            break;
          } else {
            landed.pop();
          }
        }

        const judged = resolveWithinProject(projectRoot, `${prefixed ? 'res://' : ''}${segments.join('/')}`);
        if (escaped) {
          assert.ok(!judged.ok);
          assert.match(judged.reason, /outside the project directory/);
        } else if (landed.length === 0) {
          assert.ok(!judged.ok);
          assert.match(judged.reason, /project directory itself/);
        } else {
          assert.ok(judged.ok, judged.ok ? '' : judged.reason);
          assert.equal(judged.relativePath, landed.join('/'));
          assert.equal(judged.absolutePath, join(projectRoot, ...landed));
        }
      },
    ),
    { numRuns: 1000 },
  );
}

function absoluteFormsAreRefusedEverywhere(): void {
  const forms = [
    '/etc/passwd',
    '\\x',
    '//host/share/x',
    '\\\\host\\share\\x',
    'file:///x',
    'user://x',
    'uid://abc',
    'res:///x',
    'C:/x',
    'C:\\x',
    'c:/x',
    'C:x',
    'D:/x',
    'script.gd:hidden',
  ];

  fc.assert(
    fc.property(fc.constantFrom(...forms), fc.constantFrom('', '/scenes/main.tscn', '/..'), (form, tail) => {
      assert.ok(!resolveWithinProject(projectRoot, `${form}${tail}`).ok);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The engine archive
// ---------------------------------------------------------------------------------------------

/** Names Windows reads as devices whatever directory they are written in. */
const DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const plainName = fc.stringMatching(/^[a-z]{1,4}$/).filter((name) => !DEVICE_NAMES.has(name));
const directories = fc.array(plainName, { maxLength: 2 });

/** Files end in .txt and directories never do, so no archive can name one as the other. */
const fileEntry: fc.Arbitrary<ZipEntrySpec> = fc
  .tuple(
    directories,
    plainName,
    fc.string({ unit: 'binary', maxLength: 300 }),
    fc.constantFrom(STORED, DEFLATED),
  )
  .map(([dirs, name, contents, method]) => ({ name: [...dirs, `${name}.txt`].join('/'), contents, method }));
const directoryEntry: fc.Arbitrary<ZipEntrySpec> = fc
  .array(plainName, { minLength: 1, maxLength: 2 })
  .map((dirs) => ({ name: `${dirs.join('/')}/` }));
const archiveEntries = fc.uniqueArray(fc.oneof(fileEntry, directoryEntry), {
  selector: (entry) => entry.name,
  maxLength: 6,
});

function inTemp(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-zip-'));
  try {
    body(dir);
  } finally {
    sweep(dir);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function archivesRoundTrip(): void {
  fc.assert(
    fc.property(archiveEntries, (entries) => {
      inTemp((dir) => {
        extract(buildZip(entries), dir);
        for (const entry of entries) {
          if (entry.name.endsWith('/')) {
            assert.ok(statSync(join(dir, entry.name)).isDirectory());
          } else {
            assert.deepEqual(readFileSync(join(dir, entry.name)), Buffer.from(entry.contents ?? '', 'utf8'));
          }
        }
        assert.equal(filesUnder(dir).length, entries.filter((entry) => !entry.name.endsWith('/')).length);
      });
    }),
  );
}

function hostileEntriesWriteNothing(): void {
  const names = ['../x', 'a/../../x', '/x', '//host/share/x', '.', './', '', 'x/..', 'a\0b.txt'];
  if (WINDOWS) names.push('\\x', 'D:/x', 'D:\\x', '\\\\host\\share\\x');

  fc.assert(
    fc.property(archiveEntries, fc.constantFrom(...names), fc.nat(), (entries, hostile, at) => {
      const position = at % (entries.length + 1);
      const spliced = [
        ...entries.slice(0, position),
        { name: hostile, contents: 'never written' },
        ...entries.slice(position),
      ];
      inTemp((dir) => {
        assert.throws(() => {
          extract(buildZip(spliced), dir);
        }, /outside the install directory|names the install directory itself|null byte/);
        assert.deepEqual(readdirSync(dir), []);
      });
    }),
  );
}

function bytesThatAreNotAnArchiveWriteNothing(): void {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
      inTemp((dir) => {
        assert.throws(() => {
          extract(Buffer.from(bytes), dir);
        }, Error);
        assert.deepEqual(readdirSync(dir), []);
      });
    }),
    { numRuns: 300 },
  );
}

/** An archive with a few bytes changed after it was built: what a corrupt download looks like. */
function damagedArchivesFailCleanly(): void {
  fc.assert(
    fc.property(
      archiveEntries,
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 4 }),
      (entries, damage) => {
        const zip = buildZip(entries);
        for (const [at, byte] of damage) zip[at % zip.length] = byte;
        inTemp((dir) => {
          try {
            extract(zip, dir);
          } catch (error) {
            assert.ok(error instanceof Error, `a damaged archive threw ${String(error)}`);
          }
        });
      },
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// The game log
// ---------------------------------------------------------------------------------------------

/** Whether any character is a control character, other than the ones named. */
function hasControlCharacter(text: string, allowed: readonly number[] = []): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && !allowed.includes(code)) {
      return true;
    }
  }
  return false;
}

const logLine = fc.oneof(
  // Line endings are the property's own to add, and colour codes are what the reader strips,
  // so neither may sit inside a line that is counted.
  fc.string({ unit: 'grapheme', maxLength: 40 }).filter((line) => !hasControlCharacter(line, [0x09])),
  fc.constantFrom('ERROR: x', 'SCRIPT ERROR: y', 'WARNING: z', 'USER ERROR: w', 'USER WARNING: v'),
  fc.constantFrom('   at: here (res://a.gd:1)', '\tGDScript backtrace', '       [0] _init'),
  fc.constant(''),
);
const logText = fc
  .tuple(fc.array(logLine, { maxLength: 24 }), fc.constantFrom('\n', '\r\n'))
  .map(([lines, ending]) => ({ text: lines.map((line) => `${line}${ending}`).join(''), ending }));

/**
 * The pipe may cut the bytes anywhere, inside a line or inside a character, and the entries
 * are the same as if the whole text had arrived at once; every non-blank line lands in exactly
 * one entry, and the severity counts add up to the entries.
 */
function logsReadTheSameInAnyPieces(): void {
  fc.assert(
    fc.property(logText, cuts, ({ text, ending }, points) => {
      const whole = new GameLog();
      whole.append('stderr', text);
      whole.finish();

      const pieces = new GameLog();
      for (const piece of chunked(Buffer.from(text, 'utf8'), points)) {
        pieces.append('stderr', piece);
      }
      pieces.finish();

      assert.deepEqual(pieces.all, whole.all);
      const said = text.split(ending).filter((line) => line.trim() !== '').length;
      const kept = whole.all.reduce((sum, entry) => sum + 1 + entry.detail.length, 0);
      assert.equal(kept, said, 'every non-blank line is in exactly one entry');
      assert.equal(whole.count('error') + whole.count('warning') + whole.count('info'), whole.all.length);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// JUnit reports
// ---------------------------------------------------------------------------------------------

/** Text as XML may carry it: no control characters, which XML 1.0 has no spelling for. */
const xmlText = fc
  .string({ unit: 'grapheme', maxLength: 30 })
  .filter((text) => !hasControlCharacter(text, [0x09, 0x0a, 0x0d]) && text.trim() === text);

const reportCase = fc.record({
  name: xmlText.filter((name) => name !== ''),
  status: fc.constantFrom('passed', 'failed', 'error', 'skipped'),
  message: xmlText,
  detail: xmlText,
  time: fc
    .float({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true })
    .map((seconds) => Number(seconds.toFixed(3))),
});
const reportSuite = fc.record({
  name: fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/),
  cases: fc.array(reportCase, { maxLength: 6 }),
});

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

/** Detail as a writer may spell it: CDATA where it can, escaped text where it cannot. */
function body(value: string, cdata: boolean): string {
  if (cdata && !value.includes(']]>')) {
    return `<![CDATA[${value}]]>`;
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Whatever a writer puts in a report comes back out of it, spelled either way it may be. */
function reportsRoundTrip(): void {
  fc.assert(
    fc.property(fc.array(reportSuite, { minLength: 1, maxLength: 4 }), fc.boolean(), (suites, cdata) => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<testsuites>',
        ...suites.flatMap((suite) => [
          `<testsuite name="${suite.name}" package="test" tests="${suite.cases.length}" time="1.5">`,
          ...suite.cases.flatMap((entry) => {
            const outcome =
              entry.status === 'passed'
                ? ''
                : `<${entry.status === 'failed' ? 'failure' : entry.status} message="${attribute(entry.message)}">${body(entry.detail, cdata)}</${entry.status === 'failed' ? 'failure' : entry.status}>`;
            return [`<testcase name="${attribute(entry.name)}" time="${entry.time}">${outcome}</testcase>`];
          }),
          '</testsuite>',
        ]),
        '</testsuites>',
      ].join('\n');

      const report = parseJUnit(xml);
      assert.deepEqual(
        report.suites.map((suite) => ({
          name: suite.name,
          cases: suite.cases.map((entry) => ({
            name: entry.name,
            status: entry.status,
            message: entry.message,
            detail: entry.detail,
            time: entry.time,
          })),
        })),
        suites.map((suite) => ({
          name: suite.name,
          cases: suite.cases.map((entry) => ({
            name: entry.name,
            status: entry.status,
            message: entry.status === 'passed' ? null : entry.message,
            detail: entry.status === 'passed' || entry.detail === '' ? null : entry.detail,
            time: entry.time,
          })),
        })),
      );
      assert.equal(
        report.tests,
        suites.reduce((sum, suite) => sum + suite.cases.length, 0),
      );
      assert.equal(report.time, suites.length * 1.5);
    }),
    { numRuns: 300 },
  );
}

/** Bytes that are not a report are refused as such, never read as a run with no tests. */
function junkIsNeverAReport(): void {
  fc.assert(
    fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
      try {
        const report = parseJUnit(text);
        // Only a document with a real suite element parses, and one with none has no cases.
        assert.ok(/<testsuites?[\s/>]/.test(text), `read a report out of ${JSON.stringify(text)}`);
        assert.ok(report.suites.every((suite) => suite.cases.length === 0 || text.includes('<testcase')));
      } catch (error) {
        assert.ok(
          error instanceof MalformedReportError,
          `only MalformedReportError may escape, not ${String(error)}`,
        );
      }
    }),
    { numRuns: 1000 },
  );
}

framesRoundTripUnderAnyChunking();
everyHeaderSpellingIsRead();
junkNeverEscapesTheContract();
theCeilingHoldsOnBothSides();
projectFileNeverThrowsOrPollutes();
projectFilesRoundTrip();
anyPathIsJudgedWithoutThrowing();
segmentsAreJudgedByWhereTheyLand();
absoluteFormsAreRefusedEverywhere();
archivesRoundTrip();
hostileEntriesWriteNothing();
bytesThatAreNotAnArchiveWriteNothing();
damagedArchivesFailCleanly();
logsReadTheSameInAnyPieces();
reportsRoundTrip();
junkIsNeverAReport();

console.log('fuzz properties held');
