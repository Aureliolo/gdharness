/**
 * What one engine's run of suites printed, read case by case, and judged.
 *
 * Read from the engine's own console rather than from gdUnit4's reports, because a gate needs what
 * the reports leave out: the `ERROR` and `WARNING` lines a passing case printed, which case printed
 * each one, the
 * leaks the engine reports as it exits, and how far a run got when it crashed or was ended. Both of
 * the engine's streams go into one file, so an error is read in order with the case lines around it.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import {
  EXIT_LEAK,
  heldAtExit,
  type SelfTypedExport,
  selfTypedSentence,
  WALK_STOPPED_SENTENCE,
  walkStoppedPartWay,
} from './engine-leaks.js';
import { CRASH_HEADER, caseLineOf, GDUNIT_TIME, type LogEntry, suiteOpenedBy } from './game-log.js';
import { DiscoveryRead, type OrphansLeft, orphansLeftOn, orphansLeftSaid } from './junit.js';
import { bytesAt, eachLogLine, owned } from './log-read.js';
import { isRecord, isStringList } from './records.js';

/** One case as the run reported it finishing. */
interface CaseRan {
  /** As gdUnit4 printed it: the function, or `test_params:0 (1)` for one row of a parameterised case. */
  readonly name: string;
  /** The function the case is, which is what a suite declares and a skipping file names. */
  readonly func: string;
  /** Which row of a parameterised case it is, or null for a case that is not one. */
  readonly row: number | null;
  /** PASSED, FAILED, FLAKY, SKIPPED or WARNING, without the retry count gdUnit4 prints after some. */
  readonly verdict: string;
  readonly seconds: number;
  /** Where its verdict line is in the printed lines. */
  readonly at: number;
}

interface SuitePrinted {
  readonly path: string;
  readonly cases: CaseRan[];
  /** The verdict and time on its statistics line, or null when the run never reached it. */
  closed: { readonly verdict: string; readonly seconds: number } | null;
  /** What it spent before its first case, as the runner printed it, or null when it printed none. */
  setUp: SuiteSetUp | null;
}

/**
 * What a suite spent before its first case, which gdUnit4's case and suite times leave out of the
 * one and spread over the other.
 */
interface SuiteSetUp {
  /** From the suite before it ending, or the session opening, until gdUnit4 began it: its load. */
  readonly loadSeconds: number;
  /** Its `before()`, up to its first case. */
  readonly beforeSeconds: number;
}

/** What an engine spent before its first suite, as the runner printed it. */
export interface EngineStart {
  /** From the engine starting until gdUnit4 opened its session. */
  readonly seconds: number;
  /** The part of it spent compiling the engine's suites together. */
  readonly compiledSeconds: number;
}

/** An error or warning line the engine printed, and what was running when it did. */
interface PrintedError {
  /** The line's text after `ERROR: ` or `WARNING: `, which is what a suite declares it expects. */
  readonly text: string;
  /** Whether it is a warning, which a suite declares apart from its errors. */
  readonly warning: boolean;
  /** Whether the engine headed it `SCRIPT ERROR` or `SCRIPT WARNING`, a fault in running a script. */
  readonly script?: boolean;
  readonly at: number;
  /** The suite that was open, or null for one printed outside every suite. */
  readonly suite: string | null;
  /**
   * The case that printed it, as {@link CaseRan.name}, or `before` or `after` for the suite's own
   * hooks. Null outside every suite. A line printed after a case's verdict counts as that case's
   * when another case follows, since what a case leaves for a later frame prints there, and as
   * `after`'s once the last case is done, since `after` runs there.
   */
  readonly during: string | null;
}

export interface RunPrinted {
  readonly lines: readonly string[];
  readonly suites: ReadonlyMap<string, SuitePrinted>;
  readonly errors: readonly PrintedError[];
  /** Lines saying objects, resources, memory pages or RIDs were still held as the engine exited. */
  readonly leaks: readonly string[];
  /** Lines saying the engine ran out of memory, or a decode the memory pressure starved. */
  readonly starved: readonly string[];
  /** The case count of gdUnit4's closing summary, or null when the run never printed one. */
  readonly executed: number | null;
  /** Scripts gdUnit4 could not load while looking for cases, which stops the run before its first. */
  readonly unloadable: readonly string[];
  /** What was running as the printed lines end: a case, a suite's hook, or null outside every suite. */
  readonly stoppedIn: string | null;
  /**
   * The same as [member stoppedIn], read: the suite open as the printed lines end and the case
   * running in it, `before` in its first hook, or null between its cases and after them.
   */
  readonly running: { readonly suite: string; readonly during: string | null } | null;
  /**
   * The rows the engine found and left to the others, by `path > func`, or null for a case that is no
   * row. gdUnit4 prints nothing for them, so without these a row no engine was dealt goes unseen.
   */
  readonly leftOut: ReadonlyMap<string, readonly (number | null)[]>;
  /** The version the engine's banner gives, such as `4.7.2.stable.official.ed1daf0bf`, or null. */
  readonly engineVersion: string | null;
  /** What the engine spent before its first suite, or null when the run never opened a session. */
  readonly started: EngineStart | null;
  /** The time a reused engine spent compiling its share's suites together, or null for any other share. */
  readonly reusedCompiledSeconds: number | null;
  /** The orphans each case or suite's hooks left, as the runner named them. */
  readonly orphansLeft: readonly OrphansLeft[];
  /** The rows gdUnit4 skipped for data that does not fit their case's parameters. */
  readonly mismatched: readonly MismatchedRow[];
  /** The cases gdUnit4 skipped because it cannot run them as they are declared. */
  readonly unrunnable: readonly MismatchedRow[];
  /** The cases, rows and suites skipped with `do_skip`, which never ran. */
  readonly skipped: readonly SkippedRow[];
}

/**
 * A case, or a row of a parameterised one, that gdUnit4 skipped for how it is declared, or for data
 * that does not fit it.
 */
interface MismatchedRow {
  readonly suite: string;
  /** The row as gdUnit4 printed it, `test_fit:0 (…)`. */
  readonly name: string;
  /** gdUnit4's reason, its lines joined. */
  readonly reason: string;
}

/**
 * A case, a row or a whole suite skipped with `do_skip`. The cases of a skipped suite print the
 * same reason, gdUnit4's own, so the suite is the one entry and `cases` counts what it held.
 */
interface SkippedRow {
  readonly suite: string;
  /** The case or row as gdUnit4 printed it, or null for a suite skipped whole. */
  readonly name: string | null;
  /** The reason `skip_reason` gave, or gdUnit4's own when it was given none. */
  readonly reason: string;
  /** How many cases never ran: one, or every case of a suite skipped whole. */
  readonly cases: number;
  /** There when the output ended, or gdUnit4 went on, before a quote closed the reason. */
  readonly cut?: true;
}

// Printed by the runner in src/godot/tests/listed.gd, TIMING there.
const STARTED_TIMING = /^gdharness timing: started (\d+) ms, compiled together (\d+) ms\s*$/;
const REUSED_TIMING = /^gdharness timing: reused engine, compiled together (\d+) ms\s*$/;
const SET_UP_TIMING = /^gdharness timing: (res:\/\/.+?\.gd) loaded (\d+) ms, before (\d+) ms\s*$/;
const STATISTICS = new RegExp(String.raw`^Statistics:.*\|\s*([A-Z]+)(?:\s+\(.*?\))?\s+(${GDUNIT_TIME})\s*$`);
// The text keeps its trailing blanks here and loses them where it is read: a pattern leaving them
// out took a minute over one line of 200,000 blanks, with the watch on a silent engine stopped.
const ERROR_LINE = /^\s*(?:SCRIPT |USER )?ERROR: (.*)$/;
const WARNING_LINE = /^\s*(?:SCRIPT |USER )?WARNING: (.*)$/;
/**
 * The engine's own line for what it held as it exited, which opens with the count or the report. An
 * error of the project's that quotes the report further in is the project's.
 */
const EXIT_LEAK_LINE = new RegExp(String.raw`^\s*(?:ERROR|WARNING): (?:\d+ )?(?:${EXIT_LEAK.source})`);

const EXECUTED = /^Executed test cases\s*:\s*\((\d+)\//;
// gdUnit4's reason for skipping a row whose data does not fit its case, printed under the row, which
// it prints as PASSED first. The run's summary counts it skipped, and nothing else says it never ran.
const MISMATCHED_ROW = /^\s*The test data set at index \(\d+\) does not match the expected test parameters/;
// gdUnit4's reason for skipping a case it cannot run as declared, printed under the case the same
// way: a parameter it has no data for, or a fuzzer declared after a setting. Not a skip the case
// asked for with do_skip, whose reason is the case's own.
const UNRUNNABLE_CASE =
  /^\s*Reason: '((?:Unknown test case argument's \[.*\] found|Fuzzer argument '.+' must be declared before the test config argument\(s\) \[.*\])\.)'\s*$/;
