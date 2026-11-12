import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedEntries } from './class-cache.js';
import { errorMessage } from './errors.js';
import { fileNoCaseCompare } from './file-order.js';
import { holdsAProject } from './paths.js';

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
interface UidMend {
  readonly moved: readonly (readonly [id: bigint, from: string, to: string])[];
  readonly dropped: readonly UidEntry[];
}

const CACHE = join('.godot', 'uid_cache.bin');
const RES = 'res://';
const UID = 'uid://';
const NOTHING: UidMend = { moved: [], dropped: [] };
const CLASS_LIST = join('.godot', 'global_script_class_cache.cfg');

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
  // A sidecar whose file is gone declares nothing: the editor leaves it behind when a file is
  // deleted outside it, and the cache must not be pointed at a path with nothing there.
  const ownerPresent = (sidecar: string): boolean => existsSync(path.slice(0, -sidecar.length));
  if (name.endsWith('.uid')) {
    const text = ownerPresent('.uid') ? read()?.trim() : undefined;
    return text === undefined ? null : [text, name.slice(0, -'.uid'.length)];
  }
  const pattern = name.endsWith('.import')
    ? IMPORT_UID
    : name.endsWith('.tscn') || name.endsWith('.tres')
      ? HEADER_UID
      : null;
  const text =
    pattern === null || (name.endsWith('.import') && !ownerPresent('.import'))
      ? undefined
      : read()?.match(pattern)?.[1];
  if (text === undefined) {
    return null;
  }
  return [text, name.endsWith('.import') ? name.slice(0, -'.import'.length) : name];
}

/**
 * The `res://` path of the file declaring each of [param wanted], as the engine's scan settles it:
 * a folder or file spelled with a leading dot, and a folder holding a `.gdignore` or a
 * `project.godot` of its own, are stepped over.
 * The scan takes a folder's subfolders first, then its files, each in `fileNoCaseCompare` order, and
 * of two files declaring one id the later wins. The walk goes in the reverse order and keeps the
 * first, so it ends once every id is found.
 */
function declaringFiles(projectPath: string, wanted: ReadonlySet<bigint>): Map<bigint, string> {
  const found = new Map<bigint, string>();
  findDeclarations(projectPath, '', wanted, found);
  return found;
}

function findDeclarations(
  directory: string,
  prefix: string,
  wanted: ReadonlySet<bigint>,
  found: Map<bigint, string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.name === '.gdignore')) {
    return;
  }
  const shown = entries.filter((entry) => !entry.name.startsWith('.'));
  const files = shown
    .filter((entry) => entry.isFile())
    .toSorted((a, b) => fileNoCaseCompare(declaredFor(b.name), declaredFor(a.name)));
  const folders = shown
    .filter((entry) => entry.isDirectory() && !holdsAProject(join(directory, entry.name)))
    .toSorted((a, b) => fileNoCaseCompare(b.name, a.name));
  for (const file of files) {
    if (found.size === wanted.size) {
      return;
    }
    recordDeclaration(join(directory, file.name), `${prefix}${file.name}`, wanted, found);
  }
  for (const folder of folders) {
    if (found.size === wanted.size) {
      return;
    }
    findDeclarations(join(directory, folder.name), `${prefix}${folder.name}/`, wanted, found);
  }
}

/** The name of the file [param name] declares a uid for, which is where the engine's scan meets it. */
function declaredFor(name: string): string {
  for (const sidecar of ['.uid', '.import']) {
    if (name.endsWith(sidecar)) {
      return name.slice(0, -sidecar.length);
    }
  }
  return name;
}

/** Notes [param path] in [param found] when it declares a wanted id that no file walked before declared. */
function recordDeclaration(
  path: string,
  spelled: string,
  wanted: ReadonlySet<bigint>,
  found: Map<bigint, string>,
): void {
  const declaration = declared(path, spelled);
  const id = declaration === null ? null : uidOfText(declaration[0]);
  if (declaration !== null && id !== null && wanted.has(id) && !found.has(id)) {
    found.set(id, `${RES}${declaration[1]}`);
  }
}

/**
 * The `res://` path of the file declaring each `uid://` text of [param texts], by the same walk the
 * cache mend uses. A text no file declares, or that is not a uid, has no entry.
 */
