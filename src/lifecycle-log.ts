/**
 * The servers' own log: a line when a server starts, when its client says who it is, when it takes
 * a project over from another server, and when it ends and why.
 *
 * A client can end a server in the middle of a call and start another, and nothing it does says
 * why: a restart, a crash, an idle timeout and a reconnect all looked the same from here, and each
 * wants a different fix. So the server writes down what it knows itself. One file for every server
 * of the user, beside the runtime announcements, since a harness restarts the servers of every
 * project and each line names its project.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { runtimeDirectory } from './runtime-client.js';
import { SERVER_VERSION } from './server-version.js';

/** Where the lines go. */
export function lifecycleLogPath(): string {
  return join(runtimeDirectory(), 'servers.log');
}

/**
 * Past this many bytes the file is moved aside to `servers.log.1`, replacing the one there, so the
 * log never holds more than twice this. A line is a few hundred bytes, so this is thousands of
 * server lives, which is weeks of a harness reconnecting.
 */
export const LIFECYCLE_LOG_LIMIT = 1_000_000;

/** A call the server was answering, as the ended line names it. */
export interface CallInFlight {
  readonly tool: string;
  readonly op: string;
  readonly startedAt: number;
}

/**
 * Appends one line for [param event]. Written synchronously, because the line saying a server
 * ended is written as it exits, and never thrown out of: a log that cannot be written must not
 * take the server down with it.
 */
export function writeLifecycle(event: string, fields: Record<string, unknown> = {}): void {
  const path = lifecycleLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LIFECYCLE_LOG_LIMIT) {
      // Two servers can both find it full. The second rename finds nothing to move and the line
      // goes into the fresh file either way.
      try {
        renameSync(path, `${path}.1`);
      } catch {
        // Moved by the other one.
      }
    }
    const line: Record<string, unknown> = {
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      version: SERVER_VERSION,
      event,
    };
    // None of them may stand in for the line's own pid, version or event.
    for (const [name, value] of Object.entries(fields)) {
      if (!Object.hasOwn(line, name)) {
        line[name] = value;
      }
    }
    appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // Nowhere to say so but stderr, which is the client's.
    console.error(`[SERVER] Could not write the lifecycle log at ${path}.`);
  }
}

/** The calls in flight as an ended line carries them: each with how long it had been running. */
export function callsInFlight(
  calls: Iterable<CallInFlight>,
  now: number = Date.now(),
): Record<string, unknown>[] {
  return [...calls].map((call) => ({
    tool: call.tool,
    ...(call.op === '' ? {} : { op: call.op }),
    runningMs: now - call.startedAt,
  }));
}
