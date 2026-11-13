/**
 * Properties over the readers that take input nobody here wrote, over the order a run's waits come in, and over the port walk.
 *
 * The example tests beside these pin one crafted input each. A property states what must hold for
 * every input and lets the generator hunt for the one that breaks it, which is how the cases nobody
 * thought to craft turn up: a header cut across a chunk boundary, a body whose bytes and characters
 * count differently, an archive entry the filesystem would place on another drive. A failure is
 * reported with the seed and the shrunken input that reproduce it.
 */

import { jest } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import fc from 'fast-check';

import { extract } from '../scripts/install-godot.js';
import { type Frame, FrameReader, frame, MAX_MESSAGE_BYTES, OversizedStreamError } from '../src/framing.js';
import { answersTo, GameLog, type LogEntry, type Severity } from '../src/game-log.js';
import {
  type DebuggerMessage,
  DebuggerStream,
  decodeVariant,
  framedCommand,
  type SentValue,
} from '../src/godot-variant.js';
import { MalformedReportError, parseJUnit } from '../src/junit.js';
import { isWithinRoot, resolveWithinProject } from '../src/paths.js';
import { keepPipelineCache } from '../src/pipeline-cache.js';
import { VERSION_MARKER } from '../src/project-walk.js';
import { isRecord } from '../src/records.js';
import { parseProjectGodot } from '../src/resources.js';
import {
  amendRunRecord,
  clearRunRecord,
  everyRunRecord,
  type RunRecord,
  readRunRecord,
  recordRunEnded,
  sweepTranscripts,
  writeRunRecord,
} from '../src/run-record.js';
import { discardUsing } from '../src/scratch.js';
import { SERVER_VERSION } from '../src/server-version.js';
import { ADDONS, installAddons, installedEditorDigest, installedRuntimeDigest } from '../src/setup.js';
import {
  type CasesBySuite,
  type DeclaredSuite,
  dealt,
  peakOf,
  type SuiteTimes,
  type Unit,
  unitsOf,
} from '../src/suite-plan.js';
import { MemoryGate, runShares } from '../src/suite-run.js';
import { inTurnFor, tryTake } from '../src/write-turns.js';
import { bandWalk, PORT_BAND } from './support/server.js';
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
    .toSorted((a, b) => a - b);
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
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header =
    `${spelling.ahead}${spelling.before}` +
    `${spelling.name}${spelling.separator}${payload.length}${spelling.trailing}\r\n` +
    `${spelling.after}\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
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

/** A block with a body but no usable length, or a body of the wrong length, costs only itself. */
function messagesAfterAFaultyBlockStillArrive(): void {
  const faulty = fc.constantFrom(
    'Content-Length: -7\r\n\r\n{"a":1}',
    'Content-Type: x\r\n\r\n{"a":1}',
    'Content-Length: nope\r\n\r\n{"a":1}',
    'Content-Length: 9\r\n\r\n{"s":"é"}',
    'Content-Length: 3\r\n\r\n{"a":1}',
  );
  fc.assert(
    fc.property(
      fc.array(faulty, { minLength: 1, maxLength: 3 }),
      fc.array(jsonValue, { minLength: 1, maxLength: 5 }),
      cuts,
      (faults, messages, points) => {
        const wire = Buffer.concat([
          ...faults.map((text) => Buffer.from(text, 'utf8')),
          ...messages.map(frame),
        ]);
        const values = received(new FrameReader(), chunked(wire, points))
          .filter((found) => found.kind === 'message')
          .map((found) => found.value);
        assert.deepEqual(values.slice(-messages.length), messages.map(carried));
      },
    ),
    { numRuns: 300 },
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
  const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).toSorted();

  fc.assert(
    fc.property(fc.array(projectLine, { maxLength: 24 }), fc.constantFrom('\n', '\r\n'), (lines, eol) => {
      const parsed = parseProjectGodot(lines.join(eol));

      assert.equal(Object.getPrototypeOf(parsed), null);
      assert.ok(Object.hasOwn(parsed, ''));
      for (const section of Object.values(parsed)) {
        assert.equal(Object.getPrototypeOf(section), null);
        for (const value of Object.values(section)) {
          assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
          if (typeof value === 'number') assert.ok(Number.isFinite(value));
        }
      }

      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).toSorted(), prototypeBefore);
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
const sectionName = fc.oneof(fc.constant('root'), fc.stringMatching(/^[a-z_][a-z0-9_.]{0,11}$/));
const settingKey = fc.stringMatching(/^[a-z_][a-z0-9_/]{0,15}$/);

const writtenValue: fc.Arbitrary<WrittenValue> = fc.oneof(
  fc.integer().map((n) => ({ text: String(n), value: n })),
  fc
    .integer({ min: -1_000_000_000, max: 1_000_000_000 })
    .filter((n) => n % 1000 !== 0)
    .map((n) => ({ text: (n / 1000).toString(), value: n / 1000 })),
  fc.boolean().map((flag) => ({ text: String(flag), value: flag })),
  fc.constant({ text: 'null', value: null }),
  // Escaped as Godot writes a setting, which escapes a backslash and a quote and nothing else.
  fc
    .string({ unit: 'grapheme', maxLength: 30 })
    .filter((text) => !/[\r\n]/.test(text))
    .map((text) => ({ text: `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`, value: text })),
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
  .map(([topLevelSettings, sections, equals, eol, noiseLines]) => {
    const lines: string[] = [];
    const topLevel: Record<string, IniValue> = {};
    const expected: Record<string, Record<string, IniValue>> = { '': topLevel };
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

    write(topLevel, topLevelSettings);
    for (const [name, pairs] of sections) {
      const section: Record<string, IniValue> = {};
      // The same for a section named `__proto__`, which the pattern allows too.
      Object.defineProperty(expected, name, {
        value: section,
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
  // a setting named `__proto__` reads back as a key of that name, at the top and in a section,
  // and so does a section named that.
  const named = plain(parseProjectGodot('__proto__=1\n[a]\n__proto__="x"\n[__proto__]\nb=2\n'));
  assert.deepEqual(
    named,
    Object.fromEntries([
      ['', Object.fromEntries([['__proto__', 1]])],
      ['a', Object.fromEntries([['__proto__', 'x']])],
      ['__proto__', { b: 2 }],
    ]),
  );
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
const directoryNames = fc.array(plainName, { maxLength: 2 });

/** Files end in .txt and directories never do, so no archive can name one as the other. */
const fileEntry: fc.Arbitrary<ZipEntrySpec> = fc
  .tuple(
    directoryNames,
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

function inTemp(work: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-zip-'));
  try {
    work(dir);
  } finally {
    sweep(dir);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Runs whose pids and starts repeat, on two projects and two runtime directories.
 *
 * The model keeps one note per project and directory, replaced whole by a start, left alone by an
 * amend or an ending that is another run's, and told apart by transcript alone. A note reads back
 * as the model's, the first directory first.
 */
function aRunNoteHoldsOnlyItsOwnRun(): void {
  const aRun = fc.record({
    pid: fc.constantFrom(1111, 2222),
    startedAt: fc.constantFrom(1000, 2000),
    name: fc.constantFrom('run-1000.log', 'run-1000-1.log', 'run-2000.log'),
  });
  const aStep: fc.Arbitrary<RunStep> = fc.record({
    kind: fc.constantFrom('start', 'amend', 'end', 'clear', 'sweep'),
    directory: fc.constantFrom(0, 1),
    project: fc.constantFrom(0, 1),
    run: aRun,
    restarted: fc.boolean(),
    looking: fc.boolean(),
  });
  const had = process.env['GDHARNESS_RUNTIME_DIR'];
  fc.assert(
    fc.property(fc.array(aStep, { maxLength: 14 }), (steps) => {
      inTemp((root) => {
        const model = newRunModel(root);
        try {
          for (const step of steps) {
            applyRunStep(model, step);
            checkRunModel(model);
          }
        } finally {
          if (had === undefined) {
            delete process.env['GDHARNESS_RUNTIME_DIR'];
          } else {
            process.env['GDHARNESS_RUNTIME_DIR'] = had;
          }
        }
      });
    }),
    { numRuns: 60 },
  );
}

/** One step of the run-note model: an action on one of two runtime directories and two projects. */
interface RunStep {
  kind: 'start' | 'amend' | 'end' | 'clear' | 'sweep';
  directory: 0 | 1;
  project: 0 | 1;
  run: { pid: number; startedAt: number; name: string };
  restarted: boolean;
  looking: boolean;
}

/** The notes and transcript files the real ones must match, per runtime directory and project. */
interface RunModel {
  directories: readonly [string, string];
  projects: readonly [string, string];
  notes: (RunRecord | null)[][];
  files: Set<string>[];
}

function newRunModel(root: string): RunModel {
  return {
    directories: [join(root, 'a'), join(root, 'b')],
    projects: [join(root, 'project-0'), join(root, 'project-1')],
    notes: [
      [null, null],
      [null, null],
    ],
    files: [new Set(), new Set()],
  };
}

function noteOf(model: RunModel, directory: number, project: number): RunRecord | null {
  return model.notes[directory]?.[project] ?? null;
}

function setNote(model: RunModel, directory: number, project: number, note: RunRecord | null): void {
  const row = model.notes[directory];
  if (row !== undefined) {
    row[project] = note;
  }
}

function normal<Note extends RunRecord | null>(note: Note): Note | RunRecord {
  return note?.endedAt === undefined ? note : { ...note, endedAt: 0 };
}

// A note as text with its fields in a fixed order, since a note read back orders them its own way.
function keyed(note: RunRecord): string {
  return JSON.stringify(Object.entries(normal(note)).toSorted(([one], [other]) => one.localeCompare(other)));
}

/** Does [param step] on the real run notes and records what the model expects of it. */
function applyRunStep(model: RunModel, step: RunStep): void {
  const { directories, projects } = model;
  const directory = directories[step.directory];
  const project = projects[step.project];
  process.env['GDHARNESS_RUNTIME_DIR'] = step.kind === 'sweep' ? directories[0] : directory;
  const runs = join(directory, 'runs');
  const base: RunRecord = {
    pid: step.run.pid,
    transcript: join(runs, step.run.name),
    startedAt: step.run.startedAt,
    startedBy: step.run.startedAt,
    projectPath: project,
    arguments: [],
    command: 'godot',
  };
  const said: RunRecord = {
    ...base,
    ...(step.restarted ? { pid: 3333, restartedFrom: [{ pid: step.run.pid, endedAt: 7 }] } : {}),
    ...(step.looking ? { endingAt: 5000 } : {}),
  };
  const there = noteOf(model, step.directory, step.project);
  const own = there === null || there.transcript === said.transcript;
  if (step.kind === 'start') {
    startAModelRun(model, step, base);
  } else if (step.kind === 'amend') {
    assert.equal(amendRunRecord(said), own, 'an amend writes unless the note is another run');
    if (own) {
      setNote(model, step.directory, step.project, said);
    }
  } else if (step.kind === 'end') {
    assert.equal(recordRunEnded(said, { exitCode: 0, exitSignal: null }), own);
    if (own) {
      const { endingAt: _looked, ...kept } = said;
      setNote(model, step.directory, step.project, { ...kept, exitCode: 0, endedAt: 0 });
    }
  } else if (step.kind === 'clear') {
    clearRunRecord(project, directories);
    setNote(model, 0, step.project, null);
    setNote(model, 1, step.project, null);
  } else {
    sweepModelTranscripts(model);
  }
}

function startAModelRun(model: RunModel, step: RunStep, base: RunRecord): void {
  mkdirSync(dirname(base.transcript), { recursive: true });
  writeFileSync(base.transcript, '');
  model.files[step.directory]?.add(step.run.name);
  writeRunRecord(base);
  setNote(model, step.directory, step.project, base);
}

/** Sweeps old transcripts and checks that the first directory keeps only what a note names. */
function sweepModelTranscripts(model: RunModel): void {
  const { directories, files } = model;
  sweepTranscripts(24 * 60 * 60 * 1000, Date.now() + 2 * 24 * 60 * 60 * 1000);
  const noted = new Set(
    [0, 1].flatMap((which) => {
      const note = noteOf(model, 0, which);
      return note === null ? [] : [basename(note.transcript)];
    }),
  );
  files[0] = new Set([...(files[0] ?? [])].filter((name) => noted.has(name)));
  const left = existsSync(join(directories[0], 'runs'))
    ? readdirSync(join(directories[0], 'runs')).filter((entry) => entry.endsWith('.log'))
    : [];
  assert.deepEqual(left.toSorted(), [...files[0]].toSorted(), 'the sweep keeps what a note names');
  const other = existsSync(join(directories[1], 'runs'))
    ? readdirSync(join(directories[1], 'runs')).filter((entry) => entry.endsWith('.log'))
    : [];
  assert.deepEqual(other.toSorted(), [...(files[1] ?? [])].toSorted(), 'and leaves the other directory');
}

/** Reads every note back and holds it to the model. */
function checkRunModel(model: RunModel): void {
  const { directories, projects } = model;
  for (const which of [0, 1]) {
    const wanted = noteOf(model, 0, which) ?? noteOf(model, 1, which);
    assert.deepEqual(normal(readRunRecord(projects[which] ?? '', directories)), normal(wanted));
  }
  const every = [0, 1].flatMap((d) => [0, 1].map((p) => noteOf(model, d, p))).filter((note) => note !== null);
  const listed = everyRunRecord(directories);
  assert.deepEqual(listed.map(keyed).toSorted(), every.map(keyed).toSorted(), 'every note is listed');
  for (let index = 1; index < listed.length; index += 1) {
    assert.ok((listed[index - 1]?.startedAt ?? 0) >= (listed[index]?.startedAt ?? 0), 'newest first');
  }
  for (const note of listed) {
    assert.ok(note.endedAt === undefined || note.endingAt === undefined, 'an ended run is not ending');
  }
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
 * are the same as if the whole text had arrived at once. Every non-blank line lands in exactly
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
        // In order of path, which is the order a report is read in whatever order it was written.
        suites
          .toSorted((a, b) => {
            const [left, right] = [`res://test/${a.name}.gd`, `res://test/${b.name}.gd`];
            return left < right ? -1 : left > right ? 1 : 0;
          })
          .map((suite) => ({
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
  // Random text almost never holds a suite element, so the reading of one is held apart: a report
  // with a suite in it is read as that suite whatever plain text lies inside it.
  fc.assert(
    fc.property(
      fc.string({ maxLength: 80 }).filter((text) => !text.includes('<') && !text.includes('&')),
      (inner) => {
        const report = parseJUnit(
          `<testsuites><testsuite name="s" package="t">${inner}</testsuite></testsuites>`,
        );
        assert.deepEqual(
          report.suites.map((suite) => [suite.name, suite.path, suite.cases.length]),
          [['s', 'res://t/s.gd', 0]],
        );
      },
    ),
    { numRuns: 200 },
  );
}

// ---------------------------------------------------------------------------------------------
// The waits of a run for a machine slot and for memory
// ---------------------------------------------------------------------------------------------

const GIB = 1024 ** 3;
const ENGINE_BYTES = 1.5 * GIB;
const KEPT_BYTES = 4 * GIB;
const IDLE_STEPS_BEFORE_HUNG = 100;
const SETTLE_ROUNDS_BEFORE_STUCK = 1000;

/** Slots handed on in the order they were asked for, taking and giving back with no folder behind. */
class StandInSlots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.free = count;
  }

  get freeCount(): number {
    return this.free;
  }

  takeNow(): string | null {
    if (this.free === 0) {
      return null;
    }
    this.free -= 1;
    return 'lock';
  }

  async take(signal?: AbortSignal): Promise<string> {
    for (;;) {
      signal?.throwIfAborted();
      const lock = this.takeNow();
      if (lock !== null) {
        return lock;
      }
      await new Promise<void>((woken, refused) => {
        this.waiting.push(woken);
        signal?.addEventListener(
          'abort',
          () => {
            refused(new Error('the wait for a slot was ended'));
          },
          { once: true },
        );
      });
    }
  }

  release(_lock: string): void {
    this.free += 1;
    this.waiting.shift()?.();
  }

  markWaiting(): () => void {
    return () => undefined;
  }
}

