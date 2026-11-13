/**
 * The cases a project_test run is asked for by name, turned into what gdUnit4 takes.
 *
 * gdUnit4's runner adds suites and directories and leaves cases out, and has no way to add one
 * case, so a run of test_doubles alone was a run of its suite with every other case named under
 * ignore, which a caller had to know the names of. The suites holding the cases asked for are
 * added, and their other cases left out.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { nearest } from './nearest.js';
import { resolveWithinProject } from './paths.js';
import { projectFiles } from './project-scan.js';
import { ProjectScripts } from './suite-plan.js';

/** A `script.gd:test_case` entry, as gdharness test takes one case: the script, then the case. */
const CASE_AFTER_SCRIPT = /^(.*\.gd):(\w+)$/;

/**
 * [param given], project_test's path, with each `script.gd:test_case` entry taken apart into its
 * suite, kept under path, and its case, added to [param tests], as gdharness test reads such an
 * entry. As a file name it was refused for its colon, which told a caller from the command line
 * nothing of tests. Refused beside a whole suite or a directory, since a run with cases named runs
 * only those, and the rest of the list would not have run.
 */
export function casesOutOfPath(
  projectPath: string,
  given: unknown,
  tests: unknown,
): { ok: true; path: unknown; tests: unknown } | { ok: false; reason: string } {
  const entries: unknown[] = Array.isArray(given) ? given : [given];
  const cases: string[] = [];
  const whole: string[] = [];
  const path = entries.map((entry) => {
    const caseAt = typeof entry === 'string' ? CASE_AFTER_SCRIPT.exec(entry.trim()) : null;
    const suite =
      caseAt === null ? null : resolveWithinProject(projectPath, caseAt[1] ?? '', { forTheEngine: true });
    if (caseAt === null || suite === null || !suite.ok) {
      if (typeof entry === 'string') {
        whole.push(entry);
      }
      return entry;
    }
    cases.push(`res://${suite.relativePath}:${caseAt[2] ?? ''}`);
    return `res://${suite.relativePath}`;
  });
  if (cases.length === 0) {
    return { ok: true, path: given, tests };
  }
  if (whole.length > 0) {
    return {
      ok: false,
      reason: `path names ${cases.length === 1 ? 'a case' : 'cases'}, ${cases.join(', ')}, beside ${whole.join(', ')}, and a run with cases named runs only those: run the cases on their own, and the rest in a run of its own.`,
    };
  }
  const named: unknown[] =
    tests === undefined || tests === null ? [] : Array.isArray(tests) ? tests : [tests];
  return { ok: true, path: [...new Set(path)], tests: [...named, ...cases] };
}

/**
 * Why [param given], editor_run's suites, cannot be played, when an entry names one case as
 * `script.gd:test_case`: the suites scene plays whole suites. Null when no entry names a case.
 */
export function caseInSuites(given: unknown): string | null {
  const entries: unknown[] = Array.isArray(given) ? given : [given];
  const cased = entries.filter(
    (entry): entry is string => typeof entry === 'string' && CASE_AFTER_SCRIPT.test(entry.trim()),
  );
  const first = cased[0];
  if (first === undefined) {
    return null;
  }
  const file = CASE_AFTER_SCRIPT.exec(first.trim())?.[1] ?? first;
  return `suites plays whole suites, and ${cased.join(', ')} ${cased.length === 1 ? 'names' : 'name'} one case: name the file, ${file}, to play every case in it, or run the case alone with project_test, whose path takes ${first}.`;
}

/** One case asked for, by the entry that asked for it and the suite file it is in. */
interface SelectedTest {
  readonly entry: string;
  readonly suite: string;
  readonly test: string;
}

interface TestSelection {
  /** The suite files to add, as res:// paths. */
  readonly suites: readonly string[];
  /** The cases of those suites to leave out, as gdUnit4's `res://suite.gd:test_name`. */
  readonly ignore: readonly string[];
  readonly selected: readonly SelectedTest[];
}

/**
 * The cases a suite file runs, by the name gdUnit4 runs them under: a function at the top level
 * whose name starts with test_, its own and those of the project's scripts it extends, as its
 * discoverer finds them. Read from the file alone, a suite inheriting every case from a base suite
 * was refused as declaring none, and an inherited case could be neither asked for nor left out.
 */
function casesIn(scripts: ProjectScripts, suite: string): readonly string[] {
  return (
    scripts.suite(suite)?.cases ??
    scripts.script(suite)?.funcs.filter((name) => name.startsWith('test_')) ??
    []
  );
}

/**
 * The scripts among [param asked], each a res:// path of a file in the project, that declare no
 * case. Named on their own, they give gdUnit4 nothing to run: it started an engine for seconds to
 * say so, and the answer was its whole console with exit code 0 beside passed false.
 */
export function scriptsWithoutCases(projectPath: string, asked: readonly string[]): string[] {
  const scripts = new ProjectScripts(projectPath);
  return asked.filter(
    (path) =>
      path.endsWith('.gd') &&
      existsSync(join(projectPath, path.slice('res://'.length))) &&
      casesIn(scripts, scripts.spelled(path)).length === 0,
  );
}

/** The scripts under [param folders], res:// paths of directories in the project, that declare a case. */
export function suiteFilesUnder(projectPath: string, folders: readonly string[]): string[] {
  const scripts = new ProjectScripts(projectPath);
  return suitesUnder(projectPath, scripts, folders)
    .filter((path) => casesIn(scripts, path).length > 0)
    .toSorted();
}

