/**
 * What one engine's run of suites printed, read case by case, and judged.
 *
 * Read from the engine's own console rather than from gdUnit4's reports, because a gate needs what
 * the reports leave out: the `ERROR` lines a passing case printed, which case printed each one, the
 * leaks the engine reports as it exits, and how far a run got when it crashed or was ended. Both of
 * the engine's streams go into one file, so an error is read in order with the case lines around it.
 */

import { stripVTControlCharacters } from 'node:util';
import { scriptErrorsPrinted } from './junit.js';

/** One case as the run reported it finishing. */
interface CaseRan {
  /** As gdUnit4 printed it: the function, or `test_params:0 (1)` for one row of a parameterised case. */
  readonly name: string;
  /** The function the case is, which is what a suite declares and a skipping file names. */
  readonly func: string;
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

/** An error line the engine printed, and what was running when it did. */
interface PrintedError {
  /** The line's text after `ERROR: `, which is what a suite declares it expects. */
  readonly text: string;
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
}

const SUITE_OPENED = /^Run Test Suite:\s*(res:\/\/.+?\.gd)\s*$/;
const TIME = String.raw`(?:\d+h )?(?:\d+min )?(?:\d+s )?\d+ms`;
const CASE_LINE = new RegExp(
  String.raw`^\s*(res://.+?\.gd) > (.+?) (STARTED|PASSED|FAILED|FLAKY|SKIPPED|WARNING)(?: \((?:retry \d+|\d+ retries)\))?(?: (${TIME}))?\s*$`,
);
const STATISTICS = new RegExp(String.raw`^Statistics:.*\|\s*([A-Z]+)(?:\s+\(.*?\))?\s+(${TIME})\s*$`);
const ERROR_LINE = /^\s*(?:SCRIPT |USER )?ERROR: (.*?)\s*$/;
const EXECUTED = /^Executed test cases\s*:\s*\((\d+)\//;
const LEAK =
  /ObjectDB instances (?:were )?leaked at exit|resources? still in use at exit|Pages in use exist at exit/;
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
  let afterCase: { text: string; at: number }[] = [];
  let lastCase: string | null = null;
  const settleAfterCase = (owner: string): void => {
    for (const held of afterCase) {
      errors.push({ ...held, suite: open?.path ?? null, during: owner });
    }
    afterCase = [];
  };
  for (const [at, line] of lines.entries()) {
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
    if (LEAK.test(line)) {
      leaks.push(line.trim());
      continue;
    }
    const error = ERROR_LINE.exec(line);
    if (error === null) {
      continue;
    }
    const text = error[1] ?? '';
    if (open === null) {
      errors.push({ text, at, suite: null, during: null });
    } else if (during === null) {
      afterCase.push({ text, at });
    } else {
      errors.push({ text, at, suite: open.path, during });
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
  return { lines, suites, errors, leaks, starved, executed, unloadable, stoppedIn };
}

/** What one engine was handed, which is what its run is judged against. */
export interface EngineAssignment {
  /** Each suite, with the functions this engine is to run of it. */
  readonly suites: ReadonlyArray<{ readonly path: string; readonly cases: readonly string[] }>;
  /**
   * The errors each suite declares it prints, by suite and then by function or hook: the
   * `GDHARNESS_EXPECTED_ERRORS` constant as the runner read it from the compiled suite.
   */
  readonly expected: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
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

/** The exit code as a person reads it: a Windows status by name and in hex. */
export function exitNamed(code: number): string {
  const unsigned = code >>> 0;
  const name = WINDOWS_EXITS.get(unsigned);
  return name === undefined ? String(code) : `0x${unsigned.toString(16).toUpperCase()} (${name})`;
}

/** How many lines of a run's end are shown when nothing in it says what went wrong. */
const TAIL = 60;
/** How many cases are named in one sentence before the rest are counted. */
const MOST_NAMED = 8;

function named(items: readonly string[]): string {
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
  if (end.ended !== null) {
    faults.push(end.ended);
  } else if (end.code !== 0) {
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
  for (const { path, cases } of handed.suites) {
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
    const missing = cases.filter((func) => !finished.has(func));
    if (missing.length > 0 && suite.closed !== null) {
      faults.push(`${path} closed without running ${named(missing)}`);
      failing.add(path);
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
  const unexpected = unexpectedErrors(printed, handed);
  for (const error of unexpected.printed) {
    const where = error.suite === null ? 'outside every suite' : `in ${error.suite} > ${error.during ?? ''}`;
    faults.push(`an engine error ${where}: ${error.text}`);
    if (error.suite !== null) {
      failing.add(error.suite);
    }
    shownAt.add(error.at);
    shownAt.add(error.at + 1);
  }
  for (const missing of unexpected.neverPrinted) {
    faults.push(
      `${missing.suite} > ${missing.during} declares the error "${missing.text}", which it never printed`,
    );
    failing.add(missing.suite);
  }
  for (const leak of printed.leaks) {
    faults.push(`the engine exited holding what it should have freed: ${leak}`);
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

interface MissingError {
  readonly suite: string;
  readonly during: string;
  readonly text: string;
}

/**
 * The errors printed that no suite declared, and the declared ones that were not printed. A case
 * declares each text once for every time it prints it, and a parameterised case each time per row.
 */
function unexpectedErrors(
  printed: RunPrinted,
  handed: EngineAssignment,
): { printed: PrintedError[]; neverPrinted: MissingError[] } {
  const owed = new Map<string, { suite: string; during: string; texts: string[] }>();
  for (const { path } of handed.suites) {
    const suite = printed.suites.get(path);
    const declared = handed.expected[path];
    if (suite === undefined || declared === undefined) {
      continue;
    }
    const ranHooks = suite.closed === null ? ['before'] : ['before', 'after'];
    for (const during of [...ranHooks, ...suite.cases.map((ran) => ran.name)]) {
      const texts: unknown = declared[funcOf(during)];
      if (Array.isArray(texts) && texts.length > 0) {
        owed.set(`${path}\n${during}`, {
          suite: path,
          during,
          texts: texts.map((text: unknown) => String(text)),
        });
      }
    }
  }
  const unexpected: PrintedError[] = [];
  for (const error of printed.errors) {
    const debt =
      error.suite === null || error.during === null ? undefined : owed.get(`${error.suite}\n${error.during}`);
    const index = debt?.texts.indexOf(error.text) ?? -1;
    if (debt === undefined || index < 0) {
      unexpected.push(error);
    } else {
      debt.texts.splice(index, 1);
    }
  }
  const neverPrinted = [...owed.values()].flatMap((debt) =>
    debt.texts.map((text) => ({ suite: debt.suite, during: debt.during, text })),
  );
  return { printed: unexpected, neverPrinted };
}