// What gdUnit4 prints over the reason of a case skipped with do_skip, and over a suite skipped whole
// with do_skip in its before(): `Skipped 2 tests` follows the second, and each case of that suite
// prints the first with the reason below. A case skipped by this reason is counted in the suite's.
const CASE_SKIPPED = /^\s*This test is skipped!\s*$/;
const SUITE_SKIPPED = /^\s*The Entire test-suite is skipped!\s*$/;
const SUITE_SKIPPED_COUNT = /^\s*Skipped (\d+) tests\s*$/;
// The first line of the reason under either heading. A reason holding line breaks goes on over the
// lines below it, to the last line ending in a quote before the entry ends.
const SKIP_REASON = /^\s*Reason: '(.*)$/;
// The heading gdUnit4 prints over the reports of a case, or of a suite as `x_test > finalize()  Report:`.
const REPORT_HEADING = /\bReport:\s*$/;
const SKIPPED_WITH_ITS_SUITE = 'Skipped from the entire test suite';
// The engine's first line, `Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org`.
// A build of its own adds when it was built, `(2026-08-17 01:18:38 UTC)`, before the address.
const BANNER = /^\s*Godot Engine v(\S+?)(?:\s+\([^)]*\))?(?:\s+-\s+\S+)?\s*$/;
// Printed by the runner in src/godot/tests/listed.gd as it leaves a row out, -1 for a case whole.
const LEFT_OUT = /^gdharness left out (res:\/\/.+?\.gd) > ([^:\s]+):(-?\d+)\s*$/;
// Godot giving up on a rendering driver it could not start, and starting the next. The display
// server is made before any script of the project runs, so every error printed before this line
// is the engine probing a driver: a windowed engine on a machine without a Vulkan surface prints
// two and then runs its cases on Direct3D 12 or OpenGL.
const DRIVER_FALLBACK = /^\s*WARNING: Your video card drivers .*, switching to /;
// The line under a warning naming where in the engine it was raised, when that is the platform layer
// or a rendering driver: `at: DisplayServerMacOS (platform/macos/display_server_macos.mm:3837)`.
const MACHINE_WARNED = /^\s*at: .*\((?:\.\/)?(?:platform|drivers)\//;
// gdUnit4's own report of the orphans a case or suite left, printed with a WARNING prefix. The
// orphans are reported from the suite's statistics. Read as a warning no suite declared, the line
// came back as one more fault, with advice to declare it rather than free the nodes.
const ORPHANS_REPORTED = /^\s*WARNING: Detected \d+ (?:possible )?orphan nodes\.\s*$/;
// The allocator's null, in its error line and the location under it, an image decode the same
// pressure made fail, and godot-sandbox failing to allocate a sandbox. All three are the machine
// running out, not the case being wrong. Other sandbox exceptions are a program the sandbox refuses.
const STARVED = [
  /ERROR: Sandbox construction exception: (?:std::bad_alloc|bad allocation)\s*\n\s*at: [\w:]+ \([^)\n]*sandbox\.cpp:/g,
  /Parameter "mem(?:_new)?" is null\.?\s*\n\s*at: \w+ \((?:\.\/)?core\/(?:os\/memory\.cpp|templates\/cowdata\.h):/g,
  /ERROR: Failed decoding WebP image\.\s*\n\s*at: _webp_unpack/g,
];

/** A gdUnit4 time such as `1min 2s 30ms`, as seconds. */
export function secondsOf(time: string): number {
  // Summed in whole milliseconds, so 74ms reads as 0.074 and not a hair off it.
  let ms = 0;
  for (const [, amount, unit] of time.matchAll(/(\d+)(h|min|ms|s)\b/g)) {
    ms += Number(amount) * (unit === 'h' ? 3_600_000 : unit === 'min' ? 60_000 : unit === 's' ? 1000 : 1);
  }
  return ms / 1000;
}

/** The function a printed case name is: the part before a parameterised row's `:index (values)`. */
export function funcOf(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(0, colon);
}

/** The row a printed case name is, `test_params:3 (…)` being row 3, or null when it is no row. */
export function rowOf(name: string): number | null {
  const row = /^[^:]+:(\d+)(?: |$)/.exec(name)?.[1];
  return row === undefined ? null : Number(row);
}

/**
 * The rows of one parameterised case an engine runs: those in `only`, or every row but those in
 * `besides`, for the engine taking whatever rows were dealt nowhere else. A case that has stopped
 * being parameterised runs only in that one.
 */
export type RowShare = { readonly only: readonly number[] } | { readonly besides: readonly number[] };

/** Whether an engine given [param share] runs [param row], null for a case that is no row. */
function rowRuns(share: RowShare, row: number | null): boolean {
  return 'only' in share
    ? row !== null && share.only.includes(row)
    : row === null || !share.besides.includes(row);
}

/** [param printed], both streams in the order they came, read into suites, cases and errors. */
export function readRun(printed: string): RunPrinted {
  const lines = stripVTControlCharacters(printed).replaceAll('\r\n', '\n').split('\n');
  const {
    lineCount: _lineCount,
    errorsDropped: _errorsDropped,
    judged: _judged,
    declaredErrors: _declaredErrors,
    ...read
  } = readRunLines(lines, Infinity);
  return { lines, ...read };
}

/** A run read as {@link readRun} reads it, without its lines, which were read once and let go. */
type RunRead = Omit<RunPrinted, 'lines'> & {
  /** How many lines the run printed. */
  readonly lineCount: number;
  /** How many errors past the most kept were judged and not kept. */
  readonly errorsDropped: number;
};

/** A log read with {@link readEngineLog}, its errors judged against what the suites declare. */
export type LogRead = RunRead & {
  /**
   * As {@link unexpectedErrors} answers for every suite the log opened. Each error the log printed
   * was judged, those past the most kept included, and `printed` lists the kept ones.
   */
  readonly judged: ErrorsJudged;
  /** How many errors, not warnings, the suites declared and printed, those not kept included. */
  readonly declaredErrors: number;
};

/** The most errors a run read off a log of any size keeps. */
export const ERRORS_KEPT = 100_000;

/** The lines read once, in order, with a look at those just ahead and nothing kept behind. */
class LinesAhead {
  private readonly ahead: string[] = [];
  /** The index of the first line held. */
  private base = 0;
  private ended = false;
  private readonly source: Iterator<string>;

  constructor(source: Iterator<string>) {
    this.source = source;
  }

  /** The line at [param index], which is never one already let go, or undefined past the last. */
  at(index: number): string | undefined {
    while (!this.ended && index >= this.base + this.ahead.length) {
      const next = this.source.next();
      if (next.done === true) {
        this.ended = true;
      } else {
        this.ahead.push(next.value);
      }
    }
    return this.ahead[index - this.base];
  }

  /** Lets go of every line before [param index]. */
  dropBefore(index: number): void {
    if (index > this.base) {
      this.ahead.splice(0, index - this.base);
      this.base = index;
    }
  }
}

/**
 * As {@link readRun}, from the lines already split and stripped of colour codes, read once in order.
 * At most [param errorsKept] errors are kept, and each is judged against [param expected] as it is
 * read, those not kept included.
 */
function readRunLines(
  source: Iterable<string>,
  errorsKept: number,
  expected: Expected = { errors: {}, warnings: {} },
): RunRead & Pick<LogRead, 'judged' | 'declaredErrors'> {
  const lines = new LinesAhead(source[Symbol.iterator]());
  const state: RunState = {
    lines,
    errorsKept,
    errorsDropped: 0,
    declaredErrors: 0,
    declared: new DeclaredErrors(expected, null),
    undeclared: [],
    heldDropped: new Map(),
    suites: new Map(),
    errors: [],
    leaks: [],
    leftOut: new Map(),
    orphansLeft: [],
    mismatched: [],
    unrunnable: [],
    skipped: [],
    executed: null,
    open: null,
    during: null,
    afterCase: [],
    lastCase: null,
    engineVersion: null,
    started: null,
    reusedCompiledSeconds: null,
    reasonEnds: -1,
  };
  const discovery = new DiscoveryRead();
  const starved = new StarvedRead();
  let at = 0;
  for (let line = lines.at(0); line !== undefined; line = lines.at(at)) {
    readLine(state, line, at);
    discovery.take(line);
    starved.take(line);
    at += 1;
    lines.dropBefore(at);
  }
  const last = state.open;
  const { during } = state;
  const stoppedIn = last === null ? null : stoppedInOf(last, during, state.lastCase);
  settleAfterCase(state, 'after');
  const unloadable = (discovery.result()?.errors ?? []).map(
    (error) => `${error.path}${error.line === null ? '' : `:${String(error.line)}`}: ${error.message}`,
  );
  return {
    lineCount: at,
    errorsDropped: state.errorsDropped,
    declaredErrors: state.declaredErrors,
    suites: state.suites,
    errors: state.errors,
    leaks: state.leaks,
    starved: starved.result(),
    executed: state.executed,
    unloadable,
    stoppedIn,
    running: last === null ? null : { suite: last.path, during },
    leftOut: state.leftOut,
    engineVersion: state.engineVersion,
    started: state.started,
    reusedCompiledSeconds: state.reusedCompiledSeconds,
    orphansLeft: state.orphansLeft,
    mismatched: state.mismatched,
    unrunnable: state.unrunnable,
    skipped: state.skipped,
    judged: {
      printed: state.undeclared,
      neverPrinted: state.declared.neverPrinted(state.suites, state.suites.keys()),
    },
  };
}

/** An error or warning printed after a case's verdict, before it is known whose it is. */
interface HeldError {
  readonly text: string;
  readonly at: number;
  readonly warning: boolean;
  readonly script: boolean;
}

/** How many blank lines {@link StarvedRead} holds apart before it joins them into one text. */
const BLANKS_JOINED = 1024;

/**
 * The {@link STARVED} lines in what was printed, read a line at a time. Each pattern spans an error
 * line, the blank lines after it and the `at:` line after those, so only those are held.
 */
class StarvedRead {
  private readonly found: string[][] = STARVED.map(() => []);
  /** The last line that was not blank. */
  private before: string | null = null;
  /** The blank lines since, each run of {@link BLANKS_JOINED} joined into one text so a line costs its characters. */
  private blanks: string[] = [];
  /** The blank lines since the last run was joined. */
  private loose: string[] = [];

  take(line: string): void {
    if (line.trim() === '') {
      if (this.before !== null) {
        this.loose.push(line);
        if (this.loose.length >= BLANKS_JOINED) {
          this.blanks.push(this.loose.join('\n'));
          this.loose = [];
        }
      }
      return;
    }
    if (this.before !== null) {
      const spanned = [this.before, ...this.blanks, ...this.loose, line].join('\n');
      for (const [which, pattern] of STARVED.entries()) {
        for (const match of spanned.matchAll(pattern)) {
          this.found[which]?.push(owned(match[0]));
        }
      }
    }
    this.before = line;
    this.blanks = [];
    this.loose = [];
  }

  result(): string[] {
    return this.found.flat();
  }
}

/** Whether another error can be kept, the held ones counted. */
function errorKept(state: RunState): boolean {
  return state.errors.length + state.afterCase.length < state.errorsKept;
}

/**
 * Judges [param error], whose suite and case are known, against what its suite declares, and keeps
 * it while fewer than the most errors are kept, or while fewer than that many undeclared ones are
 * when no suite declared it. Each one not kept is counted.
 */
function errorRead(state: RunState, error: PrintedError, kept = errorKept(state)): void {
  const declared = state.declared.settles(error);
  if (declared && !error.warning) {
    state.declaredErrors += 1;
  }
  // One no suite declared fails the run wherever it came, so those are kept to a bound of their own.
  if (!kept && (declared || state.undeclared.length >= state.errorsKept)) {
    state.errorsDropped += 1;
    return;
  }
  state.errors.push(error);
  if (!declared) {
    state.undeclared.push(error);
  }
}

/**
 * Holds [param error], printed after a case's verdict, until it is known whose it is. One past the
 * most kept is held only by its text and how many times it came, and only when the open suite
 * declares that text for some case, since no other can be settled. The rest no suite declares, and
 * each is held whole while fewer undeclared ones are held than the most kept, then counted.
 */
function errorHeld(state: RunState, error: HeldError): void {
  if (errorKept(state)) {
    state.afterCase.push(error);
    return;
  }
  const suite = state.open?.path ?? '';
  if (!state.declared.mayDeclare(suite, error.warning, error.text)) {
    if (state.undeclared.length + state.afterCase.length < state.errorsKept) {
      state.afterCase.push(error);
    } else {
      state.errorsDropped += 1;
    }
    return;
  }
  const key = JSON.stringify([error.warning, error.script, error.text]);
  const held = state.heldDropped.get(key);
  if (held === undefined) {
    state.heldDropped.set(key, { error, times: 1 });
  } else {
    held.times += 1;
  }
}

/** What {@link readRun} has read so far. */
interface RunState {
  /** The lines, of which only the one being read and those after it are looked at. */
  readonly lines: { at(index: number): string | undefined };
  /** The most errors kept, the held ones included. */
  readonly errorsKept: number;
  /** How many errors were not kept for that. */
  errorsDropped: number;
  /** How many errors, not warnings, the suites declared and printed, of every line. */
  declaredErrors: number;
  /** What the suites declare, which each error is judged against as its suite and case are known. */
  readonly declared: DeclaredErrors;
  /** The errors kept that no suite declared, in the order printed. */
  readonly undeclared: PrintedError[];
  /** The errors past the most kept that are held after a verdict, by text, with how often each came. */
  readonly heldDropped: Map<string, { readonly error: HeldError; times: number }>;
  readonly suites: Map<string, SuitePrinted>;
  readonly errors: PrintedError[];
  readonly leaks: string[];
  readonly leftOut: Map<string, (number | null)[]>;
  readonly orphansLeft: OrphansLeft[];
  readonly mismatched: MismatchedRow[];
  readonly unrunnable: MismatchedRow[];
  readonly skipped: SkippedRow[];
  executed: number | null;
  open: SuitePrinted | null;
  during: string | null;
  /** Errors printed after a verdict, held until it is known whether another case follows. */
  afterCase: HeldError[];
  lastCase: string | null;
  engineVersion: string | null;
  started: EngineStart | null;
  reusedCompiledSeconds: number | null;
  /** The last line of a skip's reason, read whole where it began, which no reader looks into again. */
  reasonEnds: number;
}

/** Reads one printed line into the state, and says whether it did. */
type LineReader = (state: RunState, line: string, at: number) => boolean;

/** Gives the errors held since the last verdict to [param owner]. */
function settleAfterCase(state: RunState, owner: string): void {
  const suite = state.open?.path ?? null;
  const held = state.afterCase;
  state.afterCase = [];
  for (const error of held) {
    errorRead(state, { ...error, suite, during: owner }, true);
  }
  for (const { error, times } of state.heldDropped.values()) {
    for (let copy = 0; copy < times; copy += 1) {
      errorRead(state, { ...error, suite, during: owner }, false);
    }
  }
  state.heldDropped.clear();
}

/** Where a run that printed no more lines was, as a sentence: in the suite [param last] open at the end. */
function stoppedInOf(last: SuitePrinted, during: string | null, lastCase: string | null): string {
  if (during === null) {
    return `${last.path}, after ${lastCase ?? 'its cases'}`;
  }
  return during === 'before' ? `${last.path}, in before` : `${last.path} > ${during}`;
}

const readBanner: LineReader = (state, line) => {
  const banner: RegExpExecArray | null = state.engineVersion === null ? BANNER.exec(line) : null;
  if (banner === null) {
    return false;
  }
  state.engineVersion = banner[1] ?? null;
  return true;
};

const readOrphansLeft: LineReader = (state, line) => {
  const orphaned = orphansLeftOn(line);
  if (orphaned === null) {
    return false;
  }
  state.orphansLeft.push(orphaned);
  return true;
};

const readStartTiming: LineReader = (state, line) => {
  const startTimed = STARTED_TIMING.exec(line);
  if (startTimed === null) {
    return false;
  }
  state.started = { seconds: Number(startTimed[1]) / 1000, compiledSeconds: Number(startTimed[2]) / 1000 };
  return true;
};

const readReusedTiming: LineReader = (state, line) => {
  const reused = REUSED_TIMING.exec(line);
  if (reused === null) {
    return false;
  }
  state.reusedCompiledSeconds = Number(reused[1]) / 1000;
  return true;
};

const readSetUpTiming: LineReader = (state, line) => {
  const setUpTimed = SET_UP_TIMING.exec(line);
  if (setUpTimed === null) {
    return false;
  }
  const timed = state.suites.get(setUpTimed[1] ?? '');
  if (timed !== undefined) {
    timed.setUp = {
      loadSeconds: Number(setUpTimed[2]) / 1000,
      beforeSeconds: Number(setUpTimed[3]) / 1000,
    };
  }
  return true;
};

const readLeftOut: LineReader = (state, line) => {
  const left = LEFT_OUT.exec(line);
  if (left === null) {
    return false;
  }
  const key = `${left[1] ?? ''} > ${left[2] ?? ''}`;
  const row = Number(left[3]);
  state.leftOut.set(key, [...(state.leftOut.get(key) ?? []), row < 0 ? null : row]);
  return true;
};

const readSuiteOpened: LineReader = (state, line) => {
  const opened = suiteOpenedBy(line);
  if (opened === null) {
    return false;
  }
  settleAfterCase(state, 'after');
  const open = state.suites.get(opened) ?? { path: opened, cases: [], closed: null, setUp: null };
  state.suites.set(open.path, open);
  state.open = open;
  state.during = 'before';
  state.lastCase = null;
  return true;
};

const readCase: LineReader = (state, line, at) => {
  const caseLine = caseLineOf(line);
  const { open } = state;
  if (caseLine === null || open === null) {
    return false;
  }
  const { name } = caseLine;
  if (caseLine.verdict === 'STARTED') {
    settleAfterCase(state, state.lastCase ?? 'before');
    state.during = name;
    return true;
  }
  open.cases.push({
    name,
    func: funcOf(name),
    row: rowOf(name),
    verdict: caseLine.verdict,
    seconds: secondsOf(caseLine.time),
    at,
  });
  state.lastCase = name;
  state.during = null;
  return true;
};

const readStatistics: LineReader = (state, line) => {
  const statistics = STATISTICS.exec(line);
  const { open } = state;
  if (statistics === null || open === null) {
    return false;
  }
  settleAfterCase(state, 'after');
  open.closed = { verdict: statistics[1] ?? '', seconds: secondsOf(statistics[2] ?? '') };
  state.open = null;
  state.during = null;
  state.lastCase = null;
  return true;
};

/**
 * Reads the heading gdUnit4 prints over a skip at [param at], and keeps the skip when its reason is
 * one `do_skip` gave. Says whether [param line] was such a heading.
 */
function readSkipHeading(
  state: RunState,
  suite: string,
  lastCase: string,
  line: string,
  at: number,
): boolean {
  const whole = SUITE_SKIPPED.test(line);
  if (!whole && !CASE_SKIPPED.test(line)) {
    return false;
  }
  const count = whole ? SUITE_SKIPPED_COUNT.exec(state.lines.at(at + 1) ?? '')?.[1] : '1';
  const said = count === undefined ? null : skipReasonAt(state.lines, whole ? at + 2 : at + 1);
  if (said === null) {
    return true;
  }
  state.reasonEnds = said.ends;
  const cut = said.cut ? { cut: true as const } : {};
  if (whole) {
    state.skipped.push({ suite, name: null, reason: said.reason, cases: Number(count), ...cut });
  } else if (said.reason !== SKIPPED_WITH_ITS_SUITE) {
    state.skipped.push({ suite, name: lastCase, reason: said.reason, cases: 1, ...cut });
  }
  return true;
}

/** Whether gdUnit4 printed [param line] of its own after a report, which ends the report's entry. */
function entryEnds(line: string): boolean {
  return (
    caseLineOf(line) !== null ||
    suiteOpenedBy(line) !== null ||
    STATISTICS.test(line) ||
    REPORT_HEADING.test(line) ||
    CASE_SKIPPED.test(line) ||
    SUITE_SKIPPED.test(line)
  );
}

/**
 * The reason gdUnit4 printed from the line at [param at] on, and the last line of it. Null when no
 * reason is there, or the reason is gdUnit4's own for a row whose data does not fit or a case it
 * cannot run, which are read as those.
 *
 * The reason runs to the last line ending in a quote before the entry ends, as the report's reader
 * takes it to the entry's last quote, since a line of the reason can end in a quote with a blank
 * line under it. With no such line it is cut: what was read is the reason, and it ends on its first
 * line, so whatever came after it is still read, the engine's last errors included.
 */
function skipReasonAt(
  lines: RunState['lines'],
  at: number,
): { reason: string; ends: number; cut: boolean } | null {
  const first = lines.at(at) ?? '';
  const opened = SKIP_REASON.exec(first)?.[1];
  if (opened === undefined || UNRUNNABLE_CASE.test(first) || MISMATCHED_ROW.test(lines.at(at + 1) ?? '')) {
    return null;
  }
  const parts: string[] = [];
  let closes = -1;
  for (let line: string | undefined = opened; line !== undefined; line = lines.at(at + parts.length)) {
    if (parts.length > 0 && entryEnds(line)) {
      break;
    }
    if (line.trimEnd().endsWith("'")) {
      closes = parts.length;
    }
    parts.push(line);
  }
  if (closes < 0) {
    return { reason: parts.join('\n').trimEnd(), ends: at, cut: true };
  }
  const last = (parts[closes] ?? '').trimEnd().slice(0, -1);
  return { reason: [...parts.slice(0, closes), last].join('\n'), ends: at + closes, cut: false };
}

// A row or case gdUnit4 skips for how it is declared never ran, and it calls the run passed: a
// case taking its rows from a function returning a constant had all three skipped, and a case
// run alone whose parameter had a typo in its name was answered passed. The reason is printed
// under the case, so it is read while that suite is open.
const readSkipReason: LineReader = (state, line, at) => {
  const { open, lastCase } = state;
  if (open === null || lastCase === null) {
    return false;
  }
  const declared = UNRUNNABLE_CASE.exec(line)?.[1];
  if (declared !== undefined) {
    state.unrunnable.push({ suite: open.path, name: lastCase, reason: declared });
    return true;
  }
  if (readSkipHeading(state, open.path, lastCase, line, at)) {
    return true;
  }
  if (!MISMATCHED_ROW.test(line)) {
    return false;
  }
  state.reasonEnds = at;
  const parts = [line.trim()];
  while (!['', "'"].includes((state.lines.at(state.reasonEnds + 1) ?? '').trim())) {
    state.reasonEnds += 1;
    parts.push((state.lines.at(state.reasonEnds) ?? '').trim());
  }
  state.mismatched.push({
    suite: open.path,
    name: lastCase,
    reason: parts.join(' ').replaceAll(/\[\/?color[^\]]*\]/g, ''),
  });
  return true;
};

const readExecuted: LineReader = (state, line) => {
  const counted = EXECUTED.exec(line);
  if (counted?.[1] === undefined) {
    return false;
  }
  state.executed = Number(counted[1]);
  return true;
};

const readExitLeak: LineReader = (state, line) => {
  if (!EXIT_LEAK_LINE.test(line)) {
    return false;
  }
  state.leaks.push(line.trim());
  return true;
};

const readOrphansReported: LineReader = (_state, line) => ORPHANS_REPORTED.test(line);

const readDriverFallback: LineReader = (state, line) => {
  if (!DRIVER_FALLBACK.test(line)) {
    return false;
  }
  if (state.suites.size === 0) {
    state.errors.length = 0;
    state.undeclared.length = 0;
    state.errorsDropped = 0;
  }
  return true;
};

const readEngineError: LineReader = (state, line, at) => {
  const error = ERROR_LINE.exec(line);
  // Outside every suite too, where one is the project's own, from an autoload, a session hook or
  // the import, except one the engine's platform layer or a rendering driver raised: those are
  // about the machine, as a windowed engine on a macOS runner's virtual GPU warns that it is
  // switching to ANGLE as its display server starts. The leaks it reports at exit are read above.
  const warned =
    error === null && !(state.open === null && MACHINE_WARNED.test(state.lines.at(at + 1) ?? ''))
      ? WARNING_LINE.exec(line)
      : null;
  const found = error ?? warned;
  if (found === null) {
    return false;
  }
  const text = (found[1] ?? '').trimEnd();
  const warning = error === null;
  const script = /^\s*SCRIPT /.test(line);
  if (state.open === null) {
    errorRead(state, { text, at, suite: null, during: null, warning, script });
  } else if (state.during === null) {
    errorHeld(state, { text, at, warning, script });
  } else {
    errorRead(state, { text, at, suite: state.open.path, during: state.during, warning, script });
  }
  return true;
};

// In the order a line is tried: the first reader that takes it ends the line.
const LINE_READERS: readonly LineReader[] = [
  readBanner,
  readOrphansLeft,
  readStartTiming,
  readReusedTiming,
  readSetUpTiming,
  readLeftOut,
  readSuiteOpened,
  readCase,
  readStatistics,
  readSkipReason,
  readExecuted,
  readExitLeak,
  readOrphansReported,
  readDriverFallback,
  readEngineError,
];

/** Reads [param line], the one at [param at], with the first reader that takes it. */
function readLine(state: RunState, line: string, at: number): void {
  // A reason's lines are its text, which an `ERROR:` line inside it does not change.
  if (at <= state.reasonEnds) {
    return;
  }
  for (const read of LINE_READERS) {
    if (read(state, line, at)) {
      return;
    }
  }
}

// What Godot prints before an error raised while it was printing another. It writes the pair
// straight to stderr, past every logger, so a log the engine writes with --log-file never has them.
const NESTED_ERROR = 'While attempting to print an error, another error was printed:';

/**
 * What the engine printed into the log at [param path], read whole a line at a time, so a log of any
 * size is judged as its text would be, keeping at most {@link ERRORS_KEPT} errors. A log not there
 * is an empty run. [param nested] are the errors Godot raised while printing another, which
 * {@link nestedError} finds in the piped streams, added as {@link withNestedErrors} adds them.
 * Every error is judged against [param expected] as it is read. [param chunkBytes] is how much is
 * read at once.
 */
export function readEngineLog(
  path: string,
  nested: readonly string[],
  expected: Expected,
  chunkBytes?: number,
): LogRead {
  const read = readRunLines(existsSync(path) ? eachLogLine(path, chunkBytes) : [''], ERRORS_KEPT, expected);
  const added = nested.map((text) => ({
    text,
    at: read.lineCount,
    suite: null,
    during: null,
    warning: false,
  }));
  return added.length === 0
    ? read
    : {
        ...read,
        errors: [...read.errors, ...added],
        judged: { ...read.judged, printed: [...read.judged.printed, ...added] },
      };
}

/**
 * The error Godot raised while printing another, when [param entry] of the piped streams says one
 * follows and [param next], the entry after it, is that error. Null otherwise.
 */
export function nestedError(entry: LogEntry, next: LogEntry | undefined): string | null {
  return entry.severity === 'info' && entry.text.trim() === NESTED_ERROR && next?.severity === 'error'
    ? next.text
    : null;
}

/** The bytes gdUnit4's line opening a suite holds, which the line is looked for by. */
const SUITE_MARK = Buffer.from('Run Test Suite:');

/** The longest unfinished line kept for where it began. A suite's line is far shorter. */
const CARRY_MOST = 64 * 1024;

/**
 * Where each suite's lines begin in what an engine prints, read a chunk at a time, so what each suite
 * printed is counted without holding what came before it. Every suite is judged against the limit
 * as it ends and the running one as each chunk arrives, so a suite past it is found whatever follows.
 */
export class SuiteCuts {
  /** The suite printing now, or null before the first. */
  suite: string | null = null;
  /** How many bytes have been read. */
  taken = 0;
  /** The first suite found to have printed past the limit, null for the lines before the first suite. */
  past: { readonly suite: string | null } | null = null;
  /** The byte the running suite's line began at. */
  private opened = 0;
  /** What the running suite printed elsewhere, such as down the engine's other stream. */
  private elsewhere = 0;
  /** The unfinished last line, or null for one too long to keep. */
  private carry: Buffer | null = Buffer.alloc(0);

  private readonly limit: number;

  /** [param limit] is the most bytes one suite may print. */
  constructor(limit = Number.POSITIVE_INFINITY) {
    this.limit = limit;
  }

  /** How many bytes the running suite has printed, or the engine before its first suite. */
  get printed(): number {
    return this.taken - this.opened + this.elsewhere;
  }

  /** Counts [param bytes] the running suite printed somewhere other than what is read here. */
  add(bytes: number): void {
    this.elsewhere += bytes;
    this.judge();
  }

  /** Notes the running suite as past the limit if it is, unless one already was. */
  private judge(): void {
    if (this.past === null && this.printed > this.limit) {
      this.past = { suite: this.suite };
    }
  }

  /** Reads [param chunk], the bytes printed next. */
  take(chunk: Buffer): void {
    this.readCuts(chunk);
    this.judge();
  }

  private readCuts(chunk: Buffer): void {
    const kept = this.carry ?? Buffer.alloc(0);
    const joined = kept.length === 0 ? chunk : Buffer.concat([kept, chunk]);
    const base = this.taken - kept.length;
    this.taken += chunk.length;
    let from = 0;
    if (this.carry === null) {
      // The rest of a line too long to keep, which is no suite's line.
      const newline = joined.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      from = newline + 1;
    }
    for (let found = joined.indexOf(SUITE_MARK, from); found >= 0; found = joined.indexOf(SUITE_MARK, from)) {
      const start = Math.max(from, joined.lastIndexOf(0x0a, found) + 1);
      const end = joined.indexOf(0x0a, found);
      if (end < 0) {
        break;
      }
      // A line too long to keep is left out however it arrived, so the cuts never hang on the chunks.
      const path =
        end - start > CARRY_MOST
          ? null
          : suiteOpenedBy(stripVTControlCharacters(joined.toString('utf8', start, end)));
      if (path !== null) {
        this.opens(path, base + start);
      }
      from = end + 1;
    }
    const rest = joined.subarray(Math.max(from, joined.lastIndexOf(0x0a) + 1));
    this.carry = rest.length > CARRY_MOST ? null : Buffer.from(rest);
  }

  /** Opens the suite at [param path], whose line begins at byte [param at], once the running one is judged. */
  private opens(path: string, at: number): void {
    // The suite that ends here is judged on what it printed up to this line.
    if (this.past === null && at - this.opened + this.elsewhere > this.limit) {
      this.past = { suite: this.suite };
    }
    this.suite = owned(path);
    this.opened = at;
    this.elsewhere = 0;
  }

  /** Reads what the file at [param path] holds past what has been read, if it is there. */
  takeFrom(path: string): void {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      for (let size = fstatSync(fd).size; this.taken < size; ) {
        const chunk = bytesAt(fd, this.taken, Math.min(TAKE_BYTES, size - this.taken));
        if (chunk.length === 0) {
          break;
        }
        this.take(chunk);
      }
    } finally {
      closeSync(fd);
    }
  }
}