/**
 * The suite files under [param asked], res:// paths of files or directories in the project, spelled
 * as the disk spells them, which a case-insensitive file system lets a caller get wrong.
 */
function suitesUnder(projectPath: string, scripts: ProjectScripts, asked: readonly string[]): string[] {
  const files = projectFiles(projectPath, ['.gd']).map((path) => `res://${path}`);
  return [
    ...new Set(
      asked.flatMap((path) => {
        if (path.endsWith('.gd')) {
          return existsSync(join(projectPath, path.slice('res://'.length))) ? [scripts.spelled(path)] : [];
        }
        const folder = path.replace(/\/+$/, '');
        return files.filter((file) => scripts.holds(folder, file));
      }),
    ),
  ];
}

interface DeclaredCase {
  readonly suite: string;
  readonly test: string;
}

function nameOfSuite(suite: string): string {
  return basename(suite, '.gd');
}

/** The suite and the case a `tests` entry names, the suite null when it names only a case. */
function splitEntry(spelled: string): { suiteNamed: string | null; test: string } {
  // The colon of res:// is not the one between a suite and its case.
  const at = spelled.lastIndexOf(':');
  const suiteNamed = at === -1 || spelled.slice(at).startsWith('://') ? null : spelled.slice(0, at);
  return { suiteNamed, test: suiteNamed === null ? spelled : spelled.slice(at + 1) };
}

/** The cases spelled nearest to the one asked for, in the way the entry spelled it. */
function nearCases(found: {
  readonly test: string;
  readonly suiteNamed: string | null;
  readonly declared: readonly DeclaredCase[];
  readonly inSuite: readonly DeclaredCase[];
}): string[] {
  const { test, suiteNamed, declared, inSuite } = found;
  // Compared without the test_ every case starts with, or the suite name before it: shared by
  // every name offered, they made each one near whatever was asked.
  const bare = (name: string): string => name.replace(/^test_/, '');
  const spell = (one: DeclaredCase): string =>
    suiteNamed === null ? one.test : `${nameOfSuite(one.suite)}:${one.test}`;
  return [
    ...new Set([
      ...nearest(bare(test), [...new Set(inSuite.map((one) => bare(one.test)))]).flatMap((name) =>
        inSuite.filter((one) => bare(one.test) === name).map(spell),
      ),
      // The case asked for, in a suite other than the one named.
      ...(suiteNamed === null ? [] : declared.filter((one) => one.test === test).map(spell)),
    ]),
  ];
}

/** Why no case matched [param spelled], with the nearest names or the cases there are. */
function noCaseReason(found: {
  readonly asked: readonly string[];
  readonly spelled: string;
  readonly test: string;
  readonly suiteNamed: string | null;
  readonly declared: readonly DeclaredCase[];
  /** The declared cases of the suite named, or all of them when none was. */
  readonly inSuite: readonly DeclaredCase[];
}): string {
  const { asked, spelled, declared } = found;
  const said = `No suite under ${asked.join(', ')} has a case ${spelled}`;
  if (declared.length === 0) {
    return `${said}: none of them declares a func test_ at the top level.`;
  }
  const close = nearCases(found);
  if (close.length > 0) {
    return `${said}. The nearest ${close.length === 1 ? 'is' : 'are'} ${close.join(', ')}.`;
  }
  return `${said}. The cases there are ${casesListed(declared)}.`;
}

/** The first twelve of [param declared] as "suite:test", with how many more there are. */
function casesListed(declared: readonly DeclaredCase[]): string {
  const written = declared.map((one) => `${nameOfSuite(one.suite)}:${one.test}`);
  return `${written.slice(0, 12).join(', ')}${written.length > 12 ? `, and ${written.length - 12} more` : ''}`;
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
  const scripts = new ProjectScripts(projectPath);
  const declared = suitesUnder(projectPath, scripts, asked).flatMap((suite) =>
    casesIn(scripts, suite).map((test) => ({ suite, test })),
  );
  const selected: SelectedTest[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return {
        ok: false,
        reason: `tests[${index}] is not a case name: give "test_name" or "suite:test_name".`,
      };
    }
    const spelled = entry.trim();
    const { suiteNamed, test } = splitEntry(spelled);
    const suitePath = suiteNamed?.startsWith('res://') === true ? scripts.spelled(suiteNamed) : null;
    const inSuite =
      suiteNamed === null
        ? declared
        : declared.filter((one) => one.suite === suitePath || nameOfSuite(one.suite) === suiteNamed);
    const matches = inSuite.filter((one) => one.test === test);
    if (matches.length === 0) {
      return { ok: false, reason: noCaseReason({ asked, spelled, test, suiteNamed, declared, inSuite }) };
    }
    selected.push(...matches.map((one) => ({ entry: spelled, ...one })));
  }
  const suites = [...new Set(selected.map((one) => one.suite))];
  return { ok: true, value: { suites, ignore: unselectedIn(suites, declared, selected), selected } };
}

/** The cases of [param suites] that [param selected] leaves out, as "suite:test". */
function unselectedIn(
  suites: readonly string[],
  declared: readonly DeclaredCase[],
  selected: readonly SelectedTest[],
): string[] {
  const chosen = new Set(selected.map((one) => `${one.suite}:${one.test}`));
  return declared
    .filter((one) => suites.includes(one.suite) && !chosen.has(`${one.suite}:${one.test}`))
    .map((one) => `${one.suite}:${one.test}`);
}
