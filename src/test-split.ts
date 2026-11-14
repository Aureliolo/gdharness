/**
 * project_test's run of a named set that mixes suites needing a window with suites that do not.
 * They run in two engines, since a headless suite measures a different engine once a window is
 * there. The answers of the two engines are put together here as one.
 */

import { isRecord } from './records.js';

/** The note an answer carries when its suites ran in two engines. */
const TWO_ENGINES_NOTE =
  'Ran as two engines: the suites needing a window in one with a window, the others in one headless.';

/** The note sentence for ignore entries that named nothing under the paths run. */
export function unmatchedSaid(unmatched: readonly string[]): string {
  return `${unmatched.join(', ')} ${unmatched.length === 1 ? 'names' : 'name'} no suite, case or row under the paths run, so ${unmatched.length === 1 ? 'it' : 'they'} left nothing out.`;
}

/** The verdict clause for [param count] scripts that declare cases and are no suite. */
export function notSuitesVerdict(count: number): string {
  return `${count === 1 ? 'one script declares' : `${String(count)} scripts declare`} cases gdUnit4 never runs`;
}

/** The note sentence for scripts that declare cases and are no suite. */
export const NOT_SUITES_NOTE =
  'What notSuites names declares cases gdUnit4 never runs, so the run is not called passed, as gdharness test judges it.';

/**
 * Whether an ignore list leaves out the whole case [param test] of the suite at [param path]: by
 * the suite's file name, a piece of its path, or `suite:test`. An entry naming one row leaves out
 * the case's other rows.
 */
export function caseIgnored(path: string, test: string, ignore: readonly string[]): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.gd$/, '');
  return ignore.some((entry) => {
    const bare = entry.replace(/^res:\/\//, '');
    const at = bare.indexOf(':');
    if (at === -1) {
      return path.includes(entry);
    }
    const [suite = '', func = '', row] = bare.split(':');
    return (
      row === undefined && func === test && (suite === name || path.slice('res://'.length).includes(suite))
    );
  });
}

/** What is left of [param limit] milliseconds a call began at [param began] with, never below 0. */
export function timeLeft(limit: number, began: number, now: number): number {
  return Math.max(0, limit - (now - began));
}

/** The least milliseconds an engine is worth starting for: it spends seconds before its first suite. */
export const ENGINE_START_FLOOR_MS = 5000;

/** The note sentence for cases asked for by name that no engine ran. */
export function notRunSaid(notRun: readonly string[]): string {
  return `${notRun.join(', ')} ${notRun.length === 1 ? 'was' : 'were'} asked for and not run, so the run is not called passed: gdUnit4 runs a test_ function only in a script that extends GdUnitTestSuite, and leaves out a suite whose script does not load.`;
}

/**
 * The answer standing for an engine of [param kind] that never started because the call's
 * [param limit] was spent, naming its [param paths] as not run.
 */
export function notStartedAnswer(
  kind: string,
  paths: readonly string[],
  limit: number,
): Record<string, unknown> {
  return {
    passed: false,
    verdict: `the timeoutMs of ${String(limit)} ms was spent before the ${kind} engine started`,
    tests: 0,
    suitesNotRun: paths,
    note: `${paths.join(', ')} did not run: the ${kind} engine was not started, since the ${String(limit)} ms of timeoutMs was spent before it could.`,
  };
}

/** [param answer] failed for cases asked for by name that no engine ran, as a single run words it. */
export function withNotRun(answer: Record<string, unknown>, notRun: readonly string[]): void {
  if (notRun.length === 0) {
    return;
  }
  const said = `not run: ${notRun.join(', ')}`;
  const verdict = typeof answer['verdict'] === 'string' ? answer['verdict'] : '';
  answer['passed'] = false;
  answer['verdict'] = verdict === '' || verdict === 'passed' ? said : `${verdict}; ${said}`;
  answer['testsNotRun'] = [...notRun, ...listOf(answer['testsNotRun'])];
  answer['note'] = [answer['note'], notRunSaid(notRun)].filter((part) => typeof part === 'string').join(' ');
}