/** The most of a growing log read at once. */
const TAKE_BYTES = 1024 * 1024;

/**
 * [param printed], read off the engine's --log-file, with the errors Godot raised while printing
 * another added from [param piped], the log of its streams. They belong to no suite, since where
 * in the run they came went with them, and fail it as gdharness test does, which reads both streams
 * through one handle and so has them in place. gdUnit4's own loggers raise them, after a stack
 * overflow has left the engine counting a call stack it no longer has.
 */
export function withNestedErrors(printed: RunPrinted, piped: readonly LogEntry[]): RunPrinted {
  const nested = piped.flatMap((entry, at) => {
    const text = nestedError(entry, piped[at + 1]);
    return text === null
      ? []
      : [{ text, at: printed.lines.length, suite: null, during: null, warning: false }];
  });
  return nested.length === 0 ? printed : { ...printed, errors: [...printed.errors, ...nested] };
}

/** What suites declare they print, by suite and then by function or hook. */
type Declared = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/**
 * The errors and the warnings each suite declares it prints: its `GDHARNESS_EXPECTED_ERRORS` and
 * `GDHARNESS_EXPECTED_WARNINGS` constants as the runner read them from the compiled suite.
 */
export interface Expected {
  readonly errors: Declared;
  readonly warnings: Declared;
}

