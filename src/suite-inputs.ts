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
import { isRecord } from './records.js';
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

const RES_LITERAL = /res:\/\/[^"'\s)\]<>]*/g;
const PRELOAD = /\bpreload\(\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*))\s*\)/g;
/**
 * A call reading a file or listing a folder by the path it is given, up to the start of that path.
 * `ResourceLoader.load` is left out: see [constant RESOURCE_LOAD].
 */
const FILE_READ =
  /(?:\b(?:FileAccess\.(?:open\w*|get_file_as_string|get_file_as_bytes|file_exists|get_md5|get_sha256|get_modified_time|get_size)|DirAccess\.(?:open|get_files_at|get_directories_at|dir_exists_absolute)|ResourceLoader\.(?:list_directory|exists)|Image\.load_from_file)|(?<!\bResourceLoader)\.(?:load|load_from_file|change_dir))\(/g;
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
  private readonly texts = new Map<string, string>();
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
      if (path === EVERY_FILE || path === EVERY_NAME || path.startsWith(CACHE_HELD)) {
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
      for (const [named] of bytes.toString('latin1').matchAll(RES_LITERAL)) {
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
  private scriptReaches(path: string): { follows: string[]; also: string[] } | null {
    const text = this.textOf(path);
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
      const read = readUnder(this.heldPaths(first, path, found.index, 0));
      if (read === null) {
        if (!NAMES_READ.test(found[0])) {
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
   * What the path [param argument], written at [param at] in the script at [param path], can hold
   * as it runs: each way it is known whole or known to begin, or null when it could be anything. A
   * name not a constant is followed to the local set once that holds it, or to what every call in
   * the project passes for the parameter it is, [constant HELD_DEPTH] steps deep at most.
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
    if (index !== -1) {
      const fallback = /=\s*(.+)$/s.exec(parameters[index] ?? '')?.[1];
      return this.passedFor(declared[2] ?? '', index, { fallback, path, at: declared.index }, depth);
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
   * What every call in the project passes the function [param named] as its parameter at
   * [param index], or null. The function is only ever called by its name, or it could be handed
   * anything: a function also named as a value, or in a string a call by name reads, is not followed.
   */
  private passedFor(
    named: string,
    index: number,
    declared: { fallback: string | undefined; path: string; at: number },
    depth: number,
  ): Held[] | null {
    const held: Held[] = [];
    let calls = 0;
    const declaring = new RegExp(`\\bfunc[ \\t]+${named}\\b`, 'g');
    const mentioned = new RegExp(`(?<!\\w)${named}\\b(?![ \\t]*\\()`);
    const call = new RegExp(`(?<!\\bfunc[ \\t]+)(?<!\\w)${named}[ \\t]*\\(`, 'g');
    for (const caller of this.scripts.sources.keys()) {
      const text = this.textOf(caller);
      if (!text.includes(named)) {
        continue;
      }
      if (mentioned.test(text.replaceAll(declaring, ''))) {
        return null;
      }
      for (const found of text.matchAll(call)) {
        calls += 1;
        const given = argumentsAt(text, found.index + found[0].length)[index];
        const passed =
          given === undefined
            ? declared.fallback === undefined
              ? null
              : this.heldPaths(declared.fallback.trim(), declared.path, declared.at, depth)
            : this.heldPaths(given, caller, found.index, depth);
        if (passed === null) {
          return null;
        }
        held.push(...passed);
      }
    }
    return calls === 0 ? null : held;
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

/** How many names deep a path is followed back to what it was set from. */
const HELD_DEPTH = 4;

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
