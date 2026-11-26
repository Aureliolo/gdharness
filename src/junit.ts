/**
 * The JUnit XML a test runner writes, read into the cases and what happened to each.
 *
 * The reader is a small XML parser of its own rather than a dependency: the format here is one
 * element shape with attributes, text and CDATA, and a parser for that is shorter than the
 * supply chain it would replace. Anything it cannot read is a `MalformedReportError`, never a
 * partial report that looks like a run with fewer tests.
 *
 * A run that wrote no report at all is the same question's other answer, and `whyNoReport` reads
 * it off what the runner printed, because the exit code cannot say.
 */

import { caseLineOf, suiteOpenedBy } from './game-log.js';
import { owned } from './log-read.js';

export class MalformedReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedReportError';
  }
}

interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decoded(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(code) || code > 0x10ffff) {
        throw new MalformedReportError(`Not a character: ${whole}`);
      }
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[entity];
    if (named === undefined) {
      throw new MalformedReportError(`Unknown entity ${whole}`);
    }
    return named;
  });
}

const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Where the tag opening at `from` ends: the first `>` outside a quoted attribute value, since
 * a value may hold one. -1 when the text runs out first.
 */
function tagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let at = from + 1; at < source.length; at += 1) {
    const character = source[at];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return at;
    }
  }
  return -1;
}

/** The position after the first [param terminator] at or past [param at], or a failure with [param problem]. */
function positionPast(source: string, at: number, terminator: string, problem: string): number {
  const end = source.indexOf(terminator, at);
  if (end === -1) {
    throw new MalformedReportError(problem);
  }
  return end + terminator.length;
}

/**
 * Reads the CDATA section, comment or declaration opening at `at`, adding CDATA to [param into]'s
 * text. Returns the position after it, or null when a tag opens there instead.
 */
function skipNonElement(source: string, at: number, into: XmlElement): number | null {
  if (source.startsWith('<![CDATA[', at)) {
    const after = positionPast(source, at, ']]>', 'CDATA that never ends');
    into.text += source.slice(at + '<![CDATA['.length, after - ']]>'.length);
    return after;
  }
  if (source.startsWith('<!--', at)) {
    return positionPast(source, at, '-->', 'A comment that never ends');
  }
  if (source.startsWith('<?', at) || source.startsWith('<!', at)) {
    return positionPast(source, at, '>', 'A declaration that never ends');
  }
  return null;
}

/** The attributes in [param body] after its name, which is [param nameLength] characters long. */
function attributesOf(body: string, tag: string, nameLength: number): Record<string, string> {
  // A sticky regex resets its own position to zero on a miss, so the position is kept here.
  const attributes: Record<string, string> = {};
  let read = nameLength;
  ATTRIBUTE.lastIndex = read;
  let attribute = ATTRIBUTE.exec(body);
  while (attribute) {
    attributes[attribute[1] ?? ''] = decoded(attribute[2] ?? attribute[3] ?? '');
    read = ATTRIBUTE.lastIndex;
    attribute = ATTRIBUTE.exec(body);
  }
  if (body.slice(read).trim() !== '') {
    throw new MalformedReportError(`Unreadable attributes in <${tag}>`);
  }
  return attributes;
}

/** The element a start tag opens, given the text between `<` and `>`. */
function elementOpenedBy(tag: string): XmlElement {
  const body = tag.endsWith('/') ? tag.slice(0, -1) : tag;
  const nameMatch = /^([^\s/>]+)/.exec(body);
  if (!nameMatch?.[1]) {
    throw new MalformedReportError(`A tag with no name: <${tag}>`);
  }
  const attributes = attributesOf(body, tag, nameMatch[0].length);
  return { name: nameMatch[1], attributes, children: [], text: '' };
}

/** Checks that the end tag [param tag] closes the innermost open element, then closes it. */
function closeElement(tag: string, open: XmlElement[]): void {
  const closing = tag.slice(1).trim();
  const element = open.at(-1) ?? { name: '' };
  if (open.length === 1 || element.name !== closing) {
    throw new MalformedReportError(`</${closing}> closes <${element.name || 'nothing'}>`);
  }
  open.pop();
}

/** The elements of a document, as a tree under one synthetic root. */
function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '', attributes: {}, children: [], text: '' };
  const open: XmlElement[] = [root];
  let at = 0;

  const current = (): XmlElement => open.at(-1) ?? root;

  while (at < source.length) {
    const next = source.indexOf('<', at);
    current().text += decoded(source.slice(at, next === -1 ? source.length : next));
    if (next === -1) {
      break;
    }
    at = next;

    const after = skipNonElement(source, at, current());
    if (after !== null) {
      at = after;
      continue;
    }

    const end = tagEnd(source, at);
    if (end === -1) {
      throw new MalformedReportError('A tag that never ends');
    }
    const tag = source.slice(at + 1, end);
    at = end + 1;

    if (tag.startsWith('/')) {
      closeElement(tag, open);
      continue;
    }

    const element = elementOpenedBy(tag);
    current().children.push(element);
    if (!tag.endsWith('/')) {
      open.push(element);
    }
  }

  if (open.length !== 1) {
    throw new MalformedReportError(`<${current().name}> is never closed`);
  }
  return root;
}

type CaseStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** One thing that went wrong in a case: a failed assertion, the error that ended it, or a skip. */
interface CaseReport {
  readonly kind: 'failure' | 'error' | 'skipped';
  /** The runner's one-line message, such as where the failing assertion is. */
  readonly message: string | null;
  /** What the runner said in full: the expected and actual values, the stack. */
  readonly detail: string | null;
}