/** One suite an engine is handed. */
export interface HandedSuite {
  readonly path: string;
  readonly cases: readonly string[];
  /** By function, the rows this engine runs of each case dealt by its rows. */
  readonly rows?: Readonly<Record<string, RowShare>>;
}

/** What one engine was handed, which is what its run is judged against. */
export interface EngineAssignment {
  /**
   * Each suite, with the functions this engine is to run of it, and of a parameterised one dealt
   * over several engines the rows.
   */
  readonly suites: ReadonlyArray<HandedSuite>;
  readonly expected: Expected;
  /** The project's scripts the engine never frees once loaded, which its report at exit counts. */
  readonly selfTyped?: readonly SelfTypedExport[];
  /** The version the engine must say it is as it starts, as `--godot-version` gives it. */
  readonly godotVersion?: string | null;
  /** Whether the project turns on gdUnit4's `report/godot/push_error`. */
  readonly failsOnPushErrors?: boolean;
}

/**
 * Why the version [param said] in an engine's banner is not [param wanted], or null when it is:
 * the same, or [param wanted] followed by more of it, so 4.7.2 holds for 4.7.2.stable.official.
 */
export function versionFault(said: string | null, wanted: string): string | null {
  if (said === null) {
    return `the engine printed no version as it started, so it cannot be told to be Godot ${wanted}`;
  }
  return said === wanted || said.startsWith(`${wanted}.`)
    ? null
    : `the engine that ran is Godot ${said}, not the ${wanted} --godot-version asks for`;
}

