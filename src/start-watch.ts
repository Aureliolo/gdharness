/**
 * Whether an engine started outside this process has already died as it started, read from its
 * output file and its exit. It never waits for a start that is still running, so a call that asks
 * adds nothing to its own wait.
 */

import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { diedAsItStarted, linesAsPrinted } from './start-race.js';

const LOOK_MS = 100;

/** What a start that has gone is read from. */
interface EndedStart {
  readonly pid: number;
  /** The file the start prints into. */
  readonly output: string;
  /** How the start exited, once it has, or null. The keeper writes it after the process is gone. */
  readonly exitCode: () => number | null;
  /** When to stop waiting for the exit. */
  readonly until: number;
}

/**
 * Whether the start has ended with a status and output that {@link diedAsItStarted} reads as a
 * start race. False at once for a start that is still running, and false when its exit is not in by
 * [member EndedStart.until].
 */
export async function endedAsItStarted(start: EndedStart): Promise<boolean> {
  if (alive(start.pid)) {
    return false;
  }
  for (let code = start.exitCode(); ; code = start.exitCode()) {
    if (code !== null) {
      return diedAsItStarted(code, linesOf(start.output));
    }
    if (Date.now() >= start.until) {
      return false;
    }
    await delay(LOOK_MS);
  }
}

/** What [param file] holds, as lines. Empty for a file not there. */
function linesOf(file: string): string[] {
  try {
    return linesAsPrinted(readFileSync(file).toString('utf8'));
  } catch {
    return [];
  }
}