interface TestCase {
  readonly suite: string;
  readonly name: string;
  readonly status: CaseStatus;
  readonly time: number;
  /** The first of [member reports], which is the first thing that went wrong in the case. */
  readonly message: string | null;
  readonly detail: string | null;
  /** Everything the case reported, in the order the case met it. */
  readonly reports: readonly CaseReport[];
}

interface TestSuite {
  readonly name: string;
  readonly path: string | null;
  readonly tests: number;
  /** What the suite said it held, which is more than `tests` when the run stopped inside it. */
  readonly discovered: number;
  readonly failures: number;
  readonly errors: number;
  /**
   * Failures and errors the suite counts that none of its cases carry: a `before()` or `after()`
   * that failed, which gdUnit4 adds to the suite's own attributes and writes nowhere else.
   */
  readonly hookFailures: number;
  readonly hookErrors: number;
  readonly skipped: number;
  readonly time: number;
  readonly cases: readonly TestCase[];
}

export interface TestReport {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  /** Summed over the suites, apart from the cases' own. */
  readonly hookFailures: number;
  readonly hookErrors: number;
  readonly skipped: number;
  readonly time: number;
  readonly suites: readonly TestSuite[];
}

function count(attributes: Readonly<Record<string, string>>, name: string): number {
  const raw = attributes[name];
  if (raw === undefined) {
    return 0;
  }
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || (name !== 'time' && !Number.isInteger(value))) {
    throw new MalformedReportError(`${name}="${raw}" is not ${name === 'time' ? 'a time' : 'a count'}`);
  }
  return value;
}

/** Whether a reported case is [param test], or one row of it, which gdUnit4 names `test:N (values)`. */
function isCaseOrRow(reported: string, test: string): boolean {
  return reported === test || (reported.startsWith(test) && /^\W/.test(reported.slice(test.length)));
}

/** An entry of a run's ignore list that named a case the run went on to run. */
interface IgnoreNotApplied {
  readonly entry: string;
  /** The case that ran, as `suite_name:test_name`, which is the form that leaves it out. */
  readonly ran: string;
}

/**
 * The entries of [param ignored] that named a case which ran all the same.
 *
 * gdUnit4 reads an entry with no colon as a suite name or a piece of a suite's path, and a case only
 * as `suite_name:test_name`, so a list of test function names left out nothing and said nothing: nine
 * of nine cases ran in a run asked to skip some of them. Which entries skipped something cannot be
 * read afterwards, since a skipped case is simply absent. A case that ran under a name an entry gave
 * can be, and that is the mistake made.
 */
export function ignoredYetRan(report: TestReport, ignored: readonly string[]): IgnoreNotApplied[] {
  const found: IgnoreNotApplied[] = [];
  for (const entry of ignored) {
    const bare = entry.replace('res://', '');
    const at = bare.lastIndexOf(':');
    const suiteNamed = at === -1 ? null : bare.slice(0, at);
    const testNamed = at === -1 ? bare : bare.slice(at + 1);
    for (const suite of report.suites) {
      const suiteMatches =
        suiteNamed === null || suite.name === suiteNamed || (suite.path ?? '').includes(suiteNamed);
      if (suiteMatches && suite.cases.some((one) => isCaseOrRow(one.name, testNamed))) {
        found.push({ entry, ran: `${suite.name}:${testNamed}` });
      }
    }
  }
  return found;
}

/**
 * What the runner prints before each row of a parameterised case an ignore entry left out, kept in
 * step with IGNORED_ROW in listed.gd.
 */
const IGNORED_ROW_LINE = /^gdharness ignored (res:\/\/.+?\.gd > [^:\s]+:\d+)\s*$/;

/**
 * One row of a parameterised case as an ignore entry names it, `suite_name:test_name:N` with N the
 * index gdUnit4 reports the row under, and anything gdUnit4 prints after the index allowed, so the
 * name a failure was reported under can be passed back as it came.
 */
function rowNamed(entry: string): { suite: string; test: string; row: number } | null {
  const named = /^(.+?):([A-Za-z_]\w*):(\d+)(?:\s.*)?$/.exec(entry.replace('res://', ''));
  return named === null ? null : { suite: named[1] ?? '', test: named[2] ?? '', row: Number(named[3]) };
}

type DeclaredSuites = ReadonlyArray<{ readonly path: string; readonly cases: readonly string[] }>;

const suiteNameOf = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.gd$/, '');

function declaring(
  declared: DeclaredSuites,
  suite: string,
  test: string | null,
): Array<{ path: string; test: string }> {
  return declared
    .filter((one) => suiteNameOf(one.path) === suite || one.path.includes(suite))
    .flatMap((one) =>
      one.cases
        .filter((name) => test === null || name === test)
        .map((name) => ({ path: one.path, test: name })),
    );
}

/**
 * [param ignored] as the runner is given it. gdUnit4 reads `suite:case:row` as the case and leaves
 * out every row of it, so an entry naming one row is handed over as `res://suite.gd:case:row` for
 * each suite under the run's paths, [param declared], that declares the case, and as nothing when
 * none does.
 */
export function ignoredForTheRunner(ignored: readonly string[], declared: DeclaredSuites): string[] {
  return ignored.flatMap((entry) => {
    const row = rowNamed(entry);
    return row === null
      ? [entry]
      : declaring(declared, row.suite, row.test).map((one) => `${one.path}:${one.test}:${String(row.row)}`);
  });
}

/** The rows the runner said it left out for an ignore entry, as `res://suite.gd > test_name:N`. */
export function rowsIgnoredIn(printed: Iterable<string>): Set<string> {
  return foldedOver(new RowsIgnoredRead(), printed);
}

/** A reading of printed lines taken a line at a time, so a run's lines need not all be held at once. */
interface LineFold<Result> {
  take(line: string): void;
  result(): Result;
}