/** What each suite declares, as the runner's `--expected-out` wrote it, or nothing. */
export function readExpected(file: string): Expected {
  // A part that is not the shape the runner writes reads as declaring nothing.
  const entriesOf = (value: unknown): [string, unknown][] => Object.entries(isRecord(value) ? value : {});
  const lists = (value: unknown): Readonly<Record<string, readonly string[]>> =>
    Object.fromEntries(
      entriesOf(value).flatMap(([name, listed]): [string, string[]][] =>
        isStringList(listed) ? [[name, listed]] : [],
      ),
    );
  const declared = (value: unknown): Declared =>
    Object.fromEntries(entriesOf(value).map(([suite, byFunction]) => [suite, lists(byFunction)]));
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const read: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    return { errors: declared(read['errors']), warnings: declared(read['warnings']) };
  } catch {
    return { errors: {}, warnings: {} };
  }
}

/** How the engine's process ended. */
export interface EngineEnd {
  readonly code: number | null;
  readonly signal: string | null;
  /** Why gdharness ended it, when it did. */
  readonly ended: string | null;
  /**
   * The memory free as an engine that died on a Windows exception ended, which tells a machine
   * that ran out from a fault in the engine.
   */
  readonly freeBytes?: number;
  /** How many starts before this one died before printing past the banner, and were started again. */
  readonly crashedStarts?: number;
  /** The most bytes the engine was read holding, above 0. Absent when no reading was. */
  readonly peakBytes?: number;
  /** The priority the engine's process was last read with while it ran, named as its platform names it. */
  readonly priority?: string;
}

export interface EngineVerdict {
  readonly passed: boolean;
  /** Each thing wrong with the run, one sentence each. */
  readonly faults: readonly string[];
  /** What the engine got wrong that is not counted against the run, one sentence each. */
  readonly notes: readonly string[];
  /** The suites that passed whole here: every case it was handed passed and printed nothing unexpected. */
  readonly passedSuites: readonly string[];
  /** Whether the machine running out of memory may be why it failed. */
  readonly starved: boolean;
  /**
   * Whether a fault names no suite: the engine crashed, leaked at exit or printed an error outside
   * every suite. Any of its suites may be the cause, so none of them is kept as passed.
   */
  readonly unattributed: boolean;
  /** The printed lines worth showing for a failure, in order, with gaps marked. */
  readonly shown: readonly string[];
}

/**
 * Windows' exit statuses an engine dies with, by name and by what each means. Windows ends a process
 * that raised an exception it did not handle with the exception's status as its exit code, a number
 * from 0xC0000000 up that says nothing in decimal. Godot's own exit codes are small, so a code this
 * large is the operating system saying the process was ended.
 */
const WINDOWS_STATUSES: ReadonlyMap<number, { name: string; meaning: string }> = new Map([
  [0xc0000005, { name: 'STATUS_ACCESS_VIOLATION', meaning: 'a crash on an access violation' }],
  [0xc0000017, { name: 'STATUS_NO_MEMORY', meaning: 'a crash with no memory left' }],
  [0xc000001d, { name: 'STATUS_ILLEGAL_INSTRUCTION', meaning: 'a crash on an illegal instruction' }],
  [0xc0000094, { name: 'STATUS_INTEGER_DIVIDE_BY_ZERO', meaning: 'a crash on an integer division by zero' }],
  [0xc00000fd, { name: 'STATUS_STACK_OVERFLOW', meaning: 'a crash on a stack overflow' }],
  [0xc000012d, { name: 'STATUS_COMMITMENT_LIMIT', meaning: 'a crash at the commit limit' }],
  [0xc0000135, { name: 'STATUS_DLL_NOT_FOUND', meaning: 'a start that failed on a missing library' }],
  [0xc000013a, { name: 'STATUS_CONTROL_C_EXIT', meaning: 'its console was closed or sent Ctrl+C' }],
  [0xc0000142, { name: 'STATUS_DLL_INIT_FAILED', meaning: 'a start that failed in a library it needs' }],
  [0xc0000374, { name: 'STATUS_HEAP_CORRUPTION', meaning: 'a crash on a corrupted heap' }],
  [
    0xc0000409,
    { name: 'STATUS_STACK_BUFFER_OVERRUN', meaning: 'a crash on a stack buffer overrun or a fast fail' },
  ],
  [
    0xc06d007e,
    {
      name: 'a module that could not be found (VcppException)',
      meaning: 'a start that failed on a missing module',
    },
  ],
  [
    0xc06d007f,
    {
      name: 'a procedure that could not be found (VcppException)',
      meaning: 'a start that failed on a missing procedure',
    },
  ],
]);

/** What Windows' exit status [param code] means, or undefined when it is none the engine is known to die with. */
export function windowsStatusOf(code: number): { name: string; meaning: string } | undefined {
  return WINDOWS_STATUSES.get(code >>> 0);
}
const MEMORY_EXITS = new Set([0xc0000017, 0xc000012d]);

/**
 * The codes gdUnit4's command-line runner quits with. Without its meaning, the 100 a run with a
 * failing case ends on reads as the engine having crashed beside the failure.
 */
const GDUNIT_FAILED = 100;
const GDUNIT_ORPHANS = 101;
const GDUNIT_EXITS: ReadonlyMap<number, string> = new Map([
  [GDUNIT_FAILED, "gdUnit4's code for a case that failed or errored"],
  [GDUNIT_ORPHANS, "gdUnit4's code for orphan nodes left behind"],
  [103, "gdUnit4's code for a suite that cannot run headless"],
  [104, "gdUnit4's code for a Godot version it does not support"],
  [105, "gdUnit4's code for scripts that did not compile"],
]);

/**
 * The codes the engine itself ends with: 1 for a failure, 255 for one at start. Any other small code
 * an engine running suites exits with was asked for by something it ran, and an engine that ended
 * on 5 at the start of a suite, with nothing said of it, was taken for a crash.
 */
const GODOT_EXITS = new Set([1, 255]);

/** The exit code as a person reads it: a Windows status by name and in hex, gdUnit4's by meaning. */
export function exitNamed(code: number): string {
  const unsigned = code >>> 0;
  const status = windowsStatusOf(code)?.name;
  if (status !== undefined) {
    return `0x${unsigned.toString(16).toUpperCase()} (${status})`;
  }
  const gdunit = GDUNIT_EXITS.get(code);
  if (gdunit !== undefined) {
    return `${String(code)} (${gdunit})`;
  }
  if (code > 0 && code < 256 && !GODOT_EXITS.has(code)) {
    return `${String(code)} (a code neither Godot nor gdUnit4 ends with, so most likely a quit(${String(code)}) in the project's code the engine ran)`;
  }
  return String(code);
}

/**
 * What is wrong with the cases dealt by their rows, read over every engine that held one: each row
 * printed by exactly one engine, from row 0 up to the last any engine found, with none missing.
 * Judged over all of them rather than in each, since an engine dealt rows a case no longer has
 * rightly runs none of them. It is judged only once every engine holding the case closed its suite,
 * since one that did not is a fault already and says why.
 */
export function rowsAcross(
  engines: ReadonlyArray<{ readonly handed: readonly HandedSuite[]; readonly printed: RunPrinted }>,
): { readonly suite: string; readonly fault: string }[] {
  const dealtOut = new Map<string, DealtRows>();
  for (const { handed, printed } of engines) {
    for (const suite of handed) {
      for (const func of Object.keys(suite.rows ?? {})) {
        const key = `${suite.path} > ${func}`;
        const entry = dealtOut.get(key) ?? { path: suite.path, func, holders: [] };
        entry.holders.push(printed);
        dealtOut.set(key, entry);
      }
    }
  }
  return [...dealtOut].flatMap(([key, dealt]) =>
    dealtRowFaults(key, dealt).map((fault) => ({ suite: dealt.path, fault })),
  );
}

/** One case dealt by its rows, and the runs of the engines that were dealt some. */
interface DealtRows {
  readonly path: string;
  readonly func: string;
  readonly holders: RunPrinted[];
}

/** [param row] as a sentence names it. */
function rowSaid(row: number | null): string {
  return row === null ? 'the case whole' : `row ${String(row)}`;
}

/** How many engines ran each row of [param func], among the [param suites] that printed it. */
function enginesPerRow(
  suites: readonly (SuitePrinted | undefined)[],
  func: string,
): Map<number | null, number> {
  // The engines that ran each row, not the lines saying so: a row gdUnit4 tries again prints a
  // line for each try in the one engine.
  const counts = new Map<number | null, number>();
  for (const suite of suites) {
    const ran = (suite?.cases ?? []).filter((one) => one.func === func).map((one) => one.row);
    for (const row of new Set(ran)) {
      counts.set(row, (counts.get(row) ?? 0) + 1);
    }
  }
  return counts;
}

/** The rows from 0 up to the last any engine found that no engine ran. */
function rowGaps(
  key: string,
  holders: readonly RunPrinted[],
  counts: ReadonlyMap<number | null, number>,
): number[] {
  const rows = [...counts.keys()].filter((row) => row !== null);
  // A row past the last one run is known only from an engine that found it and left it out.
  const left = holders.flatMap((printed) => printed.leftOut.get(key) ?? []).filter((row) => row !== null);
  const top = Math.max(-1, ...rows, ...left);
  return Array.from({ length: top + 1 }, (_, row) => row).filter((row) => !counts.has(row));
}

/** What is wrong with the rows of one case dealt over several engines, once all of them closed their suite. */
function dealtRowFaults(key: string, { path, func, holders }: DealtRows): string[] {
  const suites = holders.map((printed) => printed.suites.get(path));
  if (suites.some((suite) => suite?.closed === null || suite?.closed === undefined)) {
    return [];
  }
  const counts = enginesPerRow(suites, func);
  const engineCount = String(holders.length);
  if (counts.size === 0) {
    return [`${key} ran in none of the ${engineCount} engines its rows were dealt to`];
  }
  const faults: string[] = [];
  const twice = [...counts].filter(([, times]) => times > 1).map(([row]) => rowSaid(row));
  if (twice.length > 0) {
    faults.push(`${key} ran ${named(twice)} in more than one engine`);
  }
  if ([...counts.keys()].some((row) => row !== null) && counts.has(null)) {
    faults.push(`${key} ran both whole and by its rows`);
  }
  const gaps = rowGaps(key, holders, counts);
  if (gaps.length > 0) {
    faults.push(
      `${key} did not run ${named(gaps.map(rowSaid))} in any of the ${engineCount} engines its rows were dealt to`,
    );
  }
  return faults;
}

/** The build a crash report names, as `Engine version: Godot Engine v... (<commit>)`. */
const CRASH_BUILD = /^Engine version: .*\(([0-9a-f]{40})\)$/;