interface RunSetup {
  readonly slotCount: number;
  readonly outsideHolds: boolean;
  readonly lanes: number;
  readonly suites: number;
  readonly freeGiB: number;
  /** What each suite was seen to hold, in GiB, in suite order. */
  readonly peaksGiB: readonly number[];
  /** The lanes the run is raised by, one answer each, up to the ceiling of {@link RISE_CEILING}. */
  readonly rises?: readonly number[];
}

const RISE_CEILING = 6;

interface Ran {
  readonly index: number;
  readonly suites: readonly string[];
}

interface StartedRun {
  readonly slots: StandInSlots;
  readonly settled: () => boolean;
  readonly ran: () => Ran[] | undefined;
  readonly judgeHung: () => void;
}

/** The engines memory has room for as a run begins, which is what a run held by memory starts with. */
function enginesByMemory(freeGiB: number): number {
  return Math.max(1, Math.floor((freeGiB * GIB - KEPT_BYTES) / ENGINE_BYTES));
}

/**
 * Suites of one 40 s case each, which `unitsOf` keeps whole, so each is a share of its own or a part
 * of one. Suite `at` was seen to hold `peaksGiB[at]`.
 */
function suitesOf(
  count: number,
  peaksGiB: readonly number[],
): { units: ReturnType<typeof unitsOf>; declared: CasesBySuite; times: SuiteTimes } {
  const paths = Array.from({ length: count }, (_, at) => `res://suite_${String(at)}.gd`);
  const suites: DeclaredSuite[] = paths.map((path) => ({
    path,
    cases: ['test_one'],
    windowed: false,
    headless: false,
    together: false,
    accessible: false,
  }));
  const times: SuiteTimes = Object.fromEntries(
    paths.map((path, at) => [
      path,
      { seconds: 40, cases: { test_one: 40 }, peak: (peaksGiB[at] ?? 1.5) * GIB },
    ]),
  );
  return {
    units: unitsOf(suites, times),
    declared: new Map(paths.map((path) => [path, ['test_one']])),
    times,
  };
}

