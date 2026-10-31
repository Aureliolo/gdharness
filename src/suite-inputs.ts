/**
 * What a suite's verdict depended on, read from what its engine recorded loading, so a run asked for
 * the changed suites alone can leave out a suite that passed on exactly those inputs as they stand
 * now.
 *
 * Reading the scripts alone cannot say it: every game names `res://tests/` in `project.godot` and
 * `res://` somewhere in a test, so following every path a file names reaches the whole project from
 * every suite. The runner records instead ([GdhReached] in `listed.gd`), and a suite's inputs are
 * its own script, the autoloads and what it loaded, followed only along what compiles with a script
 * (its preloads, its base, the classes it names), what it loads by a path it names, and what a scene
 * or resource names; and what the cache held as it began, for a suite reaching a load by a computed
 * path, held to where that path is known to begin. A file a script reads
 * or a folder it lists by a literal or constant path is an input too; one read or listed by a path
 * worked out at run time makes every file in the project one, since nothing records those.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { classesNamedIn } from './class-cache.js';
import { regionsOf } from './gdscript-source.js';
import { isRecord } from './records.js';
import type { ProjectScripts } from './suite-plan.js';

/** The input standing for every file in the project, for a suite reaching a computed file read. */
export const EVERY_FILE = 'res://';

/**
 * The mark of a load by a path worked out at run time, which the cache can answer without a loader
 * being asked, so nothing records it: a suite reaching one depends on what the cache held as it
 * began. Followed by the start the path is known to have (`"res://sound/" + take`), or by nothing
 * when it could be anywhere. Never a path, so it is never read and never an input itself.
 */
const CACHE_HELD = 'cache:';

/**
 * The mark before a folder read whole, every file under it: what a script reading a path joined onto
 * that folder at run time may have read.
 */
const TREE = 'tree:';

/** A suite that passed, with what its verdict depended on and their print as they stood then. */
export interface PassedSuite {
  readonly print: string;
  readonly inputs: readonly string[];
}

const RES_LITERAL = /res:\/\/[^"'\s)\]<>]*/g;
const PRELOAD = /\bpreload\(\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*))\s*\)/g;
/**
 * A call reading a file or listing a folder by the path it is given, up to the start of that path.
 * `ResourceLoader.load` is left out: see [constant RESOURCE_LOAD].
 */
const FILE_READ =
  /(?:\b(?:FileAccess\.(?:open\w*|get_file_as_string|get_file_as_bytes|file_exists|get_md5|get_sha256|get_modified_time|get_size)|DirAccess\.(?:open|get_files_at|get_directories_at|dir_exists_absolute)|ResourceLoader\.(?:list_directory|exists)|Image\.load_from_file)|(?<!\bResourceLoader)\.(?:load|load_from_file|change_dir))\(/g;
/**
 * A load through the resource loaders, up to the start of its path. One the cache answers asks no
 * loader, so the recorder misses it whenever another suite of the engine already holds the resource:
 * gdUnit4 loads every suite of an engine before the first runs, with all they preload. One by a path
 * the script names is followed like a preload; one by a computed path is [constant CACHE_HELD].
 */
const RESOURCE_LOAD = /(?:\bResourceLoader\.load(?:_threaded_request)?|(?<![\w.])(?<!\bfunc\s+)load)\(/g;
const STRING_ARGUMENT = /^(?:"([^"]*)"|'([^']*)')$/;
const CONSTANT_ARGUMENT = /^[A-Za-z_]\w*$/;
const CLASS_CONSTANT = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
/**
 * A path joined at run time, up to what joins its first part on: `+`, `%`, or a `path_join` call,
 * which puts a slash between.
 */
const JOINED_ARGUMENT =
  /^(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))\s*(?:([+%])|\.path_join\()/;
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

/** What an engine recorded for one suite. */
export interface SuiteReached {
  /** Loaded before the engine's first suite was handed to the runner: the autoloads and theirs. */
  readonly autoloads: readonly string[];
  /** Asked for while the suite ran, and compiled then without a loader being asked. */
  readonly during: readonly string[];
  /**
   * The project's files the cache held as the suite began, which a load could have had unasked, but
   * for the engine's other suites: gdUnit4 loads them all first, and no game loads a suite.
   */
  readonly resident: readonly string[];
}

/**
 * Every suite the engine's record at [param file] names that ended, with what was recorded for it.
 * No file, from an engine that never started, names none.
 */
export function reachedBySuite(file: string): Map<string, SuiteReached> {
  const bySuite = new Map<string, SuiteReached>();
  if (!existsSync(file)) {
    return bySuite;
  }
  const paths = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
  let autoloads: string[] = [];
  const resident = new Map<string, string[]>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    const recorded: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const { began, suite } = recorded;
    if (recorded['autoloads'] === true) {
      autoloads = paths(recorded['reached']);
    } else if (typeof began === 'string') {
      resident.set(began, paths(recorded['resident']));
    } else if (typeof suite === 'string') {
      // A suite whose beginning went unrecorded has no resident set to judge it by, so it has none.
      const held = resident.get(suite);
      if (held !== undefined) {
        bySuite.set(suite, { autoloads, during: paths(recorded['reached']), resident: held });
      }
    }
  }
  for (const [suite, reached] of bySuite) {
    bySuite.set(suite, { ...reached, resident: reached.resident.filter((path) => !resident.has(path)) });
  }
  return bySuite;
}

