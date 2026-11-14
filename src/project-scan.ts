/**
 * What can be learnt about a project by reading its directory, with no engine involved: what
 * kinds of file it holds, and where a piece of text occurs.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { errorMessage } from './errors.js';
import { bytesOf, statOf } from './listed-reads.js';
import { realAsFarAsItExists, relativeWithin } from './paths.js';
import { type LeftOut, leftOutAt, leftOutsOnPath, VERSION_MARKER, walkProject } from './project-walk.js';
import { uidCacheEntries } from './uid-cache.js';

export { VERSION_MARKER };

/** The extension of a file name without its dot, lower case, empty for a name with none such as `gd`. */
function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/**
 * Whether gdharness installed the addon in [param directory], which it marks with its version. The
 * engine loads such an addon, but nobody on the project wrote it, and the next upgrade replaces it.
 */
export function installedByUs(directory: string): boolean {
  return existsSync(join(directory, VERSION_MARKER));
}

/** File counts for a project, by kind. */
interface ProjectStructure {
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
}

/** Text scenes and the binary ones a project may save instead. */
const SCENE_EXTENSIONS = new Set(['tscn', 'scn']);

/** What the engine writes beside a file it imports or gives a uid, which is no file of the project's own. */
const SIDECAR_EXTENSIONS = new Set(['import', 'uid']);

/** What a project imports as media: images, fonts, sound, models, video and shaders. */
const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'bmp',
  'tga',
  'exr',
  'hdr',
  'ktx',
  'dds',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'fnt',
  'wav',
  'mp3',
  'ogg',
  'glb',
  'gltf',
  'obj',
  'fbx',
  'blend',
  'dae',
  'ogv',
  'gdshader',
  'gdshaderinc',
  'shader',
  'glsl',
]);

/** Which count a file of this extension is in, or null for a sidecar, which is no file of the project's own. */
function kindOfFile(extension: string): keyof ProjectStructure | null {
  if (SIDECAR_EXTENSIONS.has(extension)) {
    return null;
  }
  if (SCENE_EXTENSIONS.has(extension)) {
    return 'scenes';
  }
  if (extension === 'gd' || extension === 'cs') {
    return 'scripts';
  }
  return ASSET_EXTENSIONS.has(extension) ? 'assets' : 'other';
}

export function projectStructure(projectPath: string): ProjectStructure {
  const structure: ProjectStructure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
  for (const folder of walkProject(projectPath, { inside: projectPath }).folders) {
    for (const file of folder.files) {
      const kind = file.twin ? null : kindOfFile(extensionOf(file.name));
      if (kind !== null) {
        structure[kind] += 1;
      }
    }
  }
  return structure;
}

/**
 * The project's files whose extension is one of [param extensions] (with the dot, lower case),
 * project-relative with forward slashes and sorted. The walk steps over what the engine steps over.
 */
export function projectFiles(projectPath: string, extensions: readonly string[]): string[] {
  return filesIn(walkProject(projectPath, { inside: projectPath }), (name) =>
    extensions.includes(extname(name).toLowerCase()),
  );
}

/** The sorted paths, relative to the walk's start, of the files [param wanted] takes that no twin stands for. */
function filesIn(walk: ReturnType<typeof walkProject>, wanted: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const folder of walk.folders) {
    for (const file of folder.files) {
      if (!file.twin && wanted(file.name)) {
        found.push(folder.folder === '' ? file.name : `${folder.folder}/${file.name}`);
      }
    }
  }
  return found.toSorted();
}

/**
 * The folder [param directory] itself, when the scan leaves it out as holding a `.gdignore` or a
 * project of its own. What lies above it does not matter: naming a folder asks for it.
 */
function leftOutItself(projectPath: string, directory: string): LeftOut | null {
  const inside = relativeWithin(projectPath, directory);
  if (inside === null || inside === '') {
    return null;
  }
  const own = leftOutsOnPath(projectPath, inside).find((left) => left.folder === inside);
  return own === undefined || own.why === 'gdharness' ? null : own;
}

/**
 * [method projectFiles] for one folder of a project that a caller named, relative to that folder.
 * The folder is walked even when gdharness installed it, since naming it asks for it. Below it,
 * as everywhere, what the engine steps over and what gdharness installed are stepped over. A walk
 * of its own here took in gdharness's addons, so a project's diagnostics checked fifty-five of
 * them beside its three scripts while every other answer called the three the project's.
 */