/** What [param fold] makes of [param lines]. */
function foldedOver<Result>(fold: LineFold<Result>, lines: Iterable<string>): Result {
  for (const line of lines) {
    fold.take(line);
  }
  return fold.result();
}

/** {@link rowsIgnoredIn}, a line at a time. */
export class RowsIgnoredRead implements LineFold<Set<string>> {
  private readonly rows = new Set<string>();

  take(line: string): void {
    const row = IGNORED_ROW_LINE.exec(line)?.[1];
    if (row !== undefined) {
      this.rows.add(row);
    }
  }

  result(): Set<string> {
    return new Set(this.rows);
  }
}

/**
 * What [param ignored] left out, read against the cases the suites under the run's paths declare,
 * [param declared], and the rows the runner said it left out, [param rowsIgnored]: each case an entry
 * names that the report does not hold, as `suite_name:test_name`, each row as
 * `suite_name:test_name:N`, and each entry naming no case or row there at all. A run that left a case
 * out was answered passed with nothing saying a case had not run, and an entry spelt wrong left out
 * nothing and said nothing.
 */
export function ignoredLeftOut(
  report: TestReport,
  ignored: readonly string[],
  declared: DeclaredSuites,
  rowsIgnored: ReadonlySet<string> = new Set(),
): { leftOut: string[]; unmatched: string[] } {
  return leftOutNamed(ignoredLeftOutAt(report, ignored, declared, rowsIgnored));
}

/** [param read] answered as {@link ignoredLeftOut} does, each case by its suite's name. */
export function leftOutNamed(read: ReturnType<typeof ignoredLeftOutAt>): {
  leftOut: string[];
  unmatched: string[];
} {
  return { leftOut: [...new Set(read.leftOut.values())].toSorted(), unmatched: read.unmatched };
}

/**
 * {@link ignoredLeftOut} with each case or row keyed by its suite's path, as `res://dir/suite.gd:test_name`
 * and `res://dir/suite.gd:test_name:N`, so two suites of one file name stay apart. Each key maps to the
 * form {@link ignoredLeftOut} answers it as.
 */
export function ignoredLeftOutAt(
  report: TestReport,
  ignored: readonly string[],
  declared: DeclaredSuites,
  rowsIgnored: ReadonlySet<string> = new Set(),
): { leftOut: Map<string, string>; unmatched: string[] } {
  const leftOut = new Map<string, string>();
  const unmatched: string[] = [];
  for (const entry of ignored) {
    const row = rowNamed(entry);
    const found =
      row === null
        ? addCasesLeftOut(leftOut, report, declared, entry)
        : addRowsLeftOut(leftOut, declared, rowsIgnored, row);
    if (!found) {
      unmatched.push(entry);
    }
  }
  return { leftOut, unmatched };
}

/** Adds the rows the runner left out for one row entry to [param leftOut]. False when it left out none. */
function addRowsLeftOut(
  leftOut: Map<string, string>,
  declared: DeclaredSuites,
  rowsIgnored: ReadonlySet<string>,
  row: { suite: string; test: string; row: number },
): boolean {
  const rows = declaring(declared, row.suite, row.test).filter((one) =>
    rowsIgnored.has(`${one.path} > ${one.test}:${String(row.row)}`),
  );
  for (const one of rows) {
    leftOut.set(
      `${one.path}:${one.test}:${String(row.row)}`,
      `${suiteNameOf(one.path)}:${one.test}:${String(row.row)}`,
    );
  }
  return rows.length > 0;
}

/** Adds the cases one suite or case entry names that the report lacks to [param leftOut]. False when it names no declared case. */
function addCasesLeftOut(
  leftOut: Map<string, string>,
  report: TestReport,
  declared: DeclaredSuites,
  entry: string,
): boolean {
  const bare = entry.replace('res://', '');
  const at = bare.lastIndexOf(':');
  const suiteNamed = at === -1 ? bare : bare.slice(0, at);
  const testNamed = at === -1 ? null : bare.slice(at + 1);
  const named = declaring(declared, suiteNamed, testNamed);
  for (const { path, test } of named) {
    const reported = report.suites
      .filter((ran) => ran.path === path || (ran.path === null && ran.name === suiteNameOf(path)))
      .some((ran) => ran.cases.some((one) => isCaseOrRow(one.name, test)));
    if (!reported) {
      leftOut.set(`${path}:${test}`, `${suiteNameOf(path)}:${test}`);
    }
  }
  return named.length > 0;
}

/**
 * A frame of gdharness's own runner in a stack gdUnit4 wrote, with the line break before it. The
 * runner begins each case from a stage of its own, so that stage stands under every case's frames,
 * and gdUnit4 leaves out only its own. The runner is started by its full path, never a res:// one.
 */
const RUNNER_FRAME =
  /\r?\n[ \t]*at '[^']*' in (?!res:\/\/)[^\n]*\/godot\/tests\/listed\.gd:\d+[ \t]*(?=\r?\n|$)/g;

/**
 * A case with every report gdUnit4 wrote for it.
 *
 * gdUnit4 goes on past a failed assertion and writes one child per report, so a case can carry
 * several. Reading only the first dropped the rest: a case failing at two lines answered the first,
 * and one that failed assertions and then hit a runtime error answered the error alone, with no
 * failure counted, because gdUnit4 writes a case's error ahead of its failures. Measured on 4.7.2.
 * An error ends the case, so in the order the case met them its failures come first and the error
 * last, which is the order kept here. A case with an error is in error whatever failed before it.
 */
