/**
 * One engine run to its end, with what it printed read as it arrives.
 *
 * Streamed rather than collected by execFile, because execFile kills a process that prints past
 * its buffer and reports that as the process failing: a healthy import pass on a large project, or
 * a boot that warns once per resource, was ended by Node and answered as an engine fault.
 */

import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { callSignal } from './call-signal.js';
import {
  ensureHelperCompiled,
  type HelperFiles,
  HIDDEN_DESKTOP,
  helperExit,
  helperFailure,
  helperPid,
  spawnOnDesktop,
} from './desktop.js';
import { inASlot, nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { countedBy, nowSeconds, type Sample, Spent, sampled, watching } from './engine-spent.js';
import { errorMessage } from './errors.js';
import { GameLog } from './game-log.js';
import { belowNormal } from './priority.js';
import { type ChildProcess, type SpawnOptions, spawnHidden } from './spawn.js';
import { windowsStatusOf } from './suite-judge.js';
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

/** The Windows status of a console closed or sent Ctrl+C, which ends a process without a fault. */
export const CONSOLE_CLOSED = 0xc000013a;

/**
 * The Windows statuses that end an engine for a reason a second start would meet again: its console
 * closed or Ctrl+C, and a library it needs that is not there.
 */
const NOT_A_START_RACE = new Set([CONSOLE_CLOSED, 0xc0000135]);

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
    diedAsItStarted(run.exitCode, run.log.everything().length === 0)
  );
}

/**
 * Whether an engine that exited with [param code], and that nothing here ended, died as it started:
 * see {@link crashedAtStart}.
 */
export function diedAsItStarted(code: number | null, printedNothing: boolean): boolean {
  return code !== null && code >>> 0 >= 0xc0000000 && !NOT_A_START_RACE.has(code >>> 0) && printedNothing;
}

/**
 * [param start] run until it gives a run that did not crash as it started, by [param crashed], or
 * {@link ENGINE_STARTS} times. [param sleep] waits between starts. A cancelled call is not started
 * again.
 */
export async function startedUntilItRuns<Ran extends { readonly crashedStarts?: number }>(
  start: () => Promise<Ran>,
  signal: AbortSignal | undefined,
  crashed: (ran: Ran) => boolean,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((done) => {
      setTimeout(done, ms);
    }),
): Promise<Ran> {
  for (let started = 1; ; started += 1) {
    const ran = await start();
    if (started >= ENGINE_STARTS || signal?.aborted === true || !crashed(ran)) {
      return started === 1 ? ran : { ...ran, crashedStarts: started - 1 };
    }
    await sleep(START_RETRY_MS * 2 ** (started - 1));
  }
}

/** How long an engine may run, and the words for it. [param sample] reads the machine, for a test. */
interface RunOptions {
  readonly timeout?: { readonly ms: number; readonly said: string };
  readonly sample?: () => Promise<Sample>;
  /**
   * Windows only: start the engine on the hidden desktop, from [code]directory[/code], with the
   * helper's files in [code]scratch[/code]. An engine that draws opens a window, which there
   * neither shows nor takes the keyboard.
   */
  readonly desktop?: { readonly directory: string; readonly scratch: string };
}

/** How often an engine with a timeout is measured against it. */
const MEASURE_MS = 1000;

/**
 * Runs the engine in one of the machine's engine slots, waiting for one first, so an engine this
 * process starts counts against the same budget as every gate on the machine. The timeout starts
 * once the engine does, and counts the engine's own processor time while other work crowds the
 * machine, up to eight times the timeout on the clock. A gate's add_autoload at below
 * normal priority, on a machine 94% busy, was ended at ten minutes while it worked. An engine that
 * crashes as it starts is started again on the same slot.
 */