export function folderFiles(projectPath: string, directory: string, extensions: readonly string[]): string[] {
  if (leftOutItself(projectPath, directory) !== null) {
    return [];
  }
  return filesIn(walkProject(directory, { inside: projectPath }), (name) =>
    extensions.includes(extname(name).toLowerCase()),
  );
}

/**
 * The topmost folders [method folderFiles] steps over in [param directory], so that a folder with
 * no script it walks can say where its scripts are. `addons` holding only gdharness's addons was
 * answered as holding no .gd script, beside the seventy-three that naming each addon found.
 */
export function steppedOverIn(projectPath: string, directory: string): LeftOut[] {
  const itself = leftOutItself(projectPath, directory);
  if (itself !== null) {
    return [{ folder: '', why: itself.why }];
  }
  const walk = walkProject(directory, { inside: projectPath });
  // The left-out folders are whole once the walk has been read to its end.
  Array.from(walk.folders);
  return walk.leftOut.toSorted((a, b) => a.folder.localeCompare(b.folder));
}

/** The extensions Godot mints a `.uid` sidecar for. */
const CARRIES_A_UID = new Set(['gd', 'shader', 'gdshader']);

/**
 * The scripts and shaders with no `.uid` beside them, project-relative and sorted.
 *
 * A file added since the last import has no sidecar, and nothing about the file itself says so:
 * the engine mints one when it walks the project, and until then every reference to that script by
 * UID has nothing to resolve. Counting them is a question about the directory, so it is answered
 * here rather than by booting an engine to look.
 */
export function scriptsWithoutUid(projectPath: string): string[] {
  const found: string[] = [];
  for (const folder of walkProject(projectPath, { inside: projectPath }).folders) {
    for (const file of folder.files) {
      if (
        !file.twin &&
        CARRIES_A_UID.has(extensionOf(file.name)) &&
        !existsSync(join(folder.path, `${file.name}.uid`))
      ) {
        found.push(folder.folder === '' ? file.name : `${folder.folder}/${file.name}`);
      }
    }
  }
  return found.toSorted();
}

/**
 * The res:// paths the project's uid cache holds a uid for, or null when it has no cache it can read.
 * A headless write looks a path's uid up here, which nothing in the project's own files shows.
 */
export function pathsInUidCache(projectPath: string): Set<string> | null {
  let data: Buffer;
  try {
    data = readFileSync(join(projectPath, '.godot', 'uid_cache.bin'));
  } catch {
    return null;
  }
  const entries = uidCacheEntries(data);
  return entries === null ? null : new Set(entries.map(([, path]) => path));
}

export interface SearchOptions {
  readonly query: string;
  /** Extensions to search, or undefined for every text file. */
  readonly fileTypes?: readonly string[];
  /** The folder or file inside the project to search, on disk, or undefined for the whole project. */
  readonly within?: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
}

interface SearchMatch {
  readonly line: number;
  readonly content: string;
  readonly match: string;
  /** Set on a line cut to [SHOWN_OF_A_LINE]: the column the shown part starts at, from 1. */
  readonly shownFrom?: number;
  /** Set on a line cut to [SHOWN_OF_A_LINE]: how long the whole line is. */
  readonly lineLength?: number;
}

/**
 * The characters of a matching line answered, around its first match. A scene keeps a tile map's
 * cells and a mesh's arrays on one line each, and a minified JSON file is one line, so a search
 * meeting one answered every character of it.
 */
export const SHOWN_OF_A_LINE = 400;

/** [param line], which holds a match of [param length] characters at [param at], as answered. */
function shownMatch(line: string, at: number, length: number, match: string, number: number): SearchMatch {
  const trimmed = line.trim();
  if (trimmed.length <= SHOWN_OF_A_LINE) {
    return { line: number, content: trimmed, match };
  }
  const room = Math.max(0, SHOWN_OF_A_LINE - length);
  const start = Math.min(Math.max(0, at - Math.floor(room / 2)), line.length - SHOWN_OF_A_LINE);
  return {
    line: number,
    content: line.slice(start, start + SHOWN_OF_A_LINE),
    match,
    shownFrom: start + 1,
    lineLength: line.length,
  };
}

