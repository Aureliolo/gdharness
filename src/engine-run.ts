/**
 * One engine run to its end, with what it printed read as it arrives.
 *
 * Streamed rather than collected by execFile, because execFile kills a process that prints past
 * its buffer and reports that as the process failing: a healthy import pass on a large project, or
 * a boot that warns once per resource, was ended by Node and answered as an engine fault.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { callSignal } from './call-signal.js';
import {
  DESKTOP_VARIABLE,
  ensureHelperCompiled,
  type HelperFiles,
  HIDDEN_DESKTOP,
  helperExit,
  helperFailure,
  helperPid,
  throughHelper,
} from './desktop.js';
import { inASlot, nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { countedBy, nowSeconds, type Sample, Spent, sampled, watching } from './engine-spent.js';
import { errorMessage } from './errors.js';
import { GameLog } from './game-log.js';
import { belowNormal } from './priority.js';
import { spawnHidden } from './spawn.js';
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
    let failure: string | null = null;
    let command = executable;
    let spawned: readonly string[] = args;
    let env = onTheSlot(process.env, lock);
    let files: HelperFiles | null = null;
    const { desktop } = options;
    if (desktop !== undefined) {
      const at = (name: string): string => join(desktop.scratch, name);
      files = {
        spec: at('spec'),
        pid: at('pid'),
        error: at('error'),
        stop: '',
        step: at('step'),
        exit: at('exit'),
      };
      // A start after one that crashed must not read that one's files.
      for (const file of [files.pid, files.error, files.step, files.exit]) {
        rmSync(file, { force: true });
      }
      const wrapper = throughHelper(
        { desktop: HIDDEN_DESKTOP, directory: desktop.directory, endsWithHelper: true },
        executable,
        args,
        files,
      );
      command = wrapper.command;
      spawned = wrapper.args;
      env = { ...env, [DESKTOP_VARIABLE]: HIDDEN_DESKTOP };
    }
    const child = spawnHidden(command, spawned, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(signal === undefined ? {} : { signal }),
    });
    belowNormal(child);
    const whole = holdExit(child.pid);
    // The engine itself, which on the hidden desktop the helper starts and writes down.
    const engineAt = (): number | undefined => {
      if (files === null) {
        return child.pid;
      }
      return helperPid(files.pid);
    };
    // The lock names this process, and what the engine starts runs on its slot only when it names
    // the engine too.
    if (child.pid !== undefined && files === null) {
      void nameSlotEngineOf(lock, process.pid, child.pid);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      log.append('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      log.append('stderr', chunk);
    });
    const closed = { now: false };
    const { timeout } = options;
    let pid = engineAt();
    const found = (engine: number): void => {
      watching(engine, true);
      if (files !== null) {
        void nameSlotEngineOf(lock, process.pid, engine);
      }
    };
    if (pid !== undefined) {
      found(pid);
    }
    if (timeout !== undefined && child.pid !== undefined) {
      const sample = options.sample ?? sampled;
      void (async () => {
        const spent = new Spent(nowSeconds(), await sample(), pid);
        while (!closed.now) {
          await delay(MEASURE_MS);
          if (pid === undefined) {
            pid = engineAt();
            if (pid !== undefined) {
              found(pid);
            }
          }
          spent.counted(await sample(), pid);
          const at = nowSeconds();
          const past = spent.past(timeout.ms / 1000, at);
          if (past !== null) {
            failure ??= `it ran past its ${timeout.said}${countedBy(spent, past, at)}`;
            child.kill();
            return;
          }
        }
      })();
    }
    child.on('error', (error) => {
      failure ??=
        error.name === 'AbortError' ? 'the call was cancelled' : `it could not be started: ${error.message}`;
    });
    child.on('close', (code, closedBy) => {
      closed.now = true;
      if (pid !== undefined) {
        watching(pid, false);
      }
      log.finish();
      // A process that never started has a libuv error number where its exit code would be.
      const started = child.pid !== undefined;
      const told = started ? whole(code) : null;
      if (files !== null) {
        const helperSaid = helperFailure(files.error);
        if (helperSaid !== null) {
          failure ??= `it could not be started on a desktop of its own: ${helperSaid}`;
        }
      }
      resolve({
        log,
        exitCode: files === null ? told : helperExit(files.exit, told),
        exitSignal: closedBy,
        failure,
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
