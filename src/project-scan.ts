/**
 * What can be learnt about a project by reading its directory, with no engine involved: what
 * kinds of file it holds, and where a piece of text occurs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { errorMessage } from './errors.js';

/** Directories that are never part of a project's own files, and are not spelled with a dot. */
const SKIPPED = new Set(['node_modules']);

/** Whether this entry is one both walks here step over, so that they cannot disagree. */
function skipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED.has(name);
}

/** Written into each addon gdharness installs, so it can be told from one the project wrote. */
export const VERSION_MARKER = '.gdharness-version';

/**
 * A directory holding a `.gdignore` is stepped over, because the engine steps over it.
 *
 * A vendored engine, an export directory, somebody else's project kept for reference: what is
 * under one is not imported, so it is not this project's content and counting or searching it
 * answers about files the engine will never load. A hundred megabytes of exported binary is the
 * cheap half of getting this wrong; the expensive half is a search that finds a match in a copy
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

function installedByUs(directory: string): boolean {
  return existsSync(join(directory, VERSION_MARKER));
}

/** File counts for a project, by kind. */
export interface ProjectStructure {
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
  'shader',
]);

export function projectStructure(projectPath: string): ProjectStructure {
  const structure: ProjectStructure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
  const visit = (directory: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (SIDECAR_EXTENSIONS.has(extension)) {
          continue;
        }
        if (SCENE_EXTENSIONS.has(extension)) {
          structure.scenes += 1;
        } else if (extension === 'gd' || extension === 'cs') {
          structure.scripts += 1;
        } else if (ASSET_EXTENSIONS.has(extension)) {
          structure.assets += 1;
        } else {
          structure.other += 1;
        }
      }
    }
  };
  visit(projectPath);
  return structure;
}

/**
 * The project's files whose extension is one of [param extensions] (with the dot, lower case),
 * project-relative with forward slashes and sorted, stepping over what the engine steps over.
 */
export function projectFiles(projectPath: string, extensions: readonly string[]): string[] {
  return filesBelow(projectPath, extensions);
}

/**
 * [method projectFiles] for one folder of a project that a caller named, relative to that folder.
 * The folder is walked even when gdharness installed it, since naming it asks for it; below it,
 * as everywhere, what the engine steps over and what gdharness installed are stepped over. A walk
 * of its own here took in gdharness's addons, so a project's diagnostics checked fifty-five of
 * them beside its three scripts while every other answer called the three the project's.
 */
export function folderFiles(directory: string, extensions: readonly string[]): string[] {
  return gdignored(directory) ? [] : filesBelow(directory, extensions);
}

function filesBelow(root: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      const spelled = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!steppedOver(path)) {
          visit(path, spelled);
        }
      } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
        found.push(spelled);
      }
    }
  };
  visit(root, '');
  return found.sort();
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
  const visit = (directory: string, prefix: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      const spelled = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), spelled);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (CARRIES_A_UID.has(extension) && !existsSync(join(directory, `${entry.name}.uid`))) {
        found.push(spelled);
      }
    }
  };
  visit(projectPath, '');
  return found.sort();
}

/**
 * The res:// paths the project's uid cache holds a uid for, or null when it has no cache it can read.
 *
 * The engine writes `.godot/uid_cache.bin` as a count and then, for each entry, the id, the length
 * of the path and the path, little-endian; files gaining a uid later are appended and the count
 * rewritten, so a later entry for an id replaces an earlier one, as the engine's own load takes it.
 * A headless write looks a path's uid up here, which nothing in the project's own files shows.
 */
export function pathsInUidCache(projectPath: string): Set<string> | null {
  let data: Buffer;
  try {
    data = readFileSync(join(projectPath, '.godot', 'uid_cache.bin'));
  } catch {
    return null;
  }
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
  return new Set(paths.values());
}

export interface SearchOptions {
  readonly query: string;
  /** Extensions to search, or undefined for every text file. */
  readonly fileTypes?: readonly string[];
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
}

interface SearchMatch {
  readonly line: number;
  readonly content: string;
  readonly match: string;
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
  const visit = (directory: string, prefix: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const spelled = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        visit(absolute, `${spelled}/`);
        continue;
      }
      const extension = entry.name.includes('.') ? (entry.name.split('.').pop()?.toLowerCase() ?? '') : '';
      if (!entry.isFile() || BINARY_EXTENSIONS.has(extension)) {
        continue;
      }
      const bytes = readFileSync(absolute);
      if (!isBinary(bytes)) {
        found.push({ path: `res://${spelled}`, absolute, text: bytes.toString('utf8') });
      }
    }
  };
  visit(projectPath, '');
  return found;
}