function takeFreeSlots(slots: StandInSlots, count: number): string[] {
  const taken: string[] = [];
  while (taken.length < count) {
    const lock = slots.takeNow();
    if (lock === null) {
      break;
    }
    taken.push(lock);
  }
  return taken;
}

/** Starts the run the setup describes, with the scheduler deciding when each wait ends. */
function startRun(s: fc.Scheduler, setup: RunSetup, peak: { engines: number; above?: boolean }): StartedRun {
  const slots = new StandInSlots(setup.slotCount);
  if (setup.outsideHolds && setup.slotCount > 1) {
    slots.takeNow();
    void s.schedule(Promise.resolve(), 'outside run ends').then(() => {
      slots.release('outside');
    });
  }
  // Each going engine tells what its share was seen to hold at a point the scheduler picks, and the
  // memory read falls by what the engines have told.
  const going = new Map<number, { readonly need: number; held: number }>();
  let hung = false;
  const told = (): number => [...going.values()].reduce((sum, one) => sum + one.held, 0);
  const free = (): Promise<number> =>
    hung ? Promise.reject(new Error('judged hung')) : Promise.resolve(setup.freeGiB * GIB - told());
  const gate = new MemoryGate(slots, free, 1);
  const taken = takeFreeSlots(slots, Math.min(setup.lanes, enginesByMemory(setup.freeGiB)));
  const { units, declared, times } = suitesOf(setup.suites, setup.peaksGiB);
  // The lanes the run was last raised to, which no more engines than may go at once.
  let lanesNow = setup.lanes;
  const rises = [...(setup.rises ?? [])];
  const raised =
    setup.rises === undefined
      ? undefined
      : {
          ceiling: RISE_CEILING,
          past: async (above: number, signal: AbortSignal): Promise<number> => {
            const by = rises.shift();
            if (by === undefined) {
              await new Promise<void>((_, refused) => {
                signal.addEventListener('abort', () => {
                  refused(new Error('the asking was ended'));
                });
              });
            }
            await s.schedule(Promise.resolve(), 'a rise is answered');
            signal.throwIfAborted();
            lanesNow = Math.min(RISE_CEILING, above + (by ?? 1));
            return lanesNow;
          },
        };
  const run = (
    plan: { readonly suites: ReadonlyArray<{ readonly path: string }> },
    index: number,
    _lock: string,
    holds?: (bytes: number) => void,
  ): Promise<Ran> => {
    const suites = plan.suites.map((suite) => suite.path);
    const need = peakOf(suites, times, ENGINE_BYTES).bytes;
    const owed = [...going.values()].reduce((sum, one) => sum + Math.max(0, one.need - one.held), 0);
    if (going.size > 0) {
      assert.ok(
        setup.freeGiB * GIB - told() - KEPT_BYTES - owed >= need,
        `engine ${String(index)} started needing ${String(need / GIB)} GiB without room`,
      );
    }
    const engine = { need, held: 0 };
    going.set(index, engine);
    peak.engines = Math.max(peak.engines, going.size);
    assert.ok(going.size <= lanesNow, `${String(going.size)} engines going on ${String(lanesNow)} lanes`);
    if (going.size > setup.lanes) {
      peak.above = true;
    }
    void s.schedule(Promise.resolve(), `engine ${String(index)} tells`).then(() => {
      if (going.get(index) === engine) {
        engine.held = need;
        holds?.(need);
      }
    });
    return s.schedule(Promise.resolve({ index, suites }), `engine ${String(index)} ends`).finally(() => {
      going.delete(index);
    });
  };
  let result: Ran[] | undefined;
  let settled = false;
  void runShares(slots, units, declared, setup.lanes, taken, times, run, undefined, gate, raised)
    .then(
      (ran) => {
        result = ran;
      },
      () => undefined,
    )
    .finally(() => {
      settled = true;
    });
  return {
    slots,
    settled: () => settled,
    ran: () => result,
    judgeHung: () => {
      hung = true;
    },
  };
}

