/**
 * What can be learnt about a project by reading its directory, with no engine involved: what
 * kinds of file it holds, and where a piece of text occurs.
 */

import { type Dirent, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { errorMessage } from './errors.js';
import { bytesOf, entriesOf } from './listed-reads.js';
import { relativeWithin } from './paths.js';
import { uidCacheEntries } from './uid-cache.js';

/** Directories that are never part of a project's own files, and are not spelled with a dot. */
const SKIPPED = new Set(['node_modules']);

/** Whether this entry is one both walks here step over, so that they cannot disagree. */
function skipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED.has(name);
}

/** The extension of a file name without its dot, lower case, empty for a name with none such as `gd`. */
function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/** Written into each addon gdharness installs, so it can be told from one the project wrote. */
export const VERSION_MARKER = '.gdharness-version';

/**
 * A directory holding a `.gdignore` is stepped over, because the engine steps over it.
 *
 * A vendored engine, an export directory, somebody else's project kept for reference: what is
 * under one is not imported, so it is not this project's content and counting or searching it
 * answers about files the engine will never load. A hundred megabytes of exported binary is the
 * cheap half of getting this wrong. The expensive half is a search that finds a match in a copy
 * of the code nobody is running.
 *
 * An addon gdharness installed is stepped over too. The engine loads it, but nobody on the project
 * wrote it: a search for a word in the game answered with this tool's own comments, its thirty-odd
 * scripts were counted as the project's, and a rename would have rewritten code the next upgrade
 * replaces. Told by the marker setup writes, so a project's own addon of the same name is kept.
 */
function steppedOver(directory: string): boolean {
  return gdignored(directory) || installedByUs(directory);
}

function gdignored(directory: string): boolean {
  return existsSync(join(directory, '.gdignore'));
}

/** Whether gdharness installed the addon in [param directory], which it marks with its version. */
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

function countFilesIn(structure: ProjectStructure, directory: string): void {
  if (steppedOver(directory)) {
    return;
  }
  for (const entry of entriesOf(directory)) {
    if (skipped(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      countFilesIn(structure, join(directory, entry.name));
    } else if (entry.isFile()) {
      const kind = kindOfFile(extensionOf(entry.name));
      if (kind !== null) {
        structure[kind] += 1;
      }
    }
  }
}

export function projectStructure(projectPath: string): ProjectStructure {
  const structure: ProjectStructure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
  countFilesIn(structure, projectPath);
  return structure;
}

/** The path of [param name] under [param prefix], a folder spelled with forward slashes or empty. */
function spelledUnder(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * The project's files whose extension is one of [param extensions] (with the dot, lower case),
 * project-relative with forward slashes and sorted. The walk steps over what the engine steps over.
 */
export function projectFiles(projectPath: string, extensions: readonly string[]): string[] {
  return filesBelow(projectPath, extensions);
}

/**
 * [method projectFiles] for one folder of a project that a caller named, relative to that folder.
 * The folder is walked even when gdharness installed it, since naming it asks for it. Below it,
 * as everywhere, what the engine steps over and what gdharness installed are stepped over. A walk
 * of its own here took in gdharness's addons, so a project's diagnostics checked fifty-five of
 * them beside its three scripts while every other answer called the three the project's.
 */
export function folderFiles(directory: string, extensions: readonly string[]): string[] {
  return gdignored(directory) ? [] : filesBelow(directory, extensions);
}

/**
 * Whether [param relativePath], a project-relative path, is under a folder of the project holding a
 * `.gdignore`, which the engine never loads anything from.
 */
export function underGdignore(projectPath: string, relativePath: string): boolean {
  const folders = relativePath.split('/').slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth += 1) {
    if (gdignored(join(projectPath, ...folders.slice(0, depth)))) {
      return true;
    }
  }
  return false;
}

/** A folder [method folderFiles] steps over, and why. */
export interface SteppedOver {
  /** Relative to the folder walked, with forward slashes. Empty for that folder itself. */
  readonly folder: string;
  readonly why: 'gdignore' | 'gdharness';
}

/**
 * The topmost folders [method folderFiles] steps over in [param directory], so that a folder with
 * no script it walks can say where its scripts are. `addons` holding only gdharness's addons was
 * answered as holding no .gd script, beside the seventy-three that naming each addon found.
 */
export function steppedOverIn(directory: string): SteppedOver[] {
  if (gdignored(directory)) {
    return [{ folder: '', why: 'gdignore' }];
  }
  const found: SteppedOver[] = [];
  const visit = (at: string, prefix: string): void => {
    for (const entry of entriesOf(at)) {
      if (!entry.isDirectory() || skipped(entry.name)) {
        continue;
      }
      const spelled = spelledUnder(prefix, entry.name);
      const path = join(at, entry.name);
      const why = whySteppedOver(path);
      if (why === null) {
        visit(path, spelled);
      } else {
        found.push({ folder: spelled, why });
      }
    }
  };
  visit(directory, '');
  return found.toSorted((a, b) => a.folder.localeCompare(b.folder));
}

/** Why [method steppedOverIn] steps over [param directory], or null when it walks it. */
function whySteppedOver(directory: string): SteppedOver['why'] | null {
  if (gdignored(directory)) {
    return 'gdignore';
  }
  return installedByUs(directory) ? 'gdharness' : null;
}

/** Whether [param entry] is a file with one of [param extensions] (with the dot, lower case). */
function isWantedFile(entry: Dirent, extensions: readonly string[]): boolean {
  return entry.isFile() && extensions.includes(extname(entry.name).toLowerCase());
}

function filesBelow(root: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of entriesOf(directory)) {
      if (skipped(entry.name)) {
        continue;
      }
      const spelled = spelledUnder(prefix, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!steppedOver(path)) {
          visit(path, spelled);
        }
      } else if (isWantedFile(entry, extensions)) {
        found.push(spelled);
      }
    }
  };
  visit(root, '');
  return found.toSorted();
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
  const lacksItsUid = (directory: string, entry: Dirent): boolean =>
    entry.isFile() &&
    CARRIES_A_UID.has(extensionOf(entry.name)) &&
    !existsSync(join(directory, `${entry.name}.uid`));
  const visit = (directory: string, prefix: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of entriesOf(directory)) {
      if (skipped(entry.name)) {
        continue;
      }
      const spelled = spelledUnder(prefix, entry.name);
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), spelled);
      } else if (lacksItsUid(directory, entry)) {
        found.push(spelled);
      }
    }
  };
  visit(projectPath, '');
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
  for (const step of relative(projectPath, place)
    .split(sep)
    .filter((part) => part !== '')) {
    at = join(at, step);
    if (!statSync(at).isDirectory()) {
      break;
    }
    const why = whyAWholeSearchSkips(step, at);
    if (why !== null) {
      return { folder: `res://${relative(projectPath, at).split(sep).join('/')}/`, why };
    }
  }
  return null;
}