/**
 * Printed by the engine only as it reports its call queue overflowing (`CallQueue::statistics`),
 * so a log holding it is one whose queue overflowed. The overflow's own line goes to stderr just
 * before the report and is lost when the report crashes.
 */
const QUEUE_OVERFLOW_LINE = 'Object was deleted while awaiting a callback.';

/**
 * The frames an official build's crash handler prints when it crashes in that report, by the
 * build's commit: `CallQueue::push_callablep` calling `statistics`, which reads messages the
 * running flush has already destroyed. Measured on 4.7.2's Windows build. Another build moves them.
 */
const QUEUE_OVERFLOW_FRAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ['ed1daf0bf001b61586d9930840f2f1394092c079', ['main+3e1082a', 'main+3e0f4aa']],
]);

/** What Godot's crash handler printed, if it printed a report. */
interface CrashReported {
  /** Whether the handler printed its report, as against only the overflow's line. */
  readonly reported: boolean;
  /** The signal the report names. Windows' handler for an exception names none. */
  readonly signal: string | undefined;
  readonly overflowed: boolean;
}

/** What Godot's crash handler reported in [param lines]: the signal and whether the call queue overflowed. */
function crashIn(lines: readonly string[]): CrashReported | null {
  const trimmed = lines.map((line) => line.trim());
  const at = trimmed.findIndex((line) => CRASH_HEADER.test(line));
  const said = trimmed.some((line) => line.includes(QUEUE_OVERFLOW_LINE));
  if (at === -1) {
    return said ? { reported: false, signal: undefined, overflowed: true } : null;
  }
  const report = trimmed.slice(at);
  const build = report.map((line) => CRASH_BUILD.exec(line)?.[1]).find((commit) => commit !== undefined);
  const frames = build === undefined ? undefined : QUEUE_OVERFLOW_FRAMES.get(build);
  const framed = frames?.every((frame) => report.some((line) => line.includes(`(${frame})`))) === true;
  return { reported: true, signal: CRASH_HEADER.exec(trimmed[at] ?? '')?.[1], overflowed: said || framed };
}

/** The engine crashing as [param crashed] reports it, with [param during] after the verb. */
function crashSaid(crashed: CrashReported, during: string): string {
  const signal = crashed.signal === undefined ? '' : `, its crash handler reporting signal ${crashed.signal}`;
  return `the engine crashed${during}${signal}`;
}

/** Where [param running] had got to, as a clause: ` while <suite> > <case> ran`, or empty. */
function whileRunning(running: RunPrinted['running']): string {
  if (running === null) {
    return '';
  }
  return running.during === null ? ` in ${running.suite}` : ` while ${running.suite} > ${running.during} ran`;
}

/** How many lines of a run's end are shown when nothing in it says what went wrong. */
const TAIL = 60;
/** How many cases are named in one sentence before the rest are counted. */
const MOST_NAMED = 8;

/** [param items] joined, the first few by name and the rest counted. */
export function named(items: readonly string[]): string {
  const shown = items.slice(0, MOST_NAMED).join(', ');
  return items.length > MOST_NAMED ? `${shown} and ${String(items.length - MOST_NAMED)} more` : shown;
}

/**
 * What fails a run of the scripts [param found] names, each declaring cases gdUnit4 never runs
 * because it is no suite, one sentence a script.
 */
export function uncollectedSaid(
  found: readonly { readonly path: string; readonly cases: readonly string[] }[],
): string[] {
  return found.map(({ path, cases }) => {
    const one = cases.length === 1;
    return `${path} declares ${named(cases)} and does not extend GdUnitTestSuite, directly or through what it extends, so gdUnit4 never runs ${one ? 'it' : 'them'}: extend GdUnitTestSuite, or take the test_ prefix off ${one ? 'a function that is' : 'functions that are'} no case`;
  });
}

/**
 * [param printed] judged against what the engine was handed and how it ended.
 *
 * Every condition is checked whatever the exit code says, because each one has passed a run the
 * others failed to stop: gdUnit4 exits 0 having found nothing to run, a suite that does not load is
 * reported by none of its cases, and a case that prints an engine error passes.
 */
export function judgeEngine(printed: RunPrinted, handed: EngineAssignment, end: EngineEnd): EngineVerdict {
  const judging: Judging = { faults: [], failing: new Set(), shownAt: new Set(), unattributed: 0 };
  const rowsGone = suitesWithoutTheirRows(printed, handed);
  judging.faults.push(...endingFaults(printed, end), ...emptyRunFaults(printed, handed, rowsGone));
  judging.unattributed = judging.faults.length;
  for (const row of [...printed.mismatched, ...printed.unrunnable]) {
    failSuite(
      judging,
      row.suite,
      `${row.suite} > ${row.name} never ran: gdUnit4 skipped it, saying "${row.reason}"`,
    );
  }
  for (const row of printed.skipped) {
    failSuite(judging, row.suite, skippedFault(row));
  }
  for (const suite of handed.suites) {
    judgeSuite(judging, printed, suite, rowsGone);
  }
  judgeSuitesNotHanded(judging, printed, handed);
  // Failing the suite, as the run it fails is: recorded as passed, a suite leaving orphans was
  // skipped by the next run that skips what passed, which then passed.
  for (const left of printed.orphansLeft) {
    failSuite(judging, left.suite, orphansLeftSaid(left));
  }
  judgeUnexpectedErrors(judging, printed, handed);
  const beforeExit = judging.faults.length;
  const starved = printed.starved.length > 0;
  judging.faults.push(...leakFaults(printed, handed), ...(starved ? ['the engine ran out of memory'] : []));
  judging.unattributed += judging.faults.length - beforeExit;
  markSummaryLines(judging.shownAt, printed.lines);
  const passed = judging.faults.length === 0;
  const passedSuites = handed.suites.map((suite) => suite.path).filter((path) => !judging.failing.has(path));
  return {
    passed,
    faults: judging.faults,
    notes: engineNotes(printed, handed, end),
    passedSuites,
    starved: starved || endedOutOfMemory(end),
    unattributed: judging.unattributed > 0,
    shown: passed ? [] : linesShown(printed.lines, judging.shownAt, runCutShort(printed, handed, end)),
  };
}

/**
 * How many cases [param printed] says ran. gdUnit4 prints every case and row it skips passed, so
 * those are taken off what it printed.
 */
export function casesRan(
  printed: Pick<RunPrinted, 'suites' | 'skipped' | 'mismatched' | 'unrunnable'>,
): number {
  const printedCases = [...printed.suites.values()].reduce((sum, suite) => sum + suite.cases.length, 0);
  const skipped = printed.skipped.reduce((sum, one) => sum + one.cases, 0);
  return Math.max(0, printedCases - skipped - printed.mismatched.length - printed.unrunnable.length);
}

/** The fault for a case, row or suite skipped with `do_skip`, which never ran. */
function skippedFault(row: SkippedRow): string {
  const said = `saying "${row.reason}"${row.cut === true ? ' before the reason was cut off' : ''}`;
  if (row.name !== null) {
    return `${row.suite} > ${row.name} never ran: gdUnit4 skipped it, ${said}`;
  }
  const held = row.cases === 1 ? 'its one case' : `all ${String(row.cases)} of its cases`;
  return `${row.suite} never ran ${held}: gdUnit4 skipped the whole suite, ${said}`;
}

/** What judging one engine's run has found so far. */
interface Judging {
  readonly faults: string[];
  /** The suites a fault names, which are not kept as passed. */
  readonly failing: Set<string>;
  /** The printed lines worth showing for a failure. */
  readonly shownAt: Set<number>;
  /** How many faults name no suite. */
  unattributed: number;
}

/** Adds [param fault] and fails the suite at [param path]. */
function failSuite(judging: Judging, path: string, fault: string): void {
  judging.faults.push(fault);
  judging.failing.add(path);
}

/** Whether gdUnit4's exit code says no more than a case or the orphans already do. */
function exitExplained(printed: RunPrinted, end: EngineEnd): boolean {
  // gdUnit4's 100 beside a case that failed says only what that case's own line says, and its 101
  // beside the orphans the runner named only what those say.
  if (end.code === GDUNIT_FAILED) {
    return [...printed.suites.values()].some((suite) => suite.cases.some((ran) => ran.verdict === 'FAILED'));
  }
  return end.code === GDUNIT_ORPHANS && printed.orphansLeft.length > 0;
}

/** The memory free as the engine ended, as a clause for the sentence saying how it ended. */
function freeMemorySaid(end: EngineEnd): string {
  return end.freeBytes === undefined
    ? ''
    : `, with ${(end.freeBytes / 1024 ** 3).toFixed(1)} GB of memory free as it ended`;
}

/** How the engine's process ended, and the call queue overflowing, as faults. */
function endingFaults(printed: RunPrinted, end: EngineEnd): string[] {
  const faults: string[] = [];
  // A crash is read from the report the engine's crash handler printed, since the code a crashed
  // engine exits with can reach this cut short: Bun on Windows tells only its low byte, so an
  // access violation read as an exit of 5 wherever no helper wrote the code whole.
  const crashed = crashIn(printed.lines);
  const ending = endFault(
    crashed,
    end,
    exitExplained(printed, end),
    whileRunning(printed.running),
    freeMemorySaid(end),
  );
  if (ending !== undefined) {
    faults.push(ending);
  }
  if (crashed?.overflowed === true) {
    faults.push(
      `the engine's call queue overflowed${whileRunning(printed.running)}: something queued deferred calls without end within one frame, most often a layout that changes the size it is laid out from in a deferred handler, so the frame never ends${crashed.reported ? ', and the engine crashed reporting the overflow' : ''}`,
    );
  }
  return faults;
}

/** Whether the exit code is the operating system saying the process ran out of memory. */
function endedOutOfMemory(end: EngineEnd): boolean {
  return end.code !== null && MEMORY_EXITS.has(end.code >>> 0);
}

/** The faults of a run that printed nothing, loaded nothing, was the wrong engine or never summed up. */
function emptyRunFaults(
  printed: RunPrinted,
  handed: EngineAssignment,
  rowsGone: ReadonlySet<string>,
): string[] {
  const faults: string[] = [];
  if (printed.lines.every((line) => line.trim() === '')) {
    faults.push('the engine printed nothing at all');
  }
  if (printed.unloadable.length > 0) {
    faults.push(`gdUnit4 could not load ${named(printed.unloadable)}, so it ran nothing`);
  }
  const wrongEngine =
    handed.godotVersion === undefined || handed.godotVersion === null
      ? null
      : versionFault(printed.engineVersion, handed.godotVersion);
  if (wrongEngine !== null) {
    faults.push(wrongEngine);
  }
  const unsummed = summaryFault(printed, handed, rowsGone);
  if (unsummed !== undefined) {
    faults.push(unsummed);
  }
  return faults;
}