function advanceToNextTimer(): void {
  if (jest.getTimerCount() > 0) {
    jest.advanceTimersToNextTimer();
  }
}

/**
 * Steps a run: the gate's next look, one await so the lanes the look woke run on, then the
 * scheduler's next task. Answers whether the run ended before 100 steps in a row had nothing to run.
 */
async function stepUntilEnded(s: fc.Scheduler, started: StartedRun): Promise<boolean> {
  let idle = 0;
  while (!started.settled() && idle < IDLE_STEPS_BEFORE_HUNG) {
    advanceToNextTimer();
    await Promise.resolve();
    if (s.count() > 0) {
      idle = 0;
      await s.waitNext(1);
    } else {
      idle += 1;
    }
  }
  return started.settled();
}

/** Makes the gate's reading fail so a hung run ends, and moves the clock until it has. */
async function endHungRun(started: StartedRun): Promise<void> {
  started.judgeHung();
  for (let rounds = 0; !started.settled(); rounds += 1) {
    if (rounds >= SETTLE_ROUNDS_BEFORE_STUCK) {
      throw new Error('a run judged hung never ended');
    }
    advanceToNextTimer();
    await Promise.resolve();
  }
}

async function noOrderOfSlotAndMemoryWaitsHangsARun(): Promise<void> {
  const peak = { engines: 0 };
  jest.useFakeTimers();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        fc.integer({ min: 2, max: 3 }),
        fc.integer({ min: 2, max: 5 }),
        fc.constantFrom(4.5, 5, 6.5, 8),
        fc.array(fc.constantFrom(0.5, 1.5, 3), { minLength: 5, maxLength: 5 }),
        async (s, slotCount, outsideHolds, lanes, suites, freeGiB, peaksGiB) => {
          if (enginesByMemory(freeGiB) >= lanes) {
            return;
          }
          const started = startRun(s, { slotCount, outsideHolds, lanes, suites, freeGiB, peaksGiB }, peak);
          if (!(await stepUntilEnded(s, started))) {
            await endHungRun(started);
            throw new Error(
              `hung: ${String(suites)} suites over ${String(lanes)} lanes, ${String(slotCount)} slots`,
            );
          }
          await s.waitIdle();
          const ran = started.ran() ?? [];
          assert.deepEqual(
            ran.flatMap((engine) => engine.suites).toSorted(),
            suitesOf(suites, peaksGiB)
              .units.map((unit) => unit.suite)
              .toSorted(),
          );
          assert.equal(started.slots.freeCount, slotCount);
        },
      ),
      { numRuns: 150, seed: 42 },
    );
  } finally {
    jest.useRealTimers();
  }
  assert.ok(peak.engines >= 2, `at most ${String(peak.engines)} engine ran at once`);
}

async function noOrderOfRisesLosesASuite(): Promise<void> {
  const peak: { engines: number; above?: boolean } = { engines: 0 };
  jest.useFakeTimers();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 2, max: 3 }),
        fc.integer({ min: 2, max: 6 }),
        fc.constantFrom(5, 6.5, 8, 16),
        fc.array(fc.constantFrom(0.5, 1.5, 3), { minLength: 6, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { maxLength: 3 }),
        async (s, slotCount, lanes, suites, freeGiB, peaksGiB, rises) => {
          const started = startRun(
            s,
            { slotCount, outsideHolds: false, lanes, suites, freeGiB, peaksGiB, rises },
            peak,
          );
          if (!(await stepUntilEnded(s, started))) {
            await endHungRun(started);
            throw new Error(
              `hung: ${String(suites)} suites over ${String(lanes)} lanes raised by ${rises.join(', ')}`,
            );
          }
          await s.waitIdle();
          assert.deepEqual(
            (started.ran() ?? []).flatMap((engine) => engine.suites).toSorted(),
            suitesOf(suites, peaksGiB)
              .units.map((unit) => unit.suite)
              .toSorted(),
          );
          assert.equal(started.slots.freeCount, slotCount);
        },
      ),
      { numRuns: 150, seed: 42 },
    );
  } finally {
    jest.useRealTimers();
  }
  assert.ok(peak.above === true, 'no run ever had more engines going than the lanes it began on');
}

/** A stand-in `hold` that takes the blocks named, records each ask and answers after [param turns] microtask turns. */
function standInHold(
  taken: ReadonlySet<number>,
  turns: readonly number[],
): { asks: number[]; hold: (first: number) => Promise<boolean> } {
  const asks: number[] = [];
  const hold = async (first: number): Promise<boolean> => {
    const at = asks.length;
    asks.push(first);
    for (let turn = 0; turn < (turns[at % Math.max(turns.length, 1)] ?? 0); turn += 1) {
      await Promise.resolve();
    }
    return taken.has(first);
  };
  return { asks, hold };
}

const WALK_CALLS = 300;
const WALK_BLOCKS = 200;

/** A batch's results against the walk's rules, given what the walk has handed out this lap. */
function checkWalkBatch(
  results: PromiseSettledResult<number>[],
  taken: ReadonlySet<number>,
  lap: Set<number>,
  asked: { before: number; now: number },
): void {
  if (taken.size === 0) {
    assert.ok(
      results.every((result) => result.status === 'rejected'),
      'with no block taken every call is refused',
    );
    assert.equal(asked.now - asked.before, WALK_BLOCKS * results.length, 'after exactly 200 asks each');
    return;
  }
  const numbersInLap = taken.size * (PORT_BAND.block - 1);
  for (const result of results) {
    assert.equal(result.status, 'fulfilled', 'with a block taken no call is refused');
    const port = result.value;
    assert.notEqual(
      (port - PORT_BAND.first) % PORT_BAND.block,
      0,
      `a first number was given: ${String(port)}`,
    );
    const first = port - ((port - PORT_BAND.first) % PORT_BAND.block);
    assert.ok(taken.has(first), `${String(port)} is in a block that was not taken`);
    assert.ok(!lap.has(port), `${String(port)} came again before every taken number came`);
    lap.add(port);
    if (lap.size === numbersInLap) {
      lap.clear();
    }
  }
}

