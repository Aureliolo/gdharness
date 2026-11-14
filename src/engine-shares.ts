/**
 * The hand-over between a run and an engine that takes more than one share of suites. The engine
 * prints a marker line as each share ends and then waits for the file naming the next, or `stop`.
 * The run cuts the engine's log at the markers, so each share is judged on its own lines.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEnd } from './suite-judge.js';

/** The engine's argument naming the folder it looks for the next share in. */
export const SHARES_IN = '--shares-in';

/** What an engine prints as a share ends, before `<number> exit <code>`. */
const SHARE_ENDED = 'gdharness share ended';

/** What the file for the next share holds when no share is left. */
const NO_MORE_SHARES = 'stop';

/** The first line of an engine's log, which names its build and which every share is judged beside. */
const BANNER_LINE = /^\s*Godot Engine v/;

/** How many lines from the top of the log are looked at for the banner. */
const BANNER_LOOK = 20;

/** How many bytes from the top of the log are looked at for the banner. */
const BANNER_BYTES = 8192;

const MARKER_LINE = new RegExp(`^${SHARE_ENDED} \\d+ exit -?\\d+\\s*$`);

/** The file the engine reads share [param number] (1 for the second) from. */
function nextShareFile(directory: string, number: number): string {
  return join(directory, `next-${String(number)}.txt`);
}

/** The start of the line the engine prints as share [param number] ends, which `<code>` follows. */
export function shareMarker(number: number): string {
  return `${SHARE_ENDED} ${String(number)} exit `;
}

/**
 * Hands the engine share [param number] with its [param args], one a line, or tells it to stop when
 * there are none. Written whole and then renamed, so the engine never reads half of it.
 */
export function handedOver(directory: string, number: number, args: readonly string[] | null): void {
  const file = nextShareFile(directory, number);
  const partial = `${file}.part`;
  writeFileSync(partial, args === null ? NO_MORE_SHARES : args.join('\n'));
  renameSync(partial, file);
}

/** The lines of [param text] without the markers between shares. */
function withoutMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line.replace(/\r$/, '')))
    .join('\n');
}

/** The banner line of [param text], or an empty string when its first lines hold none. */
function bannerOf(text: string): string {
  const line = text.split('\n', BANNER_LOOK).find((candidate) => BANNER_LINE.test(candidate));
  return line === undefined ? '' : `${line.replace(/\r$/, '')}\n`;
}

/**
 * The lines the engine printed for the share that began at byte [param from] of [param log] and ended
 * at byte [param to] (the end of the log when absent). A share after the first is given the banner
 * the engine printed as it started, since the build it runs is judged on every share's lines.
 */
export function shareText(log: string, from: number, to?: number): string {
  const bytes = readFileSync(log);
  const text = withoutMarkers(bytes.subarray(from, to).toString('utf8'));
  return from === 0
    ? text
    : `${bannerOf(bytes.subarray(0, Math.min(from, BANNER_BYTES)).toString('utf8'))}${text}`;
}

/** How a share ended, as the watcher of its engine saw it. */
export interface ShareEnded {
  /** Which share of the engine it was, 0 for the first. */
  readonly number: number;
  /** The bytes of the log its lines run from and to. */
  readonly from: number;
  readonly to: number;
  /** Its exit code, and the most the engine held while it ran. */
  readonly end: EngineEnd;
}

/** The share the run hands the engine next. */
export interface ShareNext {
  /** What follows `--` on the engine's command line for the share. */
  readonly args: readonly string[];
  /** Told each reading of what the engine holds while it runs the share. */
  readonly holds?: (bytes: number) => void;
}

/** What the watcher of an engine needs to hand it shares. */
export interface ShareHandoff {
  /** The folder the engine looks for the next share in. */
  readonly directory: string;
  /** Answers the share after [param ended], or null when none is left. */
  readonly ended: (ended: ShareEnded) => Promise<ShareNext | null>;
}
