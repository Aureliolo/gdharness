/**
 * Writing gdharness into a config that is not JSON, without damaging the rest of it.
 *
 * The reason this exists rather than printing a block for somebody to paste: a paste step is a
 * step that gets skipped, mistyped, or pasted into the wrong file. The reason it is careful: these
 * are the reader's files, and the comments in them are theirs.
 *
 * YAML goes through a parser that round-trips comments, because a hand-rolled line editor corrupts
 * flow mappings and anchors. TOML needs no parser to write: tables are position-independent, so an
 * entry can be replaced or appended with every other byte of the file left exactly as it was.
 */

import { parseDocument } from 'yaml';

/**
 * A TOML entry: how to find ours, and what to write.
 *
 * Everything but the block is static, so removing an entry needs no launch to describe one.
 */
export interface TomlEntry {
  /** The header line that owns our entry, `[table]` or `[[array]]`. */
  readonly header: string;
  /** For an array of tables, the key line that says an entry is ours rather than somebody's. */
  readonly identity?: string;
  /** The whole block, header included. */
  readonly block: (launch: TomlLaunch) => string;
  /** A table the harness needs before it reads servers at all, added once if it is missing. */
  readonly enable?: { readonly header: string; readonly line: string };
}

/** Only what a block needs, so this module does not import the harness table it is used by. */
export interface TomlLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Whether a line opens a table or an array of tables, which is what ends the block before it. */
function isHeader(line: string): boolean {
  return line.trimStart().startsWith('[');
}

/**
 * Where our entry already is in the file, as a half-open line range, or nothing.
 *
 * A block runs from its header to the line before the next header, which is what makes replacing
 * one safe: everything above and below is another table and stays untouched.
 */
function findBlock(lines: readonly string[], entry: TomlEntry): { from: number; to: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== entry.header) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !isHeader(lines[end] ?? '')) {
      end += 1;
    }
    if (entry.identity === undefined) {
      return { from: index, to: end };
    }
    const body = lines.slice(index + 1, end).map((line) => line.trim());
    if (body.includes(entry.identity)) {
      return { from: index, to: end };
    }
  }
  return undefined;
}

/** The TOML file with our entry in it, replacing an older one of ours if there is one. */
export function writeToml(existing: string, entry: TomlEntry, launch: TomlLaunch): string {
  const lines = existing === '' ? [] : existing.replace(/\n+$/, '').split('\n');
  const found = findBlock(lines, entry);

  const block = entry.block(launch).split('\n');
  const next =
    found === undefined
      ? [...lines, ...(lines.length > 0 ? [''] : []), ...block]
      : [...lines.slice(0, found.from), ...block, ...trimLeadingBlank(lines.slice(found.to))];

  const enable = entry.enable;
  if (enable !== undefined && !next.some((line) => line.trim() === enable.header)) {
    next.unshift(enable.header, enable.line, '');
  }
  return `${next.join('\n')}\n`;
}

function trimLeadingBlank(lines: readonly string[]): readonly string[] {
  return lines.length > 0 && lines[0]?.trim() === '' ? lines.slice(1) : lines;
}

/** The TOML file without our entry, and without the blank line it left behind. */
export function removeToml(existing: string, entry: TomlEntry): string {
  const lines = existing.replace(/\n+$/, '').split('\n');
  const found = findBlock(lines, entry);
  if (found === undefined) {
    return existing;
  }
  const kept = [...lines.slice(0, found.from), ...trimLeadingBlank(lines.slice(found.to))];
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') {
    kept.pop();
  }
  return kept.length === 0 ? '' : `${kept.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * The YAML file with our entry at the given key path.
 *
 * `parseDocument` keeps the comments, so a reader's notes about their own servers survive us
 * editing the file. Blank-line layout is normalised by the document API, which is the one thing
 * this loses and the reason the alternative was ever considered.
 */
export function writeYaml(existing: string, path: readonly string[], entry: unknown): string {
  const document = parseDocument(existing === '' ? '{}' : existing);
  document.setIn([...path], entry);
  return String(document);
}

/** Whether a YAML file already holds something at this key path. */
export function parsedYamlHas(existing: string, path: readonly string[]): boolean {
  if (existing.trim() === '') {
    return false;
  }
  try {
    return parseDocument(existing).hasIn([...path]);
  } catch {
    return false;
  }
}

/** The YAML file without our entry, and without an empty container left holding nothing. */
export function removeYaml(existing: string, path: readonly string[]): string {
  const document = parseDocument(existing);
  if (!document.hasIn([...path])) {
    return existing;
  }
  document.deleteIn([...path]);
  const container = path.slice(0, -1);
  if (container.length > 0) {
    const held: unknown = document.getIn([...container], true);
    if (held !== undefined && held !== null && isEmptyCollection(held)) {
      document.deleteIn([...container]);
    }
  }
  return String(document);
}

function isEmptyCollection(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    'items' in node &&
    Array.isArray((node as { items: unknown[] }).items) &&
    (node as { items: unknown[] }).items.length === 0
  );
}
