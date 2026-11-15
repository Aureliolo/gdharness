import { marked, type Tokens } from 'marked';

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The text a reader sees in [param html], one heading's rendered inline markup. */
function textOf(html: string): string {
  // Until none is left, since removing one tag can join the pieces of another: <<b>i>.
  let bare = html;
  let before = '';
  while (bare !== before) {
    before = bare;
    bare = bare.replaceAll(/<[^>]*>/g, '');
  }
  return bare.replaceAll(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (whole, hex?: string, decimal?: string, name?: string) => {
      if (hex !== undefined) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      if (decimal !== undefined) {
        return String.fromCodePoint(Number(decimal));
      }
      return ENTITIES[(name ?? '').toLowerCase()] ?? whole;
    },
  );
}

/**
 * The ids the headings of one page get, which follow GitHub's rule so a link that works in GitHub's
 * rendering and in markdownlint works on the site too: the rendered text lowercased, every character
 * but a letter, mark, number, underscore, space or hyphen dropped, each space made a hyphen, and
 * `-1`, `-2` added to a heading whose id an earlier heading took.
 */
export class HeadingIds {
  private readonly taken = new Set<string>();
  private readonly repeats = new Map<string, number>();

  /** The id of the next heading, whose rendered inline markup is [param html]. */
  next(html: string): string {
    const base = textOf(html)
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replaceAll(' ', '-');
    let id = base;
    let count = this.repeats.get(base) ?? 0;
    while (this.taken.has(id)) {
      count += 1;
      id = `${base}-${String(count)}`;
    }
    this.repeats.set(base, count);
    this.taken.add(id);
    return id;
  }
}

/** The ids the headings of [param markdown] get, in order. */
export function headingIdsOf(markdown: string): string[] {
  const ids = new HeadingIds();
  return marked
    .lexer(markdown)
    .filter((token): token is Tokens.Heading => token.type === 'heading')
    .map((token) => ids.next(marked.parseInline(token.text, { async: false })));
}
