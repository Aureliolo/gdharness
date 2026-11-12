/**
 * `gdharness test`: a project's gdUnit4 suites over several engines, judged whole.
 *
 * What a game's gate runs, so that every game runs its suites one way: discovered from the scripts,
 * dealt to engines by what each case cost last time, each engine holding one of the machine's engine
 * slots, ended when it goes silent, and judged on everything it printed rather than on its exit code.
 * docs/test-runs.md describes it for the games, the slot scheme included.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { cachedClasses, staleAgainst } from './class-cache.js';
import {
  coresNamed,
  type EngineLaunch,
  gigabytes,
  godotNamed,
  heldRunSaid,
  homeOf,
  KEPT_RUN_DIRECTORIES,
  MEMORY_PER_ENGINE,
  MOST_ENGINES,
  memoryAvailable,
  plural,
  resPathOf,
  roomFor,
  roomForAnother,
  SILENCE_FLOOR_SECONDS,
  sweepRunDirectories,
  versionNamed,
  watchedEngine,
} from './engine-launch.js';
import { type SelfTypedExport, selfTypedExports } from './engine-leaks.js';
import { EngineSlots, machineSlots, ownStart } from './engine-slots.js';
import { EngineUsageError } from './errors.js';
import { CONTROL_SEQUENCE } from './game-log.js';
import { staleImports } from './import-freshness.js';
import { hiddenWindowFlags, wholeFlag } from './launch.js';
import { freeLibraryCopies, seedExtensionList, unlistedExtensions } from './library-copies.js';
import { cannotOpen } from './listed-reads.js';
import { prependTo, readLog } from './log-read.js';
import { commandProjectRefusal, isGodotProject } from './paths.js';
import { isRecord, isStringList } from './records.js';
import { forceNextImport } from './reimport.js';
import { gdUnit4Unusable, shippedListedRunner } from './setup.js';
import { EVERY_FILE, type PassedSuite, reachedBySuite, SuiteInputs } from './suite-inputs.js';
import {
  type EngineAssignment,
  type EngineEnd,
  type EngineStart,
  type EngineVerdict,
  exitNamed,
  funcOf,
  judgeCompile,
  judgeEngine,
  named,
  type RunPrinted,
  readExpected,
  readRun,
  rowOf,
  rowsAcross,
  uncollectedSaid,
  versionFault,
} from './suite-judge.js';
import {
  type CasesBySuite,
  capsFrames,
  type DeclaredSuite,
  dealt,
  type EnginePlan,
  gdUnitFailsOnPushErrors,
  headlessInAWindow,
  inOneEngine,
  lanesOf,
  ProjectScripts,
  peakOf,
  readTimes,
  Shares,
  SPLIT_PAST_SECONDS,
  type SuiteTimes,
  splitPastFor,
  TEST_DIRECTORIES,
  timesAfter,
  type Unit,
  unitsOf,
  viewportOf,
  windowedSaid,
  writeJson,
} from './suite-plan.js';
import { getLocalVersion } from './version.js';

/** An order `--order` runs every suite in, in one engine. A number is the seed it is shuffled by. */
type RunOrder = 'reversed' | 'named' | number;

interface TestOptions {
  readonly projectPath: string;
  /** The suites, directories and `suite.gd:test_case` cases named, or none for every suite. */
  readonly selected: readonly string[];
  readonly engines: number;
  readonly slotsDirectory: string | null;
  readonly slotCount: number | null;
  readonly silenceSeconds: number;
  /** The most seconds one engine may run, the import's included, or null for no limit. */
  readonly deadlineSeconds: number | null;
  /** The engine `--godot` names, or null for the one gdharness finds. */
  readonly godotPath: string | null;
  /** How many processors, the first ones, every engine of the run is held to, or null for all. */
  readonly cores: number | null;
  /** The version every engine must say it is as it starts, such as `4.7.2`, or null for any. */
  readonly godotVersion: string | null;
  /** The directories suites are looked for in, as `res://` paths, or none for `tests` and `test`. */
  readonly roots: readonly string[];
  readonly changedOnly: boolean;
  /** Name the scripts that make suites depend on every file, and run nothing. */
  readonly wholeTree: boolean;
  readonly reachAlso: readonly string[];
  readonly importFirst: boolean;
  /** Every suite in one engine in this order: `reversed`, as `named`, or shuffled by the seed. */
  readonly order: RunOrder | null;
  /** Print what each engine printed, after the run and before its verdict. */
  readonly printOutput: boolean;
  /** Start every engine with `--verbose`, so a leak at exit is named by what was left. */
  readonly verbose: boolean;
  /** Where the run writes its result as JSON ([type RunResult]), or null for nowhere. */
  readonly resultFile: string | null;
  /**
   * The times the run deals by and records into, or null for the project's own: a gate keeping a
   * record of its runs alone names its file, so hand runs never skew how it deals.
   */
  readonly timesFile: string | null;
}

/**
 * A run's result as `--result` writes it, for a gate that acts on more than the exit code: the
 * slowest suites past its own budget, say, or which engine's log to keep.
 */
export interface RunResult {
  readonly passed: boolean;
  /** From the command starting to its verdict. */
  readonly seconds: number;
  /** Every problem the output lists, one sentence each, the engine's named before its own. */
  readonly problems: readonly string[];
  /** Each suite an engine closed, slowest first. */
  readonly suites: readonly {
    readonly path: string;
    /** gdUnit4's time for it, from its `before()` to its `after()`. */
    readonly seconds: number;
    /** Its load before that, or null when no case of it began. */
    readonly loadSeconds: number | null;
    /** Its `before()`, up to its first case, or null when no case of it began. */
    readonly beforeSeconds: number | null;
    /** gdUnit4's word for it, such as `PASSED` or `FAILED`. */
    readonly verdict: string;
    readonly engine: number;
  }[];
  readonly engines: readonly {
    readonly index: number;
    /** The slot's lane it was dealt to. The engines of one lane run one after another. */
    readonly lane: number;
    /** When it started, in seconds after the command did, once it had a slot. */
    readonly startedAfter: number;
    readonly seconds: number;
    /** From its start until gdUnit4 opened its session, or null when it never did. */
    readonly startSeconds: number | null;
    /** The part of [member startSeconds] spent compiling its suites together. */
    readonly compiledSeconds: number | null;
    /** What the deal expected it to take, from the times kept. */
    readonly dealt: number;
    readonly passed: boolean;
    readonly windowed: boolean;
    /** The suites it was handed, a suite dealt by its cases or rows once for each engine holding part. */
    readonly suites: readonly string[];
    /** The most memory the engine was read holding, or null when it was never read. */
    readonly peakBytes: number | null;
    /** Where its whole output is kept, or null once a passing run has removed it. */
    readonly log: string | null;
  }[];
  /** The directory every engine's output is kept under, or null when the run removed it. */
  readonly logs: string | null;
  /** The engines asked for, before the room on the machine and the slots held the run to fewer. */
  readonly enginesAsked: number;
  /** How many of the slots its lanes take were free as it began. Fewer than the lanes is a shared run. */
  readonly slotsFree: number;
  /** What the run printed of its deal: the engines, what it split, and what held it. */
  readonly dealing: readonly string[];
}

/**
 * The file beside the kept suite times that every run writes its result to, whatever --result says,
 * so a run in a gate that keeps none of a passing step's output can still be read afterwards.
 */
const LAST_RUN_FILE = 'last-run.json';

/** Where a run keeps the print of what compiled together when it last passed. */
const COMPILED_FILE = 'compiled-together.json';

/** Where a run's result goes, and what it said of its deal. */
interface ResultTargets {
  readonly resultFile: string | null;
  readonly lastRunFile: string;
  readonly dealing: readonly string[];
  readonly engines: number;
  readonly slotsFree: number;
}

/** How many of the slowest suites the run names at its end. */
const SLOWEST_NAMED = 5;
/** How many times the last time of what it is running an engine may print nothing for. */
const SILENCE_TIMES_TAKEN = 4;

/**
 * How long an engine may print nothing while in [param running], at least [param floorSeconds]:
 * four times the case's last time from [param times], the row's for a row of one, or the time its
 * suite spent outside its cases while in a hook or between cases. Read from what is running rather
 * than from the slowest suite the engine was dealt, so one long suite does not leave every suite
 * beside it hanging for that long.
 */
export function silenceWhile(
  running: RunPrinted['running'],
  times: SuiteTimes,
  floorSeconds: number,
): number {
  const time = running === null ? undefined : times[running.suite];
  if (running === null || time === undefined) {
    return floorSeconds;
  }
  let taken: number | undefined;
  if (running.during === null || running.during === 'before') {
    const cases = Object.values(time.cases).reduce((sum, seconds) => sum + seconds, 0);
    taken = Math.max(0, time.seconds - cases);
  } else {
    const func = funcOf(running.during);
    const row = rowOf(running.during);
    taken = (row === null ? undefined : time.rows?.[func]?.[row]) ?? time.cases[func];
  }
  return Math.max(floorSeconds, SILENCE_TIMES_TAKEN * (taken ?? 0));
}

const VALUED = new Set([
  '--engines',
  '--slots',
  '--slot-count',
  '--silence',
  '--deadline',
  '--godot',
  '--godot-version',
  '--cores',
  '--tests',
  '--reach-also',
  '--order',
  '--result',
  '--times',
]);
const SWITCHES = new Set(['--changed-only', '--whole-tree', '--import', '--print-output', '--verbose']);

/** The arguments of `gdharness test` sorted into the options with values, the switches and the rest. */
interface SortedArguments {
  readonly valued: ReadonlyMap<string, readonly string[]>;
  readonly switches: ReadonlySet<string>;
  readonly positional: readonly string[];
}

/** [param args] sorted by what each is, refusing an unknown option or one missing its value. */
function sortedArguments(args: readonly string[]): SortedArguments {
  const valued = new Map<string, string[]>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
    } else if (SWITCHES.has(arg)) {
      switches.add(arg);
    } else if (VALUED.has(arg)) {
      const value = args[at + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new EngineUsageError(`${arg} needs a value.`);
      }
      valued.set(arg, [...(valued.get(arg) ?? []), value]);
      at += 1;
    } else {
      throw new EngineUsageError(`Unknown option ${arg} for gdharness test. Run gdharness help.`);
    }
  }
  return { valued, switches, positional };
}

/** The project a run is for: the first argument where it is one, else [param cwd], refused where it is none. */
function projectOfRun(
  positional: readonly string[],
  cwd: string,
): { readonly projectPath: string; readonly projectNamed: boolean } {
  const first = positional[0];
  const firstPath = first === undefined ? null : resolve(cwd, first);
  const projectNamed = firstPath !== null && isGodotProject(firstPath);
  const projectPath = projectNamed ? firstPath : resolve(cwd);
  const refused = commandProjectRefusal(projectPath);
  if (refused !== null) {
    throw new EngineUsageError(
      firstPath === null || firstPath === projectPath
        ? refused
        : `Not a Godot project: neither ${firstPath} nor ${projectPath} holds a project.godot. Name the project directory first, or run from it.`,
    );
  }
  return { projectPath, projectNamed };
}

