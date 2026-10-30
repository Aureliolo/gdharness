/**
 * What one engine's run of suites printed, read case by case, and judged.
 *
 * Read from the engine's own console rather than from gdUnit4's reports, because a gate needs what
 * the reports leave out: the `ERROR` and `WARNING` lines a passing case printed, which case printed
 * each one, the
 * leaks the engine reports as it exits, and how far a run got when it crashed or was ended. Both of
 * the engine's streams go into one file, so an error is read in order with the case lines around it.
 */

import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import {
  EXIT_LEAK,
  heldAtExit,
  type SelfTypedExport,
  selfTypedSentence,
  WALK_STOPPED_SENTENCE,
  walkStoppedPartWay,
} from './engine-leaks.js';
import type { LogEntry } from './game-log.js';
import { type OrphansLeft, orphansLeftOn, orphansLeftSaid, scriptErrorsPrinted } from './junit.js';

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
   * hooks; null outside every suite. A line printed after a case's verdict counts as that case's
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
   * The rows the engine found and left to the others, by `path > func`; null for a case that is no
   * row. gdUnit4 prints nothing for them, so without these a row no engine was dealt goes unseen.
   */
  readonly leftOut: ReadonlyMap<string, readonly (number | null)[]>;
  /** The version the engine's banner gives, such as `4.7.2.stable.official.ed1daf0bf`, or null. */
  readonly engineVersion: string | null;
  /** The orphans each case or suite's hooks left, as the runner named them. */
  readonly orphansLeft: readonly OrphansLeft[];
  /** The rows gdUnit4 skipped for data that does not fit their case's parameters. */
  readonly mismatched: readonly MismatchedRow[];
  /** The cases gdUnit4 skipped because it cannot run them as they are declared. */
  readonly unrunnable: readonly MismatchedRow[];
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

const SUITE_OPENED = /^Run Test Suite:\s*(res:\/\/.+?\.gd)\s*$/;
const TIME = String.raw`(?:\d+h )?(?:\d+min )?(?:\d+s )?\d+ms`;
const CASE_LINE = new RegExp(
  String.raw`^\s*(res://.+?\.gd) > (.+?) (STARTED|PASSED|FAILED|FLAKY|SKIPPED|WARNING)(?: \((?:retry \d+|\d+ retries)\))?(?: (${TIME}))?\s*$`,
);
const STATISTICS = new RegExp(String.raw`^Statistics:.*\|\s*([A-Z]+)(?:\s+\(.*?\))?\s+(${TIME})\s*$`);
const ERROR_LINE = /^\s*(?:SCRIPT |USER )?ERROR: (.*?)\s*$/;
const WARNING_LINE = /^\s*(?:SCRIPT |USER )?WARNING: (.*?)\s*$/;
const EXECUTED = /^Executed test cases\s*:\s*\((\d+)\//;
// gdUnit4's reason for skipping a row whose data does not fit its case, printed under the row, which
// it prints as PASSED first. The run's summary counts it skipped, and nothing else says it never ran.
const MISMATCHED_ROW = /^\s*The test data set at index \(\d+\) does not match the expected test parameters/;
// gdUnit4's reason for skipping a case it cannot run as declared, printed under the case the same
// way: a parameter it has no data for, or a fuzzer declared after a setting. Not a skip the case
// asked for with do_skip, whose reason is the case's own.
const UNRUNNABLE_CASE =
  /^\s*Reason: '((?:Unknown test case argument's \[.*\] found|Fuzzer argument '.+' must be declared before the test config argument\(s\) \[.*\])\.)'\s*$/;
