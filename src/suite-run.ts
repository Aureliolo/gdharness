/**
 * `gdharness test`: a project's gdUnit4 suites over several engines, judged whole.
 *
 * What a game's gate runs, so that every game runs its suites one way: discovered from the scripts,
 * dealt to engines by what each case cost last time, each engine holding one of the machine's engine
 * slots, ended when it goes silent, and judged on everything it printed rather than on its exit code.
 * docs/test-runs.md describes it for the games, the slot scheme included.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, exitOf } from './alive.js';
import { cachedClasses, staleAgainst } from './class-cache.js';
import {
  DESKTOP_VARIABLE,
  ensureHelperCompiled,
  HIDDEN_DESKTOP,
  helperFailure,
  helperStep,
  throughHelper,
} from './desktop.js';
import { type SelfTypedExport, selfTypedExports } from './engine-leaks.js';
import { EngineSlots, ownStart } from './engine-slots.js';
import { Refusal } from './errors.js';
import { mainCheckoutOf } from './harnesses.js';
import { staleImports } from './import-freshness.js';
import { freeLibraryCopies, seedExtensionList } from './library-copies.js';
import { gdUnit4Unusable, shippedListedRunner } from './setup.js';
import { type ChildProcess, runHidden, spawnHidden } from './spawn.js';
import { SuiteFingerprints } from './suite-fingerprint.js';
import {
  type EngineAssignment,
  type EngineEnd,
  type EngineVerdict,
  exitNamed,
  judgeEngine,
  named,
  type RunPrinted,
  readExpected,
  readRun,
  rowsAcross,
} from './suite-judge.js';
import {
  type CasesBySuite,
  type DeclaredSuite,
  dealt,
  type EnginePlan,
  headlessInAWindow,
  inOneEngine,
  lanesOf,
  ProjectScripts,
  readTimes,
  SPLIT_PAST_SECONDS,
  TEST_DIRECTORIES,
  timesAfter,
  type Unit,
  unitsOf,
  viewportOf,
  windowedSaid,
  writeJson,
} from './suite-plan.js';
import { getLocalVersion } from './version.js';
import { askWindows } from './windows-ask.js';

/** A command line `test` cannot act on, which the CLI answers with exit code 2. */
export class TestUsageError extends Refusal {}

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
  /** The directories suites are looked for in, as `res://` paths, or none for `tests` and `test`. */
  readonly roots: readonly string[];
  readonly changedOnly: boolean;
  readonly reachAlso: readonly string[];
  readonly importFirst: boolean;
  /** Every suite in one engine in this order: `reversed`, or shuffled by the seed. */
  readonly order: 'reversed' | number | null;
  /** Print what each engine printed, after the run and before its verdict. */
  readonly printOutput: boolean;
}

/** Most engines a run starts, whatever the machine has. */
const MOST_ENGINES = 4;
/** Memory left to the rest of the machine, and what each engine is taken to need. */
const MEMORY_KEPT = 4 * 1024 ** 3;
const MEMORY_PER_ENGINE = 1.5 * 1024 ** 3;
/** The least time an engine may print nothing before it is ended. */
const SILENCE_FLOOR_SECONDS = 300;
/** How many times its slowest unit an engine may print nothing for. */
const SILENCE_TIMES_SLOWEST = 4;
const LOOK_MS = 500;
/** How long Windows is given to say how much it can still commit, on a machine the run may load. */
const COMMIT_ASK_MS = 15_000;
/** What the engine prints when an autoload did not start, after which no suite can mean anything. */
const AUTOLOAD_FAILED = 'Failed to instantiate an autoload';
/**
 * A terminal control sequence. gdUnit4 opens its output by clearing the screen, which printed as it
 * stands would wipe the lines the run had printed before it.
 */
const CONTROL_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, 'g');