function caseOf(suite: XmlElement, element: XmlElement): TestCase {
  const of = (kind: CaseReport['kind']): CaseReport[] =>
    element.children
      .filter((child) => child.name === kind)
      .map((child) => {
        const detail = child.text.replace(RUNNER_FRAME, '').trim();
        const message = child.attributes['message'] ?? null;
        return {
          kind,
          message: kind === 'error' ? raisedAt(message, detail) : message,
          detail: detail === '' ? null : detail,
        };
      });
  const reports = [...of('failure'), ...of('error'), ...of('skipped')];
  const status: CaseStatus = reports.some((report) => report.kind === 'error')
    ? 'error'
    : reports.some((report) => report.kind === 'failure')
      ? 'failed'
      : reports.length > 0
        ? 'skipped'
        : 'passed';
  return {
    suite: suite.attributes['name'] ?? '',
    name: element.attributes['name'] ?? '',
    status,
    time: count(element.attributes, 'time'),
    message: reports[0]?.message ?? null,
    detail: reports[0]?.detail ?? null,
    reports,
  };
}

/**
 * [param message] placed at the frame that raised the error, the first `at` line of [param detail].
 * gdUnit4 names an error by the suite's path and the raising frame's line, so an error inside a
 * script the case called was put on an unrelated line of the suite: a division by zero at line 11
 * of calc.gd, called from line 15 of calc_test.gd, read `ERROR: res://test/calc_test.gd:11`.
 * Measured with gdUnit4 6.2.2.
 */
function raisedAt(message: string | null, detail: string): string | null {
  if (message === null) {
    return null;
  }
  const named = /^ERROR: \S+:\d+(?=\s|$)/.exec(message);
  const raised = /^\s*at '[^']*' in (\S+):(\d+)\s*$/m.exec(detail);
  if (named === null || raised === null) {
    return message;
  }
  return `ERROR: ${raised[1] ?? ''}:${raised[2] ?? ''}${message.slice(named[0].length)}`;
}

/** Whether [param entry] failed an assertion, which a case that then hit an error also did. */
function failedAnAssertion(entry: TestCase): boolean {
  return entry.reports.some((report) => report.kind === 'failure');
}

/** Where a suite's script is, when the report says: gdUnit4 writes the directory as `package`. */
function pathOf(suite: XmlElement): string | null {
  const directory = suite.attributes['package'];
  const name = suite.attributes['name'];
  if (!name || directory === undefined) {
    return null;
  }
  return directory === '' || directory === '.' ? `res://${name}.gd` : `res://${directory}/${name}.gd`;
}

/**
 * Every `testsuite` under [param element], at any depth and in document order. A case outside a
 * suite is refused, since reading around it would answer a run with fewer tests than it held.
 */
function suitesUnder(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  // A stack rather than recursion, so a deeply nested document cannot overflow the call stack.
  const pending: Array<{ element: XmlElement; inSuite: boolean }> = [{ element: root, inSuite: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.element.name === 'testcase' && !next.inSuite) {
      throw new MalformedReportError('A <testcase> outside any <testsuite>');
    }
    const isSuite = next.element.name === 'testsuite';
    if (isSuite) {
      found.push(next.element);
    }
    for (const child of next.element.children.toReversed()) {
      pending.push({ element: child, inSuite: next.inSuite || isSuite });
    }
  }
  return found;
}

export function parseJUnit(xml: string): TestReport {
  // An XML parser folds every line end to a line feed, and a report that passed through Windows tools
  // otherwise kept carriage returns inside the values the console is compared against.
  const document = parseXml(xml.replace(/\r\n?/g, '\n'));
  if (!document.children.some((child) => child.name === 'testsuites' || child.name === 'testsuite')) {
    throw new MalformedReportError('No <testsuites> or <testsuite> in the report');
  }
  const suiteElements = suitesUnder(document);
  // Sorted by where each suite is, because gdUnit4 runs and writes them in the order the directory
  // lists them, which is the file system's: one project gave the same suites in one order on
  // Windows and the other on Linux.
  const where = (suite: TestSuite): string => suite.path ?? suite.name;
  const suites = suiteElements.map((suite): TestSuite => {
    // Counted from the cases rather than read off the attributes, for the same reason the totals
    // below are. A suite's `tests` attribute is what it discovered. When gdUnit4 stops at a failing
    // case the cases after it are never written, so the attribute says nine while the body holds
    // two. Reporting the attribute as the count made one answer contradict itself, with the totals
    // saying two ran and the suite beside them saying nine tests and one failure, which reads as
    // eight passing tests that do not exist.
    const cases = suite.children
      .filter((child) => child.name === 'testcase')
      .map((element) => caseOf(suite, element));
    const failures = cases.filter(failedAnAssertion).length;
    const errors = cases.filter((entry) => entry.status === 'error').length;
    // What the suite's own counts are counts of: one per failed assertion, and gdUnit4 goes on past
    // a failed assertion, so a case failing two writes two. Measured on 4.7.2: a suite of one case
    // failing twice wrote failures="2", a failed before() beside a passing case failures="1", and
    // both together failures="3". Taken against failed cases, the second assertion was a hook.
    const written = (kind: string): number =>
      suite.children
        .filter((child) => child.name === 'testcase')
        .reduce((sum, element) => sum + element.children.filter((child) => child.name === kind).length, 0);
    return {
      name: suite.attributes['name'] ?? '',
      path: pathOf(suite),
      tests: cases.length,
      discovered: count(suite.attributes, 'tests'),
      failures,
      errors,
      // Measured with gdUnit4 on 4.7.2: a `before()` whose assertion failed left both cases passing
      // and wrote `failures="1"` on the suite alone, so a count taken from the cases said nothing
      // failed beside an exit code saying something had.
      hookFailures: Math.max(0, count(suite.attributes, 'failures') - written('failure')),
      hookErrors: Math.max(0, count(suite.attributes, 'errors') - written('error')),
      skipped: cases.filter((entry) => entry.status === 'skipped').length,
      time: count(suite.attributes, 'time'),
      cases,
    };
  });
  suites.sort((a, b) => (where(a) < where(b) ? -1 : where(a) > where(b) ? 1 : 0));
  // Counted from the cases rather than read off the top element: gdUnit4 leaves `errors` off
  // <testsuites> and writes `time` there as zero.
  const all = suites.flatMap((suite) => suite.cases);
  return {
    tests: all.length,
    failures: all.filter(failedAnAssertion).length,
    errors: all.filter((entry) => entry.status === 'error').length,
    hookFailures: suites.reduce((sum, suite) => sum + suite.hookFailures, 0),
    hookErrors: suites.reduce((sum, suite) => sum + suite.hookErrors, 0),
    skipped: all.filter((entry) => entry.status === 'skipped').length,
    time: suites.reduce((sum, suite) => sum + suite.time, 0),
    suites,
  };
}

