/**
 * One engine run to its end, with what it printed read as it arrives.
 *
 * Streamed rather than collected by execFile, because execFile kills a process that prints past
 * its buffer and reports that as the process failing: a healthy import pass on a large project, or
 * a boot that warns once per resource, was ended by Node and answered as an engine fault.
 */

import { callSignal } from './call-signal.js';
import { inASlot, onTheSlot } from './engine-slots.js';
import { GameLog } from './game-log.js';
import { spawnHidden } from './spawn.js';

export interface EngineRun {
  /** Both streams, finished. */
  readonly log: GameLog;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** Why this server ended the run or could not start it, when it did either. */
  readonly failure: string | null;
}

/**
 * Runs the engine in one of the machine's engine slots, waiting for one first, so an engine this
 * process starts counts against the same budget as every gate on the machine. The timeout starts
 * once the engine does.
 */
export async function runEngine(
  executable: string,
  args: readonly string[],
  options: { readonly timeout?: { readonly ms: number; readonly said: string } } = {},
): Promise<EngineRun> {
  const signal = callSignal();
  try {
    return await inASlot((lock) => runStarted(executable, args, lock, options, signal));
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return {
      log: new GameLog(),
      exitCode: null,
      exitSignal: null,
      failure:
        signal?.aborted === true ? 'the call was cancelled' : `it could not take an engine slot: ${said}`,
    };
  }
}

/**
 * Settles on `close` rather than `exit`: the streams can still hold the run's last lines when
 * `exit` fires, and those are the lines a verdict is read from. Node emits `close` after a failed
 * start and after an abort as well, so it is the one place every run ends.
 */
function runStarted(
  executable: string,
  args: readonly string[],
  lock: string,
  options: { readonly timeout?: { readonly ms: number; readonly said: string } },
  signal: AbortSignal | undefined,
): Promise<EngineRun> {
  return new Promise((resolve) => {
    const log = new GameLog();
    let failure: string | null = null;
    const child = spawnHidden(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: onTheSlot(process.env, lock),
      ...(signal === undefined ? {} : { signal }),
    });
    child.stdout.on('data', (chunk: Buffer) => {
      log.append('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      log.append('stderr', chunk);
    });
    const { timeout } = options;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            failure ??= `it ran past its ${timeout.said}`;
            child.kill();
          }, timeout.ms);
    child.on('error', (error) => {
      failure ??=
        error.name === 'AbortError' ? 'the call was cancelled' : `it could not be started: ${error.message}`;
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

/**
 * Windows ends a process that raised an exception it did not handle with the exception's status
 * as its exit code, a number from 0xC0000000 up that says nothing in decimal. A runtime that keeps
 * only the low byte, as Bun does, turns an access violation into a plain 5.
 */
const WINDOWS_STATUSES: ReadonlyMap<number, string> = new Map([
  [0xc0000005, 'an access violation, so it crashed'],
  [0xc000001d, 'an illegal instruction, so it crashed'],
  [0xc0000094, 'an integer division by zero, so it crashed'],
  [0xc00000fd, 'a stack overflow, so it crashed'],
  [0xc0000135, 'a library it needs was not found, so it never started'],
  [0xc000013a, 'its console was closed or sent Ctrl+C'],
  [0xc0000374, 'a corrupted heap, so it crashed'],
  [0xc0000409, 'a stack buffer overrun or a fast fail, so it crashed'],
]);

/** [param code] for a sentence: `exit code 3`, or `exit code 0xC0000005, an access violation, so it crashed`. */
export function exitCodeText(code: number | null): string {
  if (code === null) {
    return 'exit code unknown';
  }
  if (code < 0xc0000000) {
    return `exit code ${code}`;
  }
  const hex = `0x${code.toString(16).toUpperCase()}`;
  return `exit code ${hex}, ${WINDOWS_STATUSES.get(code) ?? 'a Windows error status'}`;
}

/** How [param run] ended, for a sentence: `exit code 3`, `ended by SIGTERM`, or this server's reason. */
export function howItEnded(run: Pick<EngineRun, 'exitCode' | 'exitSignal' | 'failure'>): string {
  if (run.failure !== null) {
    return run.exitSignal === null ? run.failure : `ended by ${run.exitSignal}, because ${run.failure}`;
  }
  return run.exitSignal === null ? exitCodeText(run.exitCode) : `ended by ${run.exitSignal}`;
}
