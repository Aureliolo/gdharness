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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { cachedClasses, staleAgainst } from './class-cache.js';
import {
  CONTROL_SEQUENCE,
  coresNamed,
  type EngineLaunch,
  EngineUsageError,
  godotNamed,
  homeOf,
  KEPT_RUN_DIRECTORIES,
  MOST_ENGINES,
  memoryAvailable,
  plural,
  resPathOf,
  roomFor,
  SILENCE_FLOOR_SECONDS,
  sweepRunDirectories,
  versionNamed,
  watchedEngine,
  wholeFlag,
} from './engine-launch.js';
import { type SelfTypedExport, selfTypedExports } from './engine-leaks.js';
import { EngineSlots, machineSlots, ownStart } from './engine-slots.js';
import { staleImports } from './import-freshness.js';
import { hiddenWindowFlags } from './launch.js';
import { freeLibraryCopies, seedExtensionList } from './library-copies.js';
import { gdUnit4Unusable, shippedListedRunner } from './setup.js';
import { EVERY_FILE, type PassedSuite, reachedBySuite, SuiteInputs } from './suite-inputs.js';
import {
  type EngineAssignment,
  type EngineEnd,
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

export interface TestOptions {
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
  readonly reachAlso: readonly string[];
  readonly importFirst: boolean;
  /** Every suite in one engine in this order: `reversed`, or shuffled by the seed. */
  readonly order: 'reversed' | number | null;
  /** Print what each engine printed, after the run and before its verdict. */
  readonly printOutput: boolean;
  /** Start every engine with `--verbose`, so a leak at exit is named by what was left. */
  readonly verbose: boolean;
  /** Where the run writes its result as JSON ([type RunResult]), or null for nowhere. */
  readonly resultFile: string | null;
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
    readonly seconds: number;
    /** gdUnit4's word for it, such as `PASSED` or `FAILED`. */
    readonly verdict: string;
    readonly engine: number;
  }[];
  readonly engines: readonly {
    readonly index: number;
    /** The slot's lane it was dealt to; the engines of one lane run one after another. */
    readonly lane: number;
    /** When it started, in seconds after the command did, once it had a slot. */
    readonly startedAfter: number;
    readonly seconds: number;
    /** What the deal expected it to take, from the times kept. */
    readonly dealt: number;
    readonly passed: boolean;
    readonly windowed: boolean;
    /** The suites it was handed, a suite dealt by its cases or rows once for each engine holding part. */
    readonly suites: readonly string[];
    /** Where its whole output is kept, or null once a passing run has removed it. */
    readonly log: string | null;
  }[];
  /** The directory every engine's output is kept under, or null when the run removed it. */
  readonly logs: string | null;
  /** The engines asked for, before the room on the machine and the slots held the run to fewer. */
  readonly enginesAsked: number;
  /** How many of the slots its lanes take were free as it began; fewer than the lanes is a shared run. */
  readonly slotsFree: number;
  /** What the run printed of its deal: the engines, what it split, and what held it. */
  readonly dealing: readonly string[];
}

/**
 * The file beside the kept suite times that every run writes its result to, whatever --result says,
 * so a run in a gate that keeps none of a passing step's output can still be read afterwards.
 */
const LAST_RUN_FILE = 'last-run.json';

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
]);
const SWITCHES = new Set(['--changed-only', '--import', '--print-output', '--verbose']);