/** The inputs of a project's suites and their prints, read once per run. */
export class SuiteInputs {
  private readonly reads = new Map<string, Read>();
  private readonly constants = new Map<string, Map<string, string>>();
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

  /**
   * The inputs of the suite at [param suite], from what its engine recorded for it: its own script,
   * the autoloads and what it loaded as it ran, all followed, and what the cache held as it began
   * only when those reach a load by a computed path, the one load the cache can answer that nothing
   * names, and of that only what lies where the path is known to begin. Held to that, since the
   * cache holds every other suite of the engine and all they preload, and a suite given it all
   * depended on nearly every file. What an earlier suite loaded and let go is not among them: the
   * cache had let it go too, so loading it again asked a loader.
   */
  inputsOfSuite(suite: string, reached: SuiteReached): string[] {
    const inputs = this.reach([suite, ...reached.autoloads, ...reached.during]);
    // What the cache held can itself reach a computed load, so add it until nothing more is held.
    for (let under: string[] = []; ; ) {
      const held = [...inputs]
        .filter((path) => path.startsWith(CACHE_HELD))
        .map((path) => path.slice(CACHE_HELD.length));
      const next = reached.resident.filter((path) => held.some((start) => path.startsWith(start)));
      if (next.length === under.length) {
        break;
      }
      under = next;
      for (const path of this.reach(under)) {
        inputs.add(path);
      }
    }
    return listed(inputs);
  }

  /** The inputs followed from [param reached], in order, every path once. */
  inputsOf(reached: readonly string[]): string[] {
    return listed(this.reach(reached));
  }

