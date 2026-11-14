/**
 * project_test's run of a named set that mixes suites needing a window with suites that do not.
 * They run in two engines, since a headless suite measures a different engine once a window is
 * there. The answers of the two engines are put together here as one.
 */

import { isRecord } from './records.js';

/** The note an answer carries when its suites ran in two engines. */
const TWO_ENGINES_NOTE =
  'Ran as two engines: the suites needing a window in one with a window, the others in one headless.';

/** [param value] as a list of unknowns, empty when it is no list. */
export function listOf(value: unknown): unknown[] {
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
      return { merged: left === true || right === true };
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
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const answer of answers) {
    for (const [key, value] of Object.entries(answer)) {
      merged[key] = mergedValue(key, merged[key], value);
    }
  }
  const note = [TWO_ENGINES_NOTE, typeof merged['note'] === 'string' ? merged['note'] : undefined]
    .filter((part) => part !== undefined)
    .join(' ');
  // An entry the suites of one engine matched left something out, so only one every engine lacked stays.
  const unmatched = answers
    .map((answer) => listOf(answer['ignoreUnmatched']))
    .reduce(
      (kept, entries) => kept.filter((entry) => entries.includes(entry)),
      listOf(merged['ignoreUnmatched']),
    );
  return {
    ...merged,
    ignoreUnmatched: unmatched.length > 0 ? [...new Set(unmatched)] : undefined,
    ...extra,
    engines: answers.length,
    note,
  };
}