export interface SearchResult {
  readonly query: string;
  readonly results: { file: string; matches: SearchMatch[] }[];
  readonly summary: {
    files_searched: number;
    files_with_matches: number;
    total_matches: number;
    truncated: boolean;
  };
  /** The folders a `.gdignore` kept out, which a search for words the project holds may want. */
  not_searched?: string[];
  /**
   * Why nothing was searched, when the extensions asked for matched no file, and that the place
   * asked for is one the engine steps over, when it is.
   */
  note?: string;
}

/**
 * The folder at or above [param place], up to [param projectPath], that a whole-project search
 * steps over, with why, or null when none is. Named as the path, such a folder is searched all the
 * same: a folder holding a .gdignore answered no file searched, while a folder inside it was
 * searched whole.
 */
function steppedOverAround(projectPath: string, place: string): { folder: string; why: string } | null {
  let at = projectPath;
  const steps = relative(projectPath, place)
    .split(sep)
    .filter((part) => part !== '');
  for (const [index, step] of steps.entries()) {
    at = join(at, step);
    if (!statSync(at).isDirectory()) {
      break;
    }
    const folder = steps.slice(0, index + 1).join('/');
    if (step.startsWith('.')) {
      return { folder: `res://${folder}/`, why: 'its name starts with a dot' };
    }
    const left = leftOutAt(projectPath, folder);
    if (left !== null) {
      return { folder: `res://${left.folder}/`, why: whyAWholeSearchSkips(left.why) };
    }
  }
  return null;
}

/** Why a whole-project search steps over a folder the scan leaves out for [param why]. */
const SEARCH_SKIPS: Readonly<Record<LeftOut['why'], string>> = {
  gdignore: 'it holds a .gdignore',
  project: 'it holds a project.godot of its own, which makes it another project',
  gdharness: 'gdharness installed it',
  link: 'it is a link back up the tree or to nothing',
  outside: 'it is a link out of the project',
};

function whyAWholeSearchSkips(why: LeftOut['why']): string {
  return SEARCH_SKIPS[why];
}

/** Whether [param bytes] are a binary file's: a NUL in the first eight thousand, as git judges. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** A text file of the project, by its `res://` path and where it is on disk. */
export interface ProjectText {
  readonly path: string;
  readonly absolute: string;
  readonly text: string;
  /** The file's real place as a `res://` path, set where the text is kept under a link's path and that place is inside the project. */
  readonly realPath?: string;
}

/**
 * Every `res://` path each file of the project is reached by, binary files included. A move of a file
 * takes them all along, since a reference may name the file by any of them.
 */
export interface Reach {
  /**
   * [param path] with every other path that reaches the same file: each link to it and its real place
   * when that lies inside the project. Only [param path] where the walk does not reach it.
   */
  readonly pathsOf: (path: string) => readonly string[];
  /** Every path the walk reaches, and each real place that lies inside the project. */
  readonly paths: () => Iterable<string>;
}

/** A text below a folder the scan leaves out, with that folder and why it is left out. */
export interface IgnoredText extends ProjectText {
  readonly why: 'gdignore' | 'project';
  /** The topmost left-out folder above the file, as a `res://` path with a closing slash. */
  readonly folder: string;
}

/**
 * Formats that are never text, passed over without being read. Opening every texture and model in
 * a project to look for a NUL made a walk of a large project read gigabytes to find its scripts.
 */
const BINARY_EXTENSIONS = new Set([
  ...[...ASSET_EXTENSIONS].filter(
    (extension) => !['svg', 'gltf', 'gdshader', 'shader', 'fnt'].includes(extension),
  ),
  'scn',
  'res',
  'zip',
  'pck',
  'exe',
  'dll',
  'so',
  'dylib',
]);

/** A file a walk reached, by the path the walk spells it with. */
interface Reached {
  readonly name: string;
  /** Relative to the project, with forward slashes. */
  readonly spelled: string;
  readonly absolute: string;
  readonly real: string;
  readonly twin: boolean;
}

/** Every file of the walk from [param start], inside [param projectPath], spelled below [param prefix]. */
function reachedFrom(
  start: string,
  projectPath: string,
  prefix: string,
): { files: Reached[]; leftOut: readonly LeftOut[] } {
  const walk = walkProject(start, { inside: projectPath });
  const files: Reached[] = [];
  for (const folder of walk.folders) {
    const below = folder.folder === '' ? prefix : `${prefix}${folder.folder}/`;
    for (const file of folder.files) {
      files.push({
        name: file.name,
        spelled: `${below}${file.name}`,
        absolute: join(folder.path, file.name),
        real: file.real,
        twin: file.twin,
      });
    }
  }
  return { files, leftOut: walk.leftOut };
}

