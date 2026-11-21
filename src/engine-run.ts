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
  childBoxNote,
  desktopBoxEnding,
  ensureHelperCompiled,
  type HelperFiles,
  HelperRefused,
  HIDDEN_DESKTOP,
  helperExit,
  helperFailure,
  helperPid,
  spawnOnDesktop,
} from './desktop.js';
import {
  CEILING_VARIABLE,
  ceilingBytes,
  type EngineGuard,
  engineMemory,
  memoryEndedSaid,
} from './engine-memory.js';
import { inASlot, nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { countedBy, nowSeconds, type Sample, Spent, sampled, watching } from './engine-spent.js';
import { errorMessage } from './errors.js';
import { GameLog } from './game-log.js';
import type { SpawnedGame } from './godot-process.js';
import { belowNormal } from './priority.js';
import { discard, scratchDirectory } from './scratch.js';
import { type ChildProcess, type SpawnOptions, spawnHidden } from './spawn.js';
import {
  CONSOLE_CLOSED,
  diedAsItStarted,
  ENGINE_STARTS,
  START_RETRY_MS,
  START_WINDOW_MS,
} from './start-race.js';
import { windowsStatusOf } from './suite-judge.js';
import { holdChildExit } from './whole-exit.js';

export interface EngineRun {
  /** Both streams, finished. */
  readonly log: GameLog;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** Why this server ended the run or could not start it, when it did either. */
  readonly failure: string | null;
  /** How many starts before this one crashed before printing past the banner: see {@link crashedAtStart}. */
  readonly crashedStarts?: number;
}

export { CONSOLE_CLOSED, ENGINE_STARTS };

/**
 * Whether [param run] is an engine that died as it started: ended by a Windows exception status
 * before it printed a line, or, for the status of the race, after its banner alone. A loaded machine
 * makes Godot do that now and then (0xC06D007F), and a headless call failed on it with "no output at
 * all". The engine's other threads run on while Windows reports the crash, so the banner can get out
 * first. The engine never reached the project, so starting it again repeats nothing.
 */
export function crashedAtStart(run: EngineRun): boolean {
  return (
    run.failure === null && run.exitSignal === null && diedAsItStarted(run.exitCode, linesOfLog(run.log))
  );
}

/**
 * Whether the engine behind [param game], a run a caller waits on that this server did not end, died
 * as it started: within {@link START_WINDOW_MS} of its start, since its output is no proof of how
 * far a run that lasted got.
 */
export function diedAtStartOf(game: SpawnedGame): boolean {
  return (
    game.exitSignal === null &&
    (game.endedAt ?? Date.now()) - game.startedAt <= START_WINDOW_MS &&
    diedAsItStarted(game.exitCode, linesOfLog(game.log))
  );
}

/**
 * The lines [param log] holds. It keeps a line with its severity word cut off, so one that was not
 * info gets it back, and a line that cannot be the banner stays one that is not.
 */
function linesOfLog(log: GameLog): string[] {
  return log
    .everything()
    .flatMap((entry) => [
      entry.severity === 'info' ? entry.text : `${entry.severity}: ${entry.text}`,
      ...entry.detail,
    ]);
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
  /** The project the engine runs for, which gives its slot the store class where its repository has it. */
  readonly project?: string;
}

/** How often the pid a helper writes for its engine is looked for. */
const ENGINE_PID_WAIT_MS = 10;

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
  let ceiling: number;
  try {
    ceiling = ceilingBytes();
  } catch (error) {
    return { log: new GameLog(), exitCode: null, exitSignal: null, failure: errorMessage(error) };
  }
  if (options.desktop !== undefined || process.platform === 'win32') {
    const compiled = await ensureHelperCompiled();
    if (compiled !== null) {
      return {
        log: new GameLog(),
        exitCode: null,
        exitSignal: null,
        failure: `it could not be started${options.desktop === undefined ? '' : ' on a desktop of its own'}: ${compiled}`,
      };
    }
  }
  try {
    return await inASlot(
      (lock) =>
        startedUntilItRuns(
          () => runStarted(executable, args, lock, options, signal, ceiling),
          signal,
          crashedAtStart,
        ),
      options.project,
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
  /** The folder this start made for the helper's files, to be removed once they are read. */
  readonly scratch: string | null;
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
  if (desktop === undefined && process.platform !== 'win32') {
    return { child: spawnHidden(executable, args, options), files: null, scratch: null };
  }
  // On Windows every engine starts through the helper, which puts it in its named job. Without a
  // desktop named it stays on the one in use.
  const scratch = desktop?.scratch ?? scratchDirectory('desktop');
  let started: ReturnType<typeof spawnOnDesktop>;
  try {
    started = spawnOnDesktop(
      {
        ...(desktop === undefined ? {} : { desktop: HIDDEN_DESKTOP }),
        directory: desktop?.directory ?? process.cwd(),
        endsWithHelper: true,
        ...(desktop === undefined ? { separateErrors: true } : {}),
        scratch,
        exit: join(scratch, 'exit'),
      },
      executable,
      args,
      options,
    );
  } catch (error) {
    if (desktop === undefined) {
      discard(scratch);
    }
    throw error;
  }
  return {
    child: started.child,
    files: started.files,
    scratch: desktop === undefined ? scratch : null,
  };
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
  engineNoticed: Promise<void>,
): Promise<void> {
  // The engine's own time is counted from the reading that has its pid, so the start through the
  // helper is not counted against it by the clock.
  await engineNoticed;
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
 * What the desktop helper says of the run's end, which the engine's own exit does not: it could not
 * start the engine, or it ended the engine on a box nobody can press. Null for an engine started
 * without the helper.
 */
function desktopFailure(files: HelperFiles | null, log: GameLog, desktop: boolean): string | null {
  if (files === null) {
    return null;
  }
  const helperSaid = helperFailure(files.error);
  if (helperSaid !== null) {
    return `it could not be started${desktop ? ' on a desktop of its own' : ''}: ${helperSaid}`;
  }
  const ended = desktopBoxEnding(log.all);
  const note = ended === null ? childBoxNote(log.all) : null;
  if (note !== null) {
    log.record('warning', note);
  }
  return ended;
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
  ceiling: number,
): Promise<EngineRun> {
  return new Promise((resolve) => {
    const log = new GameLog();
    let launched: Launch;
    try {
      launched = launchOf(executable, args, lock, options.desktop, signal);
    } catch (error) {
      if (!(error instanceof HelperRefused)) {
        throw error;
      }
      resolve({ log, exitCode: null, exitSignal: null, failure: error.message });
      return;
    }
    const { child, files, scratch } = launched;
    belowNormal(child);
    const whole = holdChildExit(child);
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
    let guard: EngineGuard | undefined;
    const found = (engine: number): void => {
      watching(engine, true);
      guard ??= engineMemory.guard(
        engine,
        ceiling,
        (end) => {
          state.failure ??= memoryEndedSaid(end, CEILING_VARIABLE);
          child.kill();
        },
        options.project === undefined ? undefined : { project: options.project, tool: 'headless' },
      );
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
    // Through the helper the engine's pid is written a moment after the start, and the lock and the
    // timeout both need it.
    const noticed = (async (): Promise<void> => {
      while (state.pid === undefined && !state.closed) {
        await delay(ENGINE_PID_WAIT_MS);
        noticeEngine();
      }
    })();
    const { timeout } = options;
    if (timeout !== undefined && child.pid !== undefined) {
      void killPastTimeout(child, timeout, options.sample ?? sampled, state, noticeEngine, noticed);
    }
    child.on('error', (error) => {
      state.failure ??=
        error.name === 'AbortError' ? 'the call was cancelled' : `it could not be started: ${error.message}`;
    });
    child.on('close', (code, closedBy) => {
      state.closed = true;
      guard?.release();
      if (state.pid !== undefined) {
        watching(state.pid, false);
      }
      log.finish();
      // A process that never started has a libuv error number where its exit code would be.
      const started = child.pid !== undefined;
      const told = started ? whole(code) : null;
      state.failure ??= desktopFailure(files, log, options.desktop !== undefined);
      // A helper that could not start the engine exits with a code of its own, which is no engine's.
      const exitCode =
        files === null ? told : helperFailure(files.error) === null ? helperExit(files.exit, told) : null;
      discard(scratch);
      resolve({
        log,
        exitCode,
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
  run: Pick<EngineRun, 'exitCode' | 'exitSignal' | 'failure' | 'crashedStarts'> & {
    readonly log?: GameLog;
  },
): string {
  if (run.failure !== null) {
    return run.exitSignal === null ? run.failure : `ended by ${run.exitSignal}, because ${run.failure}`;
  }
  if (run.exitSignal !== null) {
    return `ended by ${run.exitSignal}`;
  }
  const crashed = run.crashedStarts ?? 0;
  const code = exitCodeText(run.exitCode);
  if (crashed === 0) {
    return code;
  }
  // The earlier starts died as they started, by the rule that started them again. The last one is
  // read from its own output, since it can have run and printed.
  const lines = run.log === undefined ? null : linesOfLog(run.log);
  if (lines === null || !diedAsItStarted(run.exitCode, lines)) {
    const earlier = crashed === 1 ? 'start' : `${String(crashed)} starts`;
    return `${code}, and the ${earlier} before it died as ${crashed === 1 ? 'it' : 'they'} started, printing nothing past the banner`;
  }
  if (lines.length === 0) {
    return `${code}, and printed nothing on any of its ${String(crashed + 1)} starts`;
  }
  // One line is the banner, and only the status of the race is started again on that.
  return `${code}, and died as it started on each of its ${String(crashed + 1)} starts, printing nothing past its banner. Either the engine's start race or a library the project loads causes that`;
}