/** Why a whole-project search steps over the folder [param at], named [param step], or null. */
function whyAWholeSearchSkips(step: string, at: string): string | null {
  if (skipped(step)) {
    return step.startsWith('.') ? 'its name starts with a dot' : `it is ${step}`;
  }
  if (gdignored(at)) {
    return 'it holds a .gdignore';
  }
  return installedByUs(at) ? 'gdharness installed it' : null;
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

/**
 * Every text file of the project the engine would see, as the search walks them: dot directories,
 * node_modules and directories holding a `.gdignore` are stepped over, and a file is text when its
 * first eight thousand bytes hold no NUL.
 */
export function projectTexts(projectPath: string): ProjectText[] {
  const found: ProjectText[] = [];
  collectTexts(found, projectPath, '');
  return found;
}

function collectTexts(found: ProjectText[], directory: string, prefix: string): void {
  if (steppedOver(directory)) {
    return;
  }
  for (const entry of entriesOf(directory)) {
    if (skipped(entry.name)) {
      continue;
    }
    const absolute = join(directory, entry.name);
    const spelled = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      collectTexts(found, absolute, `${spelled}/`);
      continue;
    }
    const text =
      entry.isFile() && !BINARY_EXTENSIONS.has(extensionOf(entry.name)) ? textOf(absolute, spelled) : null;
    if (text !== null) {
      found.push(text);
    }
  }
}

/** The text file at [param absolute] as a project text, or null when it cannot be read or is binary. */
function textOf(absolute: string, spelled: string): ProjectText | null {
  const bytes = bytesOf(absolute);
  if (bytes === null || isBinary(bytes)) {
    return null;
  }
  return { path: `res://${spelled}`, absolute, text: bytes.toString('utf8') };
}

/**
 * The text files under the directories [projectTexts] steps over for holding a `.gdignore`: copies
 * the engine never loads, such as a mod kit's sources, which still name the project's classes and
 * are still broken by a rename. Dot directories and node_modules are stepped over here too.
 */
export function ignoredTexts(projectPath: string): ProjectText[] {
  const found: ProjectText[] = [];
  collectIgnoredTexts(found, projectPath, '', false);
  return found;
}

function collectIgnoredTexts(
  found: ProjectText[],
  directory: string,
  prefix: string,
  ignored: boolean,
): void {
  if (installedByUs(directory)) {
    return;
  }
  const under = ignored || gdignored(directory);
  for (const entry of entriesOf(directory)) {
    if (skipped(entry.name)) {
      continue;
    }
    const absolute = join(directory, entry.name);
    const spelled = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      collectIgnoredTexts(found, absolute, `${spelled}/`, under);
      continue;
    }
    const wanted =
      under &&
      entry.isFile() &&
      !BINARY_EXTENSIONS.has(extensionOf(entry.name)) &&
      entry.name !== '.gdignore';
    const text = wanted ? textOf(absolute, spelled) : null;
    if (text !== null) {
      found.push(text);
    }
  }
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

function searchDirectory(run: SearchRun, directory: string, named = false): void {
  if (!named && steppedOver(directory)) {
    if (gdignored(directory)) {
      run.notSearched.push(`res://${resPathOf(run, directory)}/`);
    }
    return;
  }
  // By name, so the matches a search cut at its limit shows are the same on every file system
  // rather than whichever the directory lists first.
  for (const entry of entriesOf(directory).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skipped(entry.name)) {
      continue;
    }
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      searchDirectory(run, entryPath);
    } else if (entry.isFile()) {
      searchFile(run, entryPath, entry.name);
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
    searchDirectory(run, within, true);
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