/** The `res://` path of [param file]'s real place when it differs from the path it is kept under and lies inside the project. */
function realPathOf(realProject: string, file: Reached): string | undefined {
  const inside = relativeWithin(realProject, file.real);
  if (inside === null || inside === '' || inside === file.spelled) {
    return undefined;
  }
  return `res://${inside}`;
}

/** The text file at [param file] as a project text, or null when it cannot be read or is binary. */
function textOf(file: Reached, realPath: string | undefined): ProjectText | null {
  if (BINARY_EXTENSIONS.has(extensionOf(file.name))) {
    return null;
  }
  const bytes = bytesOf(file.absolute);
  if (bytes === null || isBinary(bytes)) {
    return null;
  }
  const text: ProjectText = {
    path: `res://${file.spelled}`,
    absolute: file.absolute,
    text: bytes.toString('utf8'),
    ...(realPath === undefined ? {} : { realPath }),
  };
  return text;
}

/**
 * The walk's path that the `res://` path [param named] stands for: the one that equals it, else the
 * one that equals it in lower case, among those to the file at its real place. A file system that
 * tells case apart has no file at a path in another case, so that match is reached only where case is
 * ignored.
 */
function pathNamedBy(projectPath: string, named: string, files: readonly Reached[]): Reached | undefined {
  if (!named.startsWith('res://')) {
    return undefined;
  }
  const spelled = named.slice('res://'.length);
  const real = realAsFarAsItExists(join(projectPath, ...spelled.split('/')));
  const same = files.filter((file) => file.real === real);
  const lowered = spelled.toLowerCase();
  return (
    same.find((file) => file.spelled === spelled) ??
    same.find((file) => file.spelled.toLowerCase() === lowered)
  );
}

/** Each path of [param files] with every path that reaches the same file and that file's real place inside the project. */
function pathGroups(realProject: string, files: readonly Reached[]): Map<string, readonly string[]> {
  const byReal = new Map<string, string[]>();
  for (const file of files) {
    const group = byReal.get(file.real) ?? [];
    group.push(`res://${file.spelled}`);
    byReal.set(file.real, group);
  }
  const byPath = new Map<string, readonly string[]>();
  for (const [real, group] of byReal) {
    const inside = relativeWithin(realProject, real);
    const place = inside === null || inside === '' ? null : `res://${inside}`;
    if (place !== null && !group.includes(place)) {
      group.push(place);
    }
    for (const path of group) {
      byPath.set(path, group);
    }
  }
  return byPath;
}

/** The paths of [param files] grouped by the file they reach, built on the first lookup. */
function reachOf(realProject: string, files: readonly Reached[]): Reach {
  let groups: Map<string, readonly string[]> | null = null;
  const built = (): Map<string, readonly string[]> => (groups ??= pathGroups(realProject, files));
  return {
    pathsOf: (path) => built().get(path) ?? [path],
    paths: () => built().keys(),
  };
}

/**
 * Every text file a writer may change, each real file once: under a path in [param named] that
 * reaches it, else its own, else the first the scan reaches it by. None behind a link out of the
 * project. Text holds no NUL in its first eight thousand bytes.
 */
export function projectTexts(projectPath: string, named: readonly string[] = []): ProjectText[] {
  return scanProject(projectPath, named).texts;
}

/** The texts of [param projectTexts], with the paths every file of the same walk is reached by. */
export function scanProject(
  projectPath: string,
  named: readonly string[] = [],
): { texts: ProjectText[]; reach: Reach } {
  const { files } = reachedFrom(projectPath, projectPath, '');
  const kept = new Map<string, Reached>();
  for (const file of files) {
    if (!file.twin) {
      kept.set(file.real, file);
    }
  }
  for (const path of named) {
    const stands = pathNamedBy(projectPath, path, files);
    if (stands !== undefined) {
      kept.set(stands.real, stands);
    }
  }
  const realProject = realAsFarAsItExists(projectPath);
  const found: ProjectText[] = [];
  for (const file of files) {
    const text = kept.get(file.real) === file ? textOf(file, realPathOf(realProject, file)) : null;
    if (text !== null) {
      found.push(text);
    }
  }
  return { texts: found, reach: reachOf(realProject, files) };
}