/** Why the run's closing summary is a fault, or undefined when it is not one. */
function summaryFault(
  printed: RunPrinted,
  handed: EngineAssignment,
  rowsGone: ReadonlySet<string>,
): string | undefined {
  const nothingLeft = handed.suites.length > 0 && rowsGone.size === handed.suites.length;
  if (nothingLeft || (printed.executed !== null && printed.executed !== 0)) {
    return undefined;
  }
  // Every case that did not execute is listed as skipped, which already says why nothing ran.
  const listed = printed.skipped.length + printed.mismatched.length + printed.unrunnable.length;
  if (printed.executed === 0 && listed > 0 && casesRan(printed) === 0) {
    return undefined;
  }
  return printed.executed === null
    ? 'the run never printed its summary'
    : 'the run executed no test case at all, whatever it exited with';
}

/** Whether every row of every case [param suite] was handed was left out by the engine. */
function allRowsLeftOut(printed: RunPrinted, { path, cases, rows = {} }: HandedSuite): boolean {
  return (
    !printed.suites.has(path) &&
    cases.length > 0 &&
    cases.every((func) => rows[func] !== undefined && printed.leftOut.has(`${path} > ${func}`))
  );
}

/**
 * The suites handed to an engine that was dealt only rows a case has lost since its times were kept.
 * It finds every row it holds left out and runs nothing, so gdUnit4 opens no suite and sums up
 * nothing. Whether each row the case has now ran once is judged over all the engines, by rowsAcross.
 */
function suitesWithoutTheirRows(printed: RunPrinted, handed: EngineAssignment): Set<string> {
  return new Set(handed.suites.filter((suite) => allRowsLeftOut(printed, suite)).map(({ path }) => path));
}

/** Judges what [param printed] holds of one suite the engine was handed. */
function judgeSuite(
  judging: Judging,
  printed: RunPrinted,
  handed: HandedSuite,
  rowsGone: ReadonlySet<string>,
): void {
  const { path, cases, rows = {} } = handed;
  const suite = printed.suites.get(path);
  const notRun = suiteNotRunFault(printed, path);
  if (suite === undefined) {
    if (notRun !== undefined && !rowsGone.has(path)) {
      failSuite(judging, path, notRun);
    }
    return;
  }
  if (notRun !== undefined) {
    failSuite(judging, path, notRun);
  }
  judgeClosing(judging, path, suite);
  const finished = new Set(suite.cases.map((ran) => ran.func));
  // A case dealt by its rows can rightly run none here, when it has fewer rows than last time.
  // Whether every row ran once is judged over all the engines, by rowsAcross.
  const missing = cases.filter((func) => !finished.has(func) && rows[func] === undefined);
  if (missing.length > 0 && suite.closed !== null) {
    failSuite(judging, path, `${path} closed without running ${named(missing)}`);
  }
  for (const [func, share] of Object.entries(rows)) {
    judgeStrayRows(judging, path, func, strayRows(suite, func, share));
  }
  const wanted = new Set(cases);
  const unasked = [...finished].filter((func) => !wanted.has(func));
  if (unasked.length > 0) {
    failSuite(
      judging,
      path,
      `${path} ran ${named(unasked)}, which gdharness did not read as cases of it to run here, so its ` +
        'plan of the cases was wrong',
    );
  }
  for (const ran of suite.cases) {
    judgeFailedCase(judging, printed, path, ran);
  }
}

/**
 * What fails a suite [param printed] holds nothing of, or holds with no closing statistics: that it
 * never started, or never finished. Undefined for a suite that did both.
 */
export function suiteNotRunFault(printed: Pick<RunPrinted, 'suites'>, path: string): string | undefined {
  const suite = printed.suites.get(path);
  if (suite === undefined) {
    return `${path} never started`;
  }
  return suite.closed === null ? `${path} never finished` : undefined;
}

/** Judges how the suite at [param path] ended on a verdict other than PASSED. */
function judgeClosing(judging: Judging, path: string, suite: SuitePrinted): void {
  if (suite.closed === null || suite.closed.verdict === 'PASSED') {
    return;
  }
  // The cases can all pass while the suite does not: a failing assertion in before or after.
  if (suite.cases.every((ran) => ran.verdict !== 'FAILED')) {
    judging.faults.push(`${path} reported ${suite.closed.verdict} with every case passing, so a hook failed`);
  }
  judging.failing.add(path);
}

/** What [param suite] printed of the case [param func] that [param share] deals to another engine. */
function strayRows(suite: SuitePrinted, func: string, share: RowShare): string[] {
  return suite.cases
    .filter((ran) => ran.func === func && !rowRuns(share, ran.row))
    .map((ran) => (ran.row === null ? 'the case whole' : `row ${String(ran.row)}`));
}

/** Fails the suite at [param path] for the [param strays] of [param func] that another engine was dealt. */
function judgeStrayRows(judging: Judging, path: string, func: string, strays: readonly string[]): void {
  if (strays.length === 0) {
    return;
  }
  failSuite(
    judging,
    path,
    `${path} > ${func} ran ${named(strays)}, which ${strays.length === 1 ? 'was' : 'were'} dealt to another engine`,
  );
}

/**
 * Whether [param ran] failed and then passed on a retry. gdUnit4's flaky check counts that as a
 * pass and exits 0 on it, and no judge of a run does.
 */
function passedOnARetry(ran: { readonly verdict: string }): boolean {
  return ran.verdict === 'FLAKY';
}

/** The cases [param printed] holds that passed only on a retry, each as its suite's path, ` > ` and its name. */
export function casesRetried(printed: Pick<RunPrinted, 'suites'>): string[] {
  return [...printed.suites.values()].flatMap((suite) =>
    suite.cases.filter(passedOnARetry).map((ran) => `${suite.path} > ${ran.name}`),
  );
}

/**
 * Whether the case named [param name] in the suite at [param path] was printed passing, and printed
 * so every time. gdUnit4 decides a case's success from its last attempt, so a failure its report
 * still holds from an earlier one is not the run's.
 */
export function printedPassing(
  printed: Pick<RunPrinted, 'suites'>,
  path: string | null,
  name: string,
): boolean {
  const same =
    path === null ? [] : (printed.suites.get(path)?.cases.filter((ran) => ran.name === name) ?? []);
  return same.length > 0 && same.every((ran) => ran.verdict === 'PASSED');
}

/** Fails the suite at [param path] for [param ran] failing, and marks the lines it printed to be shown. */
function judgeFailedCase(judging: Judging, printed: RunPrinted, path: string, ran: CaseRan): void {
  if (ran.verdict !== 'FAILED' && !passedOnARetry(ran)) {
    return;
  }
  failSuite(
    judging,
    path,
    passedOnARetry(ran)
      ? `${path} > ${ran.name} failed before it passed on a retry`
      : `${path} > ${ran.name} failed`,
  );
  markBlock(judging.shownAt, printed.lines, ran.at);
}

/** Marks the line at [param first] and the lines after it up to the next blank one. */
function markBlock(shownAt: Set<number>, lines: readonly string[], first: number): void {
  for (let at = first; at < lines.length && (at === first || lines[at]?.trim()); at += 1) {
    shownAt.add(at);
  }
}

/** Fails the suites the engine ran without being handed them. */
function judgeSuitesNotHanded(judging: Judging, printed: RunPrinted, handed: EngineAssignment): void {
  // No loop over the handed suites reads a suite the engine ran without being handed it, so a case
  // failing in one explained gdUnit4's exit and the run passed.
  const handedHere = new Set(handed.suites.map((suite) => suite.path));
  for (const path of printed.suites.keys()) {
    if (!handedHere.has(path)) {
      failSuite(
        judging,
        path,
        `${path} ran here, which gdharness did not hand this engine, so its plan of the suites was wrong`,
      );
    }
  }
}

/** The sentence for [param error], a line the engine printed that no suite declared. */
function unexpectedErrorSaid(error: PrintedError): string {
  if (error.suite === null) {
    return `an engine ${errorKind(error)} outside every suite: ${error.text}`;
  }
  const stop = error.text.endsWith('.') ? '' : '.';
  return `an engine ${errorKind(error)} in ${error.suite} > ${error.during ?? ''}: ${error.text}${stop} ${declaringAdvice(error.during ?? '', error.warning)}`;
}

/** Judges the errors and warnings against what the suites declare. */
function judgeUnexpectedErrors(judging: Judging, printed: RunPrinted, handed: EngineAssignment): void {
  const unexpected = unexpectedErrors(
    printed,
    handed.expected,
    handed.suites.map((suite) => suite.path),
  );
  for (const error of unexpected.printed) {
    judging.faults.push(unexpectedErrorSaid(error));
    if (error.suite === null) {
      judging.unattributed += 1;
    } else {
      judging.failing.add(error.suite);
    }
    judging.shownAt.add(error.at);
    judging.shownAt.add(error.at + 1);
  }
  for (const missing of unexpected.neverPrinted) {
    failSuite(
      judging,
      missing.suite,
      `${missing.suite} > ${missing.during} declares the ${missing.warning ? 'warning' : 'error'} "${missing.text}", which it never printed`,
    );
  }
}

/** Whether the engine stopped its walk of the objects part way, which makes what it reports as leaked unreliable. */
function leaksCutShort(printed: RunPrinted): boolean {
  return printed.leaks.length > 0 && walkStoppedPartWay(printed.lines);
}

/** What the engine reported holding as it exited, one fault a report, unless its walk stopped part way. */
function leakFaults(printed: RunPrinted, handed: EngineAssignment): string[] {
  if (leaksCutShort(printed)) {
    return [];
  }
  const selfTyped = selfTypedSentence(handed.selfTyped ?? []);
  const held = heldAtExit(printed.lines);
  return printed.leaks.map((leak, at) => {
    const last = at === printed.leaks.length - 1;
    const after = last ? [held, selfTyped].filter((part) => part !== undefined) : [];
    // A verbose engine still ends its count of objects by advising --verbose, beside the names.
    const quoted = held === undefined ? leak : leak.replace(/\s*\(run with `?--verbose`? for details\)/, '');
    return `the engine exited holding what it should have freed: ${[quoted, ...after].join(' ')}`;
  });
}

/** What the engine got wrong that is not counted against the run. */
function engineNotes(printed: RunPrinted, handed: EngineAssignment, end: EngineEnd): string[] {
  const notes: string[] = [];
  const crashedStarts = end.crashedStarts ?? 0;
  if (crashedStarts > 0) {
    notes.push(
      `It died as it started ${crashedStarts === 1 ? 'once' : `${String(crashedStarts)} times`}, before printing past its banner, and was started again.`,
    );
  }
  const pushErrorsFailed =
    handed.failsOnPushErrors === true ? pushErrorsFailedSentence(failedOnPushErrors(printed)) : undefined;
  if (pushErrorsFailed !== undefined) {
    notes.push(pushErrorsFailed);
  }
  if (leaksCutShort(printed)) {
    notes.push(`${WALK_STOPPED_SENTENCE} It said: ${printed.leaks.join(' ')}`);
  }
  return notes;
}

