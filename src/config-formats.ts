/**
 * Writing gdharness into a config that is not JSON, without damaging the rest of it.
 *
 * The reason this exists rather than printing a block for somebody to paste: a paste step is a
 * step that gets skipped, mistyped, or pasted into the wrong file. The reason it is careful: these
 * are the reader's files, and the comments in them are theirs.
 *
 * YAML goes through a parser that round-trips comments, because a hand-rolled line editor corrupts
 * flow mappings and anchors. TOML needs no parser to write: tables are position-independent, so an
 * entry can be replaced or appended with every other byte of the file left exactly as it was. A
 * small scanner reads only enough of TOML to tell headers from the lines of a multi-line value.
 */

import { type Document, isScalar, parseDocument } from 'yaml';
import { Refusal } from './errors.js';

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
interface TomlLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface Header {
  readonly array: boolean;
  readonly path: readonly string[];
}

interface LineInfo {
  readonly header?: Header;
  /** The table the line belongs to, as the path of the last header above it. */
  readonly table: readonly string[];
  /** For a `key = value` line, the dotted key. */
  readonly key?: readonly string[];
  /** The line continues a multi-line string or a bracketed value from an earlier line. */
  readonly inValue: boolean;
  /** The line without its comment, trimmed. */
  readonly code: string;
}

interface ScanState {
  multi: string | null;
  depth: number;
}

function endOfQuoted(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1;
    } else if (text[index] === quote) {
      return index + 1;
    }
  }
  return text.length;
}

function closeOfMulti(text: string, from: number, delimiter: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (delimiter.startsWith('"') && text[index] === '\\') {
      index += 1;
    } else if (text.startsWith(delimiter, index)) {
      return index;
    }
  }
  return -1;
}

/** Walks value text, noting what carries over to the next line, and answers the text before a comment. */
function scanValue(text: string, state: ScanState): string {
  let index = 0;
  while (index < text.length) {
    if (state.multi !== null) {
      const close = closeOfMulti(text, index, state.multi);
      if (close < 0) {
        return text;
      }
      index = close + 3;
      state.multi = null;
      continue;
    }
    const char = text[index] ?? '';
    if (char === '#') {
      return text.slice(0, index);
    }
    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      if (text.startsWith(triple, index)) {
        state.multi = triple;
        index += 3;
      } else {
        index = endOfQuoted(text, index);
      }
      continue;
    }
    if (char === '[' || char === '{') {
      state.depth += 1;
    } else if (char === ']' || char === '}') {
      state.depth = Math.max(0, state.depth - 1);
    }
    index += 1;
  }
  return text;
}

/** Reads a dotted key from `start`, answering its parts and where it ended. */
function readKeyPath(text: string, start: number): { path: string[]; end: number } {
  const path: string[] = [];
  let index = start;
  for (;;) {
    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }
    const first = text[index];
    if (first === '"' || first === "'") {
      const end = endOfQuoted(text, index);
      path.push(text.slice(index + 1, end - 1));
      index = end;
    } else {
      const bare = /^[A-Za-z0-9_-]*/.exec(text.slice(index))?.[0] ?? '';
      path.push(bare);
      index += bare.length;
    }
    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }
    if (text[index] !== '.') {
      return { path, end: index };
    }
    index += 1;
  }
}

function scanToml(lines: readonly string[]): LineInfo[] {
  const state: ScanState = { multi: null, depth: 0 };
  let table: readonly string[] = [];
  return lines.map((line): LineInfo => {
    if (state.multi !== null || state.depth > 0) {
      return { table, inValue: true, code: scanValue(line, state).trim() };
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const array = trimmed.startsWith('[[');
      const read = readKeyPath(trimmed, array ? 2 : 1);
      table = read.path;
      const rest = scanValue(trimmed.slice(read.end), { multi: null, depth: 0 }).trim();
      return {
        header: { array, path: read.path },
        table,
        inValue: false,
        code: `${trimmed.slice(0, read.end)}${rest}`,
      };
    }
    if (trimmed === '' || trimmed.startsWith('#')) {
      return { table, inValue: false, code: '' };
    }
    const read = readKeyPath(trimmed, 0);
    const code = scanValue(trimmed, state).trim();
    return trimmed[read.end] === '='
      ? { table, key: read.path, inValue: false, code }
      : { table, inValue: false, code };
  });
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && startsWithPath(left, right);
}