/** A folder the scan leaves out for a `.gdignore` or a `project.godot`, whose texts a rename mentions. */
interface IgnoredStart {
  /** Relative to the project, with forward slashes. */
  readonly folder: string;
  readonly why: IgnoredText['why'];
  /** The topmost left-out folder above it, itself included. */
  readonly top: string;
}

/** A text found below a left-out folder, ranked by how plain the path to it is. */
interface IgnoredFound {
  readonly file: Reached;
  readonly rank: number;
  readonly start: IgnoredStart;
}

/** The left-out folders in [param leftOut], below [param above], taking the topmost one's reason. */
function ignoredStartsIn(
  leftOut: readonly LeftOut[],
  above: { folder: string; why: IgnoredText['why']; top: string } | null,
): IgnoredStart[] {
  const starts: IgnoredStart[] = [];
  for (const left of leftOut) {
    if (left.why !== 'gdignore' && left.why !== 'project') {
      continue;
    }
    const folder = above === null ? left.folder : `${above.folder}/${left.folder}`;
    starts.push({
      folder,
      why: above?.why ?? left.why,
      top: above?.top ?? `res://${folder}/`,
    });
  }
  return starts;
}

/**
 * 0 for a file whose path holds no link, 1 for one holding none below its left-out folder, else 2.
 */
function plainness(realProject: string, top: string, file: Reached): number {
  const folder = top.slice('res://'.length, -1);
  const realTop = realAsFarAsItExists(join(realProject, ...folder.split('/')));
  const below = file.spelled.slice(folder.length + 1);
  if (file.real !== join(realTop, ...below.split('/'))) {
    return 2;
  }
  return file.real === join(realProject, ...file.spelled.split('/')) ? 0 : 1;
}

/**
 * The texts below each folder the scan leaves out for a `.gdignore` or a `project.godot`, copies
 * the engine never loads, such as a mod kit's sources, which still name the project's classes and
 * are still broken by a rename. Each real file is listed once, under a path with no link below its
 * left-out folder where there is one, with the topmost such folder and its reason. A file the
 * project's own walk reaches is no copy.
 */
export function ignoredTexts(projectPath: string): IgnoredText[] {
  const project = reachedFrom(projectPath, projectPath, '');
  const reached = new Set(project.files.map((file) => file.real));
  const realProject = realAsFarAsItExists(projectPath);
  const found = new Map<string, IgnoredFound>();
  const queue = ignoredStartsIn(project.leftOut, null);
  const entered = new Set<string>();
  // The queue grows as each walk names the folders left out inside it, so a loop over it is the walk.
  for (const start of queue) {
    const at = join(projectPath, ...start.folder.split('/'));
    const key = `${realAsFarAsItExists(at)}\0${start.top}`;
    if (entered.has(key)) {
      continue;
    }
    entered.add(key);
    const walked = reachedFrom(at, projectPath, `${start.folder}/`);
    for (const file of walked.files.filter((one) => !one.twin && !reached.has(one.real))) {
      const rank = plainness(realProject, start.top, file);
      const known = found.get(file.real);
      if (known === undefined || rank < known.rank) {
        found.set(file.real, { file, rank, start });
      }
    }
    queue.push(...ignoredStartsIn(walked.leftOut, start));
  }
  const texts: IgnoredText[] = [];
  for (const { file, start } of found.values()) {
    const text = textOf(file, realPathOf(realProject, file));
    if (text !== null) {
      texts.push({ ...text, why: start.why, folder: start.top });
    }
  }
  return texts;
}

/**
 * Each link of the project that leads out of it, as a `res://` path with a closing slash for a
 * folder, in the scan's order. A link below a folder the scan leaves out is not among them.
 */
export function linksOut(projectPath: string): string[] {
  const walk = walkProject(projectPath, { inside: projectPath });
  Array.from(walk.folders);
  return walk.leftOut
    .filter((left) => left.why === 'outside')
    .map((left) => {
      const isFolder = statOf(join(projectPath, ...left.folder.split('/')))?.isDirectory() === true;
      return `res://${left.folder}${isFolder ? '/' : ''}`;
    });
}

/**
 * The first place [param needle] (lowered unless [param caseSensitive]) occurs in [param line], as
 * the line spells it, or null. The text found rather than the query: a search for "Item" answered
 * `match: "Item"` on a line holding only `item.gd`.
 */