function theWalkGivesOnlyWhatItHolds(): Promise<void> {
  return fc.assert(
    fc.asyncProperty(
      fc.integer({ min: PORT_BAND.first, max: PORT_BAND.last }),
      fc.uniqueArray(fc.integer({ min: 0, max: WALK_BLOCKS - 1 })),
      fc.array(fc.integer({ min: 1, max: 6 })),
      fc.array(fc.integer({ min: 0, max: 5 })),
      async (start, takenBlocks, batchSizes, turns) => {
        const taken = new Set(takenBlocks.map((index) => PORT_BAND.first + index * PORT_BAND.block));
        const { asks, hold } = standInHold(taken, turns);
        const walk = bandWalk(start, hold);
        const lap = new Set<number>();
        let calls = 0;
        for (let batch = 0; calls < WALK_CALLS; batch += 1) {
          const size = Math.min(batchSizes[batch % Math.max(batchSizes.length, 1)] ?? 1, WALK_CALLS - calls);
          calls += size;
          const before = asks.length;
          const results = await Promise.allSettled(Array.from({ length: size }, walk));
          checkWalkBatch(results, taken, lap, { before, now: asks.length });
        }
        for (const first of taken) {
          assert.ok(
            asks.filter((ask) => ask === first).length <= 1,
            `block ${String(first)} was asked again`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
}

// ---------------------------------------------------------------------------------------------
// Writes to one file, taken in turn
// ---------------------------------------------------------------------------------------------

interface Writer {
  readonly file: 0 | 1;
  readonly holdMs: number;
  readonly fails: boolean;
}

/**
 * Writers to a path, asked in any order and to either of two files, run one at a time per file and
 * in the order they asked. A writer that throws gives its turn back, so the ones behind it still run.
 */
async function writersTakeTurnsInTheOrderTheyAsked(): Promise<void> {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          file: fc.constantFrom<0 | 1>(0, 1),
          // A hold past the waiters' 100 ms look is what makes them compete for the turn.
          holdMs: fc.constantFrom(0, 0, 1, 3, 130),
          fails: fc.boolean(),
        }),
        { minLength: 1, maxLength: 7 },
      ),
      async (writers: readonly Writer[]) => {
        const project = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-turns-'));
        try {
          const files = [join(project, 'a.tscn'), join(project, 'b.tscn')];
          const events: string[] = [];
          const asked = writers.map((writer, index) =>
            inTurnFor(project, files[writer.file] ?? '', async () => {
              events.push(`start ${String(index)}`);
              await new Promise((done) => setTimeout(done, writer.holdMs));
              events.push(`end ${String(index)}`);
              if (writer.fails) {
                throw new Error(`writer ${String(index)} failed`);
              }
              return index;
            }).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            ),
          );
          const answers = await Promise.all(asked);
          for (const file of [0, 1] as const) {
            const mine = writers.flatMap((writer, index) => (writer.file === file ? [index] : []));
            const seen = events.filter((event) => mine.includes(Number(event.split(' ')[1])));
            assert.deepEqual(
              seen,
              mine.flatMap((index) => [`start ${String(index)}`, `end ${String(index)}`]),
              `writers to file ${String(file)} ran one at a time, in the order asked`,
            );
          }
          for (const [index, answer] of answers.entries()) {
            assert.ok(
              writers[index]?.fails === true ? 'error' in answer : 'value' in answer,
              'each outcome is its own',
            );
          }
          assert.deepEqual(
            readdirSync(join(project, '.godot', 'gdharness-writes')),
            [],
            'every lock was given back',
          );
        } finally {
          sweep(project);
        }
      },
    ),
    { numRuns: 12 },
  );
}

// ---------------------------------------------------------------------------------------------
// The order a plan deals in
// ---------------------------------------------------------------------------------------------

const PLAN_SUITES = [
  'res://a_test.gd',
  'res://a-b_test.gd',
  'res://a_b_test.gd',
  'res://ab_test.gd',
  'res://B_test.gd',
  'res://z_test.gd',
  'res://Z_test.gd',
  'res://ä_test.gd',
  'res://a/x_test.gd',
];

const planUnits = fc.uniqueArray(
  fc.record({
    suite: fc.constantFrom(...PLAN_SUITES),
    func: fc.constantFrom('test_a', 'test_b', 'test_c'),
    cost: fc.constantFrom(1, 2, 2, 5),
  }),
  { selector: (unit) => `${unit.suite}:${unit.func}`, maxLength: 12 },
);

function asUnit(unit: { suite: string; func: string; cost: number }): Unit {
  return {
    suite: unit.suite,
    cases: [unit.func],
    cost: unit.cost,
    timed: true,
    windowed: false,
    accessible: false,
    headless: false,
  };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Units are dealt slowest first, ties by path then case, all by code unit, so the plan is a function
 * of the units alone: not of the order they were listed in, nor of the machine's locale.
 */
function aPlanDependsOnItsUnitsAlone(): void {
  fc.assert(
    fc.property(
      planUnits,
      fc.array(fc.nat(), { maxLength: 12 }),
      fc.integer({ min: 1, max: 4 }),
      (drawn, keys, most) => {
        const units = drawn.map(asUnit);
        const declared: CasesBySuite = new Map(
          PLAN_SUITES.map((path) => [path, ['test_a', 'test_b', 'test_c']]),
        );
        const shuffled = units
          .map((unit, index) => ({ unit, key: keys[index] ?? 0, index }))
          .toSorted((a, b) => a.key - b.key || a.index - b.index)
          .map((entry) => entry.unit);
        assert.deepEqual(dealt(shuffled, declared, most), dealt(units, declared, most));

        const one = dealt(units, declared, 1);
        const expected = units
          .toSorted(
            (a, b) =>
              b.cost - a.cost ||
              byCodeUnit(a.suite, b.suite) ||
              byCodeUnit(a.cases[0] ?? '', b.cases[0] ?? ''),
          )
          .map((unit) => unit.suite);
        assert.deepEqual(
          one.flatMap((plan) => plan.suites.map((suite) => suite.path)),
          [...new Set(expected)],
          'in one engine the suites come in the order of their slowest unit, ties by code unit',
        );
        assert.equal(
          one.reduce(
            (sum, plan) => sum + plan.suites.reduce((count, suite) => count + suite.cases.length, 0),
            0,
          ),
          units.length,
          'every unit is dealt once',
        );
      },
    ),
    { numRuns: 300 },
  );
}

// ---------------------------------------------------------------------------------------------
// The kept pipeline cache
// ---------------------------------------------------------------------------------------------

/**
 * Runs that finish together each keep the cache they left, and the larger one stays whichever
 * process swaps last.
 */
async function theLargerKeptCacheSurvivesConcurrentKeeps(): Promise<void> {
  const child = resolve(import.meta.dir, 'support', 'keep-cache.ts');
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 80 }), { minLength: 2, maxLength: 4 }),
      async (counts) => {
        const root = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-keep-'));
        try {
          const home = join(root, 'home');
          const project = join(root, 'project');
          mkdirSync(project);
          const start = join(root, 'start');
          // One small cache is kept first, and a lock left by a keep that died sits where the swap looks:
          // the keeps that follow take it over and still leave the largest cache.
          const first = join(root, 'user-first', 'Godot', 'app_userdata', 'game', 'shader_cache');
          mkdirSync(first, { recursive: true });
          writeFileSync(join(first, '0.bin'), 'x'.repeat(100));
          await keepPipelineCache(join(root, 'user-first'), project, process.execPath, home);
          const keptFolder = join(
            home,
            'pipeline-caches',
            readdirSync(join(home, 'pipeline-caches'))[0] ?? '',
          );
          writeFileSync(`${keptFolder}.lock`, '0');
          const longAgo = new Date(Date.now() - 3_600_000);
          utimesSync(`${keptFolder}.lock`, longAgo, longAgo);
          const exits = counts.map((files, index) => {
            const folder = join(
              root,
              `user-${String(index)}`,
              'Godot',
              'app_userdata',
              'game',
              'shader_cache',
            );
            mkdirSync(folder, { recursive: true });
            for (let file = 0; file < files; file += 1) {
              writeFileSync(join(folder, `${String(file)}.bin`), 'x'.repeat(100));
            }
            const run = spawn(
              process.execPath,
              [child, join(root, `user-${String(index)}`), project, process.execPath, home, start],
              { stdio: 'ignore' },
            );
            return new Promise<number | null>((done) => run.once('exit', done));
          });
          writeFileSync(start, '');
          assert.deepEqual(
            await Promise.all(exits),
            counts.map(() => 0),
          );
          const kept = readdirSync(join(home, 'pipeline-caches'));
          assert.deepEqual(
            kept.length,
            1,
            `one kept cache and nothing left building or locked: ${kept.join(' ')}`,
          );
          const folder = join(home, 'pipeline-caches', kept[0] ?? '');
          const record: unknown = JSON.parse(readFileSync(join(folder, 'kept.json'), 'utf8'));
          assert.ok(isRecord(record));
          assert.equal(record['bytes'], Math.max(...counts) * 100);
          assert.equal(readdirSync(join(folder, 'shader_cache')).length, Math.max(...counts));
        } finally {
          sweep(root);
        }
      },
    ),
    { numRuns: 5 },
  );
}

