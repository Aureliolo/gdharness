/**
 * Whether an engine started outside this process died as it started, read from its output file and
 * its exit while it is still early enough to start it again from the call that asked for it.
 */

import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { diedAsItStarted, printedLinesOf } from './start-race.js';

/**
 * How long a start is watched. The race raises its status within a millisecond, but Windows reports
 * the crash for seconds while the engine's main thread goes on to print its banner. A start that
 * printed past its banner is let go at once, so only a start with nothing or the banner alone waits
 * this long. It is short because every kept start with that output pays it.
 */
const START_WATCH_MS = 2500;

/** How long the exit is waited for once the process has gone, since the keeper writes it after. */
const EXIT_WAIT_MS = 10_000;

const LOOK_MS = 100;

/** What [param file] holds from byte [param from] on, as lines. Empty for a file not there. */
function linesSince(file: string, from: number): string[] {
  try {
    return printedLinesOf(readFileSync(file).subarray(from).toString('utf8'));
  } catch {
    return [];
  }
}

/** What watching a start needs. */
interface StartWatch {
  readonly pid: number;
  /** The file the start prints into, and where its part of that file begins. */
  readonly output: string;
  readonly from: number;
  /** How the start exited, once it has, or null. */
  readonly exitCode: () => number | null;
  readonly watchMs?: number;
}

/**
 * Whether the start died as it started: it ended within [member StartWatch.watchMs] with a status
 * and output that {@link diedAsItStarted} reads as a start race. Answers false at once for a start
 * that printed past its banner, and for one that is still running when the watch ends.
 */
export async function diedAtLaunch(watch: StartWatch): Promise<boolean> {
  const until = Date.now() + (watch.watchMs ?? START_WATCH_MS);
  while (Date.now() < until) {
    const lines = linesSince(watch.output, watch.from);
    if (lines.length > 1 || (lines.length === 1 && !diedAsItStarted(0xc06d007f, lines))) {
      return false;
    }
    if (!alive(watch.pid)) {
      return await endedAsItStarted(watch);
    }
    await delay(LOOK_MS);
  }
  return false;
}

/** The ended start read once its exit is in. */
async function endedAsItStarted(watch: StartWatch): Promise<boolean> {
  const until = Date.now() + EXIT_WAIT_MS;
  for (let code = watch.exitCode(); Date.now() < until; code = watch.exitCode()) {
    if (code !== null) {
      return diedAsItStarted(code, linesSince(watch.output, watch.from));
    }
    await delay(LOOK_MS);
  }
  return false;
}