const VALUED = new Set([
  '--engines',
  '--slots',
  '--slot-count',
  '--silence',
  '--deadline',
  '--tests',
  '--reach-also',
  '--order',
]);
const SWITCHES = new Set(['--changed-only', '--import', '--print-output']);

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
        throw new TestUsageError(`${arg} needs a value.`);
      }
      valued.set(arg, [...(valued.get(arg) ?? []), value]);
      at += 1;
    } else {
      throw new TestUsageError(`Unknown option ${arg} for gdharness test. Run gdharness help.`);
    }
  }
  const first = positional[0];
  const named = first === undefined ? null : resolve(cwd, first);
  const projectNamed = named !== null && existsSync(join(named, 'project.godot'));
  const projectPath = projectNamed ? named : resolve(cwd);
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new TestUsageError(`Not a Godot project: ${projectPath} holds no project.godot.`);
  }
  const last = (flag: string): string | undefined => valued.get(flag)?.at(-1);
  const order = last('--order');
  return {
    projectPath,
    selected: positional.slice(projectNamed ? 1 : 0).map((entry) => resPathOf(entry, projectPath, cwd)),
    engines: whole(last('--engines'), '--engines') ?? MOST_ENGINES,
    slotsDirectory: last('--slots') === undefined ? null : resolve(cwd, last('--slots') ?? ''),
    slotCount: whole(last('--slot-count'), '--slot-count'),
    silenceSeconds: whole(last('--silence'), '--silence') ?? SILENCE_FLOOR_SECONDS,
    deadlineSeconds: whole(last('--deadline'), '--deadline'),
    roots: (valued.get('--tests') ?? []).map((root) => resPathOf(root, projectPath, cwd).replace(/\/$/, '')),
    changedOnly: switches.has('--changed-only'),
    reachAlso: (valued.get('--reach-also') ?? []).map((path) => resolve(projectPath, path)),
    importFirst: switches.has('--import'),
    order: order === undefined ? null : order === 'reversed' ? 'reversed' : seedOf(order),
    printOutput: switches.has('--print-output'),
  };
}

function whole(value: string | undefined, flag: string): number | null {
  if (value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TestUsageError(`${flag} takes a whole number above 0, not ${value}.`);
  }
  return number;
}

function seedOf(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new TestUsageError(`--order takes reversed or a whole number to shuffle by, not ${value}.`);
  }
  return seed;
}

/**
 * [param entry] as a `res://` path: as it is when it is one, else a path in the project, read from
 * [param cwd] only when it is there and not in the project, so a path that is nowhere is refused as
 * missing from the project rather than as outside it. A `:test_case` after a script stays.
 */
function resPathOf(entry: string, projectPath: string, cwd: string): string {
  if (entry.startsWith('res://')) {
    return entry;
  }
  const caseAt = /^(.*\.gd):(\w+)$/.exec(entry);
  const file = caseAt?.[1] ?? entry;
  const fromProject = resolve(projectPath, file);
  const fromHere = resolve(cwd, file);
  const absolute =
    isAbsolute(file) || (!existsSync(fromProject) && existsSync(fromHere)) ? fromHere : fromProject;
  const inside = relative(projectPath, absolute);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new TestUsageError(`${entry} is not inside the project at ${projectPath}.`);
  }
  const path = `res://${inside.split(sep).join('/')}`;
  return caseAt === null ? path : `${path}:${caseAt[2] ?? ''}`;
}

/** Where a run keeps what outlives it: beside the main checkout when the project is a worktree of one. */
function homeOf(projectPath: string): string {
  return mainCheckoutOf(projectPath) ?? projectPath;
}