/** [param value] read from [param cwd], or null where the option was not given. */
function pathNamed(value: string | undefined, cwd: string): string | null {
  return value === undefined ? null : resolve(cwd, value);
}

/**
 * The order the `--order` option names: reversed, the order [param selected] names the suites in, a
 * seed to shuffle by, or null for the plain one.
 */
function orderNamed(order: string | undefined, selected: readonly string[]): RunOrder | null {
  if (order === undefined) {
    return null;
  }
  if (order === 'named' && selected.length === 0) {
    throw new EngineUsageError(
      '--order named needs suites named on the command line: gdharness test a_test.gd b_test.gd --order named.',
    );
  }
  return order === 'reversed' || order === 'named' ? order : seedOf(order);
}

/** [param args], everything after `test`, read into options. Relative paths are read from [param cwd]. */
export function testOptionsOf(args: readonly string[], cwd: string): TestOptions {
  const { valued, switches, positional } = sortedArguments(args);
  const { projectPath, projectNamed } = projectOfRun(positional, cwd);
  const last = (flag: string): string | undefined => valued.get(flag)?.at(-1);
  const selected = positional.slice(projectNamed ? 1 : 0).map((entry) => resPathOf(entry, projectPath, cwd));
  return {
    projectPath,
    selected,
    engines: wholeFlag(last('--engines'), '--engines') ?? MOST_ENGINES,
    slotsDirectory: pathNamed(last('--slots'), cwd),
    slotCount: wholeFlag(last('--slot-count'), '--slot-count'),
    silenceSeconds: wholeFlag(last('--silence'), '--silence') ?? SILENCE_FLOOR_SECONDS,
    deadlineSeconds: wholeFlag(last('--deadline'), '--deadline'),
    godotPath: godotNamed(last('--godot'), cwd),
    godotVersion: versionNamed(last('--godot-version')),
    cores: coresNamed(last('--cores')),
    roots: (valued.get('--tests') ?? []).map((root) => resPathOf(root, projectPath, cwd).replace(/\/$/, '')),
    changedOnly: switches.has('--changed-only'),
    wholeTree: switches.has('--whole-tree'),
    reachAlso: (valued.get('--reach-also') ?? []).map((path) => resolve(projectPath, path)),
    importFirst: switches.has('--import'),
    order: orderNamed(last('--order'), selected),
    printOutput: switches.has('--print-output'),
    verbose: switches.has('--verbose'),
    resultFile: pathNamed(last('--result'), cwd),
    timesFile: pathNamed(last('--times'), cwd),
  };
}

function seedOf(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new EngineUsageError(
      `--order takes reversed, named or a whole number to shuffle by, not ${value}.`,
    );
  }
  return seed;
}

/** The directories a run with nothing selected looks for suites in. */
function rootsOf(options: TestOptions): readonly string[] {
  return options.roots.length > 0
    ? options.roots
    : TEST_DIRECTORIES.filter((root) => existsSync(join(options.projectPath, root))).map(
        (root) => `res://${root}`,
      );
}

/** The directories the run searched for suites: those of a run with nothing selected, or those selected. */
function searchedRoots(options: TestOptions): readonly string[] {
  return options.selected.length === 0
    ? rootsOf(options)
    : options.selected.filter((entry) => {
        const directory = join(options.projectPath, entry.slice('res://'.length));
        return existsSync(directory) && statSync(directory).isDirectory();
      });
}

/** The suites a run is asked for, each with the cases asked of it. */
function selectedSuites(scripts: ProjectScripts, options: TestOptions): DeclaredSuite[] {
  if (options.selected.length === 0) {
    return suitesOfTheRoots(scripts, options);
  }
  const chosen = new Map<string, { suite: DeclaredSuite; cases: Set<string> }>();
  for (const entry of options.selected) {
    const caseAt = /^(res:\/\/.*\.gd):(\w+)$/.exec(entry);
    const path = caseAt?.[1] ?? entry;
    const asked = caseAt?.[2];
    for (const suite of suitesOfEntry(scripts, options, path)) {
      const picked = chosen.get(suite.path) ?? { suite, cases: new Set<string>() };
      for (const func of casesAsked(suite, asked)) {
        picked.cases.add(func);
      }
      chosen.set(suite.path, picked);
    }
  }
  return [...chosen.values()].map(({ suite, cases }) => ({
    ...suite,
    cases: suite.cases.filter((c) => cases.has(c)),
  }));
}

/** The cases of [param suite] a selection asks for: the one named by [param asked], or all of them. */
function casesAsked(suite: DeclaredSuite, asked: string | undefined): readonly string[] {
  if (asked === undefined) {
    return suite.cases;
  }
  if (!suite.cases.includes(asked)) {
    throw new EngineUsageError(
      `${suite.path} declares no case ${asked}. It declares ${suite.cases.join(', ')}.`,
    );
  }
  return [asked];
}

/** Every suite under the directories a run with nothing selected looks in, refusing where there is none. */
function suitesOfTheRoots(scripts: ProjectScripts, options: TestOptions): DeclaredSuite[] {
  const roots = rootsOf(options);
  const missing = roots.find((root) => !existsSync(join(options.projectPath, root.slice('res://'.length))));
  if (missing !== undefined) {
    throw new EngineUsageError(`Nothing at ${missing} in the project at ${options.projectPath}.`);
  }
  const found = scripts.suitesUnder(roots);
  if (found.length === 0) {
    throw new EngineUsageError(
      roots.length === 0
        ? 'The project has no tests or test directory to look for suites in. Name one with --tests.'
        : `No gdUnit4 suite under ${roots.join(' or ')}: no script there extends GdUnitTestSuite and declares a test_ function.`,
    );
  }
  return found;
}

/** The suites the selected [param path] names, one for a script and every one under a directory. */
function suitesOfEntry(scripts: ProjectScripts, options: TestOptions, path: string): DeclaredSuite[] {
  const directory = join(options.projectPath, path.slice(6));
  const suites =
    existsSync(directory) && statSync(directory).isDirectory()
      ? scripts.suitesUnder([path.replace(/\/$/, '')])
      : [scripts.suite(path)].filter((suite) => suite !== null);
  if (suites.length === 0) {
    throw new EngineUsageError(
      existsSync(directory)
        ? `${path} holds no gdUnit4 suite: nothing there extends GdUnitTestSuite and declares a test_ function.`
        : `Nothing at ${path} in the project at ${options.projectPath}.`,
    );
  }
  return suites;
}

/**
 * [param units] in the order [param order] asks: reversed by path, in the order [param selected]
 * names them, or shuffled by a seed.
 */
function ordered(units: readonly Unit[], order: RunOrder, selected: readonly string[]): Unit[] {
  const sorted = [...units].toSorted((a, b) => a.suite.localeCompare(b.suite));
  if (order === 'reversed') {
    return sorted.reverse();
  }
  if (order === 'named') {
    // A suite comes where the first entry naming it stands, the suites of one folder by path.
    const rank = (suite: string): number =>
      selected.findIndex((entry) => {
        const path = /^(.+\.gd):[^/]*$/.exec(entry)?.[1] ?? entry;
        return path === suite || suite.startsWith(path.endsWith('/') ? path : `${path}/`);
      });
    return sorted.toSorted((a, b) => rank(a.suite) - rank(b.suite));
  }
  // mulberry32, so a seed names the same order on every machine and every run.
  let state = order >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  for (let at = sorted.length - 1; at > 0; at -= 1) {
    const other = Math.floor(next() * (at + 1));
    const here = sorted[at];
    const there = sorted[other];
    if (here !== undefined && there !== undefined) {
      sorted[at] = there;
      sorted[other] = here;
    }
  }
  return sorted;
}

/** One engine's run, as it ended. */
interface EngineRan {
  readonly index: number;
  readonly plan: EnginePlan;
  readonly printed: RunPrinted;
  readonly verdict: EngineVerdict;
  readonly log: string;
  /** When it started, in milliseconds since the epoch, once it had a slot. */
  readonly began: number;
  readonly seconds: number;
  /** Whether this is the engine run again alone after one ran out of memory. */
  readonly again: boolean;
  /** The file the runner wrote what it loaded into, a line as each suite ended. */
  readonly reached: string;
  /** The most bytes the engine was read holding, when it was read at all. */
  readonly peakBytes?: number;
}

/**
 * Where a run's logs are read once it is over. The engines write them inside the project, where
 * the folder gdUnit4 writes its reports to has to be, since it takes that folder as a `res://` path.
 * A project that is a worktree of another checkout also gets a copy of a failed run's logs beside
 * the main checkout: a gate running in a worktree of the commit removes it once the run ends, and
 * the logs with it.
 */
class RunLogs {
  readonly directory: string;
  private readonly kept: string | null;

  constructor(directory: string, kept: string | null) {
    this.directory = directory;
    this.kept = kept;
  }

  /** Where the run's logs are read once it is over. */
  get shown(): string {
    return this.kept ?? this.directory;
  }

  /** [param path], a file the run writes, as it is named once the run is over. */
  named(path: string): string {
    return this.kept === null ? path : join(this.kept, relative(this.directory, path));
  }