// The engine's first line, `Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org`.
const BANNER = /^\s*Godot Engine v(\S+?)(?:\s+-\s+\S+)?\s*$/;
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
// orphans are reported from the suite's statistics; read as a warning no suite declared, the line
// came back as one more fault, with advice to declare it rather than free the nodes.
const ORPHANS_REPORTED = /^\s*WARNING: Detected \d+ (?:possible )?orphan nodes\.\s*$/;
// The allocator's null, in its error line and the location under it, and an image decode the same
// pressure made fail. Both are the machine running out, not the case being wrong.
const STARVED = [
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

/**
 * Every row [param printed] says gdUnit4 skipped for data that does not fit its case, and every case
 * it skipped as unrunnable as declared, under the suite and the row or case printed last before the
 * reason.
 *
 * A row or case skipped this way never ran, and gdUnit4 calls the run passed: a case taking its rows
 * from a function returning a constant had all three skipped, a mix of fitting and misfitting rows
 * passes with only the misfits left out, and a case run alone whose parameter had a typo in its name
 * was answered passed.
 */
function skippedAsDeclaredIn(printed: readonly string[]): {
  mismatched: MismatchedRow[];
  unrunnable: MismatchedRow[];
} {
  const lines = printed.flatMap((text) => stripVTControlCharacters(text).split(/\r?\n/));
  const found: MismatchedRow[] = [];
  const unrunnable: MismatchedRow[] = [];
  let suite: string | null = null;
  let lastCase: string | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    const opened = SUITE_OPENED.exec(line)?.[1];
    if (opened !== undefined) {
      suite = opened;
      lastCase = null;
      continue;
    }
    const caseLine = CASE_LINE.exec(line);
    if (caseLine !== null) {
      lastCase = caseLine[3] === 'STARTED' ? lastCase : (caseLine[2] ?? null);
      continue;
    }
    if (suite === null || lastCase === null) {
      continue;
    }
    const declared = UNRUNNABLE_CASE.exec(line)?.[1];
    if (declared !== undefined) {
      unrunnable.push({ suite, name: lastCase, reason: declared });
      continue;
    }
    if (!MISMATCHED_ROW.test(line)) {
      continue;
    }
    const parts = [line.trim()];
    while (at + 1 < lines.length && !['', "'"].includes((lines[at + 1] ?? '').trim())) {
      at += 1;
      parts.push((lines[at] ?? '').trim());
    }
    found.push({ suite, name: lastCase, reason: parts.join(' ').replaceAll(/\[\/?color[^\]]*\]/g, '') });
  }
  return { mismatched: found, unrunnable };
}