export async function runEngine(
  executable: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<EngineRun> {
  const signal = callSignal();
  if (options.desktop !== undefined) {
    const compiled = await ensureHelperCompiled();
    if (compiled !== null) {
      return {
        log: new GameLog(),
        exitCode: null,
        exitSignal: null,
        failure: `it could not be started on a desktop of its own: ${compiled}`,
      };
    }
  }
  try {
    return await inASlot((lock) =>
      startedUntilItRuns(() => runStarted(executable, args, lock, options, signal), signal, crashedAtStart),
    );
  } catch (error) {
    const said = errorMessage(error);
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
 * An engine started directly, or through the helper that gives it a desktop of its own, in which
 * case its helper's files are named. A crashed run's exit code is read from the exit file alone.
 */
interface Launch {
  readonly child: ChildProcess;
  readonly files: HelperFiles | null;
}

function launchOf(
  executable: string,
  args: readonly string[],
  lock: string,
  desktop: RunOptions['desktop'],
  signal: AbortSignal | undefined,
): Launch {
  const options: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: onTheSlot(process.env, lock),
    ...(signal === undefined ? {} : { signal }),
  };
  if (desktop === undefined) {
    return { child: spawnHidden(executable, args, options), files: null };
  }
  const started = spawnOnDesktop(
    {
      desktop: HIDDEN_DESKTOP,
      directory: desktop.directory,
      endsWithHelper: true,
      scratch: desktop.scratch,
      exit: join(desktop.scratch, 'exit'),
    },
    executable,
    args,
    options,
  );
  return { child: started.child, files: started.files };
}

/** What the run's handlers share while it lasts. */
interface RunState {
  pid: number | undefined;
  failure: string | null;
  closed: boolean;
}

/** Ends the run once its engine has used more than [param timeout] allows. */
async function killPastTimeout(
  child: { kill(): boolean },
  timeout: { readonly ms: number; readonly said: string },
  sample: () => Promise<Sample>,
  state: RunState,
  noticeEngine: () => void,
): Promise<void> {
  const spent = new Spent(nowSeconds(), await sample(), state.pid);
  while (!state.closed) {
    await delay(MEASURE_MS);
    noticeEngine();
    spent.counted(await sample(), state.pid);
    const at = nowSeconds();
    const past = spent.past(timeout.ms / 1000, at);
    if (past !== null) {
      state.failure ??= `it ran past its ${timeout.said}${countedBy(spent, past, at)}`;
      child.kill();
      return;
    }
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
  options: RunOptions,
  signal: AbortSignal | undefined,
): Promise<EngineRun> {
  return new Promise((resolve) => {
    const log = new GameLog();
    const { child, files } = launchOf(executable, args, lock, options.desktop, signal);
    belowNormal(child);
    const whole = holdExit(child.pid);
    // The engine itself, which on the hidden desktop the helper starts and writes down.
    const engineAt = (): number | undefined => (files === null ? child.pid : helperPid(files.pid));
    // The lock names this process, and what the engine starts runs on its slot only when it names
    // the engine too.
    if (child.pid !== undefined && files === null) {
      void nameSlotEngineOf(lock, process.pid, child.pid);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      log.append('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log.append('stderr', chunk);
    });
    const state: RunState = { pid: engineAt(), failure: null, closed: false };
    const found = (engine: number): void => {
      watching(engine, true);
      if (files !== null) {
        void nameSlotEngineOf(lock, process.pid, engine);
      }
    };
    const noticeEngine = (): void => {
      if (state.pid !== undefined) {
        return;
      }
      state.pid = engineAt();
      if (state.pid !== undefined) {
        found(state.pid);
      }
    };
    if (state.pid !== undefined) {
      found(state.pid);
    }
    const { timeout } = options;
    if (timeout !== undefined && child.pid !== undefined) {
      void killPastTimeout(child, timeout, options.sample ?? sampled, state, noticeEngine);
    }
    child.on('error', (error) => {
      state.failure ??=
        error.name === 'AbortError' ? 'the call was cancelled' : `it could not be started: ${error.message}`;
    });
    child.on('close', (code, closedBy) => {
      state.closed = true;
      if (state.pid !== undefined) {
        watching(state.pid, false);
      }
      log.finish();
      // A process that never started has a libuv error number where its exit code would be.
      const started = child.pid !== undefined;
      const told = started ? whole(code) : null;
      const helperSaid = files === null ? null : helperFailure(files.error);
      if (helperSaid !== null) {
        state.failure ??= `it could not be started on a desktop of its own: ${helperSaid}`;
      }
      resolve({
        log,
        exitCode: files === null ? told : helperExit(files.exit, told),
        exitSignal: closedBy,
        failure: state.failure,
      });
    });
  });
}

/**
 * [param code] for a sentence: `exit code 3`, or `exit code 0xC0000005, an access violation, so it
 * crashed`. A runtime that keeps only the low byte, as Bun does, turns an access violation into a
 * plain 5.
 */
export function exitCodeText(code: number | null): string {
  if (code === null) {
    return 'exit code unknown';
  }
  if (code < 0xc0000000) {
    return `exit code ${code}`;
  }
  return `exit code 0x${code.toString(16).toUpperCase()}, ${windowsStatusOf(code)?.meaning ?? 'a Windows error status'}`;
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
