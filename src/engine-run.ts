/**
 * One engine run to its end, with what it printed read as it arrives.
 *
 * Streamed rather than collected by execFile, because execFile kills a process that prints past
 * its buffer and reports that as the process failing: a healthy import pass on a large project, or
 * a boot that warns once per resource, was ended by Node and answered as an engine fault.
 */

import { spawn } from 'node:child_process';
import { callSignal } from './call-signal.js';
import { GameLog } from './game-log.js';

export interface EngineRun {
  /** Both streams, finished. */
  readonly log: GameLog;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** Why this server ended the run or could not start it, when it did either. */
  readonly failure: string | null;
}

/**
 * Settles on `close` rather than `exit`: the streams can still hold the run's last lines when
 * `exit` fires, and those are the lines a verdict is read from. Node emits `close` after a failed
 * start and after an abort as well, so it is the one place every run ends.
 */
export function runEngine(
  executable: string,
  args: readonly string[],
  options: { readonly timeout?: { readonly ms: number; readonly said: string } } = {},
): Promise<EngineRun> {
  return new Promise((resolve) => {
    const log = new GameLog();
    let failure: string | null = null;
    const signal = callSignal();
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
    child.stdout.on('data', (chunk: Buffer) => log.append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => log.append('stderr', chunk));
    const { timeout } = options;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            failure ??= `it ran past its ${timeout.said}`;
            child.kill();
          }, timeout.ms);
    child.on('error', (error) => {
      failure ??= error.name === 'AbortError' ? 'the call was cancelled' : `it could not be started: ${error.message}`;
    });
    child.on('close', (code, closedBy) => {
      clearTimeout(timer);
      log.finish();
      // A process that never started has a libuv error number where its exit code would be.
      const started = child.pid !== undefined;
      resolve({ log, exitCode: started ? code : null, exitSignal: closedBy, failure });
    });
  });
}

/** How [param run] ended, for a sentence: `exit code 3`, `ended by SIGTERM`, or this server's reason. */
export function howItEnded(run: Pick<EngineRun, 'exitCode' | 'exitSignal' | 'failure'>): string {
  if (run.failure !== null) {
    return run.exitSignal === null ? run.failure : `ended by ${run.exitSignal}, because ${run.failure}`;
  }
  return run.exitSignal === null ? `exit code ${run.exitCode ?? 'unknown'}` : `ended by ${run.exitSignal}`;
}