  private reach(reached: readonly string[]): Set<string> {
    const inputs = new Set<string>();
    const pending = [...reached, ...this.everywhere]
      .map(inputPath)
      .filter((path): path is string => path !== null);
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
      if (inputs.has(path)) {
        continue;
      }
      inputs.add(path);
      if (path === EVERY_FILE || path.startsWith(CACHE_HELD)) {
        continue;
      }
      const read = this.read(path);
      pending.push(...read.follows, ...read.also);
    }
    return inputs;
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
      path === EVERY_FILE
        ? this.everyFile()
        : path.startsWith(TREE)
          ? this.tree(path.slice(TREE.length))
          : ADDON.test(path)
            ? this.tree(path)
            : this.readAnew(path);
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
   * The folder at [param root] read whole, every file under it. An addon is read so rather than
   * followed from script to script: gdUnit4 walks directories and loads computed paths, while an
   * addon changes only when it is installed again.
   */
  private tree(root: string): Read {
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
        .toSorted();
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
    const constants = this.constantsOf(path);
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
      const named = literal !== null ? (literal[1] ?? literal[2]) : this.constantNamed(first, path);
      const start = named ?? this.knownStart(first, path);
      if (start.startsWith('user://')) {
        continue;
      }
      if (named?.startsWith('res://') === true) {
        also.push(named);
        continue;
      }
      // A path joined onto a folder the script names reads somewhere under that folder.
      const folder = start.slice(0, start.lastIndexOf('/') + 1);
      if (named !== undefined || !folder.startsWith('res://') || folder === 'res://') {
        return null;
      }
      also.push(`${TREE}${folder}`);
    }
    for (const found of text.matchAll(RESOURCE_LOAD)) {
      const [first = ''] = argumentsAt(text, found.index + found[0].length);
      const literal = STRING_ARGUMENT.exec(first);
      const named = literal !== null ? (literal[1] ?? literal[2]) : this.constantNamed(first, path);
      // A load the cache can answer, by a path that names nothing here, is recorded only when asked.
      if (named === undefined || named.startsWith('uid://')) {
        const start = this.knownStart(first, path);
        also.push(`${CACHE_HELD}${start.startsWith('res://') ? start : ''}`);
      } else {
        follows.push(
          named.startsWith('res://') ? named : `res://${posix.join(posix.dirname(path.slice(6)), named)}`,
        );
      }
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

  /**
   * The string the constant [param name] holds in the script at [param path]: its own, one it
   * inherits, or a global class's when qualified with the class.
   */
  private constantNamed(name: string, path: string): string | undefined {
    const qualified = CLASS_CONSTANT.exec(name);
    if (qualified !== null) {
      const declaring = this.scripts.classes.get(qualified[1] ?? '');
      return declaring === undefined ? undefined : this.constantsOf(declaring).get(qualified[2] ?? '');
    }
    return CONSTANT_ARGUMENT.test(name) ? this.constantsOf(path).get(name) : undefined;
  }

  /** The string constants the script at [param path] declares or inherits, the nearest winning. */
  private constantsOf(path: string): ReadonlyMap<string, string> {
    const known = this.constants.get(path);
    if (known !== undefined) {
      return known;
    }
    const constants = new Map<string, string>();
    // Set before the base is read, so a chain that loops ends here.
    this.constants.set(path, constants);
    const base = this.scripts.base(path);
    if (base !== null && 'path' in base) {
      for (const [name, value] of this.constantsOf(base.path)) {
        constants.set(name, value);
      }
    }
    for (const [name, expression] of constantsDeclared(uncommented(this.scripts.sources.get(path) ?? ''))) {
      const value = joinedString(expression, (part) =>
        part.includes('.') ? this.constantNamed(part, path) : constants.get(part),
      );
      if (value === undefined) {
        constants.delete(name);
      } else {
        constants.set(name, value);
      }
    }
    return constants;
  }

  /**
   * How the path [param argument] the script at [param path] joins at run time is known to begin, or
   * nothing.
   */
  private knownStart(argument: string, path: string): string {
    const joined = JOINED_ARGUMENT.exec(argument);
    if (joined === null) {
      return '';
    }
    const first = joined[1] ?? joined[2] ?? this.constantNamed(joined[3] ?? '', path) ?? '';
    if (joined[4] === '%') {
      return first.split('%')[0] ?? '';
    }
    return joined[4] === undefined && !first.endsWith('/') && first !== '' ? `${first}/` : first;
  }
}

/** [param inputs] in order, or every file alone when they reach it, without the cache's mark. */
function listed(inputs: ReadonlySet<string>): string[] {
  return inputs.has(EVERY_FILE)
    ? [EVERY_FILE]
    : [...inputs].filter((path) => !path.startsWith(CACHE_HELD)).toSorted();
}

/** A recorded path as an input: the addon it is in, or null for one outside the project's files. */
function inputPath(path: string): string | null {
  if (path === EVERY_FILE || path.startsWith(CACHE_HELD) || path.startsWith(TREE)) {
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

/** The constants [param text] declares on one line, by name, each with what it is set to. */
function constantsDeclared(text: string): [string, string][] {
  return [...text.matchAll(/^\s*const\s+([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?:?=\s*(.+?)\s*$/gm)].map((found) => [
    found[1] ?? '',
    found[2] ?? '',
  ]);
}

/**
 * The string [param expression] makes of string literals and constants joined with `+`, each constant
 * given by [param named], or undefined for any other expression.
 */
function joinedString(expression: string, named: (name: string) => string | undefined): string | undefined {
  const part = /\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))\s*(\+|$)/y;
  let value = '';
  for (let found = part.exec(expression); found !== null; found = part.exec(expression)) {
    const piece = found[1] ?? found[2] ?? named(found[3] ?? '');
    if (piece === undefined) {
      return undefined;
    }
    value += piece;
    if (found[4] === '') {
      return value;
    }
  }
  return undefined;
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
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
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