/** The suites a run is asked for, each with the cases asked of it. */
function selectedSuites(scripts: ProjectScripts, options: TestOptions): DeclaredSuite[] {
  const roots =
    options.roots.length > 0
      ? options.roots
      : TEST_DIRECTORIES.filter((root) => existsSync(join(options.projectPath, root))).map(
          (root) => `res://${root}`,
        );
  if (options.selected.length === 0) {
    const found = scripts.suitesUnder(roots);
    if (found.length === 0) {
      throw new TestUsageError(
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
      throw new TestUsageError(
        existsSync(directory)
          ? `${path} holds no gdUnit4 suite: nothing there extends GdUnitTestSuite and declares a test_ function.`
          : `Nothing at ${path} in the project at ${options.projectPath}.`,
      );
    }
    for (const suite of suites) {
      const picked = chosen.get(suite.path) ?? { suite, cases: new Set<string>() };
      const asked = caseAt?.[2];
      if (asked !== undefined && !suite.cases.includes(asked)) {
        throw new TestUsageError(
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

/**
 * How many of the [param most] engines asked for the machine has room for, given its [param
 * processors] and the memory [param available] past what it keeps, with what held it below
 * [param most] when something did.
 */
export function roomFor(
  most: number,
  processors: number,
  available: number,
  said = 'of memory free',
): { engines: number; held: string | undefined } {
  const byMemory = Math.floor((available - MEMORY_KEPT) / MEMORY_PER_ENGINE);
  const engines = Math.max(1, Math.min(most, processors, byMemory));
  if (engines >= most) {
    return { engines, held: undefined };
  }
  const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return {
    engines,
    held:
      byMemory < processors
        ? `the machine has ${gigabytes(Math.max(0, available))} ${said}, ${gigabytes(MEMORY_KEPT)} of it kept for everything else and ${gigabytes(MEMORY_PER_ENGINE)} taken for each engine`
        : `the machine has ${plural(processors, 'processor')}`,
  };
}

/** The memory the machine can give engines, how the line on room words it, and why a reading failed. */
interface MemoryRoom {
  readonly bytes: number;
  readonly said: string;
  readonly unread?: string;
}

/**
 * The memory the machine can give engines. freemem on macOS counts only the pages nobody holds,
 * a few hundred megabytes on a Mac whose file cache would give way at once, so a run there was held
 * to one engine whatever it asked for. The kernel's own share of memory it counts as free, the
 * percentage memory_pressure prints, includes what it can take back. Windows refuses an allocation
 * at the commit limit rather than at physical memory, and a machine with 23 GB free and 4.9 GB left
 * to commit started sixteen engines that died with STATUS_COMMITMENT_LIMIT, so there the smaller
 * of the two is the room.
 */
async function memoryAvailable(): Promise<MemoryRoom> {
  const level = await macMemoryLevel();
  if (level !== null) {
    return { bytes: (totalmem() * level) / 100, said: 'of memory free' };
  }
  return memoryRoomOf(freemem(), await windowsCommitLeft());
}

/**
 * The room [param free] physical bytes and [param commit], what Windows can still commit (null
 * elsewhere, or why it did not say), leave engines: the smaller of the two.
 */
export function memoryRoomOf(free: number, commit: number | string | null): MemoryRoom {
  if (typeof commit === 'string') {
    return { bytes: free, said: 'of memory free', unread: commit };
  }
  return commit !== null && commit < free
    ? { bytes: commit, said: 'of memory left to commit' }
    : { bytes: free, said: 'of memory free' };
}

/**
 * How much more Windows will commit, in bytes, which is what GlobalMemoryStatusEx answers as
 * ullAvailPageFile; null off Windows, or why Windows did not say.
 */
export async function windowsCommitLeft(): Promise<number | string | null> {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const said = await askWindows(
      '(Get-CimInstance Win32_OperatingSystem -Property FreeVirtualMemory).FreeVirtualMemory',
      COMMIT_ASK_MS,
    );
    const kilobytes = Number(said.trim());
    return Number.isFinite(kilobytes) && kilobytes > 0
      ? kilobytes * 1024
      : `it answered ${JSON.stringify(said.trim())}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The percentage of memory macOS counts as free, or null off macOS or when it would not say. */
export async function macMemoryLevel(): Promise<number | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const level = Number((await runHidden('sysctl', ['-n', 'kern.memorystatus_level'])).stdout.trim());
    return Number.isFinite(level) && level > 0 && level <= 100 ? level : null;
  } catch {
    return null;
  }
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
  readonly seconds: number;
}

/** What starting engines needs, the same for every engine of a run. */
interface Launch {
  readonly godotPath: string;
  readonly projectPath: string;
  readonly runDirectory: string;
  readonly slots: EngineSlots;
  readonly silenceFloorSeconds: number;
  /** The most seconds one engine may run, printing or not, or null for no limit. */
  readonly deadlineSeconds: number | null;
  readonly running: Set<() => void>;
  readonly selfTyped: readonly SelfTypedExport[];
}

/** Runs the suites [param options] asks for with the engine at [param godotPath], answering the exit code. */
export async function runTestCommand(options: TestOptions, godotPath: string): Promise<number> {
  const unusable = gdUnit4Unusable(options.projectPath);
  if (unusable !== null) {
    throw new TestUsageError(`${unusable.reason}. Install gdUnit4 6.0 or later under addons/gdUnit4.`);
  }
  const startedAt = Date.now();
  const scripts = new ProjectScripts(options.projectPath);
  const home = homeOf(options.projectPath);
  const state = join(home, '.godot', 'gdharness');
  const timesFile = join(state, 'suite-times.json');
  const passedFile = join(state, 'suite-passed.json');
  let suites = selectedSuites(scripts, options);
  // Whole, whatever the selection asked of them: the cases an engine is to leave out are the rest.
  const wholeSuites = suites.map((suite) => scripts.suite(suite.path) ?? suite);
  const declared: CasesBySuite = new Map(wholeSuites.map((suite) => [suite.path, suite.cases]));
  const testRuns = join(options.projectPath, '.godot', 'gdharness', 'test-runs');
  sweepRunDirectories(testRuns);
  const runDirectory = join(testRuns, `${String(startedAt)}-${String(process.pid)}`);
  mkdirSync(runDirectory, { recursive: true });
  const slots = new EngineSlots(
    options.slotsDirectory ?? join(home, '.godot', 'gate', 'slots'),
    options.slotCount ?? Math.min(MOST_ENGINES, availableParallelism()),
    { pid: process.pid, started: await ownStart() },
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
    slots,
    silenceFloorSeconds: options.silenceSeconds,
    deadlineSeconds: options.deadlineSeconds,
    running,
    selfTyped: selfTypedExports(scripts.sources),
  };
  try {
    if (options.importFirst) {
      const imported = await importProject(launch);
      if (imported !== null) {
        console.log(`The import failed, so no suite ran: ${imported}`);
        return 1;
      }
    }
    // After the import, which writes the .import files beside every asset a suite can reach.
    const fingerprints = new SuiteFingerprints(scripts, [
      getLocalVersion(),
      readFileSync(shippedListedRunner(), 'utf8'),
      ...options.reachAlso.map(
        (path) => `${path}\n${existsSync(path) ? readFileSync(path, 'latin1') : 'missing'}`,
      ),
    ]);
    const printsOf = new Map(suites.map((suite) => [suite.path, fingerprints.of(suite)]));
    if (options.changedOnly) {
      const passedBefore = readRecord(passedFile);
      const unchanged = suites.filter((suite) => {
        const print = printsOf.get(suite.path);
        return print !== null && print !== undefined && passedBefore[suite.path] === print;
      });
      suites = suites.filter((suite) => !unchanged.includes(suite));
      if (unchanged.length > 0) {
        console.log(
          `${plural(unchanged.length, 'suite')} passed with everything ${unchanged.length === 1 ? 'it reaches' : 'they reach'} as it stands now, and ${unchanged.length === 1 ? 'is' : 'are'} not run: ${named(unchanged.map((suite) => suite.path))}.`,
        );
      }
      if (suites.length === 0) {
        console.log('Nothing has changed since every suite last passed.');
        rmSync(runDirectory, { recursive: true, force: true });
        return 0;
      }
    }
    const times = readTimes(timesFile);
    const units = unitsOf(suites, times);
    const memory = await memoryAvailable();
    if (memory.unread !== undefined) {
      console.log(
        `Windows did not say how much memory it can still commit (${memory.unread}), so engines are sized by the physical memory free.`,
      );
    }
    const room = roomFor(options.engines, availableParallelism(), memory.bytes, memory.said);
    const plans =
      options.order === null
        ? dealt(units, declared, room.engines)
        : [inOneEngine(ordered(units, options.order), declared)];
    const functions = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
    const how =
      options.order === null
        ? `${windowedSaid(plans)}${roomSaid(plans.length, lanesOf(plans), lanesOf(dealt(units, declared, options.engines)), room.held, options.engines)}`
        : options.order === 'reversed'
          ? ', in reverse order of path'
          : `, shuffled by ${String(options.order)}`;
    console.log(
      `${plural(functions, 'test function')} in ${plural(suites.length, 'suite')} over ${plural(plans.length, 'engine')}${how}.`,
    );
    const windowedAnyway = headlessInAWindow(plans, units);
    if (windowedAnyway.length > 0) {
      const one = windowedAnyway.length === 1;
      console.log(
        `${named(windowedAnyway)} ${one ? 'says it runs' : 'say they run'} headless and ${one ? 'runs' : 'run'} with a window here, since an ordered run is one engine and a suite in it needs a window. Run ${one ? 'it' : 'them'} without the windowed suites to run ${one ? 'it' : 'them'} headless.`,
      );
    }
    const split = [...new Set(units.map((unit) => unit.suite))].filter(
      (path) => units.filter((unit) => unit.suite === path && unit.row === undefined).length > 1,
    );
    if (plans.length > 1 && split.length > 0) {
      console.log(
        `Dealt out case by case, since ${split.length === 1 ? 'it' : 'each'} took more than ${String(SPLIT_PAST_SECONDS)} s last time: ${named(split)}.`,
      );
    }
    const byRows = [
      ...new Set(
        units.flatMap((unit) => (unit.row === undefined ? [] : [`${unit.suite} > ${unit.cases[0] ?? ''}`])),
      ),
    ];
    if (plans.length > 1 && byRows.length > 0) {
      console.log(
        `Dealt out row by row, since ${byRows.length === 1 ? 'it' : 'each'} took more than ${String(SPLIT_PAST_SECONDS)} s last time: ${named(byRows)}.`,
      );
    }
    const lanes = [...new Set(plans.map((plan) => plan.lane))].map((lane) =>
      plans.flatMap((plan, index) => (plan.lane === lane ? [{ plan, index }] : [])),
    );
    let ran = (await inTurns(lanes, room.engines, (lane) => runLane(launch, lane, units)))
      .flat()
      .sort((a, b) => a.index - b.index);
    if (ran.some((engine) => engine.verdict.starved) && ran.some((engine) => !engine.verdict.passed)) {
      console.log('An engine ran out of memory, so every engine that failed runs again, one at a time.');
      const again: EngineRan[] = [];
      for (const engine of ran) {
        again.push(
          engine.verdict.passed ? engine : await runEngine(launch, engine.plan, engine.index, units, 'again'),
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
    recordPassed(passedFile, ran, printsOf, new Set(across.map((fault) => fault.suite)));
    return report(
      ran,
      across.map((fault) => fault.fault),
      startedAt,
      runDirectory,
      options.printOutput,
    );
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
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

/** [param run] over every one of [param items], [param at] at most at a time, answered in their order. */
export async function inTurns<T, R>(
  items: readonly T[],
  at: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await run(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(at, items.length)) }, lane));
  return answers;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function readRecord(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Keeps each suite that passed whole with the fingerprint it passed at, and drops each that did not.
 * A suite dealt out over several engines passed only if it passed in each of them.
 */
function recordPassed(
  file: string,
  ran: readonly EngineRan[],
  printsOf: ReadonlyMap<string, string | null>,
  failedAcross: ReadonlySet<string>,
): void {
  const passed = readRecord(file);
  const failedSomewhere = new Set<string>(failedAcross);
  const passedSomewhere = new Set<string>();
  for (const engine of ran) {
    const passing = new Set(engine.verdict.passedSuites);
    for (const { path } of engine.plan.suites) {
      (passing.has(path) ? passedSomewhere : failedSomewhere).add(path);
    }
  }
  for (const path of new Set([...passedSomewhere, ...failedSomewhere])) {
    const print = printsOf.get(path);
    if (!failedSomewhere.has(path) && print !== null && print !== undefined) {
      passed[path] = print;
    } else {
      delete passed[path];
    }
  }
  writeJson(file, passed);
}

/** Removes what earlier runs left behind, other than a run still going. */
function sweepRunDirectories(testRuns: string): void {
  if (!existsSync(testRuns)) {
    return;
  }
  for (const entry of readdirSync(testRuns)) {
    const pid = Number(/^\d+-(\d+)$/.exec(entry)?.[1]);
    if (!Number.isInteger(pid) || !alive(pid)) {
      rmSync(join(testRuns, entry), { recursive: true, force: true });
    }
  }
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
    const ended = await watched(
      launch,
      ['--headless', '--audio-driver', 'Dummy', '--path', launch.projectPath, '--import'],
      directory,
      log,
      launch.silenceFloorSeconds,
    );
    if (ended.ended !== null || ended.code !== 0) {
      return `${ended.ended ?? `the engine exited ${exitNamed(ended.code ?? 0)}`}; everything it printed is in ${log}`;
    }
    // Godot's import exits 0 whatever it printed, and a suite run on a failed import reads what
    // the import left behind.
    const errors = readRun(readFileSync(log, 'utf8')).errors.filter((error) => !error.warning);
    if (errors.length > 0) {
      return `it printed ${errors.length === 1 ? 'an engine error' : `${String(errors.length)} engine errors`}, the first ${JSON.stringify(errors[0]?.text ?? '')}; everything it printed is in ${log}`;
    }
    return null;
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
  units: readonly Unit[],
): Promise<EngineRan[]> {
  const lock = await launch.slots.take();
  try {
    const ran: EngineRan[] = [];
    for (const { plan, index } of lane) {
      ran.push(await runEngine(launch, plan, index, units, '', lock));
    }
    return ran;
  } finally {
    launch.slots.release(lock);
  }
}

/**
 * Runs [param plan] in an engine of its own, in the slot [param slot] when its lane holds one and
 * otherwise once a slot is free, and judges what it printed.
 */
async function runEngine(
  launch: Launch,
  plan: EnginePlan,
  index: number,
  units: readonly Unit[],
  again = '',
  slot: string | null = null,
): Promise<EngineRan> {
  const directory = join(launch.runDirectory, `engine-${String(index)}${again === '' ? '' : `-${again}`}`);
  mkdirSync(join(directory, 'user'), { recursive: true });
  const suitesFile = join(directory, 'suites.txt');
  const skippingFile = join(directory, 'skipping.txt');
  const rowsFile = join(directory, 'rows.txt');
  const expectedFile = join(directory, 'expected.json');
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
  const display = plan.windowed
    ? viewport === null
      ? []
      : ['--resolution', `${String(viewport.width)}x${String(viewport.height)}`]
    : ['--headless'];
  const args = [
    ...display,
    '--audio-driver',
    'Dummy',
    '--path',
    launch.projectPath,
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
  ];
  const held = new Set(plan.suites.map((suite) => suite.path));
  const slowest = Math.max(0, ...units.filter((unit) => held.has(unit.suite)).map((unit) => unit.cost));
  const silence = Math.max(launch.silenceFloorSeconds, SILENCE_TIMES_SLOWEST * slowest);
  const log = join(directory, 'engine.log');
  const lock = slot ?? (await launch.slots.take());
  const began = Date.now();
  let end: EngineEnd;
  try {
    end = await watched(launch, args, directory, log, silence);
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
  };
  return {
    index,
    plan,
    printed,
    verdict: judgeEngine(printed, assignment, end),
    log,
    seconds: (Date.now() - began) / 1000,
  };
}

/**
 * Starts the engine with [param args], both its streams into [param log] through one handle so
 * their lines stay in the order printed, and waits for it, ending it once it has printed nothing for
 * [param silenceSeconds], has run past the run's deadline, or an autoload has failed to start.
 */
async function watched(
  launch: Launch,
  args: readonly string[],
  directory: string,
  log: string,
  silenceSeconds: number,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  // Each engine its own user data, so two engines never write one save or settings file.
  const env = { ...process.env, APPDATA: user, XDG_DATA_HOME: user };
  const output = openSync(log, 'w');
  let child: ChildProcess;
  let stop: () => void;
  let helper: {
    readonly error: string;
    readonly how: string;
    readonly pid: string;
    readonly step: string;
  } | null = null;
  try {
    // On Windows every engine on a desktop of its own, headless too: an engine that fails to start
    // shows a modal alert even with --headless, and on the desktop in use that takes the keyboard of
    // whoever is working there. The helper also clears the bit that keeps a crash from being reported.
    if (process.platform === 'win32') {
      const where = 'on a desktop of its own';
      const compiled = await ensureHelperCompiled();
      if (compiled !== null) {
        return { code: null, signal: null, ended: `the engine could not be started ${where}: ${compiled}` };
      }
      const stopFile = join(directory, 'stop');
      const error = join(directory, 'error');
      helper = { error, how: where, pid: join(directory, 'pid'), step: join(directory, 'step') };
      const how = { desktop: HIDDEN_DESKTOP, directory: launch.projectPath };
      const wrapper = throughHelper(how, launch.godotPath, args, {
        spec: join(directory, 'spec'),
        pid: helper.pid,
        error,
        stop: stopFile,
        step: helper.step,
      });
      child = spawnHidden(wrapper.command, wrapper.args, {
        stdio: ['ignore', output, output],
        env: { ...env, [DESKTOP_VARIABLE]: HIDDEN_DESKTOP },
        cwd: directory,
      });
      stop = () => {
        writeFileSync(stopFile, '');
      };
    } else {
      child = spawnHidden(launch.godotPath, args, {
        stdio: ['ignore', output, output],
        env,
        cwd: launch.projectPath,
        detached: true,
      });
      stop = () => {
        endTree(child);
      };
    }
  } finally {
    closeSync(output);
  }
  launch.running.add(stop);
  let ended: string | null = null;
  const exited = Promise.race([
    exitOf(child),
    new Promise<{ code: null; signal: null }>((settle) => {
      child.once('error', (error: Error) => {
        ended ??= `the engine did not start: ${error.message}`;
        settle({ code: null, signal: null });
      });
    }),
  ]);
  const finished = { now: false };
  void exited.then(() => {
    finished.now = true;
  });
  const reading = openSync(log, 'r');
  try {
    let size = 0;
    const started = Date.now();
    let lastGrowth = started;
    let text = '';
    while (!finished.now) {
      await delay(LOOK_MS);
      // Silence alone never ends an engine that keeps printing, such as a case warning every frame.
      const deadline = launch.deadlineSeconds;
      if (ended === null && deadline !== null && Date.now() - started > deadline * 1000) {
        const stoppedIn = readRun(text).stoppedIn;
        ended = `the engine ran past the ${String(deadline)} s deadline${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended`;
        stop();
      }
      const now = fstatSync(reading).size;
      if (now > size) {
        const chunk = Buffer.alloc(now - size);
        readSync(reading, chunk, 0, chunk.length, size);
        text += chunk.toString('utf8');
        size = now;
        lastGrowth = Date.now();
        if (ended === null && text.includes(AUTOLOAD_FAILED)) {
          ended = 'an autoload did not start, so the suites were ended rather than run without it';
          stop();
        }
      } else if (ended === null && Date.now() - lastGrowth > silenceSeconds * 1000) {
        const stoppedIn = readRun(text).stoppedIn;
        // A helper that never wrote the pid never started the engine, which is a start that hung.
        const unstarted =
          helper !== null && !existsSync(helper.pid)
            ? `, and it never started ${helper.how}: ${helperStep(helper.step)}`
            : '';
        ended = `the engine printed nothing for ${String(silenceSeconds)} s${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended${unstarted}`;
        stop();
      }
    }
  } finally {
    closeSync(reading);
    launch.running.delete(stop);
  }
  const { code, signal } = await exited;
  // The helper's own failure reaches only its file, and the exit code it leaves says nothing.
  const failed = helper === null ? null : helperFailure(helper.error);
  if (failed !== null && helper !== null) {
    ended ??= `the engine could not be started ${helper.how}: ${failed}`;
  }
  return { code, signal, ended };
}

/** Ends [param child] and everything it started: Godot's console build is a wrapper around the engine. */
function endTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    runHidden('taskkill', ['/T', '/F', '/PID', String(child.pid)]).catch(() => {
      // Gone already.
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}

/** Prints how the run went and answers the exit code: what failed, in full, then one line of totals. */
function report(
  ran: readonly EngineRan[],
  across: readonly string[],
  startedAt: number,
  runDirectory: string,
  printOutput: boolean,
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
    console.log('');
    console.log(
      `--- engine ${String(engine.index)}: ${plural(engine.plan.suites.length, 'suite')}, ${engine.seconds.toFixed(1)} s`,
    );
    for (const fault of engine.verdict.faults) {
      console.log(`  ${fault}`);
    }
    if (engine.verdict.shown.length > 0) {
      console.log('');
      for (const line of engine.verdict.shown) {
        console.log(line);
      }
    }
    console.log(`everything it printed: ${engine.log}`);
  }
  if (across.length > 0) {
    console.log('');
    console.log('--- the cases dealt by their rows, over every engine holding them:');
    for (const fault of across) {
      console.log(`  ${fault}`);
    }
  }
  const cases = ran.reduce(
    (sum, engine) => sum + [...engine.printed.suites.values()].reduce((n, s) => n + s.cases.length, 0),
    0,
  );
  const suites = new Set(ran.flatMap((engine) => engine.plan.suites.map((suite) => suite.path))).size;
  const longest = Math.max(0, ...ran.map((engine) => engine.seconds));
  const took = (Date.now() - startedAt) / 1000;
  const totals = `${plural(cases, 'case')} in ${plural(suites, 'suite')} across ${plural(ran.length, 'engine')}, ${took.toFixed(1)} s; the longest engine took ${longest.toFixed(1)} s.`;
  console.log('');
  if (failed.length === 0 && across.length === 0) {
    rmSync(runDirectory, { recursive: true, force: true });
    console.log(`Passed: ${totals}`);
    return 0;
  }
  const problems = failed.reduce((sum, engine) => sum + engine.verdict.faults.length, across.length);
  console.log(`Failed: ${plural(problems, 'problem')}, listed above. Ran ${totals}`);
  console.log(`Every engine's output is kept under ${runDirectory} until the next run.`);
  return 1;
}