  /**
   * Copies the logs beside the main checkout, once they are complete, when they go there: each
   * engine's own, one folder down, and not what the engine wrote in its user folder below that.
   */
  keep(): void {
    if (this.kept === null) {
      return;
    }
    for (const file of readdirSync(this.directory, { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('.log') && file.split(sep).length === 2) {
        mkdirSync(dirname(join(this.kept, file)), { recursive: true });
        copyFileSync(join(this.directory, file), join(this.kept, file));
      }
    }
  }
}

/** What starting a run's engines needs, the same for every engine of it. */
interface Launch extends EngineLaunch {
  readonly runDirectory: string;
  readonly logs: RunLogs;
  readonly slots: EngineSlots;
  readonly silenceFloorSeconds: number;
  readonly selfTyped: readonly SelfTypedExport[];
  readonly godotVersion: string | null;
  readonly verbose: boolean;
  readonly failsOnPushErrors: boolean;
}

/**
 * What `--whole-tree` prints: each script whose reads make the suites reaching it depend on every
 * file, with its first read by a path that could be anything and how many of the suites asked for
 * reach it from their own code and the autoloads.
 */
export function wholeTreeSaid(options: TestOptions): string[] {
  const scripts = new ProjectScripts(options.projectPath);
  const suites = selectedSuites(scripts, options).map((suite) => suite.path);
  const reads = new SuiteInputs(scripts, []).wholeTreeReads(suites);
  if (reads.length === 0) {
    return [`No script makes a suite depend on every file (${plural(suites.length, 'suite')} checked).`];
  }
  return reads.map(
    (read) =>
      `${read.path}:${String(read.line)}: ${read.argument} could be any path, reached by ${String(read.suites)} of ${plural(suites.length, 'suite')}.`,
  );
}

/** Runs the suites [param options] asks for with the engine at [param godotPath]. Answers the exit code. */
export async function runTestCommand(options: TestOptions, godotPath: string): Promise<number> {
  const unusable = gdUnit4Unusable(options.projectPath);
  if (unusable !== null) {
    throw new EngineUsageError(`${unusable.reason}. Install gdUnit4 6.0 or later under addons/gdUnit4.`);
  }
  const startedAt = Date.now();
  const scripts = new ProjectScripts(options.projectPath);
  const home = homeOf(options.projectPath);
  const state = join(home, '.godot', 'gdharness');
  const suites = selectedSuites(scripts, options);
  const uncollected = uncollectedSaid(scripts.uncollectedUnder(searchedRoots(options)));
  // Whole, whatever the selection asked of them: the cases an engine is to leave out are the rest.
  const wholeSuites = suites.map((suite) => scripts.suite(suite.path) ?? suite);
  const declared: CasesBySuite = new Map(wholeSuites.map((suite) => [suite.path, suite.cases]));
  const { launch, interrupted } = await openedRun(options, godotPath, scripts, state, startedAt);
  try {
    return await runStages({
      options,
      godotPath,
      startedAt,
      state,
      timesFile: options.timesFile ?? join(state, 'suite-times.json'),
      passedFile: join(state, 'suite-passed.json'),
      lastRunFile: join(state, LAST_RUN_FILE),
      suites,
      uncollected,
      wholeSuites,
      declared,
      launch,
    });
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

/** What the stages of one run share. */
interface RunContext {
  readonly options: TestOptions;
  readonly godotPath: string;
  readonly startedAt: number;
  /** The folder the project keeps what it learns across runs in. */
  readonly state: string;
  readonly timesFile: string;
  readonly passedFile: string;
  readonly lastRunFile: string;
  readonly suites: readonly DeclaredSuite[];
  readonly uncollected: readonly string[];
  readonly wholeSuites: readonly DeclaredSuite[];
  readonly declared: CasesBySuite;
  readonly launch: Launch;
}

/**
 * Opens a run: sweeps the folders old runs left, makes the run's own, takes the slots' directory
 * and answers the launch every engine starts from, with the handler that ends them on an interrupt,
 * which the caller takes off once the run is over.
 */
async function openedRun(
  options: TestOptions,
  godotPath: string,
  scripts: ProjectScripts,
  state: string,
  startedAt: number,
): Promise<{ readonly launch: Launch; readonly interrupted: () => void }> {
  const testRuns = join(options.projectPath, '.godot', 'gdharness', 'test-runs');
  const keptRuns = join(state, 'test-runs');
  const held = sweepRunDirectories(testRuns);
  if (keptRuns !== testRuns) {
    held.push(...sweepRunDirectories(keptRuns));
  }
  for (const directory of held) {
    console.log(heldRunSaid(directory));
  }
  const runName = `${String(startedAt)}-${String(process.pid)}`;
  const runDirectory = join(testRuns, runName);
  mkdirSync(runDirectory, { recursive: true });
  const logs = new RunLogs(runDirectory, keptRuns === testRuns ? null : join(keptRuns, runName));
  const chosen = machineSlots({ directory: options.slotsDirectory, count: options.slotCount });
  const slots = new EngineSlots(
    chosen.directory,
    chosen.count,
    { pid: process.pid, started: await ownStart(), by: `gdharness test of ${options.projectPath}` },
    (line) => {
      console.log(line);
    },
  );
  const running = new Set<() => void>();
  const interrupted = (): void => {
    for (const end of running) {
      end();
    }
    slots.releaseAll();
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const launch: Launch = {
    godotPath,
    projectPath: options.projectPath,
    runDirectory,
    logs,
    slots,
    silenceFloorSeconds: options.silenceSeconds,
    deadlineSeconds: options.deadlineSeconds,
    running,
    selfTyped: selfTypedExports(scripts.sources),
    godotVersion: options.godotVersion,
    cores: options.cores,
    verbose: options.verbose,
    failsOnPushErrors: gdUnitFailsOnPushErrors(options.projectPath),
  };
  return { launch, interrupted };
}

/** A run from its import to its report, answering the exit code. */
async function runStages(context: RunContext): Promise<number> {
  const { options, launch, godotPath, state, startedAt } = context;
  const failedImport = await importedFirst(context);
  if (failedImport !== null) {
    return failedImport;
  }
  // After the import, which writes the .import and .uid files beside what a suite loads.
  const suitesBegan = Date.now();
  // Read again from here, since a script edited during the import is loaded as it is now, and
  // one edited from here on is newer than suitesBegan, which keeps its pass unrecorded.
  const loaded = new ProjectScripts(options.projectPath);
  const always = [
    getLocalVersion(),
    readFileSync(shippedListedRunner(), 'utf8'),
    engineSaid(godotPath),
    ...reachedAlsoSaid(options.reachAlso),
  ];
  const compileKept = options.changedOnly
    ? { file: join(state, COMPILED_FILE), scripts: loaded, always }
    : null;
  const suites = options.changedOnly ? withoutTheUnchanged(context, loaded, always) : context.suites;
  if (options.changedOnly && suites.length === 0) {
    return await nothingChanged(context, compileKept);
  }
  const deal = await dealtRun(context, suites);
  // What the run said of its deal is kept with its outcome, since a gate keeps a passing step's
  // output nowhere and a slow pass could not be told from an uneven deal afterwards.
  const dealing: string[] = [];
  const say = (line: string): void => {
    dealing.push(line);
    console.log(line);
  };
  announceDeal(context, suites, deal, say);
  const started = await takenLanes(context, deal, say);
  // Once the lanes hold what slots were free, so it takes one only beside them.
  const handed = new HandedSlot();
  const compiling = compileUnlessUnchanged(launch, context.suites, compileKept, handed);
  // Awaited after the suites. A run failing before then reports its own error, not this one too.
  compiling.catch(() => undefined);
  const ran = await ranEngines(context, deal, started, handed, say);
  recordTimes(context, loaded, ran);
  const across = rowsAcross(ran.map((engine) => ({ handed: engine.plan.suites, printed: engine.printed })));
  const passKept = recordPassed(
    context.passedFile,
    options.projectPath,
    ran,
    new Set(across.map((fault) => fault.suite)),
    new SuiteInputs(loaded, always),
    suitesBegan,
    context.declared,
  );
  return report(
    ran,
    await compiling,
    across.map((fault) => fault.fault),
    context.uncollected,
    passKept ? [] : [unkeptSaid(context.passedFile)],
    startedAt,
    launch.logs,
    options.printOutput,
    {
      resultFile: options.resultFile,
      lastRunFile: context.lastRunFile,
      dealing,
      engines: options.engines,
      slotsFree: started.taken.length,
    },
  );
}

/** Imports the project where the run asks for it or it needs it, answering the exit code of a failed import. */
async function importedFirst(context: RunContext): Promise<number | null> {
  const { options, launch, startedAt, lastRunFile } = context;
  const needed = options.importFirst ? null : importNeeded(options.projectPath);
  if (needed !== null) {
    console.log(needed);
  }
  if (!options.importFirst && needed === null) {
    return null;
  }
  const imported = await importProject(launch);
  if (imported === null) {
    return null;
  }
  launch.logs.keep();
  const unwritten = writeEarlyResult(
    { resultFile: options.resultFile, lastRunFile, engines: options.engines },
    startedAt,
    [`the import failed: ${imported}`],
    launch.logs.shown,
  );
  console.log(`The import failed, so no suite ran: ${imported}`);
  return exitAfter(1, unwritten);
}

/** The suites of the run less those that passed on everything their engine loads as it stands now. */
function withoutTheUnchanged(
  context: RunContext,
  loaded: ProjectScripts,
  always: readonly string[],
): readonly DeclaredSuite[] {
  const inputs = new SuiteInputs(loaded, always);
  const passedBefore = readPassed(context.passedFile);
  const unchanged = context.suites.filter((suite) => {
    const passed = passedBefore[suite.path];
    return passed !== undefined && inputs.printOf(passed.inputs) === passed.print;
  });
  if (unchanged.length > 0) {
    console.log(
      `${plural(unchanged.length, 'suite')} passed on everything ${unchanged.length === 1 ? 'its engine' : 'their engines'} loaded as it stands now, and ${unchanged.length === 1 ? 'is' : 'are'} not run: ${named(unchanged.map((suite) => suite.path))}.`,
    );
  }
  return context.suites.filter((suite) => !unchanged.includes(suite));
}

/** Ends a run in which every suite last passed on what it loads now, answering the exit code. */
async function nothingChanged(context: RunContext, compileKept: CompileKept | null): Promise<number> {
  const { options, launch, uncollected, startedAt, lastRunFile } = context;
  console.log('Nothing has changed since every suite last passed.');
  const compiled = await compileUnlessUnchanged(launch, context.suites, compileKept);
  const problems = [...compiled.faults.map((fault) => `${COMPILE_CHECK}: ${fault}`), ...uncollected];
  if (problems.length === 0) {
    rmSync(launch.runDirectory, { recursive: true, force: true });
  } else {
    launch.logs.keep();
  }
  const unwritten = writeEarlyResult(
    { resultFile: options.resultFile, lastRunFile, engines: options.engines },
    startedAt,
    problems,
    problems.length === 0 ? null : launch.logs.shown,
  );
  if (problems.length === 0) {
    return exitAfter(0, unwritten);
  }
  printCompiled(compiled, launch.logs);
  printUncollected(uncollected);
  console.log('');
  console.log(`Failed: ${plural(problems.length, 'problem')}, listed above.`);
  return exitAfter(1, unwritten);
}

/** How many engines a size of engine has room for, given the memory a run may use. */
type Room = ReturnType<typeof roomFor>;

/** What a run was dealt: the times it went by, the room there was for engines, and the engines' shares. */
interface Deal {
  readonly times: SuiteTimes;
  /** The room memory leaves, which holds the run to fewer engines than the processors would. */
  readonly byMemory: Room;
  /** The room the run is dealt for: what the processors leave when memory holds it. */
  readonly room: Room;
  readonly memoryHeld: boolean;
  readonly units: readonly Unit[];
  readonly splitPast: number;
  readonly plans: readonly EnginePlan[];
}

/** The room [param bytes] of memory leaves for engines of the size the run's suites were seen to hold. */
function roomFinder(
  options: TestOptions,
  memory: Awaited<ReturnType<typeof memoryAvailable>>,
  suites: readonly DeclaredSuite[],
  times: SuiteTimes,
): (bytes: number) => Room {
  // Every engine is sized by the most any suite of the run was seen to hold, since the start does
  // not know which suites share an engine.
  const sized = peakOf(
    suites.map((suite) => suite.path),
    times,
    MEMORY_PER_ENGINE,
  );
  const perEngine = {
    bytes: sized.bytes,
    said: sized.seen
      ? 'taken for each engine, the most one holding these suites was seen to hold'
      : 'taken for each engine',
  };
  return (bytes) =>
    options.cores === null
      ? roomFor(options.engines, availableParallelism(), bytes, memory.said, undefined, perEngine)
      : roomFor(
          options.engines,
          options.cores,
          bytes,
          memory.said,
          `--cores holds it to ${plural(options.cores, 'processor')}`,
          perEngine,
        );
}

/** Sizes the engines of the run by the memory there is and deals the suites over them. */
async function dealtRun(context: RunContext, suites: readonly DeclaredSuite[]): Promise<Deal> {
  const { options, declared } = context;
  const times = readTimes(context.timesFile);
  const memory = await memoryAvailable();
  if (memory.unread !== undefined) {
    console.log(
      `Windows did not say how much memory it can still commit (${memory.unread}), so engines are sized by the physical memory free.`,
    );
  }
  const roomWith = roomFinder(options, memory, suites, times);
  const byMemory = roomWith(memory.bytes);
  // What the processors leave room for. Memory held a run to the engines it had room for at the
  // start for the whole of it, so one engine was dealt nearly everything while memory freed beside
  // it. Held by memory, the run is dealt for these and its engines start as memory has room.
  const unheld = roomWith(Number.POSITIVE_INFINITY);
  const unheldUnits = unitsOf(suites, times, splitPastFor(suites, times, unheld.engines));
  const heldLanes = lanesOf(dealt(unheldUnits, declared, unheld.engines));
  const memoryHeld = options.order === null && byMemory.engines < heldLanes;
  const room = memoryHeld ? unheld : byMemory;
  if (options.cores !== null && process.platform === 'darwin') {
    console.log(
      'macOS offers no way to hold a process to some processors, so --cores holds only the number of engines here.',
    );
  }
  const splitPast = splitPastFor(suites, times, room.engines);
  const units = memoryHeld ? unheldUnits : unitsOf(suites, times, splitPast);
  const plans =
    options.order === null
      ? dealt(units, declared, room.engines)
      : [inOneEngine(ordered(units, options.order, options.selected), declared)];
  return { times, byMemory, room, memoryHeld, units, splitPast, plans };
}

/** What the run says of its deal, ahead of the lines for each way the deal was cut. */
function dealSaid(context: RunContext, suites: readonly DeclaredSuite[], deal: Deal): string {
  const { options, declared } = context;
  const { times, room, plans } = deal;
  // Cut for the engines asked: held to fewer, the share grows and keeps whole what they would split.
  const asked = unitsOf(suites, times, splitPastFor(suites, times, options.engines));
  const how =
    options.order === null
      ? `${windowedSaid(plans)}${roomSaid(plans.length, lanesOf(plans), lanesOf(dealt(asked, declared, options.engines)), room.held, options.engines)}`
      : options.order === 'reversed'
        ? ', in reverse order of path'
        : options.order === 'named'
          ? ', in the order named'
          : `, shuffled by ${String(options.order)}`;
  const functions = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
  return `${plural(functions, 'test function')} in ${plural(suites.length, 'suite')} over ${plural(plans.length, 'engine')}${how}.`;
}

/** Says how the suites were dealt, and which were cut up, kept whole or given a window. */
function announceDeal(
  context: RunContext,
  suites: readonly DeclaredSuite[],
  deal: Deal,
  say: (line: string) => void,
): void {
  const { options } = context;
  const { units, plans, room, splitPast } = deal;
  say(dealSaid(context, suites, deal));
  const windowedAnyway = headlessInAWindow(plans, units);
  if (windowedAnyway.length > 0) {
    const one = windowedAnyway.length === 1;
    say(
      `${named(windowedAnyway)} ${one ? 'says it runs' : 'say they run'} headless and ${one ? 'runs' : 'run'} with a window here, since an ordered run is one engine and a suite in it needs a window. Run ${one ? 'it' : 'them'} without the windowed suites to run ${one ? 'it' : 'them'} headless.`,
    );
  }
  sayWhatWasCutUp(deal, say);
  // Said beside the deal, so a suite past the split in one engine reads as asked for, not missed.
  const keptWhole = units.flatMap((unit) =>
    unit.cost > splitPast && !unit.windowed && suites.some((s) => s.path === unit.suite && s.together)
      ? [unit.suite]
      : [],
  );
  // By the engines there was room for rather than those used: kept whole, it may need only one.
  if (options.order === null && room.engines > 1 && keptWhole.length > 0) {
    const one = keptWhole.length === 1;
    say(
      `Kept whole in one engine, since ${one ? 'it declares' : 'each declares'} GDHARNESS_TOGETHER: ${named(keptWhole)}.`,
    );
  }
}

/** Says which suites were dealt out case by case and which row by row. */
function sayWhatWasCutUp(deal: Deal, say: (line: string) => void): void {
  const { units, plans, splitPast } = deal;
  const past =
    splitPast > SPLIT_PAST_SECONDS
      ? `an engine's share of this run (${String(Math.round(splitPast))} s)`
      : `${String(SPLIT_PAST_SECONDS)} s`;
  const split = [...new Set(units.map((unit) => unit.suite))].filter(
    (path) => units.filter((unit) => unit.suite === path && unit.row === undefined).length > 1,
  );
  if (plans.length > 1 && split.length > 0) {
    say(
      `Dealt out case by case, since ${split.length === 1 ? 'it' : 'each'} took more than ${past} last time: ${named(split)}.`,
    );
  }
  const byRows = [
    ...new Set(
      units.flatMap((unit) => (unit.row === undefined ? [] : [`${unit.suite} > ${unit.cases[0] ?? ''}`])),
    ),
  ];
  if (plans.length > 1 && byRows.length > 0) {
    say(
      `Dealt out row by row, since ${byRows.length === 1 ? 'it' : 'each'} took more than ${past} last time: ${named(byRows)}.`,
    );
  }
}

/** The lanes of a deal, each engine with its place in the deal, and the slots taken for them. */
interface StartedLanes {
  readonly lanes: ReadonlyArray<ReadonlyArray<{ readonly plan: EnginePlan; readonly index: number }>>;
  readonly taken: readonly string[];
  /** Whether the engines are handed shares as slots come free, rather than one lane to a slot. */
  readonly shared: boolean;
}

/** Takes a slot for each lane where one is free now, and says what that leaves for the rest. */
async function takenLanes(
  context: RunContext,
  deal: Deal,
  say: (line: string) => void,
): Promise<StartedLanes> {
  const { options, launch } = context;
  const { plans, memoryHeld, byMemory } = deal;
  const lanes = [...new Set(plans.map((plan) => plan.lane))].map((lane) =>
    plans.flatMap((plan, index) => (plan.lane === lane ? [{ plan, index }] : [])),
  );
  // A slot for each lane, taken only where one is free now: what the run was dealt holds only when
  // every lane starts at once. Held by memory, only the lanes memory has room for take one now.
  // The rest take theirs in the slots' queue, then wait for memory holding them.
  const startable = memoryHeld ? Math.min(byMemory.engines, lanes.length) : lanes.length;
  const taken: string[] = [];
  while (taken.length < startable) {
    const lock = await launch.slots.takeFree();
    if (lock === null) {
      break;
    }
    taken.push(lock);
  }
  if (memoryHeld) {
    say(memorySaid(byMemory.engines, lanes.length, byMemory.held ?? ''));
  }
  const shared = options.order === null && lanes.length > 1 && (memoryHeld || taken.length < lanes.length);
  if (shared && taken.length < startable) {
    say(sharesSaid(taken.length, startable));
  }
  return { lanes, taken, shared };
}

/** Runs the engines of the deal, and runs again alone any that failed for want of memory. */
async function ranEngines(
  context: RunContext,
  deal: Deal,
  started: StartedLanes,
  handed: HandedSlot,
  say: (line: string) => void,
): Promise<EngineRan[]> {
  const { launch, declared } = context;
  const { units, times, memoryHeld } = deal;
  const { lanes, taken, shared } = started;
  const ran = shared
    ? await runShares(
        launch.slots,
        units,
        declared,
        lanes.length,
        taken,
        times,
        (plan, index, lock, holds) => runEngine(launch, plan, index, times, '', lock, holds),
        handed,
        memoryHeld ? new MemoryGate(launch.slots, async () => (await memoryAvailable()).bytes) : undefined,
      )
    : (await Promise.all(lanes.map((lane, at) => runLane(launch, lane, times, taken[at] ?? null, handed))))
        .flat()
        .toSorted((a, b) => a.index - b.index);
  if (ran.some((engine) => engine.verdict.starved) && ran.some((engine) => !engine.verdict.passed)) {
    say(outOfMemorySaid(ran));
    const again: EngineRan[] = [];
    for (const engine of ran) {
      again.push(
        engine.verdict.passed ? engine : await runEngine(launch, engine.plan, engine.index, times, 'again'),
      );
    }
    return again;
  }
  return ran;
}

/** Writes the times the engines measured, saying so where they could not be written. */
function recordTimes(context: RunContext, loaded: ProjectScripts, ran: readonly EngineRan[]): void {
  const { timesFile } = context;
  const timesKept = writeJson(
    timesFile,
    timesAfter(
      readTimes(timesFile),
      context.wholeSuites,
      ran,
      (path) => loaded.suite(path),
      new Set(
        ran.flatMap((engine) =>
          engine.plan.suites
            .filter((suite) => (engine.printed.suites.get(suite.path)?.closed ?? null) === null)
            .flatMap((suite) => suite.cases.map((func) => `${suite.path}:${func}`)),
        ),
      ),
    ),
  );
  if (!timesKept) {
    console.log(
      `The times could not be written to ${timesFile}, so the next run is dealt by what that file held before.`,
    );
  }
}

/**
 * What a run says when only [param free] of the slots its [param lanes] lanes take were free as it
 * began, so its engines are handed shares rather than the parts it announced.
 */
export function sharesSaid(free: number, lanes: number): string {
  return `${free === 0 ? 'None' : String(free)} of the ${String(lanes)} slots this run uses ${free === 1 ? 'was' : 'were'} free as it began, so its engines are handed the suites a share at a time as each starts, and an engine starts as each slot comes free.`;
}

/**
 * What a run says when memory had room for [param room] of its [param lanes] engines at once as it
 * began, for the reason [param held].
 */
export function memorySaid(room: number, lanes: number, held: string): string {
  return `Memory had room for ${room === 1 ? 'one' : String(room)} of these ${String(lanes)} engines at once as the run began, since ${held}, so its engines are handed the suites a share at a time, and another starts whenever memory has room for it.`;
}

/**
 * What a run says when an engine ran out of memory: the failed engines run again, and each
 * engine's most held in this run, or that it was not read, shows what else held the machine.
 */
export function outOfMemorySaid(engines: readonly Pick<EngineRan, 'index' | 'peakBytes'>[]): string {
  const held = engines
    .map(
      (engine) =>
        `engine ${String(engine.index)} ${engine.peakBytes === undefined ? 'unread' : gigabytes(engine.peakBytes)}`,
    )
    .join(', ');
  return `An engine ran out of memory, so every engine that failed runs again, one at a time. The most each held in this run: ${held}.`;
}

/** How often a share held back for memory reads it again. */
const MEMORY_LOOK_MS = 2000;

/** An engine a [class MemoryGate] let start, with what it needs and what it holds now. */
export interface Admitted {
  /** The memory it was admitted for. */
  readonly need: number;
  /** What it held at its last reading, 0 before the first. */
  held: number;
  /** Told once the engine has ended, so the gate stops counting it. */
  readonly ended: () => void;
  /** Told each reading of what the engine holds. */
  readonly holds: (bytes: number) => void;
}

/**
 * Lets the engines of a run that memory held start one at a time while the machine has room for
 * another, read again before each, so engines join as other work frees memory rather than the run
 * keeping all its life the count it had room for as it began. A going engine is counted at what it
 * has yet to take, its need less what it holds now, since what it holds already shows in the memory
 * read. The first engine of the run always starts, as a run held to one engine did. A wait keeps a
 * mark in the slots, as a wait for a slot does.
 */
export class MemoryGate {
  private readonly slots: Pick<EngineSlots, 'markWaiting'>;
  private readonly read: () => Promise<number>;
  private readonly lookMs: number;
  private readonly going = new Set<Admitted>();
  private turn: Promise<unknown> = Promise.resolve();

  constructor(slots: Pick<EngineSlots, 'markWaiting'>, read: () => Promise<number>, lookMs = MEMORY_LOOK_MS) {
    this.slots = slots;
    this.read = read;
    this.lookMs = lookMs;
  }

  /**
   * Waits until an engine needing [param need] has room, one caller at a time, and answers its
   * admission. [param need] is asked at each look, since the share a caller would draw changes as
   * others draw theirs.
   */
  admit(signal: AbortSignal, need: () => number): Promise<Admitted> {
    const admitted = this.turn.then(() => this.room(signal, need));
    this.turn = admitted.catch(() => undefined);
    return admitted;
  }

  private async room(signal: AbortSignal, need: () => number): Promise<Admitted> {
    let unmark: (() => void) | undefined;
    let needed = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        needed = need();
        // Summed before the read, as the memory read is taken before a reading told while it is
        // out. Summed after, that growth would count as owed no longer and as free memory too.
        const owed = [...this.going].reduce((sum, one) => sum + Math.max(0, one.need - one.held), 0);
        if (this.going.size === 0 || roomForAnother(await this.read(), owed, needed)) {
          break;
        }
        unmark ??= this.slots.markWaiting();
        await delay(this.lookMs, undefined, { signal });
      }
    } finally {
      unmark?.();
    }
    const engine: Admitted = {
      need: needed,
      held: 0,
      ended: () => {
        this.going.delete(engine);
      },
      holds: (bytes) => {
        engine.held = bytes;
      },
    };
    this.going.add(engine);
    return engine;
  }
}

/**
 * What the line announcing a dealt run says of the machine's room, after the window: nothing unless
 * what [param held] it kept its [param lanes] below the [param unheld] it would have dealt with the
 * [param asked] engines, since a run too small to fill more lanes was not held by anything. Its
 * [param engines] run [param lanes] at a time.
 */
export function roomSaid(
  engines: number,
  lanes: number,
  unheld: number,
  held: string | undefined,
  asked: number,
): string {
  if (held === undefined || lanes >= unheld) {
    return '';
  }
  return engines > lanes
    ? `, ${lanes === 1 ? 'one' : String(lanes)} at a time, since ${held}`
    : `, of the ${String(asked)} asked for, since ${held}`;
}

/** The suites [param file] keeps as passed, each with its inputs and their print. */
function readPassed(file: string): Record<string, PassedSuite> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const passed: Record<string, PassedSuite> = {};
  for (const [path, entry] of Object.entries(isRecord(parsed) ? parsed : {})) {
    const { print, inputs }: Record<string, unknown> = isRecord(entry) ? entry : {};
    if (typeof print === 'string' && isStringList(inputs)) {
      passed[path] = { print, inputs };
    }
  }
  return passed;
}

/**
 * Keeps each suite that passed with its inputs and their print, and drops each that did not. A suite
 * dealt out over several engines passed only if it passed in each, and its inputs are what each of
 * them loaded. One is not kept when its engine failed on something naming no suite, which any of
 * them may have caused, or when [param inputs] reads one of its inputs as changed after the suites
 * began at [param began], since the suite may have run on what was there before. A suite whose
 * script is gone from [param projectPath] is dropped too.
 *
 * A suite the engines were handed only some of the cases [param declared] gives it has not passed
 * as a whole. A pass of those cases leaves what was kept for it as it was, and a failure drops it.
 *
 * Answers whether [param file] was written.
 */
function recordPassed(
  file: string,
  projectPath: string,
  ran: readonly EngineRan[],
  failedAcross: ReadonlySet<string>,
  inputs: SuiteInputs,
  began: number,
  declared: CasesBySuite,
): boolean {
  const passed = readPassed(file);
  for (const path of Object.keys(passed)) {
    if (!existsSync(join(projectPath, path.slice('res://'.length)))) {
      delete passed[path];
    }
  }
  const { failedSomewhere, reached } = inputsReached(ran, failedAcross, inputs);
  const handed = casesHanded(ran);
  for (const path of new Set([...reached.keys(), ...failedSomewhere])) {
    const ranWhole = (declared.get(path) ?? []).every((func) => handed.get(path)?.has(func) ?? false);
    if (!ranWhole && !failedSomewhere.has(path)) {
      continue;
    }
    const kept = failedSomewhere.has(path) ? [] : inputsKept(reached.get(path));
    if (kept.length > 0 && !inputs.modifiedAfter(kept, began)) {
      passed[path] = { print: inputs.printOf(kept), inputs: kept };
    } else {
      delete passed[path];
    }
  }
  return writeJson(file, passed);
}

/** The inputs each suite of [param ran] loaded, and the suites that failed in some engine or across engines. */
function inputsReached(
  ran: readonly EngineRan[],
  failedAcross: ReadonlySet<string>,
  inputs: SuiteInputs,
): { readonly failedSomewhere: Set<string>; readonly reached: Map<string, Set<string>> } {
  const failedSomewhere = new Set<string>(failedAcross);
  const reached = new Map<string, Set<string>>();
  for (const engine of ran) {
    const passing = new Set(engine.verdict.unattributed ? [] : engine.verdict.passedSuites);
    const loaded = reachedBySuite(engine.reached);
    for (const { path } of engine.plan.suites) {
      const recorded = loaded.get(path);
      if (!passing.has(path) || recorded === undefined) {
        failedSomewhere.add(path);
        continue;
      }
      const into = reached.get(path) ?? new Set<string>();
      for (const one of inputs.inputsOfSuite(path, recorded)) {
        into.add(one);
      }
      reached.set(path, into);
    }
  }
  return { failedSomewhere, reached };
}

/** The cases of each suite that the engines of [param ran] were handed, over all of them. */
function casesHanded(ran: readonly EngineRan[]): Map<string, Set<string>> {
  const handed = new Map<string, Set<string>>();
  for (const suite of ran.flatMap((engine) => engine.plan.suites)) {
    const cases = handed.get(suite.path) ?? new Set<string>();
    for (const func of suite.cases) {
      cases.add(func);
    }
    handed.set(suite.path, cases);
  }
  return handed;
}

/** The inputs to keep for a suite that passed: every file, or the files it loaded, sorted. */
function inputsKept(loaded: ReadonlySet<string> | undefined): string[] {
  if (loaded === undefined) {
    return [];
  }
  return loaded.has(EVERY_FILE) ? [EVERY_FILE] : [...loaded].toSorted();
}

/**
 * The problem of a run that could not write what passed to [param file]. The file still holds the
 * passes before this run, so a suite that failed here would be left out of a `--changed-only` run.
 */
function unkeptSaid(file: string): string {
  return `what passed could not be written to ${file}, which still keeps a suite that failed here as passed for a --changed-only run`;
}

/**
 * The engine at [param godotPath] as the build it is, for a suite to have passed on: the file it is
 * past every link, so checkouts reaching one install through a junction each of their own key their
 * suites alike, and a pass kept in one is a pass in the next.
 */
export function engineSaid(godotPath: string): string {
  const engine = realpathSync.native(godotPath);
  const stat = statSync(engine);
  return `${engine}\n${String(stat.size)}\n${String(stat.mtimeMs)}`;
}

/**
 * The files at [param paths] a run was told its suites depend on, by what each holds and never by
 * where it lies. A game names one in a cache outside its checkouts, which sit at different depths,
 * and the same pins key the same suites in each. A file another process holds shut reads as a key
 * no later run can match, since what it will hold is not known yet.
 */
export function reachedAlsoSaid(paths: readonly string[]): string[] {
  const textOf = (file: string): string => {
    try {
      return readFileSync(file, 'latin1');
    } catch (error) {
      if (!cannotOpen(error)) {
        throw error;
      }
      return `unopened at ${String(Date.now())}`;
    }
  };
  return paths.map((path) => {
    if (!existsSync(path)) {
      return 'missing';
    }
    if (!statSync(path).isDirectory()) {
      return textOf(path);
    }
    // A folder is every file under it, each with where it lies.
    return readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted()
      .map((file) => `${relative(path, file).split(sep).join('/')}\n${textOf(file)}`)
      .join('\n');
  });
}

/** What compiling every script together found wrong, and where its engine's log is. */
interface Compiled {
  readonly faults: readonly string[];
  readonly log: string;
}

/** How a problem of the compile check is headed, in the output and the result. */
const COMPILE_CHECK = 'compiling every script together';

/**
 * The slot the compile check runs in, beside a run's suites: one free as it asks, or else the first
 * a lane of the same run is done with, handed over rather than given back, since another run waiting
 * would take it and leave this one waiting on slots held elsewhere after its suites had finished.
 */
class HandedSlot {
  private wanted = true;
  private handOver: (lock: string) => void = () => undefined;
  readonly lock = new Promise<string>((received) => {
    this.handOver = received;
  });

