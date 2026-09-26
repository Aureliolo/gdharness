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

interface TestCase {
  readonly suite: string;
  readonly name: string;
  readonly status: CaseStatus;
  readonly time: number;
  /** The runner's one-line message, such as where the failing assertion is. */
  readonly message: string | null;
  /** What the runner said in full: the expected and actual values, the stack. */
  readonly detail: string | null;
}

interface TestSuite {
  readonly name: string;
  readonly path: string | null;
  readonly tests: number;
  /** What the suite said it held, which is more than `tests` when the run stopped inside it. */
  readonly discovered: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
  readonly cases: readonly TestCase[];
}

export interface TestReport {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
  readonly suites: readonly TestSuite[];
}

function count(attributes: Readonly<Record<string, string>>, name: string): number {
  const value = Number(attributes[name] ?? '0');
  return Number.isFinite(value) ? value : 0;
}

function caseOf(suite: XmlElement, element: XmlElement): TestCase {
  const outcome = element.children.find((child) => ['failure', 'error', 'skipped'].includes(child.name));
  const status: CaseStatus =
    outcome === undefined
      ? 'passed'
      : outcome.name === 'failure'
        ? 'failed'
        : outcome.name === 'error'
          ? 'error'
          : 'skipped';
  const detail = outcome?.text.trim() ?? '';
  return {
    suite: suite.attributes['name'] ?? '',
    name: element.attributes['name'] ?? '',
    status,
    time: count(element.attributes, 'time'),
    message: outcome?.attributes['message'] ?? null,
    detail: detail === '' ? null : detail,
  };
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
    return {
      name: suite.attributes['name'] ?? '',
      path: pathOf(suite),
      tests: cases.length,
      discovered: count(suite.attributes, 'tests'),
      failures: cases.filter((entry) => entry.status === 'failed').length,
      errors: cases.filter((entry) => entry.status === 'error').length,
      skipped: cases.filter((entry) => entry.status === 'skipped').length,
      time: count(suite.attributes, 'time'),
      cases,
    };
  });
  // Counted from the cases rather than read off the top element: gdUnit4 leaves `errors` off
  // <testsuites> and writes `time` there as zero.
  const all = suites.flatMap((suite) => suite.cases);
  return {
    tests: all.length,
    failures: all.filter((entry) => entry.status === 'failed').length,
    errors: all.filter((entry) => entry.status === 'error').length,
    skipped: all.filter((entry) => entry.status === 'skipped').length,
    time: suites.reduce((sum, suite) => sum + suite.time, 0),
    suites,
  };
}

/** What gdUnit4 prints when it was pointed at something, and there was nothing there to run. */
const NOTHING_RAN = /no test cases found/i;
const NO_SUCH_PATH = /given directory or file does not exists:\s*(\S+)/i;

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
  return failed.map((entry) => {
    if (entry.detail === null) {
      return entry;
    }
    let detail = entry.detail;
    let recovered = false;
    for (const diff of diffs) {
      const wrong = ` but was\n '${diff.merged.replaceAll('\r', '')}'${diff.suffix}\n\tat ${diff.at}`;
      if (detail.includes(wrong)) {
        detail = detail.replace(wrong, () => ` but was\n '${diff.actual}'${diff.suffix}\n\tat ${diff.at}`);
        recovered = true;
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

/** One suite that finished with nodes still in the tree, and how many. */
interface SuiteOrphans {
  /** The suite's script, as gdUnit4 names it on the line announcing the run. */
  readonly path: string;
  readonly orphans: number;
}

/** What a run left behind, counted per suite and in total. */
export interface OrphanReport {
  readonly total: number;
  readonly suites: readonly SuiteOrphans[];
}

const RUNNING_SUITE = /Run Test Suite:\s*(\S+)/;
const ORPHANS = /(\d+)\s+orphans/;
const OVERALL = 'Overall Summary';

/**
 * The orphan nodes a run reported, read off what it printed.
 *
 * Read from the console because it is the only place they are. gdUnit4 counts orphans per suite
 * and decides the run's state from them: no errors and no failures, but nodes left in the tree,
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
  for (const line of printed) {
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
      suites.push({ path: running, orphans });
    }
    // Whether it counted any or not: the suite's statistics line is the end of its block, and the
    // next count belongs to whatever runs next rather than to this one.
    running = null;
  }
  return {
    // Summed as a fallback, so a summary line this stops recognising costs the total and not the
    // per-suite rows, which are the part worth having.
    total: total ?? suites.reduce((sum, suite) => sum + suite.orphans, 0),
    suites,
  };
}
