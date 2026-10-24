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
import { EXIT_LEAK, type SelfTypedExport, selfTypedSentence } from './engine-leaks.js';
import type { LogEntry } from './game-log.js';
import { scriptErrorsPrinted } from './junit.js';

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
  /** Lines saying objects, resources or memory pages were still held as the engine exited. */
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
   * The rows the engine found and left to the others, by `path > func`; null for a case that is no
   * row. gdUnit4 prints nothing for them, so without these a row no engine was dealt goes unseen.
   */
  readonly leftOut: ReadonlyMap<string, readonly (number | null)[]>;
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
// Printed by the runner in src/godot/tests/listed.gd as it leaves a row out, -1 for a case whole.
const LEFT_OUT = /^gdharness left out (res:\/\/.+?\.gd) > ([^:\s]+):(-?\d+)\s*$/;
// Godot giving up on a rendering driver it could not start, and starting the next. The display
// server is made before any script of the project runs, so every error printed before this line
// is the engine probing a driver: a windowed engine on a machine without a Vulkan surface prints
// two and then runs its cases on Direct3D 12 or OpenGL.
const DRIVER_FALLBACK = /^\s*WARNING: Your video card drivers .*, switching to /;
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
function rowOf(name: string): number | null {
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
  const suites = new Map<string, SuitePrinted>();
  const errors: PrintedError[] = [];
  const leaks: string[] = [];
  let executed: number | null = null;
  let open: SuitePrinted | null = null;
  let during: string | null = null;
  // Errors printed after a verdict, held until it is known whether another case follows.
  let afterCase: { text: string; at: number; warning: boolean }[] = [];
  let lastCase: string | null = null;
  const settleAfterCase = (owner: string): void => {
    for (const held of afterCase) {
      errors.push({ ...held, suite: open?.path ?? null, during: owner });
    }
    afterCase = [];
  };
  const leftOut = new Map<string, (number | null)[]>();
  for (const [at, line] of lines.entries()) {
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
    // A warning counts only inside a suite. Outside every suite it is the engine's own as it starts
    // or exits, which no suite can declare; the leaks it reports at exit are read above.
    const warned = error === null && open !== null ? WARNING_LINE.exec(line) : null;
    const found = error ?? warned;
    if (found === null) {
      continue;
    }
    const text = found[1] ?? '';
    const warning = error === null;
    if (open === null) {
      errors.push({ text, at, suite: null, during: null, warning });
    } else if (during === null) {
      afterCase.push({ text, at, warning });
    } else {
      errors.push({ text, at, suite: open.path, during, warning });
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
  return { lines, suites, errors, leaks, starved, executed, unloadable, stoppedIn, leftOut };
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
}

export interface EngineVerdict {
  readonly passed: boolean;
  /** Each thing wrong with the run, one sentence each. */
  readonly faults: readonly string[];
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
const GDUNIT_EXITS: ReadonlyMap<number, string> = new Map([
  [GDUNIT_FAILED, "gdUnit4's code for a case that failed or errored"],
  [101, "gdUnit4's code for orphan nodes left behind"],
  [103, "gdUnit4's code for a suite that cannot run headless"],
  [104, "gdUnit4's code for a Godot version it does not support"],
  [105, "gdUnit4's code for scripts that did not compile"],
]);

/** The exit code as a person reads it: a Windows status by name and in hex, gdUnit4's by meaning. */
export function exitNamed(code: number): string {
  const unsigned = code >>> 0;
  const status = WINDOWS_EXITS.get(unsigned);
  if (status !== undefined) {
    return `0x${unsigned.toString(16).toUpperCase()} (${status})`;
  }
  const gdunit = GDUNIT_EXITS.get(code);
  return gdunit === undefined ? String(code) : `${String(code)} (${gdunit})`;
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
  // gdUnit4's 100 beside a case that failed says only what that case's own line says.
  const explained =
    end.code === GDUNIT_FAILED &&
    [...printed.suites.values()].some((suite) => suite.cases.some((ran) => ran.verdict === 'FAILED'));
  if (end.ended !== null) {
    faults.push(end.ended);
  } else if (end.code !== 0 && !explained) {
    faults.push(
      end.code === null
        ? `the engine was ended by ${end.signal ?? 'a signal'}`
        : `the engine exited ${exitNamed(end.code)}`,
    );
  }
  if (printed.unloadable.length > 0) {
    faults.push(`gdUnit4 could not load ${named(printed.unloadable)}, so it ran nothing`);
  }
  if (printed.executed === null || printed.executed === 0) {
    faults.push(
      printed.executed === null
        ? 'the run never printed its summary'
        : 'the run executed no test case at all, whatever it exited with',
    );
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
  const unexpected = unexpectedErrors(
    printed,
    handed.expected,
    handed.suites.map((suite) => suite.path),
  );
  for (const error of unexpected.printed) {
    faults.push(
      error.suite === null
        ? `an engine error outside every suite: ${error.text}`
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
  printed.leaks.forEach((leak, at) => {
    const last = at === printed.leaks.length - 1;
    faults.push(
      `the engine exited holding what it should have freed: ${leak}${last && selfTyped !== undefined ? ` ${selfTyped}` : ''}`,
    );
  });
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
