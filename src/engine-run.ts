/**
 * One engine run to its end, with what it printed read as it arrives.
 *
 * Streamed rather than collected by execFile, because execFile kills a process that prints past
 * its buffer and reports that as the process failing: a healthy import pass on a large project, or
 * a boot that warns once per resource, was ended by Node and answered as an engine fault.
 */

import { callSignal } from './call-signal.js';
import { inASlot, nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { GameLog } from './game-log.js';
import { belowNormal } from './priority.js';
import { spawnHidden } from './spawn.js';
import { holdExit } from './whole-exit.js';

export interface EngineRun {
  /** Both streams, finished. */
  readonly log: GameLog;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** Why this server ended the run or could not start it, when it did either. */
  readonly failure: string | null;
  /** How many starts before this one crashed before printing a line: see {@link crashedAtStart}. */
  readonly crashedStarts?: number;
}

/** How many times an engine that crashes as it starts is started in all. */
export const ENGINE_STARTS = 3;
/** The wait before the second start, doubled before each one after it. */
const START_RETRY_MS = 500;

/**
 * The Windows statuses that end an engine for a reason a second start would meet again: its console
 * closed or Ctrl+C, and a library it needs that is not there.
 */
const NOT_A_START_RACE = new Set([0xc000013a, 0xc0000135]);

/**
 * Whether [param run] is an engine that died as it started: ended by a Windows exception status
 * before it printed its banner. A loaded machine makes Godot do that now and then (0xC06D007F, a
 * race in its input library's hook), and a headless call failed on it with "no output at all". It
 * never reached the project, so starting it again repeats nothing.
 */
export function crashedAtStart(run: EngineRun): boolean {
  return (
    run.failure === null &&
    run.exitSignal === null &&
    run.exitCode !== null &&
    run.exitCode >= 0xc0000000 &&
    !NOT_A_START_RACE.has(run.exitCode) &&
    run.log.everything().length === 0
  );
}

/**
 * [param start] run until it gives a run that did not crash as it started, or {@link ENGINE_STARTS}
 * times, sleeping with [param sleep] between. A cancelled call is not started again.
 */
export async function startedUntilItRuns(
  start: () => Promise<EngineRun>,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((done) => {
      setTimeout(done, ms);
    }),
): Promise<EngineRun> {
  for (let started = 1; ; started += 1) {
    const ran = await start();
    if (started >= ENGINE_STARTS || signal?.aborted === true || !crashedAtStart(ran)) {
      return started === 1 ? ran : { ...ran, crashedStarts: started - 1 };
    }
    await sleep(START_RETRY_MS * 2 ** (started - 1));
  }
}

/**
 * Runs the engine in one of the machine's engine slots, waiting for one first, so an engine this
 * process starts counts against the same budget as every gate on the machine. The timeout starts
 * once the engine does. An engine that crashes as it starts is started again on the same slot.
 */
export async function runEngine(
  executable: string,
  args: readonly string[],
  options: { readonly timeout?: { readonly ms: number; readonly said: string } } = {},
): Promise<EngineRun> {
  const signal = callSignal();
  try {
    return await inASlot((lock) =>
      startedUntilItRuns(() => runStarted(executable, args, lock, options, signal), signal),
    );
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
    belowNormal(child);
    const whole = holdExit(child.pid);
    // The lock names this process, and what the engine starts runs on its slot only when it names
    // the engine too.
    if (child.pid !== undefined) {
      void nameSlotEngineOf(lock, process.pid, child.pid);
    }
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
      resolve({ log, exitCode: started ? whole(code) : null, exitSignal: closedBy, failure });
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
export function howItEnded(
  run: Pick<EngineRun, 'exitCode' | 'exitSignal' | 'failure' | 'crashedStarts'>,
): string {
  if (run.failure !== null) {
    return run.exitSignal === null ? run.failure : `ended by ${run.exitSignal}, because ${run.failure}`;
  }
  if (run.exitSignal !== null) {
    return `ended by ${run.exitSignal}`;
  }
  const crashed = run.crashedStarts ?? 0;
  return crashed === 0
    ? exitCodeText(run.exitCode)
    : `${exitCodeText(run.exitCode)}, and printed nothing on any of its ${String(crashed + 1)} starts`;
}