function plainMatch(
  line: string,
  needle: string,
  caseSensitive: boolean,
): { text: string; at: number } | null {
  if (caseSensitive) {
    const at = line.indexOf(needle);
    return at < 0 ? null : { text: needle, at };
  }
  const lowered = line.toLowerCase();
  const at = lowered.indexOf(needle);
  if (at < 0) {
    return null;
  }
  // Lowering can change a line's length ("İ" becomes two characters), and then the offsets
  // found in the lowered line do not land in the original, which is answered as lowered instead.
  return lowered.length === line.length
    ? { text: line.slice(at, at + needle.length), at }
    : { text: needle, at: Math.min(at, line.length) };
}

/**
 * [param query] as the regular expression it was given as. The engine's own refusal named the
 * expression with flags it was never given, `/(/i: Unterminated group`, and nothing said that a
 * bracket meant as itself wants a backslash in this mode.
 */
function compiledQuery(query: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(query, caseSensitive ? '' : 'i');
  } catch (error) {
    const why = errorMessage(error).split(': ').at(-1) ?? '';
    throw new Error(
      `'${query}' is not a regular expression: ${why.charAt(0).toLowerCase()}${why.slice(1)}. With regex true, a character such as ( ) [ ] { } . * + ? | ^ $ or \\ stands for itself only after a backslash, as in \\(. Leave regex out to search for the text as written.`,
      { cause: error },
    );
  }
}