/** A case the report holds as skipped, with the reason gdUnit4 wrote under it. */
interface SkippedInReport {
  /** The suite's script, or its name when the report names no folder. */
  readonly suite: string;
  readonly name: string;
  readonly reason: string;
}

// The reason gdUnit4 writes under the skip's heading, `  Reason: 'not today'`, which ends the entry.
// It runs to the entry's last quote, as it can hold line breaks and quotes of its own.
const REPORTED_REASON = /^\s*Reason: '([\s\S]*)'\s*$/m;

/** Every case [param report] holds as skipped. */
export function skippedInReport(report: TestReport): SkippedInReport[] {
  return report.suites.flatMap((suite) =>
    suite.cases
      .filter((entry) => entry.status === 'skipped')
      .map((entry) => ({
        suite: suite.path ?? suite.name,
        name: entry.name,
        reason: REPORTED_REASON.exec(entry.detail ?? '')?.[1] ?? entry.message ?? 'no reason given',
      })),
  );
}

/** A hook's failure as the runner printed it, which is the only place its message is. */
interface HookFailure {
  /** The hook, `before` or `after`. */
  readonly hook: string;
  /** The suite's script. */
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

// Printed under the suite's `finalize()` report, the location after a tab on the message's last
// line once colours are off: `  Expecting: 'true' but is 'false'	at 'before' in res://test/hooked_test.gd:5`.
const HOOK_LOCATION = "\tat '";
// Matched on the text after the tab. A pattern opening on a lazy message and white space tries every
// split of a long run of blanks, which took seconds on a padded line.
const HOOK_FAILURE = /^at '(before|after)' in (res:\/\/.+?):(\d+)\s*$/;
const REPORT_HEADING = /\bfinalize\(\)\s+Report:\s*$/;
const REPORT_END = /^\s*Statistics:/;

/**
 * Every hook failure [param printed] names, in the order printed.
 *
 * An assertion's message can run over several lines, as `assert_int`'s does (`Expecting:`, the
 * value, `but was`, the value), so a message is every line since the report's heading or the hook
 * before it: read from its last line alone, a hook expecting 4 that met 3 was reported as "3".
 */
export function hookFailuresPrinted(printed: Iterable<string>): HookFailure[] {
  return foldedOver(new HookFailuresRead(), printed);
}

/** {@link hookFailuresPrinted}, a line at a time. */
export class HookFailuresRead implements LineFold<HookFailure[]> {
  private readonly found: HookFailure[] = [];
  private above: string[] | null = null;

  take(line: string): void {
    if (REPORT_HEADING.test(line)) {
      this.above = [];
      return;
    }
    if (REPORT_END.test(line)) {
      this.above = null;
      return;
    }
    const tab = line.lastIndexOf(HOOK_LOCATION);
    const found = tab === -1 ? null : HOOK_FAILURE.exec(line.slice(tab + 1));
    if (found === null) {
      this.above?.push(owned(line.trim()));
      return;
    }
    const message = [...(this.above ?? []), line.slice(0, tab).trim()]
      .filter((part) => part !== '')
      .join(' ');
    this.above = [];
    this.found.push({ hook: found[1] ?? '', path: found[2] ?? '', line: Number(found[3]), message });
  }

  result(): HookFailure[] {
    return [...this.found];
  }
}

/** What gdUnit4 prints when it was pointed at something, and there was nothing there to run. */
const NOTHING_RAN = /no test cases found/i;
// To the end of the line, since a directory can have a space in its name: `(\S+)` answered
// `res://my` for `res://my tests`.
const NO_SUCH_PATH = /given directory or file does not exists:\s*(.+?)\s*$/i;

/**
 * Why a run wrote no report, as a verdict, or nothing when the printed output does not say.
 *
 * gdUnit4 exits 0 when it found nothing to run, so a path typo, a renamed suite directory and an
 * ignore list that excluded everything all arrive as a clean exit and read as `passed`. That is
 * the one verdict in this program where being wrong costs the most: an agent skimming a long
 * answer takes the word, and a tier that never ran looks like a tier that is green. The exit code
 * cannot tell those apart, and the runner's own two lines can.
 *
 * [param asked] is the path the run was pointed at, which the answer names because a run that
 * found nothing is nearly always a run that looked in the wrong place.
 */
export function whyNoReport(printed: Iterable<string>, asked: string): string | null {
  return foldedOver(new NoReportRead(), printed)(asked);
}

/** {@link whyNoReport}, a line at a time, given the path asked for once the lines are read. */
export class NoReportRead implements LineFold<(asked: string) => string | null> {
  private missing: string | null | undefined;
  private nothingRan = false;