/**
 * However many takers meet one lock whose holder has gone, whatever it holds, exactly one of them
 * ends up holding it, and the lock names that one.
 */
async function exactlyOneTakerHoldsAStaleLock(): Promise<void> {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 6 }),
      fc.constantFrom('unwritten', 'deadHolder'),
      async (takers, kind) => {
        const root = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-take-'));
        try {
          const lock = join(root, 'held.lock');
          // A pid no process has: the largest a 32-bit signed id holds.
          writeFileSync(lock, kind === 'unwritten' ? '0' : JSON.stringify({ pid: 2 ** 31 - 1, started: 1 }));
          const longAgo = new Date(Date.now() - 3_600_000);
          utimesSync(lock, longAgo, longAgo);
          const holders = Array.from(
            { length: takers },
            (_, index) => `{"pid":${String(process.pid)},"n":${String(index)}}`,
          );
          const got = await Promise.all(holders.map((holder) => tryTake(lock, holder, new Map())));
          assert.equal(got.filter(Boolean).length, 1, `${String(takers)} takers of a lock held by ${kind}`);
          assert.equal(readFileSync(lock, 'utf8'), holders[got.indexOf(true)]);
          assert.equal(existsSync(`${lock}.steal`), false, 'the steal file is given back');
        } finally {
          sweep(root);
        }
      },
    ),
    { numRuns: 30 },
  );
}

// ---------------------------------------------------------------------------------------------
// Installing the addons
// ---------------------------------------------------------------------------------------------

type InstallFailure =
  | { readonly at: 'none' }
  | { readonly at: 'missing' | 'version'; readonly addon: number }
  | { readonly at: 'digest'; readonly addon: 0 | 1 };

const MARKINGS = ['plugin.cfg', 'runtime_autoload.gd', 'plugin.cfg', 'share.gd'];

/** A package of the four addons, each with its marking file and one more, holding [param content]. */
function fakePackage(root: string, content: string, failure: InstallFailure): string {
  const from = join(root, `package-${content}-${failure.at}`);
  for (const [index, name] of ADDONS.entries()) {
    if (failure.at === 'missing' && failure.addon === index) {
      continue;
    }
    mkdirSync(join(from, name, 'inner'), { recursive: true });
    writeFileSync(join(from, name, MARKINGS[index] ?? ''), `${name} ${content}`);
    writeFileSync(join(from, name, 'inner', 'file.gd'), `${content} ${name}`);
    if (failure.at === 'version' && failure.addon === index) {
      mkdirSync(join(from, name, VERSION_MARKER));
    }
  }
  if (failure.at === 'digest') {
    mkdirSync(join(from, failure.addon === 0 ? ADDONS[0] : 'gdharness_runtime', '.gdharness-digest'));
  }
  return from;
}

/** Every folder and file under [param folder], with its content, so two trees can be compared. */
function treeOf(folder: string): string[] {
  if (!existsSync(folder)) {
    return ['(absent)'];
  }
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return entry.isDirectory()
        ? `d ${relative(folder, path)}`
        : `f ${relative(folder, path)} ${readFileSync(path, 'utf8')}`;
    })
    .toSorted();
}

/**
 * An install either puts all four addons in with their markers, or leaves the project's addons as
 * it found them, whichever step fails: a missing addon, a version marker or a digest marker that
 * cannot be written. A half install is read as current by one reader and refused by another.
 */
function aFailedInstallLeavesTheProjectAsItWas(): void {
  const failures = fc.oneof(
    fc.constant<InstallFailure>({ at: 'none' }),
    fc.record({
      at: fc.constantFrom('missing' as const, 'version' as const),
      addon: fc.integer({ min: 0, max: 3 }),
    }),
    fc.record({ at: fc.constant('digest' as const), addon: fc.constantFrom<0 | 1>(0, 1) }),
  );
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), failures, (earlier, hadAddonsFolder, failure) => {
      const root = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-install-'));
      try {
        const project = join(root, 'project');
        mkdirSync(project);
        if (hadAddonsFolder) {
          mkdirSync(join(project, 'addons', 'other'), { recursive: true });
        }
        if (earlier) {
          installAddons(project, fakePackage(root, 'old', { at: 'none' }));
        }
        const before = treeOf(join(project, 'addons'));
        const from = fakePackage(root, 'new', failure);
        if (failure.at === 'none') {
          const installed = installAddons(project, from);
          assert.deepEqual(
            installed.map((addon) => [addon.name, addon.replaced]),
            ADDONS.map((name) => [name, earlier]),
          );
          for (const name of ADDONS) {
            assert.equal(
              readFileSync(join(project, 'addons', name, VERSION_MARKER), 'utf8').trim(),
              SERVER_VERSION,
            );
          }
          assert.notEqual(installedEditorDigest(project), null);
          assert.notEqual(installedRuntimeDigest(project), null);
        } else {
          assert.throws(() => installAddons(project, from));
          assert.deepEqual(
            treeOf(join(project, 'addons')),
            before,
            'the addons are as the failed install found them',
          );
        }
        assert.equal(existsSync(join(project, 'addons', '.gdharness-previous')), false);
      } finally {
        sweep(root);
      }
    }),
    { numRuns: 25 },
  );
}

// ---------------------------------------------------------------------------------------------
// Giving back a scratch folder
// ---------------------------------------------------------------------------------------------

const RETRY_WAITS = [250, 500, 1000, 2000, 4000, 8000, 16000];

