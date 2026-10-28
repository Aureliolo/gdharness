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
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
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

/** The elements of a document, as a tree under one synthetic root. */
function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '', attributes: {}, children: [], text: '' };
  const open: XmlElement[] = [root];
  let at = 0;

  const current = (): XmlElement => {
    const element = open.at(-1);
    if (element === undefined) {
      throw new MalformedReportError('A close tag with nothing open');
    }
    return element;
  };

  while (at < source.length) {
    const next = source.indexOf('<', at);
    if (next === -1) {
      current().text += decoded(source.slice(at));
      break;
    }
    current().text += decoded(source.slice(at, next));
    at = next;

    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at);
      if (end === -1) {
        throw new MalformedReportError('CDATA that never ends');
      }
      current().text += source.slice(at + '<![CDATA['.length, end);
      at = end + ']]>'.length;
      continue;
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at);
      if (end === -1) {
        throw new MalformedReportError('A comment that never ends');
      }
      at = end + '-->'.length;
      continue;
    }
    if (source.startsWith('<?', at) || source.startsWith('<!', at)) {
      const end = source.indexOf('>', at);
      if (end === -1) {
        throw new MalformedReportError('A declaration that never ends');
      }
      at = end + 1;
      continue;
    }

    const end = tagEnd(source, at);
    if (end === -1) {
      throw new MalformedReportError('A tag that never ends');
    }
    const tag = source.slice(at + 1, end);
    at = end + 1;

    if (tag.startsWith('/')) {
      const closing = tag.slice(1).trim();
      const element = current();
      if (element === root || element.name !== closing) {
        throw new MalformedReportError(`</${closing}> closes <${element.name || 'nothing'}>`);
      }
      open.pop();
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch?.[1]) {
      throw new MalformedReportError(`A tag with no name: <${tag}>`);
    }
    // A sticky regex resets its own position to zero on a miss, so the position is kept here.
    const attributes: Record<string, string> = {};
    let read = nameMatch[0].length;
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

    const element: XmlElement = { name: nameMatch[1], attributes, children: [], text: '' };
    current().children.push(element);
    if (!selfClosing) {
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
  const value = Number(attributes[name] ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/** An entry of a run's ignore list that named a case the run went on to run. */
export interface IgnoreNotApplied {
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
 * read afterwards, since a skipped case is simply absent; a case that ran under a name an entry gave
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
      const ran = suiteMatches ? suite.cases.find((one) => one.name === testNamed) : undefined;
      if (ran !== undefined) {
        found.push({ entry, ran: `${suite.name}:${ran.name}` });
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
  const named = /^(.+):([A-Za-z_]\w*):(\d+)(?:\s.*)?$/.exec(entry.replace('res://', ''));
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
export function rowsIgnoredIn(printed: readonly string[]): Set<string> {
  return new Set(printed.flatMap((line) => IGNORED_ROW_LINE.exec(line)?.[1] ?? []));
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
  const leftOut = new Set<string>();
  const unmatched: string[] = [];
  for (const entry of ignored) {
    const row = rowNamed(entry);
    if (row !== null) {
      const rows = declaring(declared, row.suite, row.test).filter((one) =>
        rowsIgnored.has(`${one.path} > ${one.test}:${String(row.row)}`),
      );
      if (rows.length === 0) {
        unmatched.push(entry);
      }
      for (const one of rows) {
        leftOut.add(`${suiteNameOf(one.path)}:${one.test}:${String(row.row)}`);
      }
      continue;
    }
    const bare = entry.replace('res://', '');
    const at = bare.lastIndexOf(':');
    const suiteNamed = at === -1 ? bare : bare.slice(0, at);
    const testNamed = at === -1 ? null : bare.slice(at + 1);
    const named = declaring(declared, suiteNamed, testNamed);
    if (named.length === 0) {
      unmatched.push(entry);
      continue;
    }
    for (const { path, test } of named) {
      const reported = report.suites
        .filter((ran) => ran.path === path || (ran.path === null && ran.name === suiteNameOf(path)))
        .some((ran) =>
          ran.cases.some((one) => one.name === test || new RegExp(`^${test}\\W`).test(one.name)),
        );
      if (!reported) {
        leftOut.add(`${suiteNameOf(path)}:${test}`);
      }
    }
  }
  return { leftOut: [...leftOut].sort(), unmatched };
}

/**
 * A case with every report gdUnit4 wrote for it.
 *
 * gdUnit4 goes on past a failed assertion and writes one child per report, so a case can carry
 * several. Reading only the first dropped the rest: a case failing at two lines answered the first,
 * and one that failed assertions and then hit a runtime error answered the error alone, with no
 * failure counted, because gdUnit4 writes a case's error ahead of its failures. Measured on 4.7.2.
 * An error ends the case, so in the order the case met them its failures come first and the error
 * last, which is the order kept here; a case with an error is in error whatever failed before it.
 */
function caseOf(suite: XmlElement, element: XmlElement): TestCase {
  const of = (kind: CaseReport['kind']): CaseReport[] =>
    element.children
      .filter((child) => child.name === kind)
      .map((child) => {
        const detail = child.text.trim();
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
  return directory && name ? `res://${directory}/${name}.gd` : null;
}

export function parseJUnit(xml: string): TestReport {
  const document = parseXml(xml);
  const top = document.children.find((child) => child.name === 'testsuites' || child.name === 'testsuite');
  if (top === undefined) {
    throw new MalformedReportError('No <testsuites> or <testsuite> in the report');
  }
  const suiteElements =
    top.name === 'testsuite' ? [top] : top.children.filter((child) => child.name === 'testsuite');
  // Sorted by where each suite is, because gdUnit4 runs and writes them in the order the directory
  // lists them, which is the file system's: one project gave the same suites in one order on
  // Windows and the other on Linux.
  const where = (suite: TestSuite): string => suite.path ?? suite.name;
  const suites = suiteElements.map((suite): TestSuite => {
    // Counted from the cases rather than read off the attributes, for the same reason the totals
    // below are. A suite's `tests` attribute is what it discovered; when gdUnit4 stops at a failing
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

/** A hook's failure as the runner printed it, which is the only place its message is. */
export interface HookFailure {
  /** The hook, `before` or `after`. */
  readonly hook: string;
  /** The suite's script. */
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

// Printed under the suite's `finalize()` report, the location after a tab on the message's last
// line once colours are off: `  Expecting: 'true' but is 'false'	at 'before' in res://test/hooked_test.gd:5`.
const HOOK_FAILURE = /^\s*(.*?)\s*\tat '(before|after)' in (res:\/\/.+?):(\d+)\s*$/;
const REPORT_HEADING = /\bfinalize\(\)\s+Report:\s*$/;
const REPORT_END = /^\s*Statistics:/;

/**
 * Every hook failure [param printed] names, in the order printed.
 *
 * An assertion's message can run over several lines, as `assert_int`'s does (`Expecting:`, the
 * value, `but was`, the value), so a message is every line since the report's heading or the hook
 * before it: read from its last line alone, a hook expecting 4 that met 3 was reported as "3".
 */
export function hookFailuresPrinted(printed: readonly string[]): HookFailure[] {
  let above: string[] | null = null;
  return printed.flatMap((line) => {
    if (REPORT_HEADING.test(line)) {
      above = [];
      return [];
    }
    if (REPORT_END.test(line)) {
      above = null;
      return [];
    }
    const found = HOOK_FAILURE.exec(line);
    if (found === null) {
      above?.push(line.trim());
      return [];
    }
    const message = [...(above ?? []), found[1] ?? ''].filter((part) => part !== '').join(' ');
    above = [];
    return [{ hook: found[2] ?? '', path: found[3] ?? '', line: Number(found[4]), message }];
  });
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
export function whyNoReport(printed: readonly string[], asked: string): string | null {
  const missing = printed.map((line) => NO_SUCH_PATH.exec(line)).find((found) => found !== null);
  if (missing !== undefined) {
    return `nothing at ${missing[1] ?? asked}`;
  }
  return printed.some((line) => NOTHING_RAN.test(line)) ? `no test cases found at ${asked}` : null;
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
export function scriptErrorsPrinted(printed: readonly string[]): ScriptError[] {
  return discoveryListing(printed)?.errors ?? [];
}

/**
 * Where in [param printed] gdUnit4 listed the scripts it could not load, from its heading to the
 * last line of the list, with the errors read off it; null when it listed none.
 */
export function discoveryListing(
  printed: readonly string[],
): { readonly errors: ScriptError[]; readonly from: number; readonly to: number } | null {
  const start = printed.findIndex((line) => line.includes(DISCOVERY_FAILED));
  if (start < 0) {
    return null;
  }
  const found: ScriptError[] = [];
  let message: string | null = null;
  let to = start + 1;
  for (const line of printed.slice(start + 1)) {
    const at = /^\s*at (res:\/\/.+):(\d+)\s*$/.exec(line);
    if (at !== null && message !== null) {
      found.push({ path: at[1] ?? '', line: Number(at[2]) === 0 ? null : Number(at[2]), message });
      message = null;
    } else if (at === null && message === null && /^ {2}\S/.test(line)) {
      message = line.trim();
    } else {
      break;
    }
    to += 1;
  }
  // gdUnit4 lists them in the order the filesystem hands it the directory, which Linux and
  // Windows disagree about, so the same project named its broken scripts in two orders.
  const errors = found.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0),
  );
  return { errors, from: start, to };
}

const ESCAPE = String.fromCharCode(0x1b);

const LOCATION = `'[^'\\n]*' in \\S+:\\d+`;
const IGNORING_CASE = ' \\(ignoring case\\)';

/**
 * A failing value the runner printed as a character diff, with the assertion it belongs to: the
 * value a string equality found, between " but was" and the location line that follows it.
 *
 * The value may not run over a location line, which ends every case's report, so the match stays
 * inside one. An array equality prints its value, then a table of differences, then its location,
 * so a value matched lazily up to the next quote before a location line ran through the table and
 * on to the end of the next case's string diff, and read the two as one.
 *
 * `is_equal_ignoring_case` writes " (ignoring case)" after the closing quote, so a match that
 * wanted the location straight after the quote never ended on one, and its merge stood.
 */
const PRINTED_ACTUAL = new RegExp(
  ` but was\\n '((?:(?!\\tat ${LOCATION})[\\s\\S])*?)'((?:${ESCAPE}\\[[0-9;]*m)*)(${IGNORING_CASE})?((?:${ESCAPE}\\[[0-9;]*m)*)\\tat (${LOCATION})`,
  'g',
);

/**
 * A failing equality between two quoted values as the report writes it, a string's being a merged
 * diff; the error-message form is `assert_failure`'s `has_message` and its siblings.
 */
const QUOTED_EQUALITY = new RegExp(
  `^Expecting(?: error message)?:\\n '([\\s\\S]*)'\\n but was\\n '([\\s\\S]*)'(?:${IGNORING_CASE})?\\n\\tat `,
);
const COLOUR = new RegExp(`${ESCAPE}\\[([0-9;]*)m`, 'g');

/** How gdUnit4 spells a character it marks, read back into the character. */
const SPELLED: Readonly<Record<string, string>> = {
  '<LF>': '\n',
  '<CR>': '\r',
  '<TAB>': '\t',
  '<BS>': '\b',
  '<FF>': '\f',
  '<VT>': '\v',
  '<BEL>': '\u0007',
  '<ESC>': ESCAPE,
  '<DEL>': '\u007f',
};

function unspelled(text: string): string {
  return text.replace(/<(?:LF|CR|TAB|BS|FF|VT|BEL|ESC|DEL|0x[0-9A-F]{2})>/g, (spelling) =>
    spelling.startsWith('<0x')
      ? String.fromCharCode(Number.parseInt(spelling.slice(3, 5), 16))
      : (SPELLED[spelling] ?? spelling),
  );
}

/**
 * [param printed] read as gdUnit4's character diff: `merged` is what the report keeps once the
 * marks are gone, and `actual` is the value the assertion found.
 *
 * A character on a red background is one the value lacked and one on green is one it had in
 * addition, told apart by which channel is the larger; the rest were in both. A marked character
 * that does not print, such as a line feed, is spelled out as "<LF>".
 */
function readDiff(printed: string): { merged: string; actual: string } {
  let merged = '';
  let actual = '';
  let background: 'missing' | 'added' | null = null;
  let last = 0;
  const take = (text: string): void => {
    merged += text;
    if (background === null) {
      actual += text;
    } else if (background === 'added') {
      actual += unspelled(text);
    }
  };
  for (const match of printed.matchAll(COLOUR)) {
    take(printed.slice(last, match.index));
    last = match.index + match[0].length;
    const codes = (match[1] ?? '').split(';');
    if (codes[0] === '48' && codes[1] === '2') {
      background = Number(codes[2]) > Number(codes[3]) ? 'missing' : 'added';
    } else if (codes[0] === '0' || codes[0] === '') {
      background = null;
    }
  }
  take(printed.slice(last));
  return { merged, actual };
}

/** The sentence a detail carries when both sides printed alike and nothing could say which was which. */
export const BOTH_SIDES_ALIKE_NOTE =
  '[gdharness: the expected and the actual printed alike because gdUnit4 drops the marks that tell them apart when it writes its report, and the runner printed no copy of this one, so neither side above is the value the assertion found.]';

/** The sentence a string equality's detail carries when the console had no copy of its diff to read the value from. */
export const VALUE_NOT_RECOVERED_NOTE =
  '[gdharness: the value after "but was" may not be the one the assertion found. gdUnit4 writes a failing string into its report as a character diff against the expected one with the marks dropped, which merges the two, and the runner printed no copy of this one to read the value back from.]';

/**
 * The sentence a detail carries when its value was read back and the two sides still print alike.
 * gdUnit4 passes the expected string through its BBCode renderer, so "[b]plain[/b]" against "plain"
 * printed "plain" on both sides, with the tags gone into terminal bold.
 */
export const RENDERED_AWAY_NOTE =
  '[gdharness: the two sides print alike, so what tells them apart is something gdUnit4 does not print. The usual cause is BBCode in the expected string, which gdUnit4 renders as formatting instead of showing; the value after "but was" is the one the assertion found.]';

/**
 * [param failed] with each failing string equality's actual value put back, read off [param
 * printed], which is what the runner wrote to its console with the colours left in.
 *
 * gdUnit4 prints a failing string's value as a character diff against the expected one, marked
 * with background colours, and strips the marks when it writes the JUnit report: what is left is
 * both strings merged, so an empty value reads as the expected string in full, and "abXd" against
 * "abcd" reads "abcXd". The console keeps the marks. A detail the console has no copy of says its
 * value may be the merge, and one whose sides still read alike says why, rather than letting
 * either side stand as the value. A string gdUnit4 masked because it held BBCode is unmasked.
 */
export function withActualsPrinted<Case extends { readonly detail: string | null }>(
  failed: readonly Case[],
  printed: string,
): Case[] {
  // A line break reaches a pipe as CRLF on Windows, and the report is written with every carriage
  // return taken out, so the two are compared the way the report spells them.
  const diffs = [...printed.replaceAll('\r\n', '\n').matchAll(PRINTED_ACTUAL)].map((match) => ({
    suffix: match[3] ?? '',
    at: match[5] ?? '',
    ...readDiff(match[1] ?? ''),
  }));
  // Each printed diff belongs to one failure, and both are in the order the run met them. The same
  // assertion line failing twice merges alike when the values differ only where the marks were, so
  // a diff offered to every failure it matched gave both the first one's value.
  const used = new Set<number>();
  return failed.map((entry) => {
    if (entry.detail === null) {
      return entry;
    }
    let detail = entry.detail;
    let recovered = false;
    for (const [index, diff] of diffs.entries()) {
      if (used.has(index)) {
        continue;
      }
      const wrong = ` but was\n '${diff.merged.replaceAll('\r', '')}'${diff.suffix}\n\tat ${diff.at}`;
      if (detail.includes(wrong)) {
        detail = detail.replace(wrong, () => ` but was\n '${diff.actual}'${diff.suffix}\n\tat ${diff.at}`);
        recovered = true;
        used.add(index);
      }
    }
    const quoted = QUOTED_EQUALITY.exec(detail);
    if (quoted !== null) {
      const alike = quoted[1] === quoted[2];
      const note = recovered
        ? alike
          ? RENDERED_AWAY_NOTE
          : null
        : alike
          ? BOTH_SIDES_ALIKE_NOTE
          : VALUE_NOT_RECOVERED_NOTE;
      detail = note === null ? detail : `${detail}\n${note}`;
    }
    if (quoted !== null && masked(quoted[1] ?? '', quoted[2] ?? '')) {
      const end = quoted[0].length - '\n\tat '.length;
      detail = detail.slice(0, end).replaceAll(MASKED_BRACKET, '[') + detail.slice(end);
    }
    return detail === entry.detail ? entry : { ...entry, detail };
  });
}

/** A report standing for every identical one in its case, with how many there were when several. */
type FoldedReport = CaseReport & { readonly times?: number };

/** A failed case as the answer names it: its first report, and its reports when it has several. */
export interface FailedCase {
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
 * closing the connection, taking the call and every later tool with it. Folding takes such a case
 * to four; this bounds one whose reports all differ.
 */
export const MOST_REPORTS_SHOWN = 20;

/** The most characters of one report's detail an answer carries; the rest are counted. */
export const LONGEST_DETAIL = 20_000;

function shortened(detail: string | null): string | null {
  if (detail === null || detail.length <= LONGEST_DETAIL) {
    return detail;
  }
  return `${detail.slice(0, LONGEST_DETAIL)}\n[${detail.length - LONGEST_DETAIL} more characters left out]`;
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

/**
 * Every case in [param report] that failed or hit an error, with the values [param printed] puts
 * back into each of its reports.
 *
 * Read report by report rather than case by case, because the printed diffs are matched in the
 * order the run met them, and a case failing two string equalities printed two.
 */
export function failedCases(report: TestReport, printed: string): FailedCase[] {
  const cases = report.suites.flatMap((suite) =>
    suite.cases
      .filter((entry) => entry.status === 'failed' || entry.status === 'error')
      .map((entry) => ({ entry, path: suite.path })),
  );
  const read = withActualsPrinted(
    cases.flatMap(({ entry }) => entry.reports),
    printed,
  );
  let next = 0;
  return cases.map(({ entry, path }) => {
    const reports = read.slice(next, next + entry.reports.length);
    next += entry.reports.length;
    const folded = foldedReports(reports);
    const shown = folded.slice(0, MOST_REPORTS_SHOWN);
    return {
      suite: entry.suite,
      name: entry.name,
      status: entry.status,
      time: entry.time,
      path,
      message: reports[0]?.message ?? null,
      detail: shortened(reports[0]?.detail ?? null),
      ...(reports.length > 1 ? { reports: shown, reportCount: reports.length } : {}),
      ...(folded.length > shown.length ? { reportsLeftOut: folded.length - shown.length } : {}),
    };
  });
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
  const smallestFirst = sizes.map((_, index) => index).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
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
    return { ...named, message: entry.message?.slice(0, 500) ?? null, detail: null };
  });
  return { failed: kept, briefed: failed.length - whole.size };
}

const MASKED_BRACKET = '[lb]';

/**
 * Whether [param expected] and [param actual] are strings gdUnit4 masked before printing them.
 *
 * A string equality whose value reads as BBCode is printed with every "[" written "[lb]", on the
 * console and in the report, so a line of game text holding "[b]" came back as "[lb]b]". It masks
 * both sides together, and a value holding "[lb]" itself is BBCode and is masked too, so in a masked
 * pair every bracket is spelled that way. Nothing else is masked: an array prints its own brackets
 * bare, and a dictionary, which can hold a literal "[lb]" and nothing else bracketed, is known by
 * the layout gdUnit4 prints one in.
 */
function masked(expected: string, actual: string): boolean {
  const allSpelled = (value: string): boolean =>
    !PRINTED_DICTIONARY.test(value) && value.split('[').length === value.split(MASKED_BRACKET).length;
  return `${expected}${actual}`.includes(MASKED_BRACKET) && allSpelled(expected) && allSpelled(actual);
}

const PRINTED_DICTIONARY = /^\{\n\t[\s\S]*\n {2}\}$/;

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
export interface OrphanReport {
  readonly total: number;
  readonly suites: readonly SuiteOrphans[];
}

// Up to the script's own extension rather than the first space, for the same reason.
const RUNNING_SUITE = /Run Test Suite:\s*(res:\/\/.+?\.(?:gd|cs))(?=\s|$)/;
const ORPHANS = /(\d+)\s+orphans/;
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
export function orphansPrinted(printed: readonly string[]): OrphanReport {
  const suites: SuiteOrphans[] = [];
  let total: number | null = null;
  let running: string | null = null;
  const named = new Map<string, OrphansLeft[]>();
  for (const line of printed) {
    const left = orphansLeftOn(line);
    if (left !== null) {
      named.set(left.suite, [...(named.get(left.suite) ?? []), left]);
      continue;
    }
    const started = RUNNING_SUITE.exec(line);
    if (started?.[1] !== undefined) {
      running = started[1];
      continue;
    }
    const counted = ORPHANS.exec(line);
    if (counted?.[1] === undefined) {
      continue;
    }
    const orphans = Number(counted[1]);
    if (line.includes(OVERALL)) {
      total = orphans;
      running = null;
      continue;
    }
    if (running !== null && orphans > 0) {
      suites.push({ path: running, orphans, left: [] });
    }
    // Whether it counted any or not: the suite's statistics line is the end of its block, and the
    // next count belongs to whatever runs next rather than to this one.
    running = null;
  }
  return {
    // Summed as a fallback, so a summary line this stops recognising costs the total and not the
    // per-suite rows, which are the part worth having.
    total: total ?? suites.reduce((sum, suite) => sum + suite.orphans, 0),
    suites: suites.map((suite) => ({ ...suite, left: named.get(suite.path) ?? [] })),
  };
}

/** One suite the run finished, as its statistics line counted it, and the cases that did not pass. */
export interface SuiteFinished {
  readonly path: string;
  readonly cases: number;
  readonly errors: number;
  readonly failures: number;
  /** The names of its cases that failed or errored, as gdUnit4 printed them. */
  readonly failed: readonly string[];
}

const SUITE_COUNTS = /(\d+)\s+test cases\s*\|\s*(\d+)\s+errors\s*\|\s*(\d+)\s+failures/;
const CASE_FAILED = /^\s*res:\/\/.+?\.(?:gd|cs) > (.+?) (?:FAILED|ERROR)(?:\s|$)/;

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
export function suitesPrinted(printed: readonly string[]): {
  finished: SuiteFinished[];
  running: string | null;
} {
  const finished: SuiteFinished[] = [];
  let running: string | null = null;
  let failed: string[] = [];
  for (const line of printed) {
    const started = RUNNING_SUITE.exec(line);
    if (started?.[1] !== undefined) {
      running = started[1];
      failed = [];
      continue;
    }
    if (running === null) {
      continue;
    }
    const failing = CASE_FAILED.exec(line)?.[1];
    if (failing !== undefined) {
      failed.push(failing);
      continue;
    }
    const counted = finishesASuite(line) ? SUITE_COUNTS.exec(line) : null;
    if (counted !== null) {
      finished.push({
        path: running,
        cases: Number(counted[1]),
        errors: Number(counted[2]),
        failures: Number(counted[3]),
        failed,
      });
      running = null;
    }
  }
  return { finished, running };
}

/** The progress message for a run [param elapsedMs] in, from what [param printed] says so far. */
export function testProgressMessage(printed: readonly string[], elapsedMs: number): string {
  const { finished, running } = suitesPrinted(printed);
  const failing = finished.filter((suite) => suite.errors + suite.failures > 0).length;
  const seconds = Math.floor(elapsedMs / 1000);
  const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const done =
    finished.length === 0
      ? 'No suite has finished'
      : `${finished.length === 1 ? 'One suite has' : `${finished.length} suites have`} finished${failing === 0 ? '' : `, ${failing} with failures`}`;
  return `${done}${running === null ? '' : `; running ${running}`}; ${took} in.`;
}
