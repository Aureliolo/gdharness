import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A project's uid cache, `.godot/uid_cache.bin`, set right before an engine starts on it: an entry
 * naming a file that is gone is pointed at the file that declares its uid now, or dropped when none
 * does.
 *
 * An editor creates the project's autoloads from the cache before it scans a file, and a boot or a
 * suite's engine never scans at all. A file moved with its `.uid` therefore leaves every older cache
 * naming the old path, and an autoload named by its uid loads from a file that is gone. Dropping the
 * entry alone is not enough, because an engine that does not scan then knows no file for the uid.
 *
 * The format is Godot's `ResourceUID::save_to_cache`, little-endian: a u32 count, then for each entry
 * the id as 8 bytes, the path's length as a u32 and the path's UTF-8 bytes. New entries are appended
 * with the count rewritten, so one id can stand twice, and the engine keeps the later one.
 */

export type UidEntry = readonly [id: bigint, path: string];

/** What setting a cache right came to: each entry pointed at its file's new place, and each dropped. */
export interface UidMend {
  readonly moved: readonly (readonly [id: bigint, from: string, to: string])[];
  readonly dropped: readonly UidEntry[];
}

const CACHE = join('.godot', 'uid_cache.bin');
const RES = 'res://';
const UID = 'uid://';
const NOTHING: UidMend = { moved: [], dropped: [] };

/** Each id's last entry, in the order each id first stood, or null when [param data] is not a cache. */
export function uidCacheEntries(data: Buffer): UidEntry[] | null {
  if (data.length < 4) {
    return null;
  }
  const count = data.readUInt32LE(0);
  const paths = new Map<bigint, string>();
  let at = 4;
  for (let entry = 0; entry < count; entry++) {
    if (at + 12 > data.length) {
      return null;
    }
    const id = data.readBigUInt64LE(at);
    const length = data.readUInt32LE(at + 8);
    at += 12;
    if (at + length > data.length) {
      return null;
    }
    paths.set(id, data.toString('utf8', at, at + length));
    at += length;
  }
  return [...paths];
}

/** [param entries] in the form `ResourceUID::save_to_cache` writes. */
export function encodedUidCache(entries: readonly UidEntry[]): Buffer {
  const parts = [Buffer.alloc(4)];
  parts[0]?.writeUInt32LE(entries.length, 0);
  for (const [id, path] of entries) {
    const named = Buffer.from(path, 'utf8');
    const head = Buffer.alloc(12);
    head.writeBigUInt64LE(id, 0);
    head.writeUInt32LE(named.length, 8);
    parts.push(head, named);
  }
  return Buffer.concat(parts);
}

/**
 * The id a `uid://` text names, as `ResourceUID::text_to_id` reads it: base 34, a letter for its
 * place from `a` and a digit for 25 more than its value, kept to 63 bits. Null for a text that is not
 * one.
 */
function uidOfText(text: string): bigint | null {
  if (!text.startsWith(UID) || text.length === UID.length) {
    return null;
  }
  let id = 0n;
  for (const character of text.slice(UID.length)) {
    const code = character.charCodeAt(0);
    let digit: number;
    if (code >= 0x61 && code <= 0x7a) {
      digit = code - 0x61;
    } else if (code >= 0x30 && code <= 0x39) {
      digit = code - 0x30 + 25;
    } else {
      return null;
    }
    id = id * 34n + BigInt(digit);
  }
  return id & 0x7fff_ffff_ffff_ffffn;
}

/** Whether the file a `res://` path names is there, by its exact name, each folder listed once. */
function presenceIn(projectPath: string): (path: string) => boolean {
  const listed = new Map<string, ReadonlySet<string>>();
  return (path) => {
    const inside = path.slice(RES.length);
    const slash = inside.lastIndexOf('/');
    const folder = slash < 0 ? '' : inside.slice(0, slash);
    let names = listed.get(folder);
    if (names === undefined) {
      try {
        names = new Set(readdirSync(join(projectPath, folder)));
      } catch {
        names = new Set();
      }
      listed.set(folder, names);
    }
    return names.has(inside.slice(slash + 1));
  };
}

const IMPORT_UID = /^uid="(uid:\/\/[^"]*)"/m;
const HEADER_UID = /^\[gd_(?:scene|resource)\b[^\]\n]*\buid="(uid:\/\/[^"]*)"/;

/**
 * The uid a file declares and the `res://` path it declares it for: a `.uid` beside a script or a
 * shader, an `.import` beside an imported file, or a text scene's or resource's own header.
 */