interface RetryModel {
  tries: number;
  failuresLeft: number;
  waiting: boolean;
  due: number;
  step: number;
}

/** One removal try in the model: whether it worked. */
function modelTry(model: RetryModel): boolean {
  model.tries += 1;
  if (model.failuresLeft > 0) {
    model.failuresLeft -= 1;
    return false;
  }
  return true;
}

/** The timed try the schedule makes at the model's due time. */
function modelTimerFires(model: RetryModel): void {
  if (modelTry(model)) {
    model.waiting = false;
    return;
  }
  model.step += 1;
  const after = RETRY_WAITS[model.step];
  model.waiting = after !== undefined;
  model.due += after ?? 0;
}

/** A call to discard at [param at]: a try at once, and a schedule when it failed and none is running. */
function modelCall(model: RetryModel, at: number): void {
  if (!modelTry(model) && !model.waiting) {
    model.waiting = true;
    model.step = 0;
    model.due = at + (RETRY_WAITS[0] ?? 0);
  }
}

/** How many tries a removal that fails [param failures] times has had by [param until] ms, given the calls. */
function retryTriesBy(failures: number, calls: readonly number[], until: number): number {
  const model: RetryModel = { tries: 0, failuresLeft: failures, waiting: false, due: 0, step: 0 };
  let next = 0;
  for (;;) {
    const call = calls[next] ?? Number.POSITIVE_INFINITY;
    const timer = model.waiting ? model.due : Number.POSITIVE_INFINITY;
    if (Math.min(call, timer) > until) {
      return model.tries;
    }
    if (timer < call) {
      modelTimerFires(model);
    } else {
      next += 1;
      modelCall(model, call);
    }
  }
}

/**
 * The tries a removal gets, by the clock: the first at once, then after each wait of the schedule,
 * a second call for a path already waiting adding a try of its own and no second schedule, and none
 * after one has worked.
 */
function theRetryScheduleHoldsWhateverFails(): void {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 20000 }), { maxLength: 4 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 80000 }), { maxLength: 6 }),
      (failures, firstCalls, probes) => {
        const calls = [0, ...firstCalls.map((at) => at * 2 + 1)].toSorted((a, b) => a - b);
        const root = mkdtempSync(join(tmpdir(), 'gdharness-fuzz-scratch-'));
        const path = join(root, 'held');
        mkdirSync(path);
        let tries = 0;
        let left = failures;
        const remove = (target: string): void => {
          tries += 1;
          if (left > 0) {
            left -= 1;
            throw new Error('busy');
          }
          rmSync(target, { recursive: true, force: true });
        };
        jest.useFakeTimers();
        try {
          const points = [...new Set([...calls, ...probes.map((at) => at * 2 + 1), 100_000])].toSorted(
            (a, b) => a - b,
          );
          let clock = 0;
          for (const point of points) {
            jest.advanceTimersByTime(point - clock);
            clock = point;
            if (calls.includes(point)) {
              discardUsing(remove, [path]);
            }
            assert.equal(tries, retryTriesBy(failures, calls, point), `tries by ${String(point)} ms`);
          }
        } finally {
          jest.useRealTimers();
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 100 },
  );
}

// ---------------------------------------------------------------------------------------------
// The game log, read as it is written
// ---------------------------------------------------------------------------------------------

type LogStep =
  | { readonly kind: 'write'; readonly source: 'stdout' | 'stderr' | 'transcript'; readonly cut: number }
  | { readonly kind: 'record'; readonly severity: Severity; readonly text: string }
  | { readonly kind: 'read'; readonly mode: 'since' | 'all' | 'contains'; readonly limit: number };

/** The log text of three streams, each with its own line ending and a tail that may lack one. */
const streamText = fc
  .tuple(
    fc.array(logLine, { maxLength: 14 }),
    fc.constantFrom('\n', '\r\n'),
    fc.constantFrom('', 'ERROR: tail', 'WARNING: tail\r', 'plain tail', '\r', '   at: tail'),
  )
  .map(([lines, ending, tail]) => ({
    ending,
    text: `${lines.map((line) => `${line}${ending}`).join('')}${tail}`,
  }));

/**
 * One read of [param log] at [param floor], checked against the entries not yet [param covered] by
 * an earlier read. A search names the whole run and moves no mark, and any other read covers every
 * entry there is, which a later fold of some of them into an earlier entry does not undo.
 */
function readsAsShown(
  log: GameLog,
  floor: Severity,
  step: { readonly mode: 'since' | 'all' | 'contains'; readonly limit: number },
  covered: Set<LogEntry>,
): void {
  const tail = (entries: readonly LogEntry[]): { entries: LogEntry[]; omitted: number } => {
    const omitted = Math.max(0, entries.length - step.limit);
    return { entries: entries.slice(omitted), omitted };
  };
  if (step.mode === 'contains') {
    const found = log.select({ severity: floor, sinceLastCall: false, contains: 'error', limit: step.limit });
    assert.deepEqual(found, tail(log.all.filter((entry) => answersTo(entry, floor, 'error'))));
    return;
  }
  const since = step.mode === 'since';
  const found = log.select({ severity: floor, sinceLastCall: since, limit: step.limit });
  const shown = log.all.filter(
    (entry) => !(since && covered.has(entry)) && answersTo(entry, floor, undefined),
  );
  assert.deepEqual(found, tail(shown));
  for (const entry of log.all) {
    covered.add(entry);
  }
}

/**
 * Three streams interleaved and cut anywhere, a text that ends with no line ending or between CR
 * and LF included, each stream reads as if it had arrived whole, and every non-blank line is in one
 * entry. Reads between the writes show each entry once, and the three marks never move for a search.
 */