/** Marks the lines of the run's closing summary to be shown. */
function markSummaryLines(shownAt: Set<number>, lines: readonly string[]): void {
  for (const [at, line] of lines.entries()) {
    if (/^(?:Overall Summary|Executed test|Total execution time| ?Exit code)/.test(line.trim())) {
      shownAt.add(at);
    }
  }
}

/** Whether the run stopped short, which it says why in its last lines, if anywhere. */
function runCutShort(printed: RunPrinted, handed: EngineAssignment, end: EngineEnd): boolean {
  return (
    end.ended !== null ||
    printed.executed === null ||
    handed.suites.some(({ path }) => printed.suites.get(path)?.closed == null)
  );
}

/** What the runner prints once it has compiled every script together. Kept in step with `listed.gd`. */
export const COMPILED_SAID = 'gdharness compiled every script together';

/**
 * What is wrong with the engine that compiled every script of the run together, by what it printed
 * and how it ended: none when it compiled them all and printed no error or warning.
 */
export function judgeCompile(printed: RunPrinted, end: EngineEnd): string[] {
  const faults: string[] = [];
  const ending = endFault(crashIn(printed.lines), end, false, '', '');
  if (ending !== undefined) {
    faults.push(ending);
  }
  if (!printed.lines.some((line) => line.trim() === COMPILED_SAID)) {
    faults.push('it never said it had compiled them');
  }
  for (const error of unexpectedErrors(printed, { errors: {}, warnings: {} }, []).printed) {
    faults.push(`an engine ${errorKind(error)}: ${error.text}`);
  }
  // A walk the engine stopped part way reports as leaked what it never reached, as judgeEngine notes.
  if (!walkStoppedPartWay(printed.lines)) {
    for (const leak of printed.leaks) {
      faults.push(`the engine exited holding what it should have freed: ${leak}`);
    }
  }
  return faults;
}

/** Whether [param error] is the engine's warning or its error, as a sentence names it. */
function errorKind(error: PrintedError): string {
  return error.warning ? 'warning' : 'error';
}

/**
 * Why the way the engine's process ended is a fault, or undefined when it is not one. [param explained]
 * is whether gdUnit4's own exit code is already said by a case or the orphans, and [param during] and
 * [param free] close the sentence.
 */
function endFault(
  crashed: CrashReported | null,
  end: EngineEnd,
  explained: boolean,
  during: string,
  free: string,
): string | undefined {
  if (end.ended !== null) {
    return end.ended;
  }
  if (crashed?.reported === true) {
    return `${crashSaid(crashed, during)}${free}`;
  }
  if (end.code === 0 || explained) {
    return undefined;
  }
  return end.code === null
    ? `the engine was ended by ${end.signal ?? 'a signal'}${free}`
    : `the engine exited ${exitNamed(end.code)}${free}`;
}

/**
 * The lines at [param picked], with a gap marked where lines are left out, or the run's last lines
 * when it was [param cutShort] and nothing picked says why.
 */
function linesShown(lines: readonly string[], picked: ReadonlySet<number>, cutShort: boolean): string[] {
  const summary = [...picked].filter((at) => at < lines.length).toSorted((a, b) => a - b);
  const telling = summary.some(
    (at) => !/^(?:Overall Summary|Executed test|Total execution|\s*Exit code)/.test(lines[at]?.trim() ?? ''),
  );
  if (!telling && !cutShort) {
    return [];
  }
  if (!telling) {
    return lines
      .slice(Math.max(0, lines.length - TAIL))
      .filter((line, at, all) => at < all.length - 1 || line !== '');
  }
  const shown: string[] = [];
  let previous = -1;
  for (const at of summary) {
    if (previous >= 0 && at > previous + 1) {
      shown.push('...');
    }
    shown.push(lines[at] ?? '');
    previous = at;
  }
  return shown;
}

/** What to do about an error, or a [param warning], printed during [param during] that its suite did not declare. */
export function declaringAdvice(during: string, warning = false): string {
  return `If the suite prints it on purpose, list its text under "${funcOf(during)}" in the suite's ${warning ? 'GDHARNESS_EXPECTED_WARNINGS' : 'GDHARNESS_EXPECTED_ERRORS'}`;
}

/**
 * The cases gdUnit4 failed during which the engine printed an error or a warning that was not a
 * script's, as `suite > case`. A project turning on gdUnit4's `report/godot/push_error` has each of
 * those fail its case, declared or not, so a case that declares it for gdharness, as the advice
 * above asks, still fails, and gdUnit4's report gives only the text.
 */
export function failedOnPushErrors(printed: Pick<RunPrinted, 'suites' | 'errors'>): string[] {
  const failed = new Set<string>();
  for (const suite of printed.suites.values()) {
    for (const ran of suite.cases) {
      if (ran.verdict === 'FAILED') {
        failed.add(`${suite.path} > ${ran.name}`);
      }
    }
  }
  return [
    ...new Set(
      printed.errors
        .filter((error) => error.script !== true && error.suite !== null && error.during !== null)
        .map((error) => `${error.suite ?? ''} > ${error.during ?? ''}`)
        .filter((ran) => failed.has(ran)),
    ),
  ];
}

/** What to say of [param cases], from {@link failedOnPushErrors}, or nothing when there are none. */
export function pushErrorsFailedSentence(cases: readonly string[]): string | undefined {
  if (cases.length === 0) {
    return undefined;
  }
  return (
    "The project turns on gdUnit4's report/godot/push_error, so gdUnit4 fails a case on every error " +
    `and warning the engine prints while it runs, declared or not, which failed ` +
    `${cases.length === 1 ? 'this case' : 'these cases'}: ${named(cases)}. A case that prints one on purpose ` +
    'does it inside assert_error(...).is_push_error(...) or is_push_warning(...), which gdUnit4 passes, ' +
    'and declares it for gdharness all the same.'
  );
}

interface MissingError {
  readonly suite: string;
  readonly during: string;
  readonly text: string;
  readonly warning: boolean;
}

/**
 * The errors and warnings printed that no suite declared, and the declared ones that were not
 * printed, for the suites at [param paths]. A case declares each text once for every time it prints
 * it, and a parameterised case each time per row. An error is declared among the errors and a
 * warning among the warnings, so a text declared as one does not accept the other.
 */
export function unexpectedErrors(
  printed: Pick<RunPrinted, 'suites' | 'errors'>,
  expected: Expected,
  paths: readonly string[],
): ErrorsJudged {
  const judged = new Set(paths.filter((path) => printed.suites.has(path)));
  const declared = new DeclaredErrors(expected, judged);
  return {
    printed: printed.errors.filter((error) => !declared.settles(error)),
    neverPrinted: declared.neverPrinted(printed.suites, judged),
  };
}

/** The errors no suite declared, and the declared ones a case that ran to its end did not print. */
export interface ErrorsJudged {
  readonly printed: PrintedError[];
  readonly neverPrinted: MissingError[];
}

/** The key the declarations of one kind of line printed during [param during] are held under. */
function owedKey(path: string, during: string, warning: boolean): string {
  return `${path}\n${during}\n${String(warning)}`;
}

/** The texts [param expected] declares for [param during] of the suite at [param path], or none. */
function declaredTexts(expected: Expected, path: string, during: string, warning: boolean): string[] {
  const texts: unknown = (warning ? expected.warnings : expected.errors)[path]?.[funcOf(during)];
  return Array.isArray(texts) ? texts.map((text: unknown) => String(text)) : [];
}

/**
 * What the suites declare, each declared text taken off once by every line that settles it, one
 * error at a time and in the order printed. A case or hook owes its own texts, so a suite's errors
 * are settled against its declarations alone, whatever another suite printed.
 *
 * A case the engine ended in printed what it declares all the same. It owes nothing it had yet to
 * print, since the engine ending there is the fault and is said, so only the cases and hooks that ran
 * to their end are owed their texts.
 */
class DeclaredErrors {
  /** The texts each case or hook still owes, by {@link owedKey}, from its first line on. */
  private readonly owed = new Map<string, string[]>();
  /** Every text each suite declares for any case, by path and kind of line. */
  private readonly anyCase = new Map<string, ReadonlySet<string>>();
  private readonly expected: Expected;
  private readonly judged: ReadonlySet<string> | null;

  /** [param judged] are the suites judged, or null for every suite. */
  constructor(expected: Expected, judged: ReadonlySet<string> | null) {
    this.expected = expected;
    this.judged = judged;
  }

  /** Whether [param error] is one its suite declared, which takes one of the declared texts off. */
  settles(error: Pick<PrintedError, 'suite' | 'during' | 'warning' | 'text'>): boolean {
    const { suite, during, warning, text } = error;
    if (suite === null || during === null || (this.judged !== null && !this.judged.has(suite))) {
      return false;
    }
    const key = owedKey(suite, during, warning);
    let texts = this.owed.get(key);
    if (texts === undefined) {
      texts = declaredTexts(this.expected, suite, during, warning);
      this.owed.set(key, texts);
    }
    const index = texts.indexOf(text);
    if (index < 0) {
      return false;
    }
    texts.splice(index, 1);
    return true;
  }

  /** Whether the suite at [param path] declares [param text] for any case, as a warning or an error. */
  mayDeclare(path: string, warning: boolean, text: string): boolean {
    const key = `${path}\n${String(warning)}`;
    let texts = this.anyCase.get(key);
    if (texts === undefined) {
      const declared = (warning ? this.expected.warnings : this.expected.errors)[path] ?? {};
      texts = new Set(
        Object.values(declared).flatMap((one: unknown) =>
          Array.isArray(one) ? one.map((each: unknown) => String(each)) : [],
        ),
      );
      this.anyCase.set(key, texts);
    }
    return texts.has(text);
  }

  /**
   * The declared texts still owed by the cases and hooks of the suites at [param paths] that ran
   * to their end, by suite, then errors before warnings, then the order the cases ran in.
   */
  neverPrinted(suites: RunPrinted['suites'], paths: Iterable<string>): MissingError[] {
    const missing: MissingError[] = [];
    for (const path of new Set(paths)) {
      const suite = suites.get(path);
      if (suite === undefined) {
        continue;
      }
      const ranHooks = suite.closed === null ? ['before'] : ['before', 'after'];
      const finished = new Set([...ranHooks, ...suite.cases.map((ran) => ran.name)]);
      for (const warning of [false, true]) {
        for (const during of finished) {
          const texts =
            this.owed.get(owedKey(path, during, warning)) ??
            declaredTexts(this.expected, path, during, warning);
          missing.push(...texts.map((text) => ({ suite: path, during, text, warning })));
        }
      }
    }
    return missing;
  }
}
