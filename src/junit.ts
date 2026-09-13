/**
 * The JUnit XML a test runner writes, read into the cases and what happened to each.
 *
 * The reader is a small XML parser of its own rather than a dependency: the format here is one
 * element shape with attributes, text and CDATA, and a parser for that is shorter than the
 * supply chain it would replace. Anything it cannot read is a `MalformedReportError`, never a
 * partial report that looks like a run with fewer tests.
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
  const suites = suiteElements.map(
    (suite): TestSuite => ({
      name: suite.attributes['name'] ?? '',
      path: pathOf(suite),
      tests: count(suite.attributes, 'tests'),
      failures: count(suite.attributes, 'failures'),
      errors: count(suite.attributes, 'errors'),
      skipped: count(suite.attributes, 'skipped'),
      time: count(suite.attributes, 'time'),
      cases: suite.children
        .filter((child) => child.name === 'testcase')
        .map((element) => caseOf(suite, element)),
    }),
  );
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