/** [param printed], both streams in the order they came, read into suites, cases and errors. */
export function readRun(printed: string): RunPrinted {
  const lines = stripVTControlCharacters(printed).replaceAll('\r\n', '\n').split('\n');
  const suites = new Map<string, SuitePrinted>();
  const errors: PrintedError[] = [];
  const leaks: string[] = [];
  let executed: number | null = null;
  let open: SuitePrinted | null = null;
  let during: string | null = null;
  // Errors printed after a verdict, held until it is known whether another case follows.
  let afterCase: { text: string; at: number; warning: boolean; script: boolean }[] = [];
  let lastCase: string | null = null;
  const settleAfterCase = (owner: string): void => {
    for (const held of afterCase) {
      errors.push({ ...held, suite: open?.path ?? null, during: owner });
    }
    afterCase = [];
  };
  const leftOut = new Map<string, (number | null)[]>();
  const orphansLeft: OrphansLeft[] = [];
  let engineVersion: string | null = null;
  for (const [at, line] of lines.entries()) {
    const banner: RegExpExecArray | null = engineVersion === null ? BANNER.exec(line) : null;
    if (banner !== null) {
      engineVersion = banner[1] ?? null;
      continue;
    }
    const orphaned = orphansLeftOn(line);
    if (orphaned !== null) {
      orphansLeft.push(orphaned);
      continue;
    }
    const left = LEFT_OUT.exec(line);
    if (left !== null) {
      const key = `${left[1] ?? ''} > ${left[2] ?? ''}`;
      const row = Number(left[3]);
      leftOut.set(key, [...(leftOut.get(key) ?? []), row < 0 ? null : row]);
      continue;
    }
    const opened = SUITE_OPENED.exec(line);
    if (opened?.[1] !== undefined) {
      settleAfterCase('after');
      open = suites.get(opened[1]) ?? { path: opened[1], cases: [], closed: null };
      suites.set(open.path, open);
      during = 'before';
      lastCase = null;
      continue;
    }
    const caseLine = CASE_LINE.exec(line);
    if (caseLine !== null && open !== null) {
      const name = caseLine[2] ?? '';
      if (caseLine[3] === 'STARTED') {
        settleAfterCase(lastCase ?? 'before');
        during = name;
      } else {
        open.cases.push({
          name,
          func: funcOf(name),
          row: rowOf(name),
          verdict: caseLine[3] ?? '',
          seconds: secondsOf(caseLine[4] ?? ''),
          at,
        });
        lastCase = name;
        during = null;
      }
      continue;
    }
    const statistics = STATISTICS.exec(line);
    if (statistics !== null && open !== null) {
      settleAfterCase('after');
      open.closed = { verdict: statistics[1] ?? '', seconds: secondsOf(statistics[2] ?? '') };
      open = null;
      during = null;
      lastCase = null;
      continue;
    }
    const counted = EXECUTED.exec(line);
    if (counted?.[1] !== undefined) {
      executed = Number(counted[1]);
      continue;
    }
    if (EXIT_LEAK.test(line)) {
      leaks.push(line.trim());
      continue;
    }
    if (ORPHANS_REPORTED.test(line)) {
      continue;
    }
    if (DRIVER_FALLBACK.test(line)) {
      if (suites.size === 0) {
        errors.length = 0;
      }
      continue;
    }
    const error = ERROR_LINE.exec(line);
    // Outside every suite too, where one is the project's own, from an autoload, a session hook or
    // the import, except one the engine's platform layer or a rendering driver raised: those are
    // about the machine, as a windowed engine on a macOS runner's virtual GPU warns that it is
    // switching to ANGLE as its display server starts. The leaks it reports at exit are read above.
    const warned =
      error === null && !(open === null && MACHINE_WARNED.test(lines[at + 1] ?? ''))
        ? WARNING_LINE.exec(line)
        : null;
    const found = error ?? warned;
    if (found === null) {
      continue;
    }
    const text = found[1] ?? '';
    const warning = error === null;
    const script = /^\s*SCRIPT /.test(line);
    if (open === null) {
      errors.push({ text, at, suite: null, during: null, warning, script });
    } else if (during === null) {
      afterCase.push({ text, at, warning, script });
    } else {
      errors.push({ text, at, suite: open.path, during, warning, script });
    }
  }
  const last: SuitePrinted | null = open;
  const stoppedIn =
    last === null
      ? null
      : during === null
        ? `${last.path}, after ${lastCase ?? 'its cases'}`
        : during === 'before'
          ? `${last.path}, in before`
          : `${last.path} > ${during}`;
  settleAfterCase('after');
  const joined = lines.join('\n');
  const starved = STARVED.flatMap((pattern) => [...joined.matchAll(pattern)].map((found) => found[0]));
  const unloadable = scriptErrorsPrinted(lines).map(
    (error) => `${error.path}${error.line === null ? '' : `:${String(error.line)}`}: ${error.message}`,
  );
  return {
    lines,
    suites,
    errors,
    leaks,
    starved,
    executed,
    unloadable,
    stoppedIn,
    running: last === null ? null : { suite: last.path, during },
    leftOut,
    engineVersion,
    orphansLeft,
    ...skippedAsDeclaredIn(lines),
  };
}

// What Godot prints before an error raised while it was printing another. It writes the pair
// straight to stderr, past every logger, so a log the engine writes with --log-file never has them.
const NESTED_ERROR = 'While attempting to print an error, another error was printed:';

/**
 * [param printed], read off the engine's --log-file, with the errors Godot raised while printing
 * another added from [param piped], the log of its streams. They belong to no suite, since where
 * in the run they came went with them, and fail it as gdharness test does, which reads both streams
 * through one handle and so has them in place. gdUnit4's own loggers raise them, after a stack
 * overflow has left the engine counting a call stack it no longer has.
 */
