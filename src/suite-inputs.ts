/**
 * What a suite's verdict depended on, read from what its engine recorded loading, so a run asked for
 * the changed suites alone can leave out a suite that passed on exactly those inputs as they stand
 * now.
 *
 * Reading the scripts alone cannot say it: every game names `res://tests/` in `project.godot` and
 * `res://` somewhere in a test, so following every path a file names reaches the whole project from
 * every suite. The runner records instead ([GdhReached] in `listed.gd`), and a suite's inputs are
 * what its engine loaded up to the suite's end, followed only along what compiles with a script (its
 * preloads, its base, the classes it names) and what a scene or resource names. A file a script reads
 * or a folder it lists by a literal or constant path is an input too; one read or listed by a path
 * worked out at run time makes every file in the project one, since nothing records those.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { classesNamedIn } from './class-cache.js';
import { regionsOf } from './gdscript-source.js';
import type { ProjectScripts } from './suite-plan.js';

/** The input standing for every file in the project, for a suite reaching a computed file read. */
export const EVERY_FILE = 'res://';

/** A suite that passed, with what its verdict depended on and their print as they stood then. */
export interface PassedSuite {
  readonly print: string;
  readonly inputs: readonly string[];
}

const RES_LITERAL = /res:\/\/[^"'\s)\]<>]*/g;
const PRELOAD = /\bpreload\(\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*))\s*\)/g;
/**
 * A call reading a file or listing a folder by the path it is given, up to the start of that path.
 * `ResourceLoader.load` is left out: a load goes through the loaders, which record it.
 */
const FILE_READ =
  /(?:\b(?:FileAccess\.(?:open\w*|get_file_as_string|get_file_as_bytes|file_exists|get_md5|get_sha256|get_modified_time|get_size)|DirAccess\.(?:open|get_files_at|get_directories_at|dir_exists_absolute)|ResourceLoader\.list_directory|Image\.load_from_file)|(?<!\bResourceLoader)\.(?:load|load_from_file|change_dir))\(/g;
const STRING_ARGUMENT = /^(?:"([^"]*)"|'([^']*)')$/;
const CONSTANT_ARGUMENT = /^[A-Za-z_]\w*$/;
/** A file opened to be written only, which the script does not read through that call. */
const WRITE_ONLY = /^FileAccess\.WRITE$/;
/** The directory of the addon a path is in. */
const ADDON = /^res:\/\/addons\/[^/]+\//;
/** A text resource, whose dependencies are the paths it names. */
const TEXT_RESOURCE = /\.(?:tscn|tres|gdextension)$/;

interface Read {
  readonly digest: string;
  /** Read in turn, with what they name. */
  readonly follows: readonly string[];
  /** Inputs read for their own content or listing alone. */
  readonly also: readonly string[];
  /** The newest modification among what the digest covers, in milliseconds. */
  readonly modified: number;
}

/**
 * Every suite the engine's record at [param file] names, with the paths its engine had recorded by
 * the suite's end, its own and every earlier line's. No file, from an engine that never started,
 * names none.
 */
export function reachedBySuite(file: string): Map<string, string[]> {
  const bySuite = new Map<string, string[]>();
  if (!existsSync(file)) {
    return bySuite;
  }
  const sofar: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as { suite?: unknown; reached?: unknown };
    if (typeof parsed.suite !== 'string' || !Array.isArray(parsed.reached)) {
      continue;
    }
    sofar.push(...parsed.reached.filter((path): path is string => typeof path === 'string'));
    bySuite.set(parsed.suite, [...sofar]);
  }
  return bySuite;
}

/** The inputs of a project's suites and their prints, read once per run. */
export class SuiteInputs {
  private readonly reads = new Map<string, Read>();
  private readonly scripts: ProjectScripts;
  private readonly alwaysDigest: string;
  private readonly everywhere: string[];

  /**
   * [param always] is what every suite depends on besides its inputs: the gdharness version and
   * runner, the engine, the files a game names.
   */
  constructor(scripts: ProjectScripts, always: readonly string[]) {
    this.scripts = scripts;
    this.alwaysDigest = createHash('sha256').update(always.join('\n')).digest('hex');
    // The engine reads project.godot and loads its extensions before any loader is asked.
    this.everywhere = ['res://project.godot', ...extensionsOf(scripts.projectPath)];
  }