  take(line: string): void {
    if (this.missing === undefined) {
      const found = NO_SUCH_PATH.exec(line);
      if (found !== null) {
        this.missing = found[1] === undefined ? null : owned(found[1]);
      }
    }
    this.nothingRan ||= NOTHING_RAN.test(line);
  }

  result(): (asked: string) => string | null {
    const { missing, nothingRan } = this;
    return (asked) => {
      if (missing !== undefined) {
        return `nothing at ${missing ?? asked}`;
      }
      return nothingRan ? `no test cases found at ${asked}` : null;
    };
  }
}

/** One error in a script gdUnit4 could not load while looking for suites. */
export interface ScriptError {
  readonly path: string;
  /** Null where the engine printed line 0, which it does for an error that belongs to no line. */
  readonly line: number | null;
  readonly message: string;
}

const DISCOVERY_FAILED = 'Script errors were detected during test discovery!';

/**
 * The script errors gdUnit4 met while looking for suites, read off what it printed.
 *
 * One suite that does not load stops the whole run before its first case: gdUnit4 exits 105,
 * writes no report and runs none of the suites that did load. What it prints is the line above,
 * then each error as its message and an `at` line naming the script and line.
 */
export function scriptErrorsPrinted(printed: Iterable<string>): ScriptError[] {
  return discoveryListing(printed)?.errors ?? [];
}

/** Where gdUnit4 listed the scripts it could not load, and the errors read off the list. */
export interface DiscoveryListing {
  readonly errors: ScriptError[];
  readonly from: number;
  readonly to: number;
}

/**
 * Where in [param printed] gdUnit4 listed the scripts it could not load, from its heading to the
 * last line of the list, with the errors read off it. Null when it listed none.
 */
export function discoveryListing(printed: Iterable<string>): DiscoveryListing | null {
  return foldedOver(new DiscoveryRead(), printed);
}

/** {@link discoveryListing}, a line at a time. */
export class DiscoveryRead implements LineFold<DiscoveryListing | null> {
  private readonly found: ScriptError[] = [];
  private message: string | null = null;
  private at = 0;
  private from = -1;
  private to = -1;
  private done = false;

  /** Whether the line last taken is part of the list. */
  get listed(): boolean {
    return this.from >= 0 && this.at - 1 < this.to;
  }

  take(line: string): void {
    const at = this.at;
    this.at += 1;
    if (this.done) {
      return;
    }
    if (this.from < 0) {
      if (line.includes(DISCOVERY_FAILED)) {
        this.from = at;
        this.to = at + 1;
      }
      return;
    }
    const located = /^\s*at (res:\/\/.+):(\d+)\s*$/.exec(line);
    if (located !== null && this.message !== null) {
      this.found.push({
        path: owned(located[1] ?? ''),
        line: Number(located[2]) === 0 ? null : Number(located[2]),
        message: this.message,
      });
      this.message = null;
    } else if (located === null && this.message === null && /^ {2}\S/.test(line)) {
      this.message = owned(line.trim());
    } else {
      this.done = true;
      return;
    }
    this.to += 1;
  }

  result(): DiscoveryListing | null {
    if (this.from < 0) {
      return null;
    }
    // gdUnit4 lists them in the order the filesystem hands it the directory, which Linux and
    // Windows disagree about, so the same project named its broken scripts in two orders.
    const errors = this.found.toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0),
    );
    return { errors, from: this.from, to: this.to };
  }
}

/** A report standing for every identical one in its case, with how many there were when several. */
type FoldedReport = CaseReport & { readonly times?: number };

/** A failed case as the answer names it: its first report, and its reports when it has several. */
interface FailedCase {
  readonly suite: string;
  readonly name: string;
  readonly status: CaseStatus;
  readonly time: number;
  readonly path: string | null;
  readonly message: string | null;
  readonly detail: string | null;
  /** Identical ones folded into the first, and at most {@link MOST_REPORTS_SHOWN} of the rest. */
  readonly reports?: readonly FoldedReport[];
  /** How many reports the case made, when that is more than one. */
  readonly reportCount?: number;
  /** How many different reports are not in [member reports], past the ones shown. */
  readonly reportsLeftOut?: number;
}

/**
 * The most different reports one failing case answers with.
 *
 * A case calling into a class that no longer compiled raised the same runtime error on every pass
 * of its loop: one case carried 2,062 reports, the same four errors about five hundred times each,
 * and a run of 125 such cases answered 18 MB on one line, which Claude Code refuses past 16 MB by
 * closing the connection, and the call and every later tool go with it. Folding takes such a case
 * to four. This bounds one whose reports all differ.
 */
export const MOST_REPORTS_SHOWN = 20;

/** The most characters of one report's detail an answer carries. The rest are counted. */
export const LONGEST_DETAIL = 20_000;

/** The first [param length] code units of [param text], without half of a surrogate pair at the end. */
function wholeCharacters(text: string, length: number): string {
  const cut = text.slice(0, length);
  return cut.isWellFormed() ? cut : cut.slice(0, -1);
}

function shortened(detail: string | null): string | null {
  if (detail === null || detail.length <= LONGEST_DETAIL) {
    return detail;
  }
  return `${wholeCharacters(detail, LONGEST_DETAIL)}\n[${detail.length - LONGEST_DETAIL} more characters left out]`;
}

/** [param reports] with identical ones folded into the first, which says how many there were. */
function foldedReports(reports: readonly CaseReport[]): FoldedReport[] {
  const first = new Map<string, { report: CaseReport; times: number }>();
  for (const report of reports) {
    const key = JSON.stringify([report.kind, report.message, report.detail]);
    const seen = first.get(key);
    if (seen === undefined) {
      first.set(key, { report, times: 1 });
    } else {
      seen.times += 1;
    }
  }
  return [...first.values()].map(({ report, times }) => {
    const kept = { ...report, detail: shortened(report.detail) };
    return times === 1 ? kept : { ...kept, times };
  });
}