export function uidTargets(projectPath: string, texts: readonly string[]): Map<string, string> {
  const ids = new Map<bigint, string[]>();
  for (const text of texts) {
    const id = uidOfText(text);
    if (id !== null) {
      ids.set(id, [...(ids.get(id) ?? []), text]);
    }
  }
  const targets = new Map<string, string>();
  if (ids.size === 0) {
    return targets;
  }
  for (const [id, path] of declaringFiles(projectPath, new Set(ids.keys()))) {
    for (const text of ids.get(id) ?? []) {
      targets.set(text, path);
    }
  }
  return targets;
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

/** One class of the class list that names a file gone: its name and the `res://` path it is listed at. */
type GoneClass = readonly [name: string, path: string];

/**
 * Sets [param projectPath]'s class list, `.godot/global_script_class_cache.cfg`, right: an entry whose
 * path names a file that is gone is dropped, and the dropped ones are answered. A list copied from
 * another checkout names scripts this one lacks, and compiling every script together then fails on
 * `Could not find script for class`. An entry whose file is there is kept, even when the file now
 * declares another class, because the engine resolves the name to that file and loads it unharmed.
 *
 * The file is Godot's form, `list=[`, the entries joined by `, `, then `]`. A sound list is left byte
 * for byte. One naming a file gone in another form is left too, and the mend throws to say why, since
 * the start it precedes then fails as before. The new list is written beside the old and renamed
 * over it.
 */
export function mendClassList(projectPath: string): readonly GoneClass[] {
  const file = join(projectPath, CLASS_LIST);
  const entries = cachedEntries(projectPath);
  if (entries === null) {
    return [];
  }
  const present = presenceIn(projectPath);
  const gone: GoneClass[] = [];
  const kept: string[] = [];
  for (const [name, entry] of entries) {
    const path = /"path":\s*"([^"]*)"/.exec(entry)?.[1];
    if (path?.startsWith(RES) === true && !present(path)) {
      gone.push([name, path]);
    } else {
      kept.push(entry);
    }
  }
  if (gone.length === 0) {
    return [];
  }
  if (readFileSync(file, 'utf8') !== `list=[${[...entries.values()].join(', ')}]\n`) {
    throw new Error('it is not in the form Godot writes, so it is left as it is');
  }
  const written = `${file}.${String(process.pid)}.mending`;
  writeFileSync(written, `list=[${kept.join(', ')}]\n`);
  try {
    renameSync(written, file);
  } catch (error) {
    rmSync(written, { force: true });
    throw error;
  }
  return gone;
}

/**
 * The arguments of the program [param command] runs, past the wrappers an engine starts under on
 * Linux: `taskset -c <cores>` and `setpriv <options> --`, each of which runs the command after it.
 * Read as the engine's own, setpriv's `--` hid every engine's `--path`, so no Linux engine was mended.
 */
export function programArgumentsOf(command: string, args: readonly string[]): readonly string[] {
  const name = basename(command);
  const inner = args[2];
  if (name === 'taskset' && args[0] === '-c' && inner !== undefined) {
    return programArgumentsOf(inner, args.slice(3));
  }
  const end = args.indexOf('--');
  const wrapped = args[end + 1];
  if (name === 'setpriv' && end >= 0 && wrapped !== undefined) {
    return programArgumentsOf(wrapped, args.slice(end + 2));
  }
  return args;
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
    const said = errorMessage(error);
    process.stderr.write(`uid cache: could not rewrite ${where}, which names files gone: ${said}\n`);
  }
  mendClassListBeforeStart(project);
}

/** Says on stderr which classes were dropped from [param project]'s class list, or why none could be. */
function mendClassListBeforeStart(project: string): void {
  const where = join(project, CLASS_LIST);
  try {
    const dropped = mendClassList(project);
    if (dropped.length > 0) {
      const named = dropped.map(([name, path]) => `${name} at ${path}`).join(', ');
      process.stderr.write(`class list: dropped what names a file gone from ${where}: ${named}\n`);
    }
  } catch (error) {
    const said = errorMessage(error);
    process.stderr.write(`class list: could not rewrite ${where}, which names files gone: ${said}\n`);
  }
}