  /** The inputs of a suite whose engine recorded [param reached], in order, every path once. */
  inputsOf(reached: readonly string[]): string[] {
    const inputs = new Set<string>();
    const pending = [...reached, ...this.everywhere]
      .map(inputPath)
      .filter((path): path is string => path !== null);
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
      if (inputs.has(path)) {
        continue;
      }
      inputs.add(path);
      if (path === EVERY_FILE) {
        continue;
      }
      const read = this.read(path);
      pending.push(...read.follows, ...read.also);
    }
    return inputs.has(EVERY_FILE) ? [EVERY_FILE] : [...inputs].sort();
  }

  /** The print of [param inputs] as they stand now. */
  printOf(inputs: readonly string[]): string {
    const hash = createHash('sha256').update(this.alwaysDigest);
    for (const path of inputs) {
      hash.update(`${path}\n${this.read(path).digest}\n`);
    }
    return hash.digest('hex');
  }

  /** Whether any of [param inputs] was modified after [param since], in milliseconds. */
  modifiedAfter(inputs: readonly string[], since: number): boolean {
    return inputs.some((path) => this.read(path).modified > since);
  }

  private read(path: string): Read {
    const known = this.reads.get(path);
    if (known !== undefined) {
      return known;
    }
    const read =
      path === EVERY_FILE ? this.everyFile() : ADDON.test(path) ? this.addon(path) : this.readAnew(path);
    this.reads.set(path, read);
    return read;
  }

  /** Every file the engine sees, read whole: what a suite reading a computed path may have read. */
  private everyFile(): Read {
    const hash = createHash('sha256');
    let modified = 0;
    walkSeen(this.scripts.projectPath, (file, under, stat) => {
      hash.update(`${under}\n`).update(readFileSync(file));
      modified = Math.max(modified, stat.mtimeMs);
    });
    return { digest: hash.digest('hex'), follows: [], also: [], modified };
  }

  /**
   * An addon read whole, every file under it, rather than followed from script to script: gdUnit4
   * walks directories and loads computed paths, while an addon changes only when it is installed
   * again.
   */
  private addon(root: string): Read {
    const hash = createHash('sha256');
    let modified = 0;
    const directory = join(this.scripts.projectPath, root.slice('res://'.length));
    if (existsSync(directory)) {
      walkSeen(directory, (file, under, stat) => {
        hash.update(`${under}\n`).update(readFileSync(file));
        modified = Math.max(modified, stat.mtimeMs);
      });
    }
    return { digest: hash.digest('hex'), follows: [], also: [], modified };
  }

  private readAnew(path: string): Read {
    const file = join(this.scripts.projectPath, path.slice('res://'.length));
    if (!existsSync(file)) {
      return { digest: 'missing', follows: [], also: [], modified: 0 };
    }
    const stat = statSync(file);
    if (stat.isDirectory()) {
      const inside = readdirSync(file)
        .filter((name) => !name.startsWith('.'))
        .sort();
      return { digest: inside.join('\n'), follows: [], also: [], modified: stat.mtimeMs };
    }
    const bytes = readFileSync(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    // The import settings and uid beside a file decide what loading it gives, and a move shows there.
    const also = [`${path}.import`, `${path}.uid`].filter((beside) =>
      existsSync(join(this.scripts.projectPath, beside.slice('res://'.length))),
    );
    const follows: string[] = [];
    if (TEXT_RESOURCE.test(path)) {
      for (const [named] of bytes.toString('latin1').matchAll(RES_LITERAL)) {
        const target = join(this.scripts.projectPath, named.slice('res://'.length));
        (existsSync(target) && statSync(target).isDirectory() ? also : follows).push(named);
      }
    } else if (path.endsWith('.gd')) {
      const reaches = this.scriptReaches(path);
      if (reaches === null) {
        also.push(EVERY_FILE);
      } else {
        follows.push(...reaches.follows);
        also.push(...reaches.also);
      }
    }
    return {
      digest,
      follows: follows.map(inputPath).filter((named): named is string => named !== null && named !== path),
      also: also.map(inputPath).filter((named): named is string => named !== null),
      modified: stat.mtimeMs,
    };
  }

  /**
   * What the script at [param path] compiles with and what it reads by a path it names, or null when
   * it reads or preloads by a path worked out at run time.
   */
  private scriptReaches(path: string): { follows: string[]; also: string[] } | null {
    const source = this.scripts.sources.get(path) ?? '';
    const text = uncommented(source);
    const constants = stringConstants(text);
    const follows: string[] = [];
    const also: string[] = [];
    for (const found of text.matchAll(PRELOAD)) {
      const named = found[1] ?? found[2] ?? constants.get(found[3] ?? '');
      if (named === undefined || named.startsWith('uid://')) {
        return null;
      }
      follows.push(
        named.startsWith('res://') ? named : `res://${posix.join(posix.dirname(path.slice(6)), named)}`,
      );
    }
    for (const found of text.matchAll(FILE_READ)) {
      const [first, second] = argumentsAt(text, found.index + found[0].length);
      if (first === undefined || (found[0].startsWith('FileAccess.open') && WRITE_ONLY.test(second ?? ''))) {
        continue;
      }
      const literal = STRING_ARGUMENT.exec(first);
      const named =
        literal !== null
          ? (literal[1] ?? literal[2])
          : CONSTANT_ARGUMENT.test(first)
            ? constants.get(first)
            : undefined;
      if (named?.startsWith('user://') === true) {
        continue;
      }
      if (named === undefined || !named.startsWith('res://')) {
        return null;
      }
      also.push(named);
    }
    const base = this.scripts.base(path);
    if (base !== null && 'path' in base) {
      follows.push(base.path);
    }
    for (const name of classesNamedIn(this.scripts.script(path)?.code ?? '', this.scripts.classes)) {
      follows.push(this.scripts.classes.get(name) ?? '');
    }
    return { follows, also };
  }
}