  /** Takes no slot after all, so every lane gives its own back to the machine. */
  decline(): void {
    this.wanted = false;
  }

  /** Hands [param lock] over when the check still wants a slot, and says whether it did. */
  give(lock: string): boolean {
    if (!this.wanted) {
      return false;
    }
    this.wanted = false;
    this.handOver(lock);
    return true;
  }
}

/** Gives [param lock] to the compile check waiting on [param handed], or back to the machine. */
function doneWith(slots: Pick<EngineSlots, 'release'>, lock: string, handed: HandedSlot | undefined): void {
  if (handed?.give(lock) !== true) {
    slots.release(lock);
  }
}

/**
 * Compiles [param suites] together beside every class of the game in an engine of its own, which
 * names every script that does not compile. Apart from the suites' engines, so those load only what
 * their suites do and what each records is what its suites could have used. Beside a run's suites
 * it runs in the slot [param handed] settles on. Alone, in the next slot free.
 */
async function compileCheck(
  launch: Launch,
  suites: readonly DeclaredSuite[],
  handed?: HandedSlot,
): Promise<Compiled> {
  const directory = join(launch.runDirectory, 'compile');
  mkdirSync(join(directory, 'user'), { recursive: true });
  const suitesFile = join(directory, 'suites.txt');
  writeFileSync(suitesFile, `${suites.map((suite) => suite.path).join('\n')}\n`);
  const args = [
    '--headless',
    '--audio-driver',
    'Dummy',
    '--path',
    launch.projectPath,
    '-s',
    shippedListedRunner(),
    '--',
    '--suites-in',
    suitesFile,
    '--compile-only',
  ];
  const log = join(directory, 'engine.log');
  let lock: string;
  if (handed === undefined) {
    lock = await launch.slots.take();
  } else {
    const free = await launch.slots.takeFree();
    if (free !== null && !handed.give(free)) {
      launch.slots.release(free);
    }
    lock = await handed.lock;
  }
  let end: EngineEnd;
  try {
    end = await watchedEngine(launch, lock, args, directory, log, launch.silenceFloorSeconds);
  } finally {
    launch.slots.release(lock);
  }
  return { faults: judgeCompile(readRun(readFileSync(log, 'utf8')), end), log };
}

/** Where a `--changed-only` run keeps what compiled together, and what it reads the files with. */
interface CompileKept {
  readonly file: string;
  readonly scripts: ProjectScripts;
  readonly always: readonly string[];
}

/**
 * The files compiling [param suites] together beside every class of the game reads, followed from
 * them and from each class the cache lists, and their print.
 */
function compiledPrint(
  kept: CompileKept,
  projectPath: string,
  suites: readonly DeclaredSuite[],
): { inputs: SuiteInputs; read: string[]; print: string } {
  const inputs = new SuiteInputs(kept.scripts, kept.always);
  const classes = [...(cachedClasses(projectPath)?.values() ?? [])];
  const read = inputs.inputsOf([...suites.map((suite) => suite.path), ...classes]);
  return { inputs, read, print: inputs.printOf(read) };
}

/**
 * Compiles [param suites] together as [method compileCheck] does, unless [param kept] holds the
 * print of the same files from when they last compiled together cleanly: then no engine starts and
 * no slot is taken, which a `--changed-only` run with nothing to run otherwise waited for. A clean
 * check is kept only when nothing it read changed while it ran.
 */
async function compileUnlessUnchanged(
  launch: Launch,
  suites: readonly DeclaredSuite[],
  kept: CompileKept | null,
  handed?: HandedSlot,
): Promise<Compiled> {
  if (kept === null) {
    return await compileCheck(launch, suites, handed);
  }
  const before = compiledPrint(kept, launch.projectPath, suites).print;
  if (readKeptPrint(kept.file) === before) {
    handed?.decline();
    console.log(
      'Every script compiled together on these same files when last checked, so it is not compiled again.',
    );
    return { faults: [], log: '' };
  }
  const began = Date.now();
  const compiled = await compileCheck(launch, suites, handed);
  const after = compiledPrint(kept, launch.projectPath, suites);
  if (compiled.faults.length === 0 && !after.inputs.modifiedAfter(after.read, began)) {
    writeJson(kept.file, { print: after.print });
  } else {
    rmSync(kept.file, { force: true });
  }
  return compiled;
}

/** The print [param file] keeps, or null. */
function readKeptPrint(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const print = isRecord(parsed) ? parsed['print'] : undefined;
    return typeof print === 'string' ? print : null;
  } catch {
    return null;
  }
}