/** [param value] as a list of unknowns, empty when it is no list. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function sum(left: unknown, right: unknown): number | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left + right;
  }
  return typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
}

/** The sentences of two answers as one: the verdict leaves out a pass beside a failure. */
function sentences(key: string, left: unknown, right: unknown): string {
  const parts = [left, right].filter((part): part is string => typeof part === 'string' && part !== '');
  const worth =
    key === 'verdict' && parts.some((part) => part !== 'passed')
      ? parts.filter((p) => p !== 'passed')
      : parts;
  return [...new Set(worth)].join(key === 'verdict' ? '; ' : ' ');
}

/** The keys that are not added or joined, with what two values of each become. */
function namedValue(key: string, left: unknown, right: unknown): { merged: unknown } | undefined {
  switch (key) {
    case 'passed':
      return { merged: left === true && right === true };
    case 'exitCode':
      return { merged: left === 0 ? right : left };
    case 'windowed':
    case 'hung':
    case 'timedOut':
      return { merged: left === true || right === true };
    case 'silentForMs':
      return { merged: Math.max(Number(left), Number(right)) };
    case 'classes':
    case 'windowNote':
    case 'engineNote':
      return { merged: left };
    case 'verdict':
    case 'note':
      return { merged: sentences(key, left, right) };
    default:
      return undefined;
  }
}

function mergedValue(key: string, left: unknown, right: unknown): unknown {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  const named = namedValue(key, left, right);
  if (named !== undefined) {
    return named.merged;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return sum(left, right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const joined = [...listOf(left), ...listOf(right)];
    return key === 'missing' ? [...new Set(joined)] : joined;
  }
  if (isRecord(left) && isRecord(right)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(left), ...Object.keys(right)])].map((inner) => [
        inner,
        mergedValue(inner, left[inner], right[inner]),
      ]),
    );
  }
  return left;
}

/**
 * The answers of the engines of one run as the answer of the run: counts added, lists joined, the
 * verdict failed when either failed, and the two engines said.
 */
export function mergedTestAnswers(
  answers: readonly Record<string, unknown>[],
  labels: readonly string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const answer of answers) {
    for (const [key, value] of Object.entries(answer)) {
      if (key === 'arguments') {
        continue;
      }
      // The sentence about ignore entries is said once, for the entries no engine matched.
      const entries = listOf(answer['ignoreUnmatched']).map(String);
      merged[key] =
        key === 'note' && typeof value === 'string' && entries.length > 0
          ? mergedValue(key, merged[key], value.replace(unmatchedSaid(entries), '').trim())
          : mergedValue(key, merged[key], value);
    }
  }
  // An entry the suites of one engine matched left something out, so only one every engine lacked stays.
  const unmatched = [
    ...new Set(
      answers
        .map((answer) => listOf(answer['ignoreUnmatched']))
        .reduce(
          (kept, entries) => kept.filter((entry) => entries.includes(entry)),
          listOf(merged['ignoreUnmatched']),
        )
        .map(String),
    ),
  ];
  const note = [
    TWO_ENGINES_NOTE,
    typeof merged['note'] === 'string' ? merged['note'] : undefined,
    unmatched.length > 0 ? unmatchedSaid(unmatched) : undefined,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  // Each engine's command line apart, under the kind of engine it was.
  const commandLines = answers.flatMap((answer, at) =>
    answer['arguments'] === undefined ? [] : [[labels[at] ?? String(at), answer['arguments']] as const],
  );
  return {
    ...merged,
    ignoreUnmatched: unmatched.length > 0 ? unmatched : undefined,
    ...(commandLines.length > 0 ? { arguments: Object.fromEntries(commandLines) } : {}),
    engines: answers.filter((answer) => answer['suitesNotRun'] === undefined).length,
    note,
  };
}

/**
 * [param answer] failed for scripts that declare cases and are no suite, [param notSuites], the
 * way a single run is: the verdict and the note say so beside the list.
 */
export function withNotSuites(answer: Record<string, unknown>, notSuites: readonly string[]): void {
  if (notSuites.length === 0) {
    return;
  }
  const said = notSuitesVerdict(notSuites.length);
  const verdict = typeof answer['verdict'] === 'string' ? answer['verdict'] : '';
  answer['passed'] = false;
  answer['verdict'] = verdict === '' || verdict === 'passed' ? said : `${verdict}; ${said}`;
  answer['notSuites'] = [...notSuites, ...listOf(answer['notSuites'])];
  answer['note'] = [answer['note'], NOT_SUITES_NOTE].filter((part) => typeof part === 'string').join(' ');
}
