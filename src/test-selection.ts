/**
 * The cases a project_test run is asked for by name, turned into what gdUnit4 takes.
 *
 * gdUnit4's runner adds suites and directories and leaves cases out, and has no way to add one
 * case, so a run of test_doubles alone was a run of its suite with every other case named under
 * ignore, which a caller had to know the names of. The suites holding the cases asked for are
 * added, and their other cases left out.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { nearest } from './nearest.js';
import { projectFiles } from './project-scan.js';

/** One case asked for, by the entry that asked for it and the suite file it is in. */
interface SelectedTest {
  readonly entry: string;
  readonly suite: string;
  readonly test: string;
}

export interface TestSelection {
  /** The suite files to add, as res:// paths. */
  readonly suites: readonly string[];
  /** The cases of those suites to leave out, as gdUnit4's `res://suite.gd:test_name`. */
  readonly ignore: readonly string[];
  readonly selected: readonly SelectedTest[];
}

/**
 * The cases each suite file declares, by the name gdUnit4 runs them under: a function at the top
 * level whose name starts with test_, as its discoverer finds them.
 */
function casesIn(projectPath: string, suite: string): string[] {
  const text = readFileSync(join(projectPath, suite.slice('res://'.length)), 'utf8');
  return [...text.matchAll(/^func\s+(test_\w*)\s*\(/gm)].map((match) => match[1] ?? '');
}

/** The suite files under [param asked], res:// paths of files or directories in the project. */
function suitesUnder(projectPath: string, asked: readonly string[]): string[] {
  const scripts = projectFiles(projectPath, ['.gd']).map((path) => `res://${path}`);
  return [
    ...new Set(
      asked.flatMap((path) =>
        path.endsWith('.gd')
          ? existsSync(join(projectPath, path.slice('res://'.length)))
            ? [path]
            : []
          : scripts.filter((script) => script.startsWith(`${path}/`)),
      ),
    ),
  ];
}

/**
 * What [param given], the run's `tests` argument, selects among the suites under [param asked], or
 * why it selects nothing: each entry is "test_name" or "suite:test_name", the suite by its file
 * name without .gd or by its res:// path. Null when no case was named.
 */
export function selectTests(
  projectPath: string,
  asked: readonly string[],
  given: unknown,
): { ok: true; value: TestSelection | null } | { ok: false; reason: string } {
  if (given === undefined || given === null) {
    return { ok: true, value: null };
  }
  const entries: unknown[] = Array.isArray(given) ? given : [given];
  if (entries.length === 0) {
    return { ok: false, reason: 'tests is an empty list: name a case, or leave tests out to run every one.' };
  }
  const declared = suitesUnder(projectPath, asked).flatMap((suite) =>
    casesIn(projectPath, suite).map((test) => ({ suite, test })),
  );
  const nameOf = (suite: string): string => basename(suite, '.gd');
  const selected: SelectedTest[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return {
        ok: false,
        reason: `tests[${index}] is not a case name: give "test_name" or "suite:test_name".`,
      };
    }
    const spelled = entry.trim();
    // The colon of res:// is not the one between a suite and its case.
    const at = spelled.lastIndexOf(':');
    const suiteNamed = at === -1 || spelled.slice(at).startsWith('://') ? null : spelled.slice(0, at);
    const test = suiteNamed === null ? spelled : spelled.slice(at + 1);
    const suitePath = suiteNamed?.startsWith('res://') === true ? suiteNamed : null;
    const matches = declared.filter(
      (one) =>
        one.test === test &&
        (suiteNamed === null || one.suite === suitePath || nameOf(one.suite) === suiteNamed),
    );
    if (matches.length === 0) {
      const said = `No suite under ${asked.join(', ')} has a case ${spelled}`;
      if (declared.length === 0) {
        return { ok: false, reason: `${said}: none of them declares a func test_ at the top level.` };
      }
      const written = declared.map((one) => `${nameOf(one.suite)}:${one.test}`);
      const close = nearest(suiteNamed === null ? test : `${nameOf(suiteNamed)}:${test}`, [
        ...new Set(suiteNamed === null ? declared.map((one) => one.test) : written),
      ]);
      return {
        ok: false,
        reason:
          close.length > 0
            ? `${said}. The nearest ${close.length === 1 ? 'is' : 'are'} ${close.join(', ')}.`
            : `${said}. The cases there are ${written.slice(0, 12).join(', ')}${written.length > 12 ? `, and ${written.length - 12} more` : ''}.`,
      };
    }
    for (const one of matches) {
      selected.push({ entry: spelled, ...one });
    }
  }
  const suites = [...new Set(selected.map((one) => one.suite))];
  const chosen = new Set(selected.map((one) => `${one.suite}:${one.test}`));
  const ignore = declared
    .filter((one) => suites.includes(one.suite) && !chosen.has(`${one.suite}:${one.test}`))
    .map((one) => `${one.suite}:${one.test}`);
  return { ok: true, value: { suites, ignore, selected } };
}