/** [param args], everything after `test`, read into options; relative paths are read from [param cwd]. */
export function testOptionsOf(args: readonly string[], cwd: string): TestOptions {
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
      if (value === undefined || value.startsWith('--')) {
        throw new EngineUsageError(`${arg} needs a value.`);
      }
      valued.set(arg, [...(valued.get(arg) ?? []), value]);
      at += 1;
    } else {
      throw new EngineUsageError(`Unknown option ${arg} for gdharness test. Run gdharness help.`);
    }
  }
  const first = positional[0];
  const named = first === undefined ? null : resolve(cwd, first);
  const projectNamed = named !== null && existsSync(join(named, 'project.godot'));
  const projectPath = projectNamed ? named : resolve(cwd);
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new EngineUsageError(`Not a Godot project: ${projectPath} holds no project.godot.`);
  }
  const last = (flag: string): string | undefined => valued.get(flag)?.at(-1);
  const order = last('--order');
  return {
    projectPath,
    selected: positional.slice(projectNamed ? 1 : 0).map((entry) => resPathOf(entry, projectPath, cwd)),
    engines: wholeFlag(last('--engines'), '--engines') ?? MOST_ENGINES,
    slotsDirectory: last('--slots') === undefined ? null : resolve(cwd, last('--slots') ?? ''),
    slotCount: wholeFlag(last('--slot-count'), '--slot-count'),
    silenceSeconds: wholeFlag(last('--silence'), '--silence') ?? SILENCE_FLOOR_SECONDS,
    deadlineSeconds: wholeFlag(last('--deadline'), '--deadline'),
    godotPath: godotNamed(last('--godot'), cwd),
    godotVersion: versionNamed(last('--godot-version')),
    cores: coresNamed(last('--cores')),
    roots: (valued.get('--tests') ?? []).map((root) => resPathOf(root, projectPath, cwd).replace(/\/$/, '')),
    changedOnly: switches.has('--changed-only'),
    reachAlso: (valued.get('--reach-also') ?? []).map((path) => resolve(projectPath, path)),
    importFirst: switches.has('--import'),
    order: order === undefined ? null : order === 'reversed' ? 'reversed' : seedOf(order),
    printOutput: switches.has('--print-output'),
    verbose: switches.has('--verbose'),
    resultFile: last('--result') === undefined ? null : resolve(cwd, last('--result') ?? ''),
  };
}