/** Prints what [param compiled] found wrong under a heading of its own, with where its log is kept. */
function printCompiled(compiled: Compiled, logs: RunLogs): void {
  if (compiled.faults.length === 0) {
    return;
  }
  console.log('');
  console.log(`--- ${COMPILE_CHECK}:`);
  for (const fault of compiled.faults) {
    console.log(`  ${fault}`);
  }
  console.log(`everything it printed: ${logs.named(compiled.log)}`);
}

/**
 * Why the import engine that printed [param printed] failed, by the errors and warnings it printed,
 * or null. Godot's import exits 0 whatever it printed, and warns of a file it imported wrongly as
 * often as it errs on one it could not import.
 */
export function importFault(printed: RunPrinted): string | null {
  const first = printed.errors[0];
  if (first === undefined) {
    return null;
  }
  const warnings = printed.errors.filter((error) => error.warning).length;
  const errors = printed.errors.length - warnings;
  const counted = [
    ...(errors === 0 ? [] : [errors === 1 ? 'an engine error' : `${String(errors)} engine errors`]),
    ...(warnings === 0 ? [] : [warnings === 1 ? 'an engine warning' : `${String(warnings)} engine warnings`]),
  ].join(' and ');
  return `it printed ${counted}, the first ${first.warning ? 'warning' : 'error'} ${JSON.stringify(first.text)}`;
}