/** Whether two paths name one file or folder, by its identity on disk rather than its spelling. */
function sameEntry(one: string, other: string): boolean {
  try {
    const first = statSync(one, { bigint: true });
    const second = statSync(other, { bigint: true });
    return first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/**
 * The steps from [param projectPath] down to [param place], or null when it is not below it.
 *
 * Taken from the two paths rather than by cutting a length off the front, so a project path written
 * with a trailing separator, in the other slash or with `..` in it names the same files. Where the
 * paths disagree, the folders are compared by identity: a macOS temporary folder is reached as
 * `/var` and as `/private/var`, and its file system takes `T` and `t` for one folder.
 */
function stepsBelow(projectPath: string, place: string): string[] | null {
  const inside = relativeWithin(projectPath, place);
  if (inside !== null) {
    return inside === '' ? [] : inside.split('/');
  }
  const steps: string[] = [];
  for (let at = resolve(place); !sameEntry(at, projectPath); at = dirname(at)) {
    if (dirname(at) === at) {
      return null;
    }
    steps.unshift(basename(at));
  }
  return steps;
}

/** What one search carries from file to file. */
interface SearchRun {
  readonly options: SearchOptions;
  readonly extensions: Set<string> | null;
  readonly regex: RegExp | null;
  readonly needle: string;
  readonly result: SearchResult;
  /** How many matches are shown so far, against the limit. */
  shown: number;
  readonly notSearched: string[];
  /**
   * The extensions the walk met, for a search whose fileTypes matched none of them: answered as an
   * empty search, it read as a project where nothing held the query.
   */
  readonly met: Set<string>;
  readonly projectPath: string;
  readonly within: string;
  /** Everything the walk meets is below where it starts, so only the start is measured against the project. */
  readonly start: string[];
}

function resPathOf(run: SearchRun, place: string): string {
  return [...run.start, ...relative(run.within, place).split(sep)].filter((step) => step !== '').join('/');
}

/** The first match in [param line], found or not rather than by what it matched: a lookahead matches the empty string. */
function matchInLine(run: SearchRun, line: string): { text: string; at: number } | null {
  if (run.regex === null) {
    return plainMatch(line, run.needle, run.options.caseSensitive);
  }
  const exec = run.regex.exec(line);
  return exec === null ? null : { text: exec[0], at: exec.index };
}

/** The matches shown in [param bytes], with the summary counting every one. */
function matchesIn(run: SearchRun, bytes: Buffer): SearchMatch[] {
  const { summary } = run.result;
  const matches: SearchMatch[] = [];
  let matched = false;
  // Split on either ending, so `$` in a pattern meets the end of a line in a CRLF checkout.
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    const found = matchInLine(run, line);
    if (found === null) {
      continue;
    }
    matched = true;
    summary.total_matches += 1;
    if (run.shown >= run.options.maxResults) {
      summary.truncated = true;
      continue;
    }
    run.shown += 1;
    matches.push(shownMatch(line, found.at, found.text.length, found.text, index + 1));
  }
  if (matched) {
    summary.files_with_matches += 1;
  }
  return matches;
}

function searchFile(run: SearchRun, entryPath: string, name: string): void {
  const extension = extensionOf(name);
  if (extension !== '') {
    run.met.add(extension);
  }
  if (run.extensions !== null && !run.extensions.has(extension)) {
    return;
  }
  const bytes = bytesOf(entryPath);
  // Every text file by default, told by its content rather than a list of extensions: the list
  // left out project.godot and C#, so an autoload registered only in project.godot was answered
  // as used nowhere.
  if (bytes === null || (run.extensions === null && isBinary(bytes))) {
    return;
  }

  run.result.summary.files_searched += 1;
  const matches = matchesIn(run, bytes);
  if (matches.length > 0) {
    run.result.results.push({ file: `res://${resPathOf(run, entryPath)}`, matches });
  }
}

/**
 * Searches the folder the walk starts in, in the editor's order so that the matches a search cut at
 * its limit shows are the same on every file system. A folder left out is named, except gdharness's
 * addons, which are no part of the project.
 */
function searchDirectory(run: SearchRun, directory: string): void {
  const walk = walkProject(directory, { inside: run.projectPath });
  for (const folder of walk.folders) {
    for (const file of folder.files) {
      if (!file.twin) {
        searchFile(run, join(folder.path, file.name), file.name);
      }
    }
  }
  for (const left of walk.leftOut) {
    if (left.why !== 'gdharness') {
      run.notSearched.push(`res://${resPathOf(run, join(directory, left.folder))}/`);
    }
  }
}

/** The search for [param options] before it has met a file. */
function startSearch(projectPath: string, options: SearchOptions): SearchRun {
  const extensions =
    options.fileTypes === undefined
      ? null
      : new Set(options.fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean));
  const result: SearchResult = {
    query: options.query,
    results: [],
    summary: { files_searched: 0, files_with_matches: 0, total_matches: 0, truncated: false },
  };
  const regex = options.regex ? compiledQuery(options.query, options.caseSensitive) : null;
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  const within = options.within ?? projectPath;
  // Everything the walk meets is below where it starts, spelt as that is, so only the start is
  // measured against the project.
  const start = stepsBelow(projectPath, within) ?? relative(projectPath, within).split(sep);
  // The search goes on past the limit and only stops answering lines, so the summary and
  // not_searched describe the whole project: a search cut at one line answered total_matches 1 of
  // five, and left out the ignored folder it had not yet reached. Truncated only once a match past
  // the limit has been seen, since a search whose matches came to the limit exactly is whole.
  return {
    options,
    extensions,
    regex,
    needle,
    result,
    shown: 0,
    notSearched: [],
    met: new Set(),
    projectPath,
    within,
    start,
  };
}

/** The note on a search that searched no file, or undefined for one that did. */
function nothingSearchedNote(run: SearchRun): string | undefined {
  if (run.extensions === null || run.result.summary.files_searched > 0) {
    return undefined;
  }
  return run.met.size === 0
    ? 'No file was searched: there is no file there to search.'
    : `No file was searched: none there has the extension ${[...run.extensions].join(', ')}. The extensions there are ${[...run.met].toSorted().join(', ')}.`;
}

/** Where the query occurs in the project's text files, as res:// paths with line numbers. */
export function searchProject(projectPath: string, options: SearchOptions): SearchResult {
  if (options.query === '') {
    throw new Error(
      'The query is empty, and an empty query matches every line of every file. Give the text to find.',
    );
  }
  const run = startSearch(projectPath, options);
  const { within, result } = run;
  if (statSync(within).isDirectory()) {
    searchDirectory(run, within);
  } else {
    searchFile(run, within, basename(within));
  }
  const answered = run.notSearched.length === 0 ? result : { ...result, not_searched: run.notSearched };
  const around = options.within === undefined ? null : steppedOverAround(projectPath, within);
  const notes = [
    around === null
      ? undefined
      : `${around.folder} is searched because path names it. A search of the whole project steps over it, since ${around.why}.`,
    nothingSearchedNote(run),
  ].filter((note) => note !== undefined);
  return notes.length === 0 ? answered : { ...answered, note: notes.join(' ') };
}