function seedOf(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new EngineUsageError(`--order takes reversed or a whole number to shuffle by, not ${value}.`);
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
  const roots = rootsOf(options);
  if (options.selected.length === 0) {
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
  const chosen = new Map<string, { suite: DeclaredSuite; cases: Set<string> }>();
  for (const entry of options.selected) {
    const caseAt = /^(res:\/\/.*\.gd):(\w+)$/.exec(entry);
    const path = caseAt?.[1] ?? entry;
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
    for (const suite of suites) {
      const picked = chosen.get(suite.path) ?? { suite, cases: new Set<string>() };
      const asked = caseAt?.[2];
      if (asked !== undefined && !suite.cases.includes(asked)) {
        throw new EngineUsageError(
          `${suite.path} declares no case ${asked}. It declares ${suite.cases.join(', ')}.`,
        );
      }
      for (const func of asked === undefined ? suite.cases : [asked]) {
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

/** [param units] in the order [param order] asks: reversed by path, or shuffled by a seed. */
function ordered(units: readonly Unit[], order: 'reversed' | number): Unit[] {
  const sorted = [...units].sort((a, b) => a.suite.localeCompare(b.suite));
  if (order === 'reversed') {
    return sorted.reverse();
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

/** Runs the suites [param options] asks for with the engine at [param godotPath], answering the exit code. */
export async function runTestCommand(options: TestOptions, godotPath: string): Promise<number> {
  const unusable = gdUnit4Unusable(options.projectPath);
  if (unusable !== null) {
    throw new EngineUsageError(`${unusable.reason}. Install gdUnit4 6.0 or later under addons/gdUnit4.`);
  }
  const startedAt = Date.now();
  const scripts = new ProjectScripts(options.projectPath);
  const home = homeOf(options.projectPath);
  const state = join(home, '.godot', 'gdharness');
  const timesFile = join(state, 'suite-times.json');
  const passedFile = join(state, 'suite-passed.json');
  const lastRunFile = join(state, LAST_RUN_FILE);
  let suites = selectedSuites(scripts, options);
  const uncollected = uncollectedSaid(scripts.uncollectedUnder(searchedRoots(options)));
  // Whole, whatever the selection asked of them: the cases an engine is to leave out are the rest.
  const wholeSuites = suites.map((suite) => scripts.suite(suite.path) ?? suite);
  const declared: CasesBySuite = new Map(wholeSuites.map((suite) => [suite.path, suite.cases]));
  const testRuns = join(options.projectPath, '.godot', 'gdharness', 'test-runs');
  const keptRuns = join(state, 'test-runs');
  sweepRunDirectories(testRuns);
  if (keptRuns !== testRuns) {
    sweepRunDirectories(keptRuns);
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
  try {
    // A project with no class cache has never been imported, and no suite can run in it: gdUnit4's
    // own runner extends classes only the cache names. Nothing else has it open to race the import.
    const neverImported = cachedClasses(options.projectPath) === null;
    if (neverImported && !options.importFirst) {
      console.log('The project has never been imported, so it is imported first.');
    }
    if (options.importFirst || neverImported) {
      const imported = await importProject(launch);
      if (imported !== null) {
        logs.keep();
        writeEarlyResult(
          { resultFile: options.resultFile, lastRunFile, engines: options.engines },
          startedAt,
          [`the import failed: ${imported}`],
          logs.shown,
        );
        console.log(`The import failed, so no suite ran: ${imported}`);
        return 1;
      }
    }
    // After the import, which writes the .import and .uid files beside what a suite loads.
    const suitesBegan = Date.now();
    const always = [
      getLocalVersion(),
      readFileSync(shippedListedRunner(), 'utf8'),
      engineSaid(godotPath),
      ...options.reachAlso.map(
        (path) => `${path}\n${existsSync(path) ? readFileSync(path, 'latin1') : 'missing'}`,
      ),
    ];
    const everySuite = suites;
    if (options.changedOnly) {
      const inputs = new SuiteInputs(scripts, always);
      const passedBefore = readPassed(passedFile);
      const unchanged = suites.filter((suite) => {
        const passed = passedBefore[suite.path];
        return passed !== undefined && inputs.printOf(passed.inputs) === passed.print;
      });
      suites = suites.filter((suite) => !unchanged.includes(suite));
      if (unchanged.length > 0) {
        console.log(
          `${plural(unchanged.length, 'suite')} passed on everything ${unchanged.length === 1 ? 'its engine' : 'their engines'} loaded as it stands now, and ${unchanged.length === 1 ? 'is' : 'are'} not run: ${named(unchanged.map((suite) => suite.path))}.`,
        );
      }
      if (suites.length === 0) {
        console.log('Nothing has changed since every suite last passed.');
        const compiled = await compileCheck(launch, everySuite);
        const problems = [...compiled.faults.map((fault) => `${COMPILE_CHECK}: ${fault}`), ...uncollected];
        if (problems.length === 0) {
          rmSync(runDirectory, { recursive: true, force: true });
        } else {
          logs.keep();
        }
        writeEarlyResult(
          { resultFile: options.resultFile, lastRunFile, engines: options.engines },
          startedAt,
          problems,
          problems.length === 0 ? null : logs.shown,
        );
        if (problems.length === 0) {
          return 0;
        }
        printCompiled(compiled, logs);
        printUncollected(uncollected);
        console.log('');
        console.log(`Failed: ${plural(problems.length, 'problem')}, listed above.`);
        return 1;
      }
    }
    const times = readTimes(timesFile);
    const memory = await memoryAvailable();
    if (memory.unread !== undefined) {
      console.log(
        `Windows did not say how much memory it can still commit (${memory.unread}), so engines are sized by the physical memory free.`,
      );
    }
    const room =
      options.cores === null
        ? roomFor(options.engines, availableParallelism(), memory.bytes, memory.said)
        : roomFor(
            options.engines,
            options.cores,
            memory.bytes,
            memory.said,
            `--cores holds it to ${plural(options.cores, 'processor')}`,
          );
    if (options.cores !== null && process.platform === 'darwin') {
      console.log(
        'macOS offers no way to hold a process to some processors, so --cores holds only the number of engines here.',
      );
    }
    const splitPast = splitPastFor(suites, times, room.engines);
    const units = unitsOf(suites, times, splitPast);
    const past =
      splitPast > SPLIT_PAST_SECONDS
        ? `an engine's share of this run (${String(Math.round(splitPast))} s)`
        : `${String(SPLIT_PAST_SECONDS)} s`;
    const plans =
      options.order === null
        ? dealt(units, declared, room.engines)
        : [inOneEngine(ordered(units, options.order), declared)];
    const functions = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
    // Cut for the engines asked: held to fewer, the share grows and keeps whole what they would split.
    const asked = unitsOf(suites, times, splitPastFor(suites, times, options.engines));
    const how =
      options.order === null
        ? `${windowedSaid(plans)}${roomSaid(plans.length, lanesOf(plans), lanesOf(dealt(asked, declared, options.engines)), room.held, options.engines)}`
        : options.order === 'reversed'
          ? ', in reverse order of path'
          : `, shuffled by ${String(options.order)}`;
    // What the run said of its deal is kept with its outcome, since a gate keeps a passing step's
    // output nowhere and a slow pass could not be told from an uneven deal afterwards.
    const dealing: string[] = [];
    const say = (line: string): void => {
      dealing.push(line);
      console.log(line);
    };
    say(
      `${plural(functions, 'test function')} in ${plural(suites.length, 'suite')} over ${plural(plans.length, 'engine')}${how}.`,
    );
    const windowedAnyway = headlessInAWindow(plans, units);
    if (windowedAnyway.length > 0) {
      const one = windowedAnyway.length === 1;
      say(
        `${named(windowedAnyway)} ${one ? 'says it runs' : 'say they run'} headless and ${one ? 'runs' : 'run'} with a window here, since an ordered run is one engine and a suite in it needs a window. Run ${one ? 'it' : 'them'} without the windowed suites to run ${one ? 'it' : 'them'} headless.`,
      );
    }
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
    const lanes = [...new Set(plans.map((plan) => plan.lane))].map((lane) =>
      plans.flatMap((plan, index) => (plan.lane === lane ? [{ plan, index }] : [])),
    );
    // A slot for each lane, taken only where one is free now: what the run was dealt holds only when
    // every lane starts at once.
    const taken: string[] = [];
    while (taken.length < lanes.length) {
      const lock = await slots.takeFree();
      if (lock === null) {
        break;
      }
      taken.push(lock);
    }
    const shared = options.order === null && lanes.length > 1 && taken.length < lanes.length;
    if (shared) {
      say(sharesSaid(taken.length, lanes.length));
    }
    // Once the lanes hold what slots were free, so it takes one only beside them.
    const handed = new HandedSlot();
    const compiling = compileCheck(launch, everySuite, handed);
    // Awaited after the suites; a run failing before then reports its own error, not this one too.
    compiling.catch(() => undefined);
    let ran = shared
      ? await runShares(launch, units, declared, lanes.length, taken, times, handed)
      : (await Promise.all(lanes.map((lane, at) => runLane(launch, lane, times, taken[at] ?? null, handed))))
          .flat()
          .sort((a, b) => a.index - b.index);
    if (ran.some((engine) => engine.verdict.starved) && ran.some((engine) => !engine.verdict.passed)) {
      say('An engine ran out of memory, so every engine that failed runs again, one at a time.');
      const again: EngineRan[] = [];
      for (const engine of ran) {
        again.push(
          engine.verdict.passed ? engine : await runEngine(launch, engine.plan, engine.index, times, 'again'),
        );
      }
      ran = again;
    }
    writeJson(
      timesFile,
      timesAfter(
        readTimes(timesFile),
        wholeSuites,
        ran.map((engine) => engine.printed),
        (path) => scripts.suite(path),
        new Set(
          ran.flatMap((engine) =>
            engine.plan.suites
              .filter((suite) => (engine.printed.suites.get(suite.path)?.closed ?? null) === null)
              .flatMap((suite) => suite.cases.map((func) => `${suite.path}:${func}`)),
          ),
        ),
      ),
    );
    const across = rowsAcross(ran.map((engine) => ({ handed: engine.plan.suites, printed: engine.printed })));
    recordPassed(
      passedFile,
      options.projectPath,
      ran,
      new Set(across.map((fault) => fault.suite)),
      new SuiteInputs(scripts, always),
      suitesBegan,
    );
    return report(
      ran,
      await compiling,
      across.map((fault) => fault.fault),
      uncollected,
      startedAt,
      logs,
      options.printOutput,
      {
        resultFile: options.resultFile,
        lastRunFile,
        dealing,
        engines: options.engines,
        slotsFree: taken.length,
      },
    );
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
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
  for (const [path, entry] of Object.entries(typeof parsed === 'object' && parsed !== null ? parsed : {})) {
    const { print, inputs } = (entry ?? {}) as { print?: unknown; inputs?: unknown };
    if (
      typeof print === 'string' &&
      Array.isArray(inputs) &&
      inputs.every((input) => typeof input === 'string')
    ) {
      passed[path] = { print, inputs: inputs };
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
 */
function recordPassed(
  file: string,
  projectPath: string,
  ran: readonly EngineRan[],
  failedAcross: ReadonlySet<string>,
  inputs: SuiteInputs,
  began: number,
): void {
  const passed = readPassed(file);
  for (const path of Object.keys(passed)) {
    if (!existsSync(join(projectPath, path.slice('res://'.length)))) {
      delete passed[path];
    }
  }
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
  for (const path of new Set([...reached.keys(), ...failedSomewhere])) {
    const loaded = reached.get(path);
    const kept =
      failedSomewhere.has(path) || loaded === undefined
        ? []
        : loaded.has(EVERY_FILE)
          ? [EVERY_FILE]
          : [...loaded].sort();
    if (kept.length > 0 && !inputs.modifiedAfter(kept, began)) {
      passed[path] = { print: inputs.printOf(kept), inputs: kept };
    } else {
      delete passed[path];
    }
  }
  writeJson(file, passed);
}

/** The engine at [param godotPath] as the build it is, for a suite to have passed on. */
function engineSaid(godotPath: string): string {
  const stat = statSync(godotPath);
  return `${resolve(godotPath)}\n${String(stat.size)}\n${String(stat.mtimeMs)}`;
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
  readonly lock = new Promise<string>((resolve) => {
    this.handOver = resolve;
  });

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
function doneWith(launch: Launch, lock: string, handed: HandedSlot | undefined): void {
  if (handed?.give(lock) !== true) {
    launch.slots.release(lock);
  }
}

/**
 * Compiles [param suites] together beside every class of the game in an engine of its own, which
 * names every script that does not compile. Apart from the suites' engines, so those load only what
 * their suites do and what each records is what its suites could have used. Beside a run's suites
 * it runs in the slot [param handed] settles on; alone, in the next slot free.
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
    end = await watchedEngine(launch, args, directory, log, launch.silenceFloorSeconds);
  } finally {
    launch.slots.release(lock);
  }
  return { faults: judgeCompile(readRun(readFileSync(log, 'utf8')), end), log };
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
  if (
    (seeded === null || seeded.length === 0) &&
    cached !== null &&
    staleAgainst(cached, launch.projectPath).length === 0 &&
    staleImports(launch.projectPath).length === 0
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
    const ended = await watchedEngine(
      launch,
      ['--headless', '--audio-driver', 'Dummy', '--path', launch.projectPath, '--import'],
      directory,
      log,
      launch.silenceFloorSeconds,
    );
    if (ended.ended !== null || ended.code !== 0) {
      return `${ended.ended ?? `the engine exited ${exitNamed(ended.code ?? 0)}`}; everything it printed is in ${launch.logs.named(log)}`;
    }
    // Godot's import exits 0 whatever it printed, and a suite run on a failed import reads what
    // the import left behind.
    const printed = readRun(readFileSync(log, 'utf8'));
    const wrongEngine =
      launch.godotVersion === null ? null : versionFault(printed.engineVersion, launch.godotVersion);
    if (wrongEngine !== null) {
      return `${wrongEngine}; everything it printed is in ${launch.logs.named(log)}`;
    }
    const fault = importFault(printed);
    return fault === null ? null : `${fault}; everything it printed is in ${launch.logs.named(log)}`;
  } finally {
    launch.slots.release(lock);
  }
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
    doneWith(launch, lock, handed);
  }
}

/**
 * Runs [param units] over [param lanes] lanes handed a share at a time (see [class Shares]), the
 * lanes holding the slots in [param taken] at once and the rest as slots come free. A lane still
 * waiting once every share is handed out stops waiting: a slot somebody else holds is not to keep a
 * run open that has nothing left to give it.
 */
async function runShares(
  launch: Launch,
  units: readonly Unit[],
  declared: CasesBySuite,
  lanes: number,
  taken: readonly string[],
  times: SuiteTimes,
  handed?: HandedSlot,
): Promise<EngineRan[]> {
  const shares = new Shares(units, declared, lanes);
  const handedOut = new AbortController();
  let engines = 0;
  const lane = async (at: number): Promise<EngineRan[]> => {
    let lock = taken[at] ?? null;
    if (lock === null) {
      try {
        lock = await launch.slots.take(handedOut.signal);
      } catch (error) {
        if (handedOut.signal.aborted) {
          return [];
        }
        throw error;
      }
    }
    try {
      const ran: EngineRan[] = [];
      for (let plan = shares.next(at); plan !== null; plan = shares.next(at)) {
        if (shares.empty) {
          handedOut.abort();
        }
        const index = engines;
        engines += 1;
        ran.push(await runEngine(launch, plan, index, times, '', lock));
      }
      return ran;
    } finally {
      doneWith(launch, lock, handed);
    }
  };
  return (await Promise.all(Array.from({ length: lanes }, (_, at) => lane(at))))
    .flat()
    .sort((a, b) => a.index - b.index);
}

/**
 * Runs [param plan] in an engine of its own, in the slot [param slot] when its lane holds one and
 * otherwise once a slot is free, and judges what it printed.
 */
async function runEngine(
  launch: Launch,
  plan: EnginePlan,
  index: number,
  times: SuiteTimes,
  again = '',
  slot: string | null = null,
): Promise<EngineRan> {
  const directory = join(launch.runDirectory, `engine-${String(index)}${again === '' ? '' : `-${again}`}`);
  mkdirSync(join(directory, 'user'), { recursive: true });
  const suitesFile = join(directory, 'suites.txt');
  const skippingFile = join(directory, 'skipping.txt');
  const rowsFile = join(directory, 'rows.txt');
  const expectedFile = join(directory, 'expected.json');
  const reached = join(directory, 'reached.jsonl');
  writeFileSync(suitesFile, `${plan.suites.map((suite) => suite.path).join('\n')}\n`);
  writeFileSync(skippingFile, `${plan.skipping.join('\n')}\n`);
  writeFileSync(
    rowsFile,
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
  const viewport = viewportOf(launch.projectPath);
  // On Windows every engine runs on the hidden desktop, so a windowed one starts with its flags.
  const display = plan.windowed
    ? [
        ...(viewport === null
          ? []
          : ['--resolution', `${String(viewport.width)}x${String(viewport.height)}`]),
        ...(process.platform === 'win32' ? hiddenWindowFlags([], capsFrames(launch.projectPath)) : []),
      ]
    : ['--headless'];
  const args = [
    ...display,
    '--audio-driver',
    'Dummy',
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
    suitesFile,
    '--skipping-in',
    skippingFile,
    '--rows-in',
    rowsFile,
    '--html-report-off',
    '--junit-report-off',
    '--compile-together',
    '--expected-out',
    expectedFile,
    '--reached-out',
    reached,
  ];
  const log = join(directory, 'engine.log');
  const lock = slot ?? (await launch.slots.take());
  const began = Date.now();
  let end: EngineEnd;
  try {
    end = await watchedEngine(launch, args, directory, log, launch.silenceFloorSeconds, (printed) =>
      silenceWhile(printed.running, times, launch.silenceFloorSeconds),
    );
  } finally {
    if (slot === null) {
      launch.slots.release(lock);
    }
  }
  const printed = readRun(readFileSync(log, 'utf8'));
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
        .sort()
    : [];
  if (files.length === 0) {
    return null;
  }
  const shown = files.slice(0, REPORT_FILES_NAMED).map((file) => file.split(sep).join('/'));
  const more = files.length - shown.length;
  return `gdUnit4 wrote ${plural(files.length, 'file')} into ${reports} (${shown.join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}), a report the runner had turned off, so the gdUnit4 installed no longer honours a session hook marked off; report it to gdharness with gdUnit4's version`;
}

/** Prints how the run went and answers the exit code: what failed, in full, then one line of totals. */
function report(
  ran: readonly EngineRan[],
  compiled: Compiled,
  across: readonly string[],
  uncollected: readonly string[],
  startedAt: number,
  logs: RunLogs,
  printOutput: boolean,
  targets: ResultTargets,
): number {
  // Ahead of the verdict, so the last lines are still how the run went.
  if (printOutput) {
    for (const engine of ran) {
      console.log('');
      console.log(
        `--- what engine ${String(engine.index)} printed, running ${named(engine.plan.suites.map((suite) => suite.path))}:`,
      );
      console.log(
        existsSync(engine.log)
          ? readFileSync(engine.log, 'utf8').replace(CONTROL_SEQUENCE, '').trimEnd()
          : '(no log was written)',
      );
    }
  }
  const failed = ran.filter((engine) => !engine.verdict.passed);
  for (const engine of failed) {
    const heading = `--- engine ${String(engine.index)}: ${plural(engine.plan.suites.length, 'suite')}, ${engine.seconds.toFixed(1)} s${engine.again ? ', run again alone after an engine ran out of memory, and failed again' : ''}`;
    console.log('');
    console.log(heading);
    for (const fault of engine.verdict.faults) {
      console.log(`  ${fault}`);
    }
    // At the top of the kept log, so the file says why on its own, even when the engine printed nothing.
    if (existsSync(engine.log)) {
      const verdict = [
        `gdharness: ${heading.slice(4)}`,
        ...engine.verdict.faults.map((fault) => `  ${fault}`),
      ];
      writeFileSync(engine.log, `${verdict.join('\n')}\n---\n${readFileSync(engine.log, 'utf8')}`);
    }
    if (engine.verdict.shown.length > 0) {
      console.log('');
      for (const line of engine.verdict.shown) {
        console.log(line);
      }
    }
    console.log(`everything it printed: ${logs.named(engine.log)}`);
  }
  for (const engine of ran.filter((one) => one.verdict.notes.length > 0)) {
    console.log('');
    console.log(`--- engine ${String(engine.index)}, not counted against the run:`);
    for (const note of engine.verdict.notes) {
      console.log(`  ${note}`);
    }
  }
  if (across.length > 0) {
    console.log('');
    console.log('--- the cases dealt by their rows, over every engine holding them:');
    for (const fault of across) {
      console.log(`  ${fault}`);
    }
  }
  printCompiled(compiled, logs);
  printUncollected(uncollected);
  const cases = ran.reduce(
    (sum, engine) => sum + [...engine.printed.suites.values()].reduce((n, s) => n + s.cases.length, 0),
    0,
  );
  const suites = new Set(ran.flatMap((engine) => engine.plan.suites.map((suite) => suite.path))).size;
  const longest = Math.max(0, ...ran.map((engine) => engine.seconds));
  const took = (Date.now() - startedAt) / 1000;
  // What each engine took beside what it was dealt, so an uneven deal is told from a slow suite.
  if (ran.length > 1) {
    console.log('');
    console.log(
      `The engines took ${ran.map((engine) => `${engine.seconds.toFixed(1)} s`).join(', ')}, dealt ${ran.map((engine) => `${engine.plan.cost.toFixed(1)} s`).join(', ')}.`,
    );
  }
  const closed = ran
    .flatMap((engine) =>
      [...engine.printed.suites.values()].flatMap((suite) =>
        suite.closed === null
          ? []
          : [
              {
                path: suite.path,
                seconds: suite.closed.seconds,
                verdict: suite.closed.verdict,
                engine: engine.index,
              },
            ],
      ),
    )
    .sort((a, b) => b.seconds - a.seconds);
  const slowest = closed.slice(0, SLOWEST_NAMED);
  if (slowest.length > 1) {
    console.log(
      `The slowest suites: ${slowest.map((suite) => `${suite.path} ${suite.seconds.toFixed(1)} s`).join(', ')}.`,
    );
  }
  const totals = `${plural(cases, 'case')} in ${plural(suites, 'suite')} across ${plural(ran.length, 'engine')}, ${took.toFixed(1)} s; the longest engine took ${longest.toFixed(1)} s.`;
  console.log('');
  const passed =
    failed.length === 0 && compiled.faults.length === 0 && across.length === 0 && uncollected.length === 0;
  if (passed) {
    rmSync(logs.directory, { recursive: true, force: true });
  } else {
    logs.keep();
  }
  writeResult(targets, {
    passed,
    seconds: took,
    problems: [
      ...failed.flatMap((engine) =>
        engine.verdict.faults.map((fault) => `engine ${String(engine.index)}: ${fault}`),
      ),
      ...compiled.faults.map((fault) => `${COMPILE_CHECK}: ${fault}`),
      ...across,
      ...uncollected,
    ],
    suites: closed,
    engines: ran.map((engine) => ({
      index: engine.index,
      lane: engine.plan.lane,
      startedAfter: (engine.began - startedAt) / 1000,
      seconds: engine.seconds,
      dealt: engine.plan.cost,
      passed: engine.verdict.passed,
      windowed: engine.plan.windowed,
      suites: engine.plan.suites.map((suite) => suite.path),
      log: passed ? null : logs.named(engine.log),
    })),
    logs: passed ? null : logs.shown,
    enginesAsked: targets.engines,
    slotsFree: targets.slotsFree,
    dealing: targets.dealing,
  });
  if (passed) {
    console.log(`Passed: ${totals}`);
    return 0;
  }
  const problems = failed.reduce(
    (sum, engine) => sum + engine.verdict.faults.length,
    compiled.faults.length + across.length + uncollected.length,
  );
  console.log(`Failed: ${plural(problems, 'problem')}, listed above. Ran ${totals}`);
  console.log(
    `Every engine's output is kept under ${logs.shown} until ${String(KEPT_RUN_DIRECTORIES)} later runs have failed.`,
  );
  return 1;
}

/** Writes a result for a run that started no engine to [param file], when the run was asked for one. */
function writeEarlyResult(
  targets: Pick<ResultTargets, 'resultFile' | 'lastRunFile' | 'engines'>,
  startedAt: number,
  problems: readonly string[],
  logs: string | null,
): void {
  writeResult(targets, {
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

/** Writes [param result] to the last run's file, and to --result's when it was given. */
function writeResult(targets: Pick<ResultTargets, 'resultFile' | 'lastRunFile'>, result: RunResult): void {
  writeJson(targets.lastRunFile, result);
  if (targets.resultFile !== null) {
    writeJson(targets.resultFile, result);
  }
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
