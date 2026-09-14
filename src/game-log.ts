/**
 * What a running game printed, read as the engine writes it rather than as raw lines.
 *
 * The engine reports a problem as a headline (`ERROR:`, `SCRIPT ERROR:`, `WARNING:`, or the
 * `USER` forms push_error and push_warning produce) followed by indented lines that say where:
 * an `at:` line, and a backtrace when there is one. Those belong to the headline, so a filter
 * on severity keeps them with it, and a count of errors counts problems and not lines.
 */

import { StringDecoder } from 'node:string_decoder';

export type Severity = 'error' | 'warning' | 'info';

/**
 * Where an entry came from.
 *
 * `debugger` is the odd one and it is not a detail: a game the editor is playing can be broken
 * on an error the engine prints down neither pipe, and an entry that claimed to be stdout would
 * be saying the game printed something it never printed.
 */
type Source = 'stdout' | 'stderr' | 'debugger';

export interface LogEntry {
  readonly index: number;
  readonly severity: Severity;
  readonly source: Source;
  /** The headline, without its severity prefix. */
  readonly text: string;
  /** The indented lines the engine printed under the headline, if any. */
  readonly detail: readonly string[];
}

const HEADLINE = /^(USER )?(SCRIPT ERROR|ERROR|WARNING):\s?(.*)$/;

/** An ANSI colour sequence: the escape byte, a bracket, the parameters, the letter m. */
const COLOUR_CODE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');

/** The severity a headline announces, or null for a line that announces nothing. */
function announced(line: string): { severity: Severity; text: string } | null {
  const match = HEADLINE.exec(line);
  if (!match) {
    return null;
  }
  return { severity: match[2] === 'WARNING' ? 'warning' : 'error', text: match[3] ?? '' };
}

/**
 * Collects the lines a game prints, one stream at a time, into entries.
 *
 * Bytes arrive in the chunks the pipe makes of them, which can cut a character as easily as a
 * line, so each stream is decoded here and its last piece held back until the newline that
 * ends it turns up. An indented line after a headline is the headline's detail; anything else
 * starts an entry of its own.
 */
export class GameLog {
  private readonly entries: LogEntry[] = [];
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private readonly partial = { stdout: '', stderr: '' };
  private lastHeadline: { index: number; detail: string[] } | null = null;
  private cursor = 0;

  append(source: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const decoded = typeof chunk === 'string' ? chunk : this.decoders[source].write(chunk);
    const lines = (this.partial[source] + decoded).split('\n');
    this.partial[source] = lines.pop() ?? '';
    for (const raw of lines) {
      this.line(source, raw.replace(/\r$/, ''));
    }
  }

  /** Whatever was printed without a final newline, once the stream has ended. */
  finish(): void {
    for (const source of ['stdout', 'stderr'] as const) {
      const tail = this.partial[source] + this.decoders[source].end();
      this.partial[source] = '';
      if (tail !== '') {
        this.line(source, tail);
      }
    }
  }

  private line(source: 'stdout' | 'stderr', raw: string): void {
    // Colour codes are for a terminal; a caller reading entries wants the words.
    const line = raw.replace(COLOUR_CODE, '');
    if (line.trim() === '') {
      return;
    }
    if (this.lastHeadline && /^\s/.test(line) && this.lastHeadline.index === this.entries.length - 1) {
      this.lastHeadline.detail.push(line.trim());
      return;
    }
    const headline = announced(line);
    const detail: string[] = [];
    const entry: LogEntry = {
      index: this.entries.length,
      severity: headline?.severity ?? 'info',
      source,
      text: headline?.text ?? line,
      detail,
    };
    this.entries.push(entry);
    this.lastHeadline = headline ? { index: entry.index, detail } : null;
  }

  /**
   * A problem the engine reported somewhere other than its output.
   *
   * The editor's debug adapter is what does this. Godot breaks a game on a script error and
   * names it in the `stopped` event alone, printing nothing an `output` event carries, so a log
   * built from printed lines held no trace of it: a game sitting dead at an error counted zero
   * errors and read as clean, which is the answer this whole file exists to get right.
   */
  record(severity: Severity, text: string): void {
    this.entries.push({
      index: this.entries.length,
      severity,
      source: 'debugger',
      text,
      detail: [],
    });
    // It owns no following lines, so an indented line after it belongs to whatever printed last.
    this.lastHeadline = null;
  }

  get all(): readonly LogEntry[] {
    return this.entries;
  }

  count(severity: Severity): number {
    return this.entries.filter((entry) => entry.severity === severity).length;
  }

  /**
   * Entries at or above a severity, optionally only those since the last time this was asked
   * and only those mentioning a phrase, and at most `limit` of the newest.
   */
  select(options: {
    severity: Severity;
    sinceLastCall: boolean;
    contains?: string | undefined;
    limit: number;
  }): { entries: LogEntry[]; omitted: number } {
    const floor = options.sinceLastCall ? this.cursor : 0;
    this.cursor = this.entries.length;
    const wanted = new Set<Severity>(
      options.severity === 'error'
        ? ['error']
        : options.severity === 'warning'
          ? ['error', 'warning']
          : ['error', 'warning', 'info'],
    );
    const needle = options.contains?.toLowerCase();
    const matching = this.entries.slice(floor).filter((entry) => {
      if (!wanted.has(entry.severity)) {
        return false;
      }
      if (needle === undefined) {
        return true;
      }
      return [entry.text, ...entry.detail].some((line) => line.toLowerCase().includes(needle));
    });
    const omitted = Math.max(0, matching.length - options.limit);
    return { entries: matching.slice(omitted), omitted };
  }
}