/** Every case in [param report] that failed or hit an error, with its reports as gdUnit4 wrote them. */
export function failedCases(report: TestReport): FailedCase[] {
  return report.suites.flatMap((suite) =>
    suite.cases
      .filter((entry) => entry.status === 'failed' || entry.status === 'error')
      .map((entry) => {
        const folded = foldedReports(entry.reports);
        const shown = folded.slice(0, MOST_REPORTS_SHOWN);
        return {
          suite: entry.suite,
          name: entry.name,
          status: entry.status,
          time: entry.time,
          path: suite.path,
          message: entry.reports[0]?.message ?? null,
          detail: shortened(entry.reports[0]?.detail ?? null),
          ...(entry.reports.length > 1 ? { reports: shown, reportCount: entry.reports.length } : {}),
          ...(folded.length > shown.length ? { reportsLeftOut: folded.length - shown.length } : {}),
        };
      }),
  );
}

/**
 * [param failed] held to about [param budget] characters of JSON: every case still named, with its
 * first message, and the detail and reports of the largest cases left out and counted. A run whose
 * every case fails on one broken class is the run whose answer matters most, and it is the one that
 * outgrew the client.
 *
 * The smallest cases are kept whole first, so one case printing thousands of different lines costs
 * its own detail rather than everyone's, and which cases keep theirs does not depend on the order
 * gdUnit4 ran the suites in, which differs between platforms.
 */
