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
 * or resource names. The inputs also include what the cache held as it began, for a suite reaching a
 * load by a computed path, held to where that path is known to begin. A file a script reads or a
 * folder it lists by a literal or constant path is an input too. One read or listed by a path worked
 * out at run time makes every file in the project one, since nothing records those.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { classesNamedIn } from './class-cache.js';
import { regionsOf } from './gdscript-source.js';
import { isLibraryCopy } from './library-copies.js';
import { bytesOf, contentOf, entriesOf, statOf } from './listed-reads.js';
import { projectFiles } from './project-scan.js';
import { isRecord } from './records.js';
import { parseProjectGodot } from './resources.js';
import { autoloadPaths } from './setup.js';
import type { ProjectScripts } from './suite-plan.js';

/** The input standing for every file in the project, for a suite reaching a computed file read. */
export const EVERY_FILE = 'res://';

/**
 * The input standing for the name of every file and folder in the project, for a suite reaching a
 * check for a file or a listing by a computed path, which reads no file's content.
 */
export const EVERY_NAME = 'names:';

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

/** A path a text resource names: in quotes, where it may hold a space, or bare up to a delimiter. */
const RES_LITERAL = /"(res:\/\/[^"\r\n]*)"|'(res:\/\/[^'\r\n]*)'|(res:\/\/[^"'\s)\]<>]*)/g;
/** A path in a binary resource, which is stored as plain text between bytes that are not part of it. */
const BINARY_RES_LITERAL = /res:\/\/[\w./-]+/g;
const PRELOAD = /\bpreload\(/g;
/**
 * A call reading a file or listing a folder by the path it is given, up to the start of that path.
 * `ResourceLoader.load` is left out: see [constant RESOURCE_LOAD].
 */
const FILE_READ =
  /(?:\b(?:FileAccess\.(?:open\w*|get_file_as_string|get_file_as_bytes|file_exists|get_md5|get_sha256|get_modified_time|get_size)|DirAccess\.(?:open|get_files_at|get_directories_at|dir_exists_absolute)|ResourceLoader\.(?:list_directory|exists)|Image\.load_from_file)|(?<!\bResourceLoader)\.(?:load|load_from_file|change_dir|open|load_dynamic_font|append_from_file))\(/g;
/** A call of [constant FILE_READ] whose answer depends on which files and folders exist alone. */
const NAMES_READ =
  /^(?:FileAccess\.file_exists|DirAccess\.(?:open|get_files_at|get_directories_at|dir_exists_absolute)|ResourceLoader\.(?:list_directory|exists)|\.change_dir)\($/;
/**
 * A load through the resource loaders, up to the start of its path. One the cache answers asks no
 * loader, so the recorder misses it whenever another suite of the engine already holds the resource:
 * gdUnit4 loads every suite of an engine before the first runs, with all they preload. One by a path
 * the script names is followed like a preload. One by a computed path is [constant CACHE_HELD].
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
const TEXT_RESOURCE = /\.(?:tscn|tres|gdextension|gdshader|gdshaderinc|import|res|scn)$/;
const BINARY_RESOURCE = /\.(?:res|scn)$/;
/** The settings that replace the project's own, read beside it before anything loads. */
const OVERRIDE_CFG = 'res://override.cfg';
/** The list of extensions the engine loads at start, which sits in the hidden folder inputs skip. */
const EXTENSION_LIST = 'res://.godot/extension_list.cfg';

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
 * One line of an engine's record, or nothing for a line that does not parse. An engine ended part
 * way through writing, as a run ends one whose autoload did not start, leaves its last line torn.
 */
function recordOf(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
    const recorded = recordOf(line);
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
  private readonly texts = new Map<string, string>();
  private readonly codes = new Map<string, string>();
  private readonly passed = new Map<string, Held[] | null>();
  private readonly lines = new Map<string, ReadonlySet<string>>();
  private readonly unfollowed = new Map<string, Unfollowed>();
  private autoloadPaths: ReadonlyMap<string, string> | null = null;
  private scenes: readonly string[] | null = null;
  private lowered: ReadonlyMap<string, string> | null = null;
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
    this.everywhere = [
      'res://project.godot',
      OVERRIDE_CFG,
      EXTENSION_LIST,
      ...extensionsOf(scripts.projectPath),
    ];
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
      if (path === EVERY_FILE || path === EVERY_NAME || path.startsWith(CACHE_HELD)) {
        continue;
      }
      const read = this.read(path);
      pending.push(...read.follows, ...read.also);
    }
    return inputs;
  }

  /**
   * Each script a suite of [param suites] reaches from itself and the autoloads whose reads make it
   * depend on every file: its first read by a path that could be anything, and how many suites reach
   * it. Most reached first.
   */
  wholeTreeReads(suites: readonly string[]): WholeTreeRead[] {
    const roots = [...this.autoloads().values()];
    const reached = new Map<string, number>();
    for (const suite of suites) {
      for (const path of this.reach([suite, ...roots])) {
        if (this.unfollowed.has(path)) {
          reached.set(path, (reached.get(path) ?? 0) + 1);
        }
      }
    }
    return [...reached]
      .map(([path, count]) => ({
        path,
        suites: count,
        ...(this.unfollowed.get(path) ?? { line: 0, argument: '' }),
      }))
      .toSorted((one, other) => other.suites - one.suites || one.path.localeCompare(other.path));
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
        : path === EVERY_NAME
          ? this.everyName()
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
    walkSeen(this.scripts.projectPath, (under, bytes, at) => {
      hash.update(`${under}\n`).update(bytes);
      modified = Math.max(modified, at);
    });
    return { digest: hash.digest('hex'), follows: [], also: [], modified };
  }

  /**
   * The name of every file and folder the engine sees, as a check or listing by a computed path read
   * them. A folder's time moves when an entry in it comes, goes or is renamed.
   */
  private everyName(): Read {
    const hash = createHash('sha256');
    let modified = statOf(this.scripts.projectPath)?.mtimeMs ?? 0;
    namesSeen(this.scripts.projectPath, (under, file, folder) => {
      hash.update(`${under}\n`);
      if (folder) {
        modified = Math.max(modified, statOf(file)?.mtimeMs ?? 0);
      }
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
      walkSeen(directory, (under, bytes, at) => {
        hash.update(`${under}\n`).update(bytes);
        modified = Math.max(modified, at);
      });
    }
    return { digest: hash.digest('hex'), follows: [], also: [], modified };
  }

  private readAnew(path: string): Read {
    const file = join(this.scripts.projectPath, path.slice('res://'.length));
    const missing: Read = { digest: 'missing', follows: [], also: [], modified: 0 };
    const stat = statOf(file);
    if (stat === undefined) {
      return missing;
    }
    if (stat.isDirectory()) {
      const inside = entriesOf(file)
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.'))
        .toSorted();
      return { digest: inside.join('\n'), follows: [], also: [], modified: stat.mtimeMs };
    }
    const bytes = bytesOf(file);
    if (bytes === null) {
      return missing;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    // The import settings and uid beside a file decide what loading it gives, and a move shows there.
    const also = [`${path}.import`, `${path}.uid`].filter((beside) =>
      existsSync(join(this.scripts.projectPath, beside.slice('res://'.length))),
    );
    const follows: string[] = [];
    if (TEXT_RESOURCE.test(path)) {
      const binary = BINARY_RESOURCE.test(path);
      for (const found of bytes.toString('latin1').matchAll(binary ? BINARY_RES_LITERAL : RES_LITERAL)) {
        const named = found[1] ?? found[2] ?? found[3] ?? found[0];
        const target = join(this.scripts.projectPath, named.slice('res://'.length));
        (statOf(target)?.isDirectory() === true ? also : follows).push(named);
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
  private scriptReaches(asked: string): { follows: string[]; also: string[] } | null {
    const path = this.spelledAsRead(asked);
    const text = this.textOf(path);
    const follows: string[] = [];
    const also: string[] = [];
    for (const found of text.matchAll(PRELOAD)) {
      const [argument = ''] = argumentsAt(text, found.index + found[0].length);
      const literal = STRING_ARGUMENT.exec(argument);
      const named = literal !== null ? (literal[1] ?? literal[2]) : this.constantExpression(argument, path);
      if (named === undefined || named.startsWith('uid://')) {
        this.unfollowed.set(path, {
          line: lineAt(text, found.index),
          argument: `${found[0]}${argument})`,
        });
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
      const read = readUnder(this.heldPaths(first, path, found.index, 0));
      if (read === null) {
        if (!NAMES_READ.test(found[0])) {
          this.unfollowed.set(path, { line: lineAt(text, found.index), argument: first });
          return null;
        }
        also.push(EVERY_NAME);
        continue;
      }
      also.push(...read);
    }
    for (const found of text.matchAll(RESOURCE_LOAD)) {
      const [first = ''] = argumentsAt(text, found.index + found[0].length);
      const literal = STRING_ARGUMENT.exec(first);
      const named = literal !== null ? (literal[1] ?? literal[2]) : this.constantNamed(first, path);
      // A load the cache can answer, by a path that names nothing here, is recorded only when asked.
      if (named === undefined || named.startsWith('uid://')) {
        const start = sharedStart(this.heldPaths(first, path, found.index, 0) ?? []);
        also.push(`${CACHE_HELD}${start.startsWith('res://') ? start : ''}`);
      } else {
        follows.push(
          named.startsWith('res://') ? named : `res://${posix.join(posix.dirname(path.slice(6)), named)}`,
        );
      }
    }
    // The script's own base and the base of each class inside it, resolved as a suite is.
    const pending = [this.scripts.script(path)?.body];
    for (let body = pending.pop(); body !== undefined; body = pending.pop()) {
      const base = this.scripts.baseOf(path, body.extendsAs);
      if (base !== null && 'path' in base) {
        follows.push(base.path);
      }
      pending.push(...body.inner);
    }
    const code = this.scripts.script(path)?.code ?? '';
    for (const name of classesNamedIn(code, this.scripts.classes)) {
      follows.push(this.scripts.classes.get(name) ?? '');
    }
    // `classesNamedIn` reads names that begin with a capital, and a class may be declared in lower case.
    for (const [name, declaring] of this.scripts.classes) {
      if (!/^[A-Z]/.test(name) && new RegExp(`\\b${name}\\b`).test(code)) {
        follows.push(declaring);
      }
    }
    return { follows, also };
  }

  /**
   * [param path] as the project's scripts spell it. A file system that ignores letter case opens a
   * script by any spelling, while the scripts are kept by the one on disk.
   */
  private spelledAsRead(path: string): string {
    if (this.scripts.sources.has(path)) {
      return path;
    }
    this.lowered ??= new Map([...this.scripts.sources.keys()].map((key) => [key.toLowerCase(), key]));
    return this.lowered.get(path.toLowerCase()) ?? path;
  }

  /** The string a constant, a class's constant or a sum of those and literals makes, or undefined. */
  private constantExpression(expression: string, path: string): string | undefined {
    return joinedString(expression, (part) => this.constantNamed(part, path));
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
   * What the path [param argument], written at [param at] in the script at [param path], can hold
   * as it runs: each way it is known whole or known to begin, or null when it could be anything. A
   * name not a constant is followed to the local set once that holds it, or to what every call that
   * can reach its function passes for the parameter it is, through any number of functions.
   */
  private heldPaths(argument: string, path: string, at: number, depth: number): Held[] | null {
    const literal = STRING_ARGUMENT.exec(argument);
    const constant = literal === null ? this.constantNamed(argument, path) : (literal[1] ?? literal[2]);
    if (constant !== undefined) {
      return [{ text: constant, whole: true }];
    }
    if (CONSTANT_ARGUMENT.test(argument)) {
      return depth < HELD_DEPTH ? this.heldIn(argument, path, at, depth + 1) : null;
    }
    // The same file, named as the system names it.
    const globalized = GLOBALIZED.exec(argument);
    if (globalized !== null) {
      const [inner] = argumentsAt(argument, globalized[0].length);
      const whole = inner !== undefined && argument === `${globalized[0]}${inner})`;
      return whole ? this.heldPaths(inner, path, at, depth) : null;
    }
    const joined = JOINED_ARGUMENT.exec(argument);
    if (joined === null) {
      return null;
    }
    const firsts =
      joined[3] === undefined
        ? [{ text: joined[1] ?? joined[2] ?? '', whole: true }]
        : this.heldPaths(joined[3], path, at, depth);
    if (firsts === null) {
      return null;
    }
    const formatted =
      joined[4] === '%' ? this.formattedFirst(argument.slice(joined[0].length), path, at, depth) : null;
    return firsts.flatMap((first): Held[] => {
      if (joined[4] === '%') {
        // A format whose first part is put in begins as that part does.
        if (first.whole && first.text.startsWith('%s') && formatted !== null) {
          const after = first.text.slice(2).split('%')[0] ?? '';
          return formatted.map((part) => ({
            text: part.whole ? part.text + after : part.text,
            whole: false,
          }));
        }
        return [{ text: first.text.split('%')[0] ?? '', whole: false }];
      }
      const joinedOn =
        joined[4] === undefined && first.whole && first.text !== '' && !first.text.endsWith('/');
      return [{ text: joinedOn ? `${first.text}/` : first.text, whole: false }];
    });
  }

  /** What the first value put into a format can hold, from what follows its `%`, or null. */
  private formattedFirst(values: string, path: string, at: number, depth: number): Held[] | null {
    const given = values.trim();
    const [first] = given.startsWith('[')
      ? argumentsAt(`${given.slice(1, given.lastIndexOf(']'))})`, 0)
      : [given];
    return first === undefined ? null : this.heldPaths(first, path, at, depth);
  }

  /**
   * What the name [param name], read at [param at] in the script at [param path], holds: a local of
   * the function around it, declared once and never set again, or a parameter of that function.
   */
  private heldIn(name: string, path: string, at: number, depth: number): Held[] | null {
    const text = this.textOf(path);
    let declared: RegExpExecArray | undefined;
    for (const found of text.matchAll(FUNCTION_DECLARED)) {
      if (found.index > at) {
        break;
      }
      declared = found;
    }
    if (declared === undefined) {
      return null;
    }
    const indent = declared[1]?.length ?? 0;
    const after = new RegExp(`\\n[ \\t]{0,${String(indent)}}(?=\\S)`, 'g');
    after.lastIndex = at;
    const body = text.slice(declared.index, after.exec(text)?.index ?? text.length);
    const parameters = argumentsAt(text, declared.index + declared[0].length);
    const index = parameters.findIndex((parameter) => /^\w+/.exec(parameter)?.[0] === name);
    // A lambda taking the name, or another `var` of it such as a match binding, may be what is read.
    const lambdas = [...body.slice(declared[0].length).matchAll(/\bfunc\b[ \t]*\w*[ \t]*\(/g)];
    const shadowed =
      lambdas.some((lambda) =>
        argumentsAt(body, declared[0].length + lambda.index + lambda[0].length).some(
          (parameter) => /^\w+/.exec(parameter)?.[0] === name,
        ),
      ) || [...body.matchAll(new RegExp(`\\bvar[ \\t]+${name}\\b`, 'g'))].length > (index === -1 ? 1 : 0);
    if (shadowed) {
      return null;
    }
    if (index !== -1) {
      const fallback = /=\s*(.+)$/s.exec(parameters[index] ?? '')?.[1];
      const most = parameters.some((parameter) => parameter.startsWith('...'))
        ? Number.POSITIVE_INFINITY
        : parameters.length;
      const least = parameters.filter(
        (parameter) => !parameter.includes('=') && !parameter.startsWith('...'),
      ).length;
      return this.passedFor(declared[2] ?? '', index, { fallback, path, at: declared.index, least, most });
    }
    const locals = [...body.matchAll(new RegExp(`\\bvar[ \\t]+${name}\\b[^=\\n]*=[ \\t]*([^\\n]+)`, 'g'))];
    const setAgain = new RegExp(
      `(?<!\\bvar[ \\t]+)(?<![\\w.])${name}[ \\t]*(?:[-+*/%&|^]|<<|>>)?=(?!=)|\\bfor[ \\t]+${name}\\b`,
    );
    const local = locals[0];
    if (locals.length !== 1 || local === undefined || setAgain.test(body)) {
      return null;
    }
    return this.heldPaths((local[1] ?? '').trim(), path, declared.index + local.index, depth);
  }

  /**
   * What every call that can reach the function [param named], declared as [param declared] says,
   * passes as its parameter at [param index], or null. A function reached again while it is
   * followed, through its own callers, is not followed.
   */
  private passedFor(named: string, index: number, declared: Declared): Held[] | null {
    const key = `${declared.path}\n${named}\n${String(index)}`;
    if (this.passed.has(key)) {
      return this.passed.get(key) ?? null;
    }
    this.passed.set(key, null);
    const held = this.passedAnew(named, index, declared);
    this.passed.set(key, held);
    return held;
  }

  /**
   * A call reaches the function from a script of its line (its own, its bases and the scripts
   * extending it) bare or through `self` or `super`. From anywhere it reaches it through a class, an
   * autoload, a preloaded script or a variable typed as one of the line, or through what could be any
   * object. A call whose argument count the function cannot take is not to it. The function is
   * followed only if every use that may be it is such a call. Named without a call, by name in a
   * call such as `call()`, or as a scene's method, it could be handed anything.
   */
  private passedAnew(named: string, index: number, declared: Declared): Held[] | null {
    const sceneNamed = new RegExp(`\\bmethod="${named}"|&"${named}"`);
    if (this.sceneTexts().some((text) => sceneNamed.test(text))) {
      return null;
    }
    const line = this.lineOf(declared.path);
    const byName = new RegExp(
      `&["']${named}["']|\\b(?:call|call_deferred|callv|has_method|rpc|rpc_id|Callable|create)[ \\t]*\\([^()]*?["']${named}["']`,
    );
    const used = new RegExp(`(?<![\\w$%])${named}\\b`, 'g');
    const held: Held[] = [];
    let calls = 0;
    for (const caller of this.scripts.sources.keys()) {
      const text = this.textOf(caller);
      if (!text.includes(named)) {
        continue;
      }
      if (byName.test(text)) {
        return null;
      }
      const code = this.codeOf(caller);
      for (const found of code.matchAll(used)) {
        if (DECLARING.test(code.slice(Math.max(0, found.index - 40), found.index))) {
          continue;
        }
        if (!this.mayBeOnLine(receiverBefore(code, found.index), caller, line)) {
          continue;
        }
        const opened = /^[ \t]*\(/.exec(code.slice(found.index + found[0].length));
        if (opened === null) {
          return null;
        }
        const given = argumentsAt(text, found.index + found[0].length + opened[0].length);
        if (given.length < declared.least || given.length > declared.most) {
          continue;
        }
        calls += 1;
        const argument = given[index];
        const passed =
          argument === undefined
            ? declared.fallback === undefined
              ? null
              : this.heldPaths(declared.fallback.trim(), declared.path, declared.at, 0)
            : this.heldPaths(argument, caller, found.index, 0);
        if (passed === null) {
          return null;
        }
        held.push(...passed);
      }
    }
    return calls === 0 ? null : held;
  }

  /**
   * Whether a use through [param receiver] in the script at [param caller] may be of a function of
   * [param line]: null for a bare use, the empty string for what could be any object.
   */
  private mayBeOnLine(receiver: string | null, caller: string, line: ReadonlySet<string>): boolean {
    if (receiver === null || receiver === 'self' || receiver === 'super') {
      return line.has(caller);
    }
    return this.targetsOf(receiver, caller).some((target) => target === null || line.has(target));
  }

  /**
   * The scripts [param receiver], written in the script at [param caller], can be or be an instance
   * of: null for any object, none for a value no script can be.
   */
  private targetsOf(receiver: string, caller: string): (string | null)[] {
    if (receiver === '') {
      return [null];
    }
    const named = this.scriptNamed(receiver, caller);
    if (named !== undefined) {
      return [named];
    }
    const text = this.textOf(caller);
    const rests = [...text.matchAll(new RegExp(`\\b(?:var|for)[ \\t]+${receiver}\\b`, 'g'))].map((found) =>
      text.slice(found.index + found[0].length),
    );
    for (const found of text.matchAll(/\bfunc\b[ \t]*\w*[ \t]*\(/g)) {
      for (const parameter of argumentsAt(text, found.index + found[0].length)) {
        if (/^\w+/.exec(parameter)?.[0] === receiver) {
          rests.push(parameter.slice(receiver.length));
        }
      }
    }
    if (rests.length === 0) {
      return [null];
    }
    return rests.flatMap((rest) => {
      const type =
        /^[ \t]*:[ \t]*([A-Za-z_]\w*)/.exec(rest)?.[1] ??
        /^[ \t]*:=[ \t]*([A-Za-z_]\w*)\.new\(/.exec(rest)?.[1];
      if (type === undefined) {
        return [null];
      }
      const script = this.scriptNamed(type, caller);
      return script !== undefined ? [script] : VALUE_TYPES.has(type) ? [] : [null];
    });
  }

  /**
   * The script the name [param name] in the script at [param caller] stands for: a global class, an
   * autoload, or a constant preloading one. Null for an autoload that is a scene.
   */
  private scriptNamed(name: string, caller: string): string | null | undefined {
    const global = this.scripts.classes.get(name);
    if (global !== undefined) {
      return global;
    }
    const autoload = this.autoloads().get(name);
    if (autoload !== undefined) {
      return autoload.endsWith('.gd') ? autoload : null;
    }
    const preloaded = new RegExp(
      `\\bconst[ \\t]+${name}\\b[^=\\n]*=[ \\t]*preload\\([ \\t]*["']([^"']+)["']`,
    ).exec(this.textOf(caller))?.[1];
    if (preloaded === undefined) {
      return undefined;
    }
    return preloaded.startsWith('res://')
      ? preloaded
      : `res://${posix.join(posix.dirname(caller.slice(6)), preloaded)}`;
  }

  /** The scripts of the line of the script at [param path]: it, its bases and the scripts extending it. */
  private lineOf(path: string): ReadonlySet<string> {
    const known = this.lines.get(path);
    if (known !== undefined) {
      return known;
    }
    const line = new Set(this.basesOf(path));
    for (const script of this.scripts.sources.keys()) {
      if (this.basesOf(script).includes(path)) {
        line.add(script);
      }
    }
    this.lines.set(path, line);
    return line;
  }

  /** The script at [param path] and every project script it extends, nearest first. */
  private basesOf(path: string): string[] {
    const chain = [path];
    for (
      let base = this.scripts.base(path);
      base !== null && 'path' in base;
      base = this.scripts.base(base.path)
    ) {
      if (chain.includes(base.path)) {
        break;
      }
      chain.push(base.path);
    }
    return chain;
  }

  /** The project's autoloads, by name, as `res://` paths. */
  private autoloads(): ReadonlyMap<string, string> {
    if (this.autoloadPaths === null) {
      const settings = bytesOf(join(this.scripts.projectPath, 'project.godot'))?.toString('utf8') ?? '';
      this.autoloadPaths = new Map(
        [...autoloadPaths(parseProjectGodot(settings), this.scripts.projectPath)].map(
          ([name, path]) => [name, `res://${path}`] as const,
        ),
      );
    }
    return this.autoloadPaths;
  }

  /** Every scene and resource of the project as text, read once per run. */
  private sceneTexts(): readonly string[] {
    this.scenes ??= projectFiles(this.scripts.projectPath, ['.tscn', '.tres']).map(
      (file) => bytesOf(join(this.scripts.projectPath, file))?.toString('utf8') ?? '',
    );
    return this.scenes;
  }

  /** The script at [param path] with its comments and strings blanked, read once per run. */
  private codeOf(path: string): string {
    const known = this.codes.get(path);
    if (known !== undefined) {
      return known;
    }
    const source = this.scripts.sources.get(path) ?? '';
    let code = '';
    for (const region of regionsOf(source)) {
      const part = source.slice(region.start, region.end);
      code += region.kind === 'code' ? part : part.replace(/[^\n]/g, ' ');
    }
    this.codes.set(path, code);
    return code;
  }

  /** The script at [param path] with its comments blanked, read once per run. */
  private textOf(path: string): string {
    const known = this.texts.get(path);
    if (known !== undefined) {
      return known;
    }
    const text = uncommented(this.scripts.sources.get(path) ?? '');
    this.texts.set(path, text);
    return text;
  }
}

/** One way a path written in a script can hold at run time: all of it, or how it begins. */
interface Held {
  readonly text: string;
  readonly whole: boolean;
}

/** A path handed to the system as the file it names, up to the path. */
const GLOBALIZED = /^ProjectSettings\.globalize_path\(/;

/** How many locals deep a path is followed within one function, for a script whose locals name each other. */
const HELD_DEPTH = 16;

/** A function whose parameter a path is: where it is declared, its default, and how many arguments it takes. */
interface Declared {
  readonly fallback: string | undefined;
  readonly path: string;
  readonly at: number;
  readonly least: number;
  readonly most: number;
}

/** The read a script makes by a path that could be anything, as `--whole-tree` names it. */
interface Unfollowed {
  readonly line: number;
  readonly argument: string;
}

/** A script whose reads make every suite reaching it depend on every file. */
export interface WholeTreeRead extends Unfollowed {
  readonly path: string;
  readonly suites: number;
}

/** Text before a function's name that declares it rather than uses it. */
const DECLARING = /\bfunc[ \t]+$/;

/** The types whose values no script can be. */
const VALUE_TYPES = new Set([
  'bool',
  'int',
  'float',
  'String',
  'StringName',
  'NodePath',
  'Array',
  'Dictionary',
  'Callable',
  'Signal',
  'RID',
  'Color',
  'Vector2',
  'Vector2i',
  'Vector3',
  'Vector3i',
  'Vector4',
  'Vector4i',
  'Rect2',
  'Rect2i',
  'Transform2D',
  'Transform3D',
  'Basis',
  'Quaternion',
  'AABB',
  'Plane',
  'Projection',
  'PackedByteArray',
  'PackedInt32Array',
  'PackedInt64Array',
  'PackedFloat32Array',
  'PackedFloat64Array',
  'PackedStringArray',
  'PackedVector2Array',
  'PackedVector3Array',
  'PackedVector4Array',
  'PackedColorArray',
]);

/**
 * What a use at [param at] in [param code] is reached through: null for a bare use, the name before
 * its dot, or the empty string for any other expression, such as a call, an index or `a.b`. A node
 * path is blanked in [param code], so it is an expression too.
 */
function receiverBefore(code: string, at: number): string | null {
  let index = at - 1;
  while (code[index] === ' ' || code[index] === '\t') {
    index -= 1;
  }
  if (code[index] !== '.') {
    return null;
  }
  const end = index;
  index -= 1;
  while (index >= 0 && /\w/.test(code[index] ?? '')) {
    index -= 1;
  }
  const name = code.slice(index + 1, end);
  return /^[A-Za-z_]\w*$/.test(name) && code[index] !== '.' ? name : '';
}

/** A named function's declaration, up to its parameters, with its indentation and name. */
const FUNCTION_DECLARED = /^([ \t]*)(?:static[ \t]+)?func[ \t]+(\w+)[ \t]*\(/gm;

/**
 * What a read by a path holding [param held] reads: the file where the path is known whole, the
 * folder it begins in where only its start is, and nothing for a `user://` path. Null where it could
 * read anywhere.
 */
function readUnder(held: readonly Held[] | null): string[] | null {
  if (held === null) {
    return null;
  }
  const read: string[] = [];
  for (const one of held) {
    if (one.text.startsWith('user://')) {
      continue;
    }
    const folder = one.text.slice(0, one.text.lastIndexOf('/') + 1);
    if (one.whole ? !one.text.startsWith('res://') : !folder.startsWith('res://') || folder === 'res://') {
      return null;
    }
    read.push(one.whole ? one.text : `${TREE}${folder}`);
  }
  return read;
}

/** How every one of [param held] begins, or nothing for none. */
function sharedStart(held: readonly Held[]): string {
  const [first, ...rest] = held.map((one) => one.text);
  let start = first ?? '';
  for (const text of rest) {
    while (!text.startsWith(start)) {
      start = start.slice(0, -1);
    }
  }
  return start;
}

/** [param inputs] in order, or every file alone when they reach it, without the cache's mark. */
function listed(inputs: ReadonlySet<string>): string[] {
  return inputs.has(EVERY_FILE)
    ? [EVERY_FILE]
    : [...inputs].filter((path) => !path.startsWith(CACHE_HELD)).toSorted();
}

/** A recorded path as an input: the addon it is in, or null for one outside the project's files. */
function inputPath(path: string): string | null {
  if (path === EVERY_FILE || path === EVERY_NAME || path.startsWith(CACHE_HELD) || path.startsWith(TREE)) {
    return path;
  }
  if (path === EXTENSION_LIST) {
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

/** The line, counted from 1, of [param at] in [param text]. */
function lineAt(text: string, at: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < at; index = text.indexOf('\n', index + 1)) {
    line += 1;
  }
  return line;
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
 * the root with forward slashes, its bytes and when it was modified: no hidden folder, no folder
 * holding a `.gdignore`, and none of the copies an engine makes of a library it loads. A file gone
 * between the listing and the read is passed over.
 */
export function walkSeen(root: string, seen: (under: string, bytes: Buffer, modified: number) => void): void {
  namesSeen(root, (under, file, folder) => {
    const content = folder ? null : contentOf(file);
    if (content !== null) {
      seen(under, content.bytes, content.modified);
    }
  });
}

/**
 * Every file and folder under [param root] that [method walkSeen] would walk, in its order, by where
 * it lies under the root, a folder ending in a slash. A folder holding a `.gdignore` is named, since
 * a listing sees it, but nothing in it is.
 */
function namesSeen(root: string, seen: (under: string, file: string, folder: boolean) => void): void {
  const walk = (directory: string, under: string): void => {
    if (existsSync(join(directory, '.gdignore'))) {
      return;
    }
    const entries = entriesOf(directory).toSorted((a, b) => a.name.localeCompare(b.name));
    const names = entries.map((entry) => entry.name);
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          seen(`${under}${entry.name}/`, file, true);
          walk(file, `${under}${entry.name}/`);
        }
      } else if (entry.isFile() && !isLibraryCopy(entry.name, names)) {
        seen(`${under}${entry.name}`, file, false);
      }
    }
  };
  walk(root, '');
}

/** The extensions the engine loads into every run of [param projectPath]. */
function extensionsOf(projectPath: string): string[] {
  return (bytesOf(join(projectPath, '.godot', 'extension_list.cfg'))?.toString('utf8') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('res://'));
}