function aGameLogReadsTheSameWhenInterleavedAndRead(): void {
  const streams = ['stdout', 'stderr', 'transcript'] as const;
  const steps = fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant('write' as const),
        source: fc.constantFrom(...streams),
        cut: fc.nat({ max: 60 }),
      }),
      fc.record({
        kind: fc.constant('record' as const),
        severity: fc.constantFrom<Severity>('error', 'warning', 'info'),
        text: fc.constantFrom('stopped at a breakpoint', 'Invalid call', ''),
      }),
      fc.record({
        kind: fc.constant('read' as const),
        mode: fc.constantFrom('since' as const, 'all' as const, 'contains' as const),
        limit: fc.constantFrom(1, 3, Number.POSITIVE_INFINITY),
      }),
    ),
    { maxLength: 30 },
  );
  fc.assert(
    fc.property(
      fc.tuple(streamText, streamText, streamText),
      steps,
      fc.constantFrom<Severity>('error', 'warning', 'info'),
      (texts, program: LogStep[], floor) => {
        const log = new GameLog();
        const left = texts.map((entry) => Buffer.from(entry.text, 'utf8'));
        const covered = new Set<LogEntry>();
        for (const step of program) {
          if (step.kind === 'write') {
            const index = streams.indexOf(step.source);
            const bytes = left[index] ?? Buffer.alloc(0);
            const take = Math.min(bytes.length, step.cut);
            log.append(step.source, bytes.subarray(0, take));
            left[index] = bytes.subarray(take);
          } else if (step.kind === 'record') {
            log.record(step.severity, step.text);
          } else {
            readsAsShown(log, floor, step, covered);
          }
        }
        for (const [index, bytes] of left.entries()) {
          log.append(streams[index] ?? 'stdout', bytes);
        }
        log.finish();

        const whole = new GameLog();
        for (const [index, entry] of texts.entries()) {
          whole.append(streams[index] ?? 'stdout', entry.text);
        }
        whole.finish();
        // Whatever other streams and the debugger put between a headline's unindented lines and its
        // `at:` line, the entries of a stream fold as they do when it arrives whole.
        for (const source of streams) {
          const foldedOf = (reader: GameLog) =>
            reader.all
              .filter((entry) => entry.source === source)
              .map(({ severity, text, detail }) => ({ severity, text, detail }));
          const scriptsOf = (reader: GameLog): boolean[] =>
            reader.all
              .filter((entry) => entry.source === source)
              .map((entry) => reader.raisedByScript(entry));
          assert.deepEqual(foldedOf(log), foldedOf(whole), `${source} folds as if it had arrived whole`);
          assert.deepEqual(scriptsOf(log), scriptsOf(whole), `${source} keeps its script errors`);
        }
        assert.deepEqual(
          log.all.map((entry) => entry.index),
          log.all.map((_, position) => position),
          'every entry is numbered by its position',
        );
        const said = texts.reduce(
          (sum, entry) =>
            sum + entry.text.split('\n').filter((line) => line.replace(/\r$/, '').trim() !== '').length,
          0,
        );
        const kept = whole.all.reduce((sum, entry) => sum + 1 + entry.detail.length, 0);
        assert.equal(kept, said, 'every non-blank line is in exactly one entry, the unfinished last one too');
      },
    ),
    { numRuns: 200 },
  );
}

// ---------------------------------------------------------------------------------------------
// The debugger stream
// ---------------------------------------------------------------------------------------------

const sentValue: fc.Arbitrary<SentValue> = fc.letrec<{ value: SentValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc.double(),
    // A whole double past what it holds exactly is a float still, and so is one a 64-bit int could hold.
    fc.double({ min: 2 ** 53, max: 2 ** 63, noNaN: true }),
    fc.double({ min: -(2 ** 63), max: -(2 ** 53), noNaN: true }),
    // A bigint is an int whatever its size, and reads back as digits once a double cannot hold it.
    fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
    fc.string({ unit: 'grapheme', maxLength: 12 }),
    fc.array(tie('value'), { maxLength: 4 }),
  ),
})).value;

const sentCommand = fc.record({
  message: fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 12 }),
  thread: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  data: fc.array(sentValue, { maxLength: 4 }),
});

/** What the reader makes of a sent value: a bigint as a number while one holds it, else its digits. */
function readBack(value: SentValue): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : { kind: 'int', values: [value.toString()] };
  }
  return Array.isArray(value) ? value.map(readBack) : value;
}

/** Every message a stream gives for [param pieces], and whether it was out of step after them. */
function streamed(pieces: readonly Uint8Array[]): { messages: DebuggerMessage[]; lost: boolean } {
  const stream = new DebuggerStream();
  const messages: DebuggerMessage[] = [];
  let lost = false;
  try {
    for (const piece of pieces) {
      messages.push(...stream.push(piece));
    }
    stream.push(new Uint8Array(0));
  } catch (error) {
    assert.ok(error instanceof RangeError);
    lost = true;
  }
  return { messages, lost };
}

/**
 * Commands of any values, joined and cut anywhere down to single bytes, come out as the commands
 * that went in. Arbitrary bytes, with lengths at the engine's limit, are read the same whole or in
 * pieces, and fail only with a RangeError.
 */
function theDebuggerStreamIsCutProof(): void {
  fc.assert(
    fc.property(fc.array(sentCommand, { maxLength: 4 }), cuts, fc.boolean(), (commands, points, bytewise) => {
      const all = Buffer.concat(commands.map((c) => framedCommand(c.message, c.data, c.thread)));
      const pieces = bytewise
        ? chunked(
            all,
            Array.from({ length: all.length }, (_, at) => at),
          )
        : chunked(all, points);
      const { messages, lost } = streamed(pieces);
      assert.equal(lost, false);
      assert.deepEqual(
        messages,
        commands.map((c) => ({ message: c.message, thread: c.thread, data: c.data.map(readBack) })),
      );
    }),
    { numRuns: 150 },
  );
  const length = fc.constantFrom(0, 1, 3, 4, 7, 12, (8 << 20) + 4, (8 << 20) + 5, 0xff_ff_ff_ff);
  const garbage = fc.array(
    fc.oneof(
      fc.tuple(length, fc.uint8Array({ maxLength: 24 })).map(([n, rest]) => {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(n);
        return Buffer.concat([header, rest]);
      }),
      fc.uint8Array({ maxLength: 24 }).map((bytes) => Buffer.from(bytes)),
      sentCommand.map((c) => Buffer.from(framedCommand(c.message, c.data, c.thread))),
      sentCommand.chain((c) =>
        fc.nat().map((at) => {
          const framed = Buffer.from(framedCommand(c.message, c.data, c.thread));
          const flipped = 4 + (at % Math.max(1, framed.length - 4));
          framed.writeUInt8((framed.readUInt8(flipped) ^ 0xff) & 0xff, flipped);
          return framed;
        }),
      ),
    ),
    { maxLength: 5 },
  );
  fc.assert(
    fc.property(garbage, cuts, (parts, points) => {
      const all = Buffer.concat(parts);
      const whole = streamed([all]);
      const pieces = streamed(chunked(all, points));
      assert.deepEqual(pieces, whole);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 40 }), (bytes) => {
      try {
        decodeVariant(bytes);
      } catch (error) {
        assert.ok(error instanceof RangeError, 'bytes that are no value are refused with a RangeError');
      }
    }),
    { numRuns: 500 },
  );
}

framesRoundTripUnderAnyChunking();
everyHeaderSpellingIsRead();
junkNeverEscapesTheContract();
messagesAfterAFaultyBlockStillArrive();
theCeilingHoldsOnBothSides();
projectFileNeverThrowsOrPollutes();
projectFilesRoundTrip();
anyPathIsJudgedWithoutThrowing();
segmentsAreJudgedByWhereTheyLand();
absoluteFormsAreRefusedEverywhere();
aRunNoteHoldsOnlyItsOwnRun();
archivesRoundTrip();
hostileEntriesWriteNothing();
bytesThatAreNotAnArchiveWriteNothing();
damagedArchivesFailCleanly();
logsReadTheSameInAnyPieces();
reportsRoundTrip();
junkIsNeverAReport();
await noOrderOfSlotAndMemoryWaitsHangsARun();
await noOrderOfRisesLosesASuite();
await theWalkGivesOnlyWhatItHolds();
await writersTakeTurnsInTheOrderTheyAsked();
aPlanDependsOnItsUnitsAlone();
await theLargerKeptCacheSurvivesConcurrentKeeps();
await exactlyOneTakerHoldsAStaleLock();
aFailedInstallLeavesTheProjectAsItWas();
theRetryScheduleHoldsWhateverFails();
aGameLogReadsTheSameWhenInterleavedAndRead();
theDebuggerStreamIsCutProof();

console.log('fuzz properties held');