/**
 * The text files under the directories [projectTexts] steps over for holding a `.gdignore`: copies
 * the engine never loads, such as a mod kit's sources, which still name the project's classes and
 * are still broken by a rename. Dot directories and node_modules are stepped over here too.
 */
export function ignoredTexts(projectPath: string): ProjectText[] {
  const found: ProjectText[] = [];
  const visit = (directory: string, prefix: string, ignored: boolean): void => {
    if (installedByUs(directory)) {
      return;
    }
    const under = ignored || gdignored(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const spelled = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        visit(absolute, `${spelled}/`, under);
        continue;
      }
      const extension = entry.name.includes('.') ? (entry.name.split('.').pop()?.toLowerCase() ?? '') : '';
      if (!under || !entry.isFile() || BINARY_EXTENSIONS.has(extension) || entry.name === '.gdignore') {
        continue;
      }
      const bytes = readFileSync(absolute);
      if (!isBinary(bytes)) {
        found.push({ path: `res://${spelled}`, absolute, text: bytes.toString('utf8') });
      }
    }
  };
  visit(projectPath, '', false);
  return found;
}

/**
 * The first place [param needle] (lowered unless [param caseSensitive]) occurs in [param line], as
 * the line spells it, or null. The text found rather than the query: a search for "Item" answered
 * `match: "Item"` on a line holding only `item.gd`.
 */
function plainMatch(line: string, needle: string, caseSensitive: boolean): [string] | null {
  if (caseSensitive) {
    return line.includes(needle) ? [needle] : null;
  }
  const lowered = line.toLowerCase();
  const at = lowered.indexOf(needle);
  if (at < 0) {
    return null;
  }
  // Lowering can change a line's length ("İ" becomes two characters), and then the offsets
  // found in the lowered line do not land in the original, which is answered as lowered instead.
  return [lowered.length === line.length ? line.slice(at, at + needle.length) : needle];
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
      `'${query}' is not a regular expression: ${why.charAt(0).toLowerCase()}${why.slice(1)}. With regex true, a character such as ( ) [ ] { } . * + ? | ^ $ or \\ stands for itself only after a backslash, as in \\(; or leave regex out to search for the text as written.`,
    );
  }
}

/** Where the query occurs in the project's text files, as res:// paths with line numbers. */
export function searchProject(projectPath: string, options: SearchOptions): SearchResult {
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
  // Truncated only once a match past the limit has been seen: a search whose matches came to the
  // limit exactly was called cut, and raising the limit gave the same list.
  const full = (): boolean => result.summary.truncated;
  const notSearched: string[] = [];

  const visit = (directory: string): void => {
    if (steppedOver(directory)) {
      if (gdignored(directory)) {
        notSearched.push(`res://${directory.slice(projectPath.length + 1).replace(/\\/g, '/')}/`);
      }
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (full()) {
        return;
      }
      if (skipped(entry.name)) {
        continue;
      }
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      const extension = entry.name.includes('.') ? (entry.name.split('.').pop()?.toLowerCase() ?? '') : '';
      if (!entry.isFile() || (extensions !== null && !extensions.has(extension))) {
        continue;
      }
      const bytes = readFileSync(entryPath);
      // Every text file by default, told by its content rather than a list of extensions: the list
      // left out project.godot and C#, so an autoload registered only in project.godot was answered
      // as used nowhere.
      if (extensions === null && isBinary(bytes)) {
        continue;
      }

      result.summary.files_searched += 1;
      const matches: SearchMatch[] = [];
      // Split on either ending, so `$` in a pattern meets the end of a line in a CRLF checkout.
      for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
        // Found or not, rather than by what it matched: a lookahead matches the empty string.
        const found = regex ? regex.exec(line) : plainMatch(line, needle, options.caseSensitive);
        if (found === null) {
          continue;
        }
        if (result.summary.total_matches >= options.maxResults) {
          result.summary.truncated = true;
          break;
        }
        matches.push({ line: index + 1, content: line.trim(), match: found[0] });
        result.summary.total_matches += 1;
      }
      if (matches.length > 0) {
        const relativePath = entryPath.slice(projectPath.length + 1).replace(/\\/g, '/');
        result.results.push({ file: `res://${relativePath}`, matches });
        result.summary.files_with_matches += 1;
      }
    }
  };
  visit(projectPath);
  return notSearched.length === 0 ? result : { ...result, not_searched: notSearched };
}