export function withNestedErrors(printed: RunPrinted, piped: readonly LogEntry[]): RunPrinted {
  const nested = piped.flatMap((entry, at) => {
    const next = piped[at + 1];
    return entry.severity === 'info' && entry.text.trim() === NESTED_ERROR && next?.severity === 'error'
      ? [{ text: next.text, at: printed.lines.length, suite: null, during: null, warning: false }]
      : [];
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
  const declared = (value: unknown): Declared =>
    typeof value === 'object' && value !== null ? (value as Declared) : {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const read = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
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
  /** The printed lines worth showing for a failure, in order, with gaps marked. */
  readonly shown: readonly string[];
}

/**
 * Windows' exit statuses an engine dies with, by name. Godot's own exit codes are small, so a code
 * this large is the operating system saying the process was ended, and the number alone says
 * nothing to the person reading it.
 */
const WINDOWS_EXITS: ReadonlyMap<number, string> = new Map([
  [0xc0000005, 'STATUS_ACCESS_VIOLATION'],
  [0xc0000017, 'STATUS_NO_MEMORY'],
  [0xc000012d, 'STATUS_COMMITMENT_LIMIT'],
  [0xc0000142, 'STATUS_DLL_INIT_FAILED'],
  [0xc0000409, 'STATUS_STACK_BUFFER_OVERRUN'],
  [0xc06d007e, 'a module that could not be found (VcppException)'],
  [0xc06d007f, 'a procedure that could not be found (VcppException)'],
]);
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
  const status = WINDOWS_EXITS.get(unsigned);
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
 * printed by exactly one engine, from row 0 up to the last any engine found, with none missing. Judged over all of them rather than
 * in each, since an engine dealt rows a case no longer has rightly runs none of them; and only once
 * every engine holding the case closed its suite, since one that did not is a fault already and says
 * why.
 */
export function rowsAcross(
  engines: ReadonlyArray<{ readonly handed: readonly HandedSuite[]; readonly printed: RunPrinted }>,
): { readonly suite: string; readonly fault: string }[] {
  const dealtOut = new Map<string, { path: string; func: string; holders: RunPrinted[] }>();
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
  const faults: { suite: string; fault: string }[] = [];
  for (const [key, { path, func, holders }] of dealtOut) {
    const suites = holders.map((printed) => printed.suites.get(path));
    if (suites.some((suite) => suite?.closed === null || suite?.closed === undefined)) {
      continue;
    }
    const counts = new Map<number | null, number>();
    for (const ran of suites.flatMap((suite) => suite?.cases ?? []).filter((ran) => ran.func === func)) {
      counts.set(ran.row, (counts.get(ran.row) ?? 0) + 1);
    }
    const said = (row: number | null): string => (row === null ? 'the case whole' : `row ${String(row)}`);
    if (counts.size === 0) {
      faults.push({
        suite: path,
        fault: `${key} ran in none of the ${String(holders.length)} engines its rows were dealt to`,
      });
      continue;
    }
    const twice = [...counts].filter(([, times]) => times > 1).map(([row]) => said(row));
    if (twice.length > 0) {
      faults.push({ suite: path, fault: `${key} ran ${named(twice)} in more than one engine` });
    }
    const rows = [...counts.keys()].filter((row) => row !== null);
    if (rows.length > 0 && counts.has(null)) {
      faults.push({ suite: path, fault: `${key} ran both whole and by its rows` });
    }
    // A row past the last one run is known only from an engine that found it and left it out.
    const left = holders.flatMap((printed) => printed.leftOut.get(key) ?? []).filter((row) => row !== null);
    const top = Math.max(-1, ...rows, ...left);
    const gaps = Array.from({ length: top + 1 }, (_, row) => row).filter((row) => !counts.has(row));
    if (gaps.length > 0) {
      faults.push({
        suite: path,
        fault: `${key} did not run ${named(gaps.map(said))} in any of the ${String(holders.length)} engines its rows were dealt to`,
      });
    }
  }
  return faults;
}

/** The line Godot's crash handler starts its report with, and the signal it names. */
const CRASH_HEADER = /^(?:CrashHandlerException|handle_crash): Program crashed with signal (\d+)/;

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
 * running flush has already destroyed. Measured on 4.7.2's Windows build; another build moves them.
 */
const QUEUE_OVERFLOW_FRAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ['ed1daf0bf001b61586d9930840f2f1394092c079', ['main+3e1082a', 'main+3e0f4aa']],
]);

/** What Godot's crash handler reported in [param lines]: the signal and whether the call queue overflowed. */
function crashIn(lines: readonly string[]): { readonly signal: string; readonly overflowed: boolean } | null {
  const trimmed = lines.map((line) => line.trim());
  const at = trimmed.findIndex((line) => CRASH_HEADER.test(line));
  const said = trimmed.some((line) => line.includes(QUEUE_OVERFLOW_LINE));
  if (at === -1) {
    return said ? { signal: '', overflowed: true } : null;
  }
  const report = trimmed.slice(at);
  const build = report.map((line) => CRASH_BUILD.exec(line)?.[1]).find((commit) => commit !== undefined);
  const frames = build === undefined ? undefined : QUEUE_OVERFLOW_FRAMES.get(build);
  const framed = frames?.every((frame) => report.some((line) => line.includes(`(${frame})`))) === true;
  return { signal: CRASH_HEADER.exec(trimmed[at] ?? '')?.[1] ?? '', overflowed: said || framed };
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
  const faults: string[] = [];
  const failing = new Set<string>();
  const shownAt = new Set<number>();
  // gdUnit4's 100 beside a case that failed says only what that case's own line says, and its 101
  // beside the orphans the runner named only what those say.
  const explained =
    (end.code === GDUNIT_FAILED &&
      [...printed.suites.values()].some((suite) => suite.cases.some((ran) => ran.verdict === 'FAILED'))) ||
    (end.code === GDUNIT_ORPHANS && printed.orphansLeft.length > 0);
  // A crash is read from the report the engine's crash handler printed, since the code a crashed
  // engine exits with says nothing reliable: a windowed one on Windows exited 5, which read as a
  // quit(5) in the game's code.
  const crashed = crashIn(printed.lines);
  if (end.ended !== null) {
    faults.push(end.ended);
  } else if (end.code !== 0 && !explained) {
    const free =
      end.freeBytes === undefined
        ? ''
        : `, with ${(end.freeBytes / 1024 ** 3).toFixed(1)} GB of memory free as it ended`;
    faults.push(
      crashed !== null && crashed.signal !== ''
        ? `the engine crashed${whileRunning(printed.running)}, its crash handler reporting signal ${crashed.signal}${free}`
        : end.code === null
          ? `the engine was ended by ${end.signal ?? 'a signal'}${free}`
          : `the engine exited ${exitNamed(end.code)}${free}`,
    );
  }
  if (crashed?.overflowed === true) {
    faults.push(
      `the engine's call queue overflowed${whileRunning(printed.running)}: something queued deferred calls without end within one frame, most often a layout that changes the size it is laid out from in a deferred handler, so the frame never ends${crashed.signal === '' ? '' : ', and the engine crashed reporting the overflow'}`,
    );
  }
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
  if (printed.executed === null || printed.executed === 0) {
    faults.push(
      printed.executed === null
        ? 'the run never printed its summary'
        : 'the run executed no test case at all, whatever it exited with',
    );
  }
  for (const row of [...printed.mismatched, ...printed.unrunnable]) {
    faults.push(`${row.suite} > ${row.name} never ran: gdUnit4 skipped it, saying "${row.reason}"`);
    failing.add(row.suite);
  }
  for (const { path, cases, rows = {} } of handed.suites) {
    const suite = printed.suites.get(path);
    if (suite === undefined) {
      faults.push(`${path} never started`);
      failing.add(path);
      continue;
    }
    if (suite.closed === null) {
      faults.push(`${path} never finished`);
      failing.add(path);
    } else if (suite.closed.verdict !== 'PASSED') {
      // The cases can all pass while the suite does not: a failing assertion in before or after.
      if (suite.cases.every((ran) => ran.verdict !== 'FAILED')) {
        faults.push(`${path} reported ${suite.closed.verdict} with every case passing, so a hook failed`);
      }
      failing.add(path);
    }
    const finished = new Set(suite.cases.map((ran) => ran.func));
    // A case dealt by its rows can rightly run none here, when it has fewer rows than last time;
    // whether every row ran once is judged over all the engines, by rowsAcross.
    const missing = cases.filter((func) => !finished.has(func) && rows[func] === undefined);
    if (missing.length > 0 && suite.closed !== null) {
      faults.push(`${path} closed without running ${named(missing)}`);
      failing.add(path);
    }
    for (const [func, share] of Object.entries(rows)) {
      const strays = suite.cases
        .filter((ran) => ran.func === func && !rowRuns(share, ran.row))
        .map((ran) => (ran.row === null ? 'the case whole' : `row ${String(ran.row)}`));
      if (strays.length > 0) {
        faults.push(
          `${path} > ${func} ran ${named(strays)}, which ${strays.length === 1 ? 'was' : 'were'} dealt to another engine`,
        );
        failing.add(path);
      }
    }
    const wanted = new Set(cases);
    const unasked = [...finished].filter((func) => !wanted.has(func));
    if (unasked.length > 0) {
      faults.push(
        `${path} ran ${named(unasked)}, which gdharness did not read as cases of it to run here, so its ` +
          'plan of the cases was wrong',
      );
      failing.add(path);
    }
    for (const ran of suite.cases) {
      if (ran.verdict === 'FAILED' || ran.verdict === 'FLAKY') {
        faults.push(
          ran.verdict === 'FLAKY'
            ? `${path} > ${ran.name} failed before it passed on a retry`
            : `${path} > ${ran.name} failed`,
        );
        failing.add(path);
        for (
          let at = ran.at;
          at < printed.lines.length && (at === ran.at || printed.lines[at]?.trim());
          at += 1
        ) {
          shownAt.add(at);
        }
      }
    }
  }
  // Failing the suite, as the run it fails is: recorded as passed, a suite leaving orphans was
  // skipped by the next run that skips what passed, which then passed.
  for (const left of printed.orphansLeft) {
    faults.push(orphansLeftSaid(left));
    failing.add(left.suite);
  }
  const unexpected = unexpectedErrors(
    printed,
    handed.expected,
    handed.suites.map((suite) => suite.path),
  );
  for (const error of unexpected.printed) {
    faults.push(
      error.suite === null
        ? `an engine ${error.warning ? 'warning' : 'error'} outside every suite: ${error.text}`
        : `an engine ${error.warning ? 'warning' : 'error'} in ${error.suite} > ${error.during ?? ''}: ${error.text}; ${declaringAdvice(error.during ?? '', error.warning)}`,
    );
    if (error.suite !== null) {
      failing.add(error.suite);
    }
    shownAt.add(error.at);
    shownAt.add(error.at + 1);
  }
  for (const missing of unexpected.neverPrinted) {
    faults.push(
      `${missing.suite} > ${missing.during} declares the ${missing.warning ? 'warning' : 'error'} "${missing.text}", which it never printed`,
    );
    failing.add(missing.suite);
  }
  const selfTyped = selfTypedSentence(handed.selfTyped ?? []);
  const notes: string[] = [];
  const pushErrorsFailed =
    handed.failsOnPushErrors === true ? pushErrorsFailedSentence(failedOnPushErrors(printed)) : undefined;
  if (pushErrorsFailed !== undefined) {
    notes.push(pushErrorsFailed);
  }
  if (printed.leaks.length > 0 && walkStoppedPartWay(printed.lines)) {
    notes.push(`${WALK_STOPPED_SENTENCE} It said: ${printed.leaks.join(' ')}`);
  } else {
    const held = heldAtExit(printed.lines);
    printed.leaks.forEach((leak, at) => {
      const last = at === printed.leaks.length - 1;
      const after = last ? [held, selfTyped].filter((part) => part !== undefined) : [];
      // A verbose engine still ends its count of objects by advising --verbose, beside the names.
      const quoted =
        held === undefined ? leak : leak.replace(/\s*\(run with `?--verbose`? for details\)/, '');
      faults.push(`the engine exited holding what it should have freed: ${[quoted, ...after].join(' ')}`);
    });
  }
  const memoryExit = end.code !== null && MEMORY_EXITS.has(end.code >>> 0);
  const starved = memoryExit || printed.starved.length > 0;
  if (printed.starved.length > 0) {
    faults.push('the engine ran out of memory');
  }
  printed.lines.forEach((line, at) => {
    if (/^(?:Overall Summary|Executed test|Total execution time| ?Exit code)/.test(line.trim())) {
      shownAt.add(at);
    }
  });
  const passed = faults.length === 0;
  const passedSuites = handed.suites.map((suite) => suite.path).filter((path) => !failing.has(path));
  // A run that stopped short says why in its last lines, if anywhere.
  const cutShort =
    end.ended !== null ||
    printed.executed === null ||
    handed.suites.some(({ path }) => printed.suites.get(path)?.closed == null);
  return {
    passed,
    faults,
    notes,
    passedSuites,
    starved,
    shown: passed ? [] : linesShown(printed.lines, shownAt, cutShort),
  };
}

/**
 * The lines at [param picked], with a gap marked where lines are left out, or the run's last lines
 * when it was [param cutShort] and nothing picked says why.
 */
function linesShown(lines: readonly string[], picked: ReadonlySet<number>, cutShort: boolean): string[] {
  const summary = [...picked].filter((at) => at < lines.length).sort((a, b) => a - b);
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
  return `if the suite prints it on purpose, list its text under "${funcOf(during)}" in the suite's ${warning ? 'GDHARNESS_EXPECTED_WARNINGS' : 'GDHARNESS_EXPECTED_ERRORS'}`;
}

/**
 * The cases gdUnit4 failed during which the engine printed an error or a warning that was not a
 * script's, as `suite > case`. A project turning on gdUnit4's `report/godot/push_error` has each of
 * those fail its case, declared or not, so a case that declares it for gdharness, as the advice
 * above asks, still fails, and gdUnit4's report gives only the text.
 */
export function failedOnPushErrors(printed: RunPrinted): string[] {
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
 * it, and a parameterised case each time per row; an error is declared among the errors and a
 * warning among the warnings, so a text declared as one does not accept the other.
 */
export function unexpectedErrors(
  printed: RunPrinted,
  expected: Expected,
  paths: readonly string[],
): { printed: PrintedError[]; neverPrinted: MissingError[] } {
  const owed = new Map<string, { suite: string; during: string; warning: boolean; texts: string[] }>();
  for (const path of paths) {
    const suite = printed.suites.get(path);
    if (suite === undefined) {
      continue;
    }
    const ranHooks = suite.closed === null ? ['before'] : ['before', 'after'];
    for (const warning of [false, true]) {
      const declared = (warning ? expected.warnings : expected.errors)[path];
      if (declared === undefined) {
        continue;
      }
      for (const during of [...ranHooks, ...suite.cases.map((ran) => ran.name)]) {
        const texts: unknown = declared[funcOf(during)];
        if (Array.isArray(texts) && texts.length > 0) {
          owed.set(`${path}\n${during}\n${String(warning)}`, {
            suite: path,
            during,
            warning,
            texts: texts.map((text: unknown) => String(text)),
          });
        }
      }
    }
  }
  const unexpected: PrintedError[] = [];
  for (const error of printed.errors) {
    const debt =
      error.suite === null || error.during === null
        ? undefined
        : owed.get(`${error.suite}\n${error.during}\n${String(error.warning)}`);
    const index = debt?.texts.indexOf(error.text) ?? -1;
    if (debt === undefined || index < 0) {
      unexpected.push(error);
    } else {
      debt.texts.splice(index, 1);
    }
  }
  const neverPrinted = [...owed.values()].flatMap((debt) =>
    debt.texts.map((text) => ({ suite: debt.suite, during: debt.during, text, warning: debt.warning })),
  );
  return { printed: unexpected, neverPrinted };
}