/**
 * Why no suite can run in the project before it is imported, said as the run says it, or null.
 *
 * gdUnit4's own runner extends classes only the class cache names, so a project without a cache
 * runs nothing, and a cache that lacks a class a script declares fails every suite reaching it. A
 * project with no extension list loads none of its extensions, so every script using a class one
 * adds fails to compile: setup writes the class cache without importing, which leaves exactly that.
 * A suite loading a file whose import is behind it runs against the old import and passes on what
 * the file no longer holds.
 */
export function importNeeded(projectPath: string): string | null {
  const cached = cachedClasses(projectPath);
  if (cached === null) {
    return 'The project has never been imported, so it is imported first.';
  }
  const unlisted = unlistedExtensions(projectPath);
  if (unlisted.length > 0) {
    return `No import has listed the project's extensions, ${named(unlisted)}, so the engine would load none of them, and the project is imported first.`;
  }
  const uncached = staleAgainst(cached, projectPath).toSorted();
  if (uncached.length > 0) {
    return `The class cache does not list ${named(uncached)} where the scripts declare ${uncached.length === 1 ? 'it' : 'them'}, so the project is imported first.`;
  }
  const behind = staleImports(projectPath);
  const [only] = behind;
  if (only !== undefined && behind.length === 1) {
    return `The import of ${only.path} is out of date, since ${only.reason}, so the project is imported first.`;
  }
  if (behind.length > 1) {
    return `The imports of ${named(behind.map((one) => one.path).toSorted())} are out of date, so the project is imported first.`;
  }
  return null;
}

/**
 * Imports the project once before the suites, as its own engine in a slot, answering why it failed
 * or null. Skipped when every imported file is current and the class cache lists every class the
 * scripts declare, which is all an import would change for the suites.
 */
async function importProject(launch: Launch): Promise<string | null> {
  const seeded = seedExtensionList(launch.projectPath);
  if (seeded !== null && seeded.length > 0) {
    console.log(`Wrote .godot/extension_list.cfg naming ${named(seeded)}, so the import loads them.`);
  }
  const cached = cachedClasses(launch.projectPath);
  const stale = staleImports(launch.projectPath);
  if (
    (seeded === null || seeded.length === 0) &&
    cached !== null &&
    staleAgainst(cached, launch.projectPath).length === 0 &&
    stale.length === 0
  ) {
    console.log('The import was skipped: every imported file and the class cache are current.');
    return null;
  }
  const directory = join(launch.runDirectory, 'import');
  mkdirSync(join(directory, 'user'), { recursive: true });
  const log = join(directory, 'import.log');
  const lock = await launch.slots.take();
  try {
    // An editor open on the project holds the copies of its extension libraries, and an import
    // that cannot copy one runs without the extension.
    freeLibraryCopies(launch.projectPath);
    // The engine's scan without the editor's cache passes over a sidecar that names no output, so
    // every file found behind is marked for the import rather than left to the scan's judgement.
    for (const one of stale) {
      forceNextImport(launch.projectPath, one.path);
    }
    const ended = await watchedEngine(
      launch,
      lock,
      ['--headless', '--audio-driver', 'Dummy', '--path', launch.projectPath, '--import'],
      directory,
      log,
      launch.silenceFloorSeconds,
    );
    const end = importEnd(ended);
    if (end !== null) {
      return `${end}, and everything it printed is in ${launch.logs.named(log)}`;
    }
    // Godot's import exits 0 whatever it printed, and a suite run on a failed import reads what
    // the import left behind.
    const printed = readRun(readLog(log));
    const wrongEngine =
      launch.godotVersion === null ? null : versionFault(printed.engineVersion, launch.godotVersion);
    if (wrongEngine !== null) {
      return `${wrongEngine}, and everything it printed is in ${launch.logs.named(log)}`;
    }
    const fault = importFault(printed);
    return fault === null ? null : `${fault}, and everything it printed is in ${launch.logs.named(log)}`;
  } finally {
    launch.slots.release(lock);
  }
}

/**
 * What an import failed on when its engine ended as [param ended], or null when the engine exited 0
 * of its own accord. One ended by a signal has no exit code, and is not one that exited 0.
 */
export function importEnd(ended: EngineEnd): string | null {
  if (ended.ended !== null) {
    return ended.ended;
  }
  if (ended.code === null) {
    return `the engine was ended by ${ended.signal ?? 'a signal'}`;
  }
  return ended.code === 0 ? null : `the engine exited ${exitNamed(ended.code)}`;
}

/**
 * Runs the engines of one lane one after another in a single slot, taken before the first and given
 * back after the last, so another run on the machine cannot take it in between.
 */
async function runLane(
  launch: Launch,
  lane: ReadonlyArray<{ readonly plan: EnginePlan; readonly index: number }>,
  times: SuiteTimes,
  taken: string | null,
  handed?: HandedSlot,
): Promise<EngineRan[]> {
  const lock = taken ?? (await launch.slots.take());
  try {
    const ran: EngineRan[] = [];
    for (const { plan, index } of lane) {
      ran.push(await runEngine(launch, plan, index, times, '', lock));
    }
    return ran;
  } finally {
    doneWith(launch.slots, lock, handed);
  }
}