export function failedWithin(
  failed: readonly FailedCase[],
  budget: number,
): { readonly failed: readonly FailedCase[]; readonly briefed: number } {
  const sizes = failed.map((entry) => JSON.stringify(entry).length);
  const smallestFirst = sizes.map((_, index) => index).toSorted((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
  const whole = new Set<number>();
  let spent = 0;
  for (const index of smallestFirst) {
    const size = sizes[index] ?? 0;
    if (spent + size > budget) {
      break;
    }
    spent += size;
    whole.add(index);
  }
  const kept = failed.map((entry, index) => {
    if (whole.has(index)) {
      return entry;
    }
    const { detail: _detail, reports: _reports, reportsLeftOut: _left, ...named } = entry;
    return {
      ...named,
      message: entry.message === null ? null : wholeCharacters(entry.message, 500),
      detail: null,
    };
  });
  return { failed: kept, briefed: failed.length - whole.size };
}

/** The orphans one case or a suite's hooks left, as the runner named them. */
export interface OrphansLeft {
  readonly suite: string;
  /**
   * The case, as gdUnit4 names it on its verdict line, or the hook: `before` or `after`, and
   * `before or after` in a suite whose cases never began, where the two cannot be told apart.
   */
  readonly during: string;
  readonly count: number;
  /** Each node's class, its name and its script, as `Node "Sandbox" of res://sandbox.gd`. */
  readonly nodes: string;
}

// Printed by the runner in src/godot/tests/listed.gd, ORPHANS_LEFT there.
const ORPHANS_LEFT = /^gdharness orphans: (res:\/\/.+?\.(?:gd|cs)) > (.+?) left (\d+): (.+?)\s*$/;

/** The orphans [param line] names, when it is the runner's line naming them. */
export function orphansLeftOn(line: string): OrphansLeft | null {
  const named = ORPHANS_LEFT.exec(line);
  if (named === null) {
    return null;
  }
  return { suite: named[1] ?? '', during: named[2] ?? '', count: Number(named[3]), nodes: named[4] ?? '' };
}

const HOOKS_LEFT = new Map([
  ['before', 'before()'],
  ['after', 'after()'],
  ['before or after', 'before() or after()'],
]);

/** The sentences naming what [param left] left behind and what frees it. */
export function orphansLeftSaid(left: OrphansLeft): string {
  const nodes = left.count === 1 ? '1 node' : `${String(left.count)} nodes`;
  const hook = HOOKS_LEFT.get(left.during);
  const where = hook === undefined ? `${left.suite} > ${left.during}` : `${left.suite}'s ${hook}`;
  return `${where} left ${nodes} neither freed nor in the tree, which gdUnit4 counts as orphans: ${left.nodes}. Free each one, or make it with auto_free(), which frees it once the ${hook === undefined ? 'case' : 'suite'} is over.`;
}

/** One suite that finished with nodes neither freed nor in the tree, and how many. */
interface SuiteOrphans {
  /** The suite's script, as gdUnit4 names it on the line announcing the run. */
  readonly path: string;
  readonly orphans: number;
  /** Each case or hook that left some, with the nodes, where the runner named them. */
  readonly left: readonly OrphansLeft[];
}

/** What a run left behind, counted per suite and in total. */
interface OrphanReport {
  readonly total: number;
  readonly suites: readonly SuiteOrphans[];
}

// Hung on the bar before the count, since a count with nothing before it is tried from every digit
// of a long number. It also keeps out a line the game prints itself, such as "took in 12 orphans".
const ORPHANS = /\|\s*(\d+)\s+orphans/;
const OVERALL = 'Overall Summary';

/**
 * The orphan nodes a run reported, read off what it printed.
 *
 * Read from the console because it is the only place they are. gdUnit4 counts orphans per suite
 * and decides the run's state from them: no errors and no failures, but nodes neither freed nor in the tree,
 * is the WARNING state, which is exit 101. Its JUnit writer does not carry any of that: an ORPHAN
 * report produces no element at all, and neither `testsuite` nor `testsuites` gets an attribute
 * for it, so a report parsed from the XML has every count at zero and nothing to explain the
 * verdict with. A project met exactly that: `warnings`, exit 101, `failures` 0, `failed` empty,
 * `engineWarnings` 0, and no way to find out but to change a suite and run the tier again.
 *
 * The two lines it does print are `Run Test Suite: <path>` when a suite starts and a statistics
 * line ending each one, with the totals repeated under `Overall Summary`. Matched loosely, on the
 * count and the word, because the runner writes them with colour and cursor moves around them.
 */
export function orphansPrinted(printed: Iterable<string>): OrphanReport {
  return foldedOver(new OrphansRead(), printed);
}

/** {@link orphansPrinted}, a line at a time. */
export class OrphansRead implements LineFold<OrphanReport> {
  private readonly suites: SuiteOrphans[] = [];
  private total: number | null = null;
  private running: string | null = null;
  private readonly named = new Map<string, OrphansLeft[]>();

  take(line: string): void {
    const left = orphansLeftOn(line);
    if (left !== null) {
      const known = this.named.get(left.suite);
      if (known === undefined) {
        this.named.set(left.suite, [left]);
      } else {
        known.push(left);
      }
      return;
    }
    const started = suiteOpenedBy(line);
    if (started !== null) {
      this.running = owned(started);
      return;
    }
    const counted = ORPHANS.exec(line);
    if (counted?.[1] === undefined) {
      return;
    }
    const orphans = Number(counted[1]);
    if (line.includes(OVERALL)) {
      this.total = orphans;
      this.running = null;
      return;
    }
    if (this.running !== null && orphans > 0) {
      this.suites.push({ path: this.running, orphans, left: [] });
    }
    // Whether it counted any or not: the suite's statistics line is the end of its block, and the
    // next count belongs to whatever runs next rather than to this one.
    this.running = null;
  }

  result(): OrphanReport {
    const { suites, named } = this;
    return {
      // Summed as a fallback, so a summary line this stops recognising costs the total and not the
      // per-suite rows, which are the part worth having.
      total: this.total ?? suites.reduce((sum, suite) => sum + suite.orphans, 0),
      suites: suites.map((suite) => ({ ...suite, left: named.get(suite.path) ?? [] })),
    };
  }
}

/** One suite the run finished, as its statistics line counted it, and the cases that did not pass. */
interface SuiteFinished {
  readonly path: string;
  readonly cases: number;
  readonly errors: number;
  readonly failures: number;
  /** The names of its cases that failed or errored, as gdUnit4 printed them. */
  readonly failed: readonly string[];
}

// The lookbehind keeps a long number from being tried from each of its digits.
const SUITE_COUNTS = /(?<!\d)(\d+)\s+test cases\s*\|\s*(\d+)\s+errors\s*\|\s*(\d+)\s+failures/;

/** Whether [param line] is the statistics line gdUnit4 prints as a suite ends. */
export function finishesASuite(line: string): boolean {
  return SUITE_COUNTS.test(line) && !line.includes(OVERALL);
}

/**
 * The suites a run has finished so far, and the one it is in, read off what it printed.
 *
 * The report is written once, at the end, so a run that is cut off has none, and what it finished
 * exists only on the console: a tier of 110 suites ended by the client's idle limit after thirty
 * minutes answered nothing of the suites that had run. Read as it goes as well, for the progress a
 * long run reports.
 */
export function suitesPrinted(printed: Iterable<string>): SuitesPrinted {
  return foldedOver(new SuitesRead(), printed);
}

/** The suites a run finished, and the one it is in. */
export interface SuitesPrinted {
  finished: SuiteFinished[];
  running: string | null;
}

/** {@link suitesPrinted}, a line at a time. */
export class SuitesRead implements LineFold<SuitesPrinted> {
  private finished: SuiteFinished[] = [];
  private running: string | null = null;
  private failed: string[] = [];

  take(line: string): void {
    const started = suiteOpenedBy(line);
    if (started !== null) {
      this.running = owned(started);
      this.failed = [];
      return;
    }
    if (this.running === null) {
      return;
    }
    const ended = caseLineOf(line);
    if (ended?.verdict === 'FAILED') {
      this.failed.push(owned(ended.name));
      return;
    }
    const counted = finishesASuite(line) ? SUITE_COUNTS.exec(line) : null;
    if (counted !== null) {
      this.finished.push({
        path: this.running,
        cases: Number(counted[1]),
        errors: Number(counted[2]),
        failures: Number(counted[3]),
        failed: this.failed,
      });
      this.running = null;
    }
  }

  result(): SuitesPrinted {
    return { finished: [...this.finished], running: this.running };
  }

  /** A reading that goes on from where this one is, leaving this one as it is. */
  copy(): SuitesRead {
    const copy = new SuitesRead();
    copy.finished = [...this.finished];
    copy.running = this.running;
    copy.failed = [...this.failed];
    return copy;
  }
}

/** The progress message for a run [param elapsedMs] in, from what [param printed] says so far. */
export function testProgressMessage(printed: Iterable<string> | SuitesPrinted, elapsedMs: number): string {
  const { finished, running } = Symbol.iterator in printed ? suitesPrinted(printed) : printed;
  const failing = finished.filter((suite) => suite.errors + suite.failures > 0).length;
  const seconds = Math.floor(elapsedMs / 1000);
  const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const done =
    finished.length === 0
      ? 'No suite has finished'
      : `${finished.length === 1 ? 'One suite has' : `${finished.length} suites have`} finished${failing === 0 ? '' : `, ${failing} with failures`}`;
  return `${done}${running === null ? '' : `, running ${running}`}, ${took} in.`;
}