function declared(path: string, name: string): readonly [text: string, owner: string] | null {
  const read = (): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  if (name.endsWith('.uid')) {
    const text = read()?.trim();
    return text === undefined ? null : [text, name.slice(0, -'.uid'.length)];
  }
  const pattern = name.endsWith('.import')
    ? IMPORT_UID
    : name.endsWith('.tscn') || name.endsWith('.tres')
      ? HEADER_UID
      : null;
  const text = pattern === null ? undefined : read()?.match(pattern)?.[1];
  if (text === undefined) {
    return null;
  }
  return [text, name.endsWith('.import') ? name.slice(0, -'.import'.length) : name];
}

/**
 * The `res://` path of the file declaring each of [param wanted], walked as the engine's scan walks:
 * a folder or file spelled with a leading dot, and a folder holding a `.gdignore`, are stepped over.
 * The walk ends once every id is found, and the first file declaring an id wins.
 */
function declaringFiles(projectPath: string, wanted: ReadonlySet<bigint>): Map<bigint, string> {
  const found = new Map<bigint, string>();
  const visit = (directory: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.gdignore')) {
      return;
    }
    for (const entry of entries) {
      if (found.size === wanted.size) {
        return;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      const path = join(directory, entry.name);
      const spelled = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        visit(path, `${spelled}/`);
        continue;
      }
      const declaration = entry.isFile() ? declared(path, spelled) : null;
      const id = declaration === null ? null : uidOfText(declaration[0]);
      if (declaration !== null && id !== null && wanted.has(id) && !found.has(id)) {
        found.set(id, `${RES}${declaration[1]}`);
      }
    }
  };
  visit(projectPath, '');
  return found;
}

/**
 * Sets [param projectPath]'s cache right and answers what changed. A sound cache, a missing one or
 * one not in Godot's form is left byte for byte. The new cache is written beside the old and renamed
 * over it, so an engine never reads half of one.
 */
export function mendUidCache(projectPath: string): UidMend {
  const cache = join(projectPath, CACHE);
  let data: Buffer;
  try {
    data = readFileSync(cache);
  } catch {
    return NOTHING;
  }
  const entries = uidCacheEntries(data);
  if (entries === null) {
    return NOTHING;
  }
  const present = presenceIn(projectPath);
  const gone = entries.filter(([, path]) => path.startsWith(RES) && !present(path));
  if (gone.length === 0) {
    return NOTHING;
  }
  const goneIds = new Set(gone.map(([id]) => id));
  const now = declaringFiles(projectPath, goneIds);
  const moved: [bigint, string, string][] = [];
  const dropped: UidEntry[] = [];
  for (const [id, path] of gone) {
    const to = now.get(id);
    if (to === undefined) {
      dropped.push([id, path]);
    } else {
      moved.push([id, path, to]);
    }
  }
  const written = `${cache}.${String(process.pid)}.mending`;
  const kept = entries.flatMap(([id, path]): UidEntry[] => {
    if (!goneIds.has(id)) {
      return [[id, path]];
    }
    const to = now.get(id);
    return to === undefined ? [] : [[id, to]];
  });
  writeFileSync(written, encodedUidCache(kept));
  try {
    renameSync(written, cache);
  } catch (error) {
    rmSync(written, { force: true });
    throw error;
  }
  return { moved, dropped };
}

/** The project a Godot command line starts on, by its `--path`, or null when it names none. */
function projectStarted(args: readonly string[], cwd: string | URL | undefined): string | null {
  const at = args.indexOf('--path');
  const named = at < 0 ? undefined : args[at + 1];
  if (named === undefined) {
    return null;
  }
  const from = cwd === undefined ? process.cwd() : cwd instanceof URL ? fileURLToPath(cwd) : cwd;
  const project = isAbsolute(named) ? named : resolve(from, named);
  return existsSync(join(project, 'project.godot')) ? project : null;
}

/**
 * Sets right the cache of the project [param args] start an engine on. A cache that cannot be
 * rewritten, as when a running editor holds it on Windows, is left for the engine to meet as it
 * would have. What changed, or why nothing could, is said on stderr, where the server's log goes.
 */
export function mendBeforeStart(args: readonly string[], cwd: string | URL | undefined): void {
  const project = projectStarted(args, cwd);
  if (project === null) {
    return;
  }
  const where = join(project, CACHE);
  try {
    const { moved, dropped } = mendUidCache(project);
    if (moved.length > 0) {
      const named = moved.map(([, from, to]) => `${from} to ${to}`).join(', ');
      process.stderr.write(`uid cache: moved what names a file gone in ${where}: ${named}\n`);
    }
    if (dropped.length > 0) {
      const named = dropped.map(([, path]) => path).join(', ');
      process.stderr.write(`uid cache: dropped what names a file gone from ${where}: ${named}\n`);
    }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    process.stderr.write(`uid cache: could not rewrite ${where}, which names files gone: ${said}\n`);
  }
}