/**
 * Runs [param units] over [param lanes] lanes handed a share at a time (see [class Shares]), the
 * lanes holding the slots in [param taken] at once and the rest as slots come free, and each engine
 * starting only once [param memory] has room for what its share was seen to hold in [param times],
 * when the run is held by memory. A lane still
 * waiting once every share is handed out stops waiting: a slot somebody else holds is not to keep a
 * run open that has nothing left to give it. A lane takes its slot before it waits for memory, so
 * an engine memory admits never waits for one.
 */
export async function runShares<T extends { readonly index: number }>(
  slots: Pick<EngineSlots, 'take' | 'release'>,
  units: readonly Unit[],
  declared: CasesBySuite,
  lanes: number,
  taken: readonly string[],
  times: SuiteTimes,
  run: (plan: EnginePlan, index: number, lock: string, holds?: (bytes: number) => void) => Promise<T>,
  handed?: HandedSlot,
  memory?: MemoryGate,
): Promise<T[]> {
  const shares = new Shares(units, declared, lanes);
  const handedOut = new AbortController();
  let engines = 0;
  // Asked through a call, since another lane empties it while this one waits.
  const empty = (): boolean => shares.empty;
  // The share this lane would draw now, read at each look. Nothing is awaited between the admission
  // and the draw, so the share it was admitted for is the one it draws.
  const needed = (): number => peakOf(shares.peek(), times, MEMORY_PER_ENGINE).bytes;
  /**
   * Takes the lane's slot and the memory its next share needs, draws the share and numbers its
   * engine, or answers null once every share is handed out. Nothing is awaited between the
   * admission and the draw.
   */
  const admit = async (
    at: number,
    held: { lock: string | null },
  ): Promise<{
    readonly lock: string;
    readonly admitted: Admitted | undefined;
    readonly plan: EnginePlan;
    readonly index: number;
  } | null> => {
    let admitted: Admitted | undefined;
    try {
      held.lock ??= await slots.take(handedOut.signal);
      admitted = await memory?.admit(handedOut.signal, needed);
    } catch (error) {
      if (handedOut.signal.aborted) {
        return null;
      }
      throw error;
    }
    const plan = shares.next(at);
    if (plan === null) {
      admitted?.ended();
      return null;
    }
    if (empty()) {
      handedOut.abort();
    }
    const index = engines;
    engines += 1;
    return { lock: held.lock, admitted, plan, index };
  };
  /** Runs a drawn share, ending its admission once it is over. */
  const runDrawn = async (drawn: {
    readonly lock: string;
    readonly admitted: Admitted | undefined;
    readonly plan: EnginePlan;
    readonly index: number;
  }): Promise<T> => {
    try {
      return await run(drawn.plan, drawn.index, drawn.lock, drawn.admitted?.holds);
    } finally {
      drawn.admitted?.ended();
    }
  };
  const lane = async (at: number): Promise<T[]> => {
    const held = { lock: taken[at] ?? null };
    const ran: T[] = [];
    try {
      while (!empty()) {
        const drawn = await admit(at, held);
        if (drawn === null) {
          break;
        }
        ran.push(await runDrawn(drawn));
      }
      return ran;
    } finally {
      if (held.lock !== null) {
        doneWith(slots, held.lock, handed);
      }
    }
  };
  return (await Promise.all(Array.from({ length: lanes }, (_, at) => lane(at))))
    .flat()
    .toSorted((a, b) => a.index - b.index);
}

/** The files an engine is handed or writes, each named in its arguments. */
interface EngineFiles {
  readonly suites: string;
  readonly skipping: string;
  readonly rows: string;
  readonly expected: string;
  readonly reached: string;
}

/** Writes what [param plan] hands its engine to read into [param directory], and names the files. */
function writtenEngineFiles(plan: EnginePlan, directory: string): EngineFiles {
  const files: EngineFiles = {
    suites: join(directory, 'suites.txt'),
    skipping: join(directory, 'skipping.txt'),
    rows: join(directory, 'rows.txt'),
    expected: join(directory, 'expected.json'),
    reached: join(directory, 'reached.jsonl'),
  };
  writeFileSync(files.suites, `${plan.suites.map((suite) => suite.path).join('\n')}\n`);
  writeFileSync(files.skipping, `${plan.skipping.join('\n')}\n`);
  writeFileSync(
    files.rows,
    `${plan.suites
      .flatMap((suite) =>
        Object.entries(suite.rows ?? {}).map(([func, share]) =>
          [
            `${suite.path}:${func}`,
            ...('only' in share ? ['only', ...share.only] : ['besides', ...share.besides]),
          ].join('\t'),
        ),
      )
      .join('\n')}\n`,
  );
  return files;
}

/** The flags that start an engine headless, or windowed at the project's own size. */
function displayFlags(launch: Launch, plan: EnginePlan): string[] {
  if (!plan.windowed) {
    return ['--headless'];
  }
  const viewport = viewportOf(launch.projectPath);
  // On Windows every engine runs on the hidden desktop, so a windowed one starts with its flags.
  return [
    ...(viewport === null ? [] : ['--resolution', `${String(viewport.width)}x${String(viewport.height)}`]),
    ...(process.platform === 'win32' ? hiddenWindowFlags([], capsFrames(launch.projectPath)) : []),
  ];
}

/** The arguments an engine running [param plan] in [param directory] starts with. */
function engineArguments(launch: Launch, plan: EnginePlan, directory: string, files: EngineFiles): string[] {
  return [
    ...displayFlags(launch, plan),
    '--audio-driver',
    'Dummy',
    ...(plan.accessible ? ['--accessibility', 'always'] : []),
    '--path',
    launch.projectPath,
    ...(launch.verbose ? ['--verbose'] : []),
    '-s',
    shippedListedRunner(),
    ...(plan.windowed ? [] : ['--ignoreHeadlessMode']),
    '-c',
    // Named from res://, since gdUnit4 reads a path starting with a slash as one under res://: an
    // absolute path on Linux or macOS would put the reports in a tree of their own in the project.
    '-rd',
    `res://${relative(launch.projectPath, join(directory, 'reports')).split(sep).join('/')}`,
    '-rc',
    '1',
    '--',
    '--suites-in',
    files.suites,
    '--skipping-in',
    files.skipping,
    '--rows-in',
    files.rows,
    '--html-report-off',
    '--junit-report-off',
    '--compile-together',
    '--expected-out',
    files.expected,
    '--reached-out',
    files.reached,
  ];
}

/**
 * Runs [param plan] in an engine of its own, in the slot [param slot] when its lane holds one and
 * otherwise once a slot is free, and judges what it printed. [param holds] is told each reading of
 * what the engine holds.
 */
async function runEngine(
  launch: Launch,
  plan: EnginePlan,
  index: number,
  times: SuiteTimes,
  again = '',
  slot: string | null = null,
  holds?: (bytes: number) => void,
): Promise<EngineRan> {
  const directory = join(launch.runDirectory, `engine-${String(index)}${again === '' ? '' : `-${again}`}`);
  mkdirSync(join(directory, 'user'), { recursive: true });
  const files = writtenEngineFiles(plan, directory);
  const args = engineArguments(launch, plan, directory, files);
  const reached = files.reached;
  const expectedFile = files.expected;
  const log = join(directory, 'engine.log');
  const lock = slot ?? (await launch.slots.take());
  const began = Date.now();
  let end: EngineEnd;
  try {
    end = await watchedEngine(
      launch,
      lock,
      args,
      directory,
      log,
      launch.silenceFloorSeconds,
      (printed) => silenceWhile(printed.running, times, launch.silenceFloorSeconds),
      holds,
    );
  } finally {
    if (slot === null) {
      launch.slots.release(lock);
    }
  }
  const printed = readRun(readLog(log));
  const assignment: EngineAssignment = {
    suites: plan.suites,
    expected: readExpected(expectedFile),
    selfTyped: launch.selfTyped,
    godotVersion: launch.godotVersion,
    failsOnPushErrors: launch.failsOnPushErrors,
  };
  const judged = judgeEngine(printed, assignment, end);
  const written = reportsFault(join(directory, 'reports'));
  return {
    index,
    plan,
    printed,
    verdict: written === null ? judged : { ...judged, passed: false, faults: [...judged.faults, written] },
    log,
    began,
    seconds: (Date.now() - began) / 1000,
    again: again !== '',
    reached,
    ...(end.peakBytes === undefined ? {} : { peakBytes: end.peakBytes }),
  };
}

/** How many of the files written into a report folder that was turned off are named. */
const REPORT_FILES_NAMED = 3;

/**
 * What fails an engine that wrote a file into [param reports], the folder its gdUnit4 reports go to,
 * or null when it wrote none. The runner turns off both reports by marking their session hooks, so a
 * file there means the gdUnit4 installed no longer reads that mark: every run then writes reports it
 * was told not to, and the hook the runner reads the registration of is no proof of it.
 */
export function reportsFault(reports: string): string | null {
  const files = existsSync(reports)
    ? readdirSync(reports, { recursive: true, encoding: 'utf8' })
        .filter((file) => statSync(join(reports, file)).isFile())
        .toSorted()
    : [];
  if (files.length === 0) {
    return null;
  }
  const shown = files.slice(0, REPORT_FILES_NAMED).map((file) => file.split(sep).join('/'));
  const more = files.length - shown.length;
  return `gdUnit4 wrote ${plural(files.length, 'file')} into ${reports} (${shown.join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}), a report the runner had turned off, so the gdUnit4 installed no longer honours a session hook marked off. Report it to gdharness with gdUnit4's version`;
}