/** A recorded path as an input: the addon it is in, or null for one outside the project's files. */
function inputPath(path: string): string | null {
  if (path === EVERY_FILE) {
    return path;
  }
  if (!path.startsWith('res://') || path.startsWith('res://.godot/') || path === '') {
    return null;
  }
  return ADDON.exec(path)?.[0] ?? path.replace(/\/+$/, '');
}

/**
 * The arguments of the call whose list opens just before [param at] in [param text], each trimmed,
 * split at the commas outside any bracket or string. None for a call given nothing.
 */
function argumentsAt(text: string, at: number): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = at;
  let quote: string | null = null;
  for (let index = at; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quote !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character) && depth > 0) {
      depth -= 1;
    } else if (character === ')' || (character === ',' && depth === 0)) {
      found.push(text.slice(start, index).trim());
      start = index + 1;
      if (character === ')') {
        break;
      }
    }
  }
  return found.length === 1 && found[0] === '' ? [] : found;
}

/** [param source] with its comments blanked and its strings kept. */
function uncommented(source: string): string {
  let text = '';
  for (const region of regionsOf(source)) {
    const part = source.slice(region.start, region.end);
    text += region.kind === 'comment' || region.kind === 'doc' ? part.replace(/[^\n]/g, ' ') : part;
  }
  return text;
}

/** The constants [param text] declares with a string literal, by name. */
function stringConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const found of text.matchAll(
    /^\s*const\s+([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?:?=\s*(?:"([^"]*)"|'([^']*)')\s*$/gm,
  )) {
    constants.set(found[1] ?? '', found[2] ?? found[3] ?? '');
  }
  return constants;
}

/**
 * Calls [param seen] with each file under [param root] that Godot's file system sees, its path from
 * the root with forward slashes, and its stat: no hidden folder, and no folder holding a `.gdignore`.
 */
function walkSeen(root: string, seen: (file: string, under: string, stat: Stats) => void): void {
  const walk = (directory: string, under: string): void => {
    if (existsSync(join(directory, '.gdignore'))) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          walk(file, `${under}${entry.name}/`);
        }
      } else if (entry.isFile()) {
        seen(file, `${under}${entry.name}`, statSync(file));
      }
    }
  };
  walk(root, '');
}

/** The extensions the engine loads into every run of [param projectPath]. */
function extensionsOf(projectPath: string): string[] {
  const list = join(projectPath, '.godot', 'extension_list.cfg');
  return existsSync(list)
    ? readFileSync(list, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('res://'))
    : [];
}