function headerOf(text: string): Header | undefined {
  return scanToml([text])[0]?.header;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

/**
 * Where our entry already is in the file, as half-open line ranges.
 *
 * A block runs from its header to the line before the next header that is not a sub-table of it.
 * The blank lines and comments just above that next header are left out, because they are the
 * reader's notes on their own table.
 */
function findBlocks(infos: readonly LineInfo[], entry: TomlEntry): Range[] {
  const wanted = headerOf(entry.header);
  const found: Range[] = [];
  if (wanted === undefined) {
    return found;
  }
  let scan = 0;
  while (scan < infos.length) {
    const from = scan;
    scan += 1;
    const head = infos[from]?.header;
    if (head === undefined || head.array !== wanted.array || !samePath(head.path, wanted.path)) {
      continue;
    }
    while (scan < infos.length) {
      const next = infos[scan]?.header;
      if (
        next !== undefined &&
        !(next.path.length > wanted.path.length && startsWithPath(next.path, wanted.path))
      ) {
        break;
      }
      scan += 1;
    }
    let to = scan;
    while (to > from + 1 && infos[to - 1]?.code === '' && infos[to - 1]?.inValue === false) {
      to -= 1;
    }
    const body = infos.slice(from + 1, to).map((info) => info.code);
    if (entry.identity === undefined || body.includes(entry.identity)) {
      found.push({ from, to });
    }
  }
  return found;
}

interface Text {
  readonly bom: string;
  readonly eol: '\n' | '\r\n';
  /** The body with Unix line ends and no trailing newline, so a reader's mark and line ends can be put back. */
  readonly body: string;
}

function splitText(existing: string): Text {
  const bom = existing.startsWith('﻿') ? '﻿' : '';
  const raw = existing.slice(bom.length);
  return {
    bom,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    body: raw.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
  };
}

function joinText(text: Text, lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${text.bom}${lines.join('\n').replace(/\n/g, text.eol)}${text.eol}`;
}

function linesOf(text: Text): string[] {
  return text.body === '' ? [] : text.body.split('\n');
}

/**
 * Our entry written as dotted keys or an inline table, which a header block cannot replace.
 *
 * Appending a table beside either leaves a file that does not parse, so the callers refuse.
 */
function holdsOtherForm(infos: readonly LineInfo[], entry: TomlEntry): boolean {
  const wanted = headerOf(entry.header);
  if (wanted === undefined || wanted.array) {
    return false;
  }
  return infos.some(
    (info) =>
      info.key !== undefined &&
      startsWithPath([...info.table, ...info.key], wanted.path) &&
      !startsWithPath(info.table, wanted.path),
  );
}

function refuseOtherForm(entry: TomlEntry, action: string): Refusal {
  return new Refusal(
    `The file holds ${entry.header} as dotted keys or an inline table, so gdharness was not ${action}. ` +
      `Write it as a ${entry.header} table, or take it out by hand, and run this again.`,
  );
}

/** Whether the file already holds our entry as a header block. */
export function tomlHas(existing: string, entry: TomlEntry): boolean {
  const lines = linesOf(splitText(existing));
  return findBlocks(scanToml(lines), entry).length > 0;
}

/** The TOML file with our entry in it, in place of an older one of ours if there is one. */
export function writeToml(existing: string, entry: TomlEntry, launch: TomlLaunch): string {
  const text = splitText(existing);
  const lines = linesOf(text);
  const infos = scanToml(lines);
  if (holdsOtherForm(infos, entry)) {
    throw refuseOtherForm(entry, 'added to it');
  }
  const found = findBlocks(infos, entry);
  const block = entry.block(launch).split('\n');

  let next: string[];
  if (found.length === 0) {
    next = [...lines, ...(lines.length > 0 ? [''] : []), ...block];
  } else {
    next = [];
    let cursor = 0;
    found.forEach((range, count) => {
      next.push(...lines.slice(cursor, range.from), ...(count === 0 ? block : []));
      cursor = range.to;
    });
    next.push(...lines.slice(cursor));
  }

  const enable = entry.enable;
  const enableHeader = enable === undefined ? undefined : headerOf(enable.header);
  if (
    enable !== undefined &&
    enableHeader !== undefined &&
    !scanToml(next).some((info) => info.header !== undefined && samePath(info.header.path, enableHeader.path))
  ) {
    // Above the first table, never above a root key, which the new table would swallow.
    let at = scanToml(next).findIndex((info) => info.header !== undefined);
    at = at < 0 ? next.length : at;
    while (at > 0 && (next[at - 1] ?? '').trim().startsWith('#')) {
      at -= 1;
    }
    next.splice(at, 0, enable.header, enable.line, ...(at < next.length ? [''] : []));
    if (at > 0 && (next[at - 1] ?? '').trim() !== '') {
      next.splice(at, 0, '');
    }
  }
  return joinText(text, next);
}

/** The TOML file without our entry, and without the blank line it left behind. */
export function removeToml(existing: string, entry: TomlEntry): string {
  const text = splitText(existing);
  const lines = linesOf(text);
  const infos = scanToml(lines);
  if (holdsOtherForm(infos, entry)) {
    throw refuseOtherForm(entry, 'removed from it');
  }
  const found = findBlocks(infos, entry);
  if (found.length === 0) {
    return existing;
  }
  const kept: string[] = [];
  let cursor = 0;
  for (const range of found) {
    kept.push(...lines.slice(cursor, range.from));
    cursor = range.to;
    // The block's own separator and the reader's next one are two blank lines for one gap.
    if (
      (kept.length === 0 || (kept[kept.length - 1] ?? '').trim() === '') &&
      (lines[cursor] ?? 'x').trim() === ''
    ) {
      cursor += 1;
    }
  }
  kept.push(...lines.slice(cursor));
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') {
    kept.pop();
  }
  return joinText(text, kept);
}

function refuseBrokenYaml(document: Document, action: string): void {
  const first = document.errors[0];
  if (first !== undefined) {
    throw new Refusal(
      `The YAML config does not parse (${first.message.split('\n')[0]}), so gdharness was not ${action}.`,
    );
  }
}

/**
 * The YAML file with our entry at the given key path.
 *
 * `parseDocument` keeps the comments, so a reader's notes about their own servers survive us
 * editing the file. Blank-line layout is normalised by the document API, which is the one thing
 * this loses and the reason the alternative was ever considered.
 */
export function writeYaml(existing: string, path: readonly string[], entry: unknown): string {
  const text = splitText(existing);
  const document = parseDocument(text.body === '' ? '{}' : text.body);
  refuseBrokenYaml(document, 'added to it');
  // A key with nothing under it is a null, which setIn will not go through.
  for (let length = 1; length < path.length; length += 1) {
    const held: unknown = document.getIn(path.slice(0, length), true);
    if (isScalar(held) && held.value === null) {
      document.setIn(path.slice(0, length), document.createNode({}));
    }
  }
  try {
    document.setIn([...path], entry);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Refusal(
      `The YAML config has a value where gdharness needs a mapping (${reason}), so it was not added.`,
      {
        cause,
      },
    );
  }
  return `${text.bom}${String(document).replace(/\n/g, text.eol)}`;
}

/** Whether a YAML file already holds something at this key path. */
export function parsedYamlHas(existing: string, path: readonly string[]): boolean {
  const { body } = splitText(existing);
  if (body.trim() === '') {
    return false;
  }
  const document = parseDocument(body);
  return document.errors.length === 0 && document.hasIn([...path]);
}

/** The YAML file without our entry, and without an empty container left holding nothing. */
export function removeYaml(existing: string, path: readonly string[]): string {
  const text = splitText(existing);
  const document = parseDocument(text.body);
  refuseBrokenYaml(document, 'removed from it');
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
  return `${text.bom}${String(document).replace(/\n/g, text.eol)}`;
}

function isEmptyCollection(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    'items' in node &&
    Array.isArray(node.items) &&
    node.items.length === 0
  );
}