/** Prints how the run went and answers the exit code: what failed, in full, then one line of totals. */
function report(
  ran: readonly EngineRan[],
  compiled: Compiled,
  across: readonly string[],
  uncollected: readonly string[],
  unkept: readonly string[],
  startedAt: number,
  logs: RunLogs,
  printOutput: boolean,
  targets: ResultTargets,
): number {
  // Ahead of the verdict, so the last lines are still how the run went.
  if (printOutput) {
    printWhatEnginesPrinted(ran);
  }
  const failed = ran.filter((engine) => !engine.verdict.passed);
  printFailedEngines(failed, logs);
  printNotCounted(ran);
  printSection('the cases dealt by their rows, over every engine holding them:', across);
  printCompiled(compiled, logs);
  printUncollected(uncollected);
  printSection('what this run keeps for the next:', unkept);
  const took = (Date.now() - startedAt) / 1000;
  const closed = closedSuitesOf(ran);
  printTimings(ran, closed);
  const totals = totalsSaid(ran, took);
  console.log('');
  const outside = [...across, ...uncollected, ...unkept];
  const passed = failed.length === 0 && compiled.faults.length === 0 && outside.length === 0;
  if (passed) {
    rmSync(logs.directory, { recursive: true, force: true });
  } else {
    logs.keep();
  }
  const unwritten = writeResult(targets, {
    passed,
    seconds: took,
    problems: [
      ...failed.flatMap((engine) =>
        engine.verdict.faults.map((fault) => `engine ${String(engine.index)}: ${fault}`),
      ),
      ...compiled.faults.map((fault) => `${COMPILE_CHECK}: ${fault}`),
      ...outside,
    ],
    suites: closed,
    engines: engineRecordsOf(ran, startedAt, passed ? null : logs),
    logs: passed ? null : logs.shown,
    enginesAsked: targets.engines,
    slotsFree: targets.slotsFree,
    dealing: targets.dealing,
  });
  if (passed) {
    console.log(`Passed: ${totals}`);
    return exitAfter(0, unwritten);
  }
  const problems = failed.reduce(
    (sum, engine) => sum + engine.verdict.faults.length,
    compiled.faults.length + outside.length,
  );
  console.log(`Failed: ${plural(problems, 'problem')}, listed above. Ran ${totals}`);
  console.log(
    `Every engine's output is kept under ${logs.shown} until ${String(KEPT_RUN_DIRECTORIES)} later runs have failed.`,
  );
  if (logs.shown !== logs.directory) {
    console.log(
      `That is a copy beside the main checkout. The run wrote them under ${logs.directory} in this worktree, and they go with it when the worktree is removed.`,
    );
  }
  return exitAfter(1, unwritten);
}

/** Prints everything each engine printed, headed by the suites it ran. */
function printWhatEnginesPrinted(ran: readonly EngineRan[]): void {
  for (const engine of ran) {
    console.log('');
    console.log(
      `--- what engine ${String(engine.index)} printed, running ${named(engine.plan.suites.map((suite) => suite.path))}:`,
    );
    console.log(readLog(engine.log).replace(CONTROL_SEQUENCE, '').trimEnd());
  }
}

/** Prints what failed in each engine of [param failed], and notes it at the top of its kept log. */
function printFailedEngines(failed: readonly EngineRan[], logs: RunLogs): void {
  for (const engine of failed) {
    const heading = `--- engine ${String(engine.index)}: ${plural(engine.plan.suites.length, 'suite')}, ${engine.seconds.toFixed(1)} s${engine.again ? ', run again alone after an engine ran out of memory, and failed again' : ''}`;
    console.log('');
    console.log(heading);
    for (const fault of engine.verdict.faults) {
      console.log(`  ${fault}`);
    }
    // At the top of the kept log, so the file says why on its own, even when the engine printed nothing.
    const verdict = [`gdharness: ${heading.slice(4)}`, ...engine.verdict.faults.map((fault) => `  ${fault}`)];
    prependTo(engine.log, `${verdict.join('\n')}\n---\n`);
    if (engine.verdict.shown.length > 0) {
      console.log('');
      for (const line of engine.verdict.shown) {
        console.log(line);
      }
    }
    console.log(`everything it printed: ${logs.named(engine.log)}`);
  }
}

/** Prints the notes of the engines that have some, which do not count against the run. */
function printNotCounted(ran: readonly EngineRan[]): void {
  for (const engine of ran.filter((one) => one.verdict.notes.length > 0)) {
    console.log('');
    console.log(`--- engine ${String(engine.index)}, not counted against the run:`);
    for (const note of engine.verdict.notes) {
      console.log(`  ${note}`);
    }
  }
}

/** Prints [param lines] under [param heading], or nothing when there are none. */
function printSection(heading: string, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log('');
  console.log(`--- ${heading}`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

/** The suites that ended in [param ran], slowest first, each with its time and the engine it ran in. */
function closedSuitesOf(ran: readonly EngineRan[]) {
  return ran
    .flatMap((engine) =>
      [...engine.printed.suites.values()].flatMap((suite) =>
        suite.closed === null
          ? []
          : [
              {
                path: suite.path,
                seconds: suite.closed.seconds,
                loadSeconds: suite.setUp?.loadSeconds ?? null,
                beforeSeconds: suite.setUp?.beforeSeconds ?? null,
                verdict: suite.closed.verdict,
                engine: engine.index,
              },
            ],
      ),
    )
    .toSorted((a, b) => b.seconds - a.seconds);
}

/** Prints what each engine took beside what it was dealt, how they started and the slowest suites. */
function printTimings(ran: readonly EngineRan[], closed: ReturnType<typeof closedSuitesOf>): void {
  // What each engine took beside what it was dealt, so an uneven deal is told from a slow suite.
  if (ran.length > 1) {
    console.log('');
    console.log(
      `The engines took ${ran.map((engine) => `${engine.seconds.toFixed(1)} s`).join(', ')}, dealt ${ran.map((engine) => `${engine.plan.cost.toFixed(1)} s`).join(', ')}.`,
    );
  }
  const starts = ran.flatMap((engine) => (engine.printed.started === null ? [] : [engine.printed.started]));
  if (starts.length > 0) {
    console.log(startsSaid(starts));
  }
  const slowest = closed.slice(0, SLOWEST_NAMED);
  if (slowest.length > 1) {
    console.log(
      `The slowest suites: ${slowest.map((suite) => `${suite.path} ${suite.seconds.toFixed(1)} s`).join(', ')}.`,
    );
  }
}

/** The line of totals a run ends on: its cases, suites, engines and times. */
function totalsSaid(ran: readonly EngineRan[], took: number): string {
  const cases = ran.reduce(
    (sum, engine) => sum + [...engine.printed.suites.values()].reduce((n, s) => n + s.cases.length, 0),
    0,
  );
  const suites = new Set(ran.flatMap((engine) => engine.plan.suites.map((suite) => suite.path))).size;
  const longest = Math.max(0, ...ran.map((engine) => engine.seconds));
  return `${plural(cases, 'case')} in ${plural(suites, 'suite')} ${acrossSaid(ran)}, ${took.toFixed(1)} s. The longest engine took ${longest.toFixed(1)} s.`;
}

/** What the result file records of each engine, with the log a failed run keeps, named through [param logs]. */
function engineRecordsOf(ran: readonly EngineRan[], startedAt: number, logs: RunLogs | null) {
  return ran.map((engine) => ({
    index: engine.index,
    lane: engine.plan.lane,
    startedAfter: (engine.began - startedAt) / 1000,
    seconds: engine.seconds,
    startSeconds: engine.printed.started?.seconds ?? null,
    compiledSeconds: engine.printed.started?.compiledSeconds ?? null,
    dealt: engine.plan.cost,
    passed: engine.verdict.passed,
    windowed: engine.plan.windowed,
    suites: engine.plan.suites.map((suite) => suite.path),
    peakBytes: engine.peakBytes ?? null,
    log: logs === null ? null : logs.named(engine.log),
  }));
}

/**
 * The line saying what [param starts], one for each engine that opened a session, spent before the
 * first suite: time no suite's or case's figure holds.
 */
export function startsSaid(starts: readonly EngineStart[]): string {
  const seconds = (all: readonly number[]): string => all.map((one) => `${one.toFixed(1)} s`).join(', ');
  const one = starts.length === 1;
  return `Before ${one ? 'its' : 'their'} first suite the ${one ? 'engine' : 'engines'} spent ${seconds(starts.map((start) => start.seconds))} starting, ${seconds(starts.map((start) => start.compiledSeconds))} of it compiling the suites together.`;
}

/** Writes the result of a run that started no suite engine, and answers the files it could not write. */
function writeEarlyResult(
  targets: Pick<ResultTargets, 'resultFile' | 'lastRunFile' | 'engines'>,
  startedAt: number,
  problems: readonly string[],
  logs: string | null,
): string[] {
  return writeResult(targets, {
    passed: problems.length === 0,
    seconds: (Date.now() - startedAt) / 1000,
    problems,
    suites: [],
    engines: [],
    logs,
    enginesAsked: targets.engines,
    slotsFree: 0,
    dealing: [],
  });
}

/**
 * How many engines [param ran] took, for the closing line, with the most that ran at once when that
 * is fewer. A run handed out a share at a time starts more engines than --engines, never more at
 * once, and a count of every engine it started read as the cap not holding.
 */
export function acrossSaid(ran: readonly Pick<EngineRan, 'began' | 'seconds'>[]): string {
  const together = mostAtOnce(ran);
  const atOnce = together < ran.length ? ` (at most ${String(together)} at once)` : '';
  return `across ${plural(ran.length, 'engine')}${atOnce}`;
}

/** The most engines of [param ran] that ran at the same moment. One ending as another begins is not. */
function mostAtOnce(ran: readonly Pick<EngineRan, 'began' | 'seconds'>[]): number {
  const changes = ran
    .flatMap((engine): [number, number][] => [
      [engine.began, 1],
      [engine.began + engine.seconds * 1000, -1],
    ])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let most = 0;
  for (const [, change] of changes) {
    running += change;
    most = Math.max(most, running);
  }
  return most;
}

/**
 * Writes [param result] to the last run's file, and to --result's when it was given. Answers the
 * files it could not write, which still hold an earlier run's result.
 */
function writeResult(
  targets: Pick<ResultTargets, 'resultFile' | 'lastRunFile'>,
  result: RunResult,
): string[] {
  const files = [targets.lastRunFile, ...(targets.resultFile === null ? [] : [targets.resultFile])];
  return files.filter((file) => !writeJson(file, result));
}

/**
 * The exit code of a run that came to [param code], once it has said which result files in
 * [param unwritten] it could not write. Such a run fails: whatever reads the file next would take
 * the earlier run's result in it for this one's.
 */
function exitAfter(code: number, unwritten: readonly string[]): number {
  for (const file of unwritten) {
    console.log(
      `The result could not be written to ${file}, which holds an earlier run's or nothing, so this run exits 1.`,
    );
  }
  return unwritten.length > 0 ? 1 : code;
}

/**
 * Writes the result of a run that [param error] ended before any engine started, so the files do
 * not go on holding the run before it.
 */
export function writeRefusedResult(options: TestOptions, startedAt: number, error: unknown): void {
  writeEarlyResult(
    {
      resultFile: options.resultFile,
      lastRunFile: join(homeOf(options.projectPath), '.godot', 'gdharness', LAST_RUN_FILE),
      engines: options.engines,
    },
    startedAt,
    [error instanceof Error ? error.message : String(error)],
    null,
  );
}

/** Lists [param uncollected], the scripts declaring cases gdUnit4 never runs, under a heading of their own. */
function printUncollected(uncollected: readonly string[]): void {
  if (uncollected.length === 0) {
    return;
  }
  console.log('');
  console.log('--- scripts among the suites that gdUnit4 never runs:');
  for (const fault of uncollected) {
    console.log(`  ${fault}`);
  }
}
