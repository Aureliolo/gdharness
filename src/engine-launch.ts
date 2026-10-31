/**
 * Starting and watching the engines a command runs on its own, shared by `gdharness test` and
 * `gdharness spread`: the options both read, how many engines the machine has room for, and one
 * engine started on a desktop of its own and ended when it goes silent or runs past its deadline.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, exitOf } from './alive.js';
import {
  DESKTOP_VARIABLE,
  ensureHelperCompiled,
  HIDDEN_DESKTOP,
  helperFailure,
  helperStep,
  throughHelper,
} from './desktop.js';
import { nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { nowSeconds, type Past, type Sample, Spent, STARVED, sampled, watching } from './engine-spent.js';
import { Refusal } from './errors.js';
import { mainCheckoutOf } from './harnesses.js';
import { LOG_LIMIT_BYTES, readLog } from './log-read.js';
import { askProcessTable } from './process-table.js';
import { type ChildProcess, runHidden, spawnHidden } from './spawn.js';
import { type EngineEnd, type RunPrinted, readRun } from './suite-judge.js';

/** A command line `test` or `spread` cannot act on, which the CLI answers with exit code 2. */
export class EngineUsageError extends Refusal {}

/** Most engines a run starts, whatever the machine has. */
export const MOST_ENGINES = 4;
/** The least time an engine may print nothing before it is ended. */
export const SILENCE_FLOOR_SECONDS = 300;
/**
 * A terminal control sequence. gdUnit4 opens its output by clearing the screen, which printed as it
 * stands would wipe the lines the run had printed before it.
 */
export const CONTROL_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** The least exit code that is a Windows exception status, such as 0xC0000005, read unsigned. */
const WINDOWS_EXCEPTION = 0xc0000000;
/** Memory left to the rest of the machine, and what each engine is taken to need. */
const MEMORY_KEPT = 4 * 1024 ** 3;
const MEMORY_PER_ENGINE = 1.5 * 1024 ** 3;
const LOOK_MS = 500;

/**
 * How [param spent] came past its limit at [param at], said only when other work crowded the
 * machine, since the plain seconds are then not the clock's.
 */
export function countedBy(spent: Spent, past: Past, at: number): string {
  const clock = Math.round(spent.clock(at));
  if (past === 'clock') {
    return `, ${String(STARVED)} times over on the clock (${String(clock)} s), the machine kept busy by other work`;
  }
  return spent.byWork === 0
    ? ''
    : ` of its own, counted by its processor time while other work kept the machine busy (${String(clock)} s on the clock)`;
}

/** How long Windows is given to say how much it can still commit, on a machine the run may load. */
const COMMIT_ASK_MS = 15_000;
/** What the engine prints when an autoload did not start, after which nothing it does can mean anything. */
const AUTOLOAD_FAILED = 'Failed to instantiate an autoload';

/** How much of a growing log is read at a time while it is scanned. */
const SCAN_BYTES = 1024 * 1024;

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** [param value] as a whole number above 0, null when [param flag] was not given. */
export function wholeFlag(value: string | undefined, flag: string): number | null {
  if (value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new EngineUsageError(`${flag} takes a whole number above 0, not ${value}.`);
  }
  return number;
}

export function godotNamed(value: string | undefined, cwd: string): string | null {
  if (value === undefined) {
    return null;
  }
  const path = resolve(cwd, value);
  if (!existsSync(path) || statSync(path).isDirectory()) {
    throw new EngineUsageError(`--godot names ${path}, which is not an engine executable.`);
  }
  return path;
}

export function coresNamed(value: string | undefined): number | null {
  const cores = wholeFlag(value, '--cores');
  // A Windows affinity mask is one bit a processor of one group, which holds 64.
  const most = Math.min(availableParallelism(), 64);
  if (cores !== null && cores > most) {
    throw new EngineUsageError(
      `--cores ${String(cores)} is more than the ${String(most)} processors a run can be held to here.`,
    );
  }
  return cores;
}

export function versionNamed(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const version = value.replace(/^v/, '');
  if (!/^\d+\.\d+(?:\.\d+)?(?:\.[\w-]+)*$/.test(version)) {
    throw new EngineUsageError(
      `--godot-version takes a version such as 4.7.2 or 4.7.2.stable, not ${value}.`,
    );
  }
  return version;
}

/**
 * [param entry] as a `res://` path: as it is when it is one, else a path in the project, read from
 * [param cwd] only when it is there and not in the project, so a path that is nowhere is refused as
 * missing from the project rather than as outside it. A `:test_case` after a script stays.
 */
export function resPathOf(entry: string, projectPath: string, cwd: string): string {
  if (entry.startsWith('res://')) {
    return entry;
  }
  const caseAt = /^(.*\.gd):(\w+)$/.exec(entry);
  const file = caseAt?.[1] ?? entry;
  const fromProject = resolve(projectPath, file);
  const fromHere = resolve(cwd, file);
  const absolute =
    isAbsolute(file) || (!existsSync(fromProject) && existsSync(fromHere)) ? fromHere : fromProject;
  const inside = relative(projectPath, absolute);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new EngineUsageError(`${entry} is not inside the project at ${projectPath}.`);
  }
  const path = `res://${inside.split(sep).join('/')}`;
  return caseAt === null ? path : `${path}:${caseAt[2] ?? ''}`;
}

/** Where a run keeps what outlives it: beside the main checkout when the project is a worktree of one. */
export function homeOf(projectPath: string): string {
  return mainCheckoutOf(projectPath) ?? projectPath;
}

/**
 * How many directories of runs that have ended a sweep leaves. A run that passes removes its own,
 * so those left are runs that failed or were cut off, and the next run is usually the one trying to
 * reproduce the failure: removing every one took the log of an engine that died mid-run with it.
 */
export const KEPT_RUN_DIRECTORIES = 5;

/**
 * Removes what earlier runs left in [param runs], each a `<start>-<pid>` directory, other than a
 * run still going and the [param kept] most recent of those that have ended.
 */
export function sweepRunDirectories(runs: string, kept = KEPT_RUN_DIRECTORIES): void {
  if (!existsSync(runs)) {
    return;
  }
  const ended: { entry: string; started: number }[] = [];
  for (const entry of readdirSync(runs)) {
    const named = /^(\d+)-(\d+)$/.exec(entry);
    const pid = Number(named?.[2]);
    if (!Number.isInteger(pid)) {
      rmSync(join(runs, entry), { recursive: true, force: true });
    } else if (!alive(pid)) {
      ended.push({ entry, started: Number(named?.[1]) });
    }
  }
  ended.sort((a, b) => b.started - a.started);
  for (const { entry } of ended.slice(kept)) {
    rmSync(join(runs, entry), { recursive: true, force: true });
  }
}

/**
 * How many of the [param most] engines asked for the machine has room for, given its [param
 * processors] and the memory [param available] past what it keeps, with what held it below
 * [param most] when something did.
 */
export function roomFor(
  most: number,
  processors: number,
  available: number,
  said = 'of memory free',
  processorsSaid = `the machine has ${plural(processors, 'processor')}`,
): { engines: number; held: string | undefined } {
  const byMemory = Math.floor((available - MEMORY_KEPT) / MEMORY_PER_ENGINE);
  const engines = Math.max(1, Math.min(most, processors, byMemory));
  if (engines >= most) {
    return { engines, held: undefined };
  }
  const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return {
    engines,
    held:
      byMemory < processors
        ? `the machine has ${gigabytes(Math.max(0, available))} ${said}, ${gigabytes(MEMORY_KEPT)} of it kept for everything else and ${gigabytes(MEMORY_PER_ENGINE)} taken for each engine`
        : processorsSaid,
  };
}

/**
 * Whether the memory [param available] has room for one more engine past what the machine keeps,
 * beside [param starting] engines started too lately for what they take to show in it yet.
 */
export function roomForAnother(available: number, starting: number): boolean {
  return available - MEMORY_KEPT - starting * MEMORY_PER_ENGINE >= MEMORY_PER_ENGINE;
}

/** The memory the machine can give engines, how the line on room words it, and why a reading failed. */
export interface MemoryRoom {
  readonly bytes: number;
  readonly said: string;
  readonly unread?: string;
}

/**
 * The memory the machine can give engines. freemem on macOS counts only the pages nobody holds,
 * a few hundred megabytes on a Mac whose file cache would give way at once, so a run there was held
 * to one engine whatever it asked for. The kernel's own share of memory it counts as free, the
 * percentage memory_pressure prints, includes what it can take back. Windows refuses an allocation
 * at the commit limit rather than at physical memory, and a machine with 23 GB free and 4.9 GB left
 * to commit started sixteen engines that died with STATUS_COMMITMENT_LIMIT, so there the smaller
 * of the two is the room.
 */
export async function memoryAvailable(): Promise<MemoryRoom> {
  const level = await macMemoryLevel();
  if (level !== null) {
    return { bytes: (totalmem() * level) / 100, said: 'of memory free' };
  }
  return memoryRoomOf(freemem(), await windowsCommitLeft());
}

/**
 * The room [param free] physical bytes and [param commit], what Windows can still commit (null
 * elsewhere, or why it did not say), leave engines: the smaller of the two.
 */
export function memoryRoomOf(free: number, commit: number | string | null): MemoryRoom {
  if (typeof commit === 'string') {
    return { bytes: free, said: 'of memory free', unread: commit };
  }
  return commit !== null && commit < free
    ? { bytes: commit, said: 'of memory left to commit' }
    : { bytes: free, said: 'of memory free' };
}

/**
 * How much more Windows will commit, in bytes, which is what GlobalMemoryStatusEx answers as
 * ullAvailPageFile; null off Windows, or why Windows did not say.
 */
export async function windowsCommitLeft(): Promise<number | string | null> {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const said = await askProcessTable('CommitLeft()', COMMIT_ASK_MS);
    const bytes = Number(said.trim());
    return Number.isFinite(bytes) && bytes > 0 ? bytes : `it answered ${JSON.stringify(said.trim())}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The percentage of memory macOS counts as free, or null off macOS or when it would not say. */
export async function macMemoryLevel(): Promise<number | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const level = Number((await runHidden('sysctl', ['-n', 'kern.memorystatus_level'])).stdout.trim());
    return Number.isFinite(level) && level > 0 && level <= 100 ? level : null;
  } catch {
    return null;
  }
}

/** [param run] over every one of [param items], [param at] at most at a time, answered in their order. */
export async function inTurns<T, R>(
  items: readonly T[],
  at: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await run(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(at, items.length)) }, lane));
  return answers;
}

/** What starting an engine needs, the same for every engine of a run. */
export interface EngineLaunch {
  readonly godotPath: string;
  readonly projectPath: string;
  /** The most seconds one engine may run, printing or not, or null for no limit. */
  readonly deadlineSeconds: number | null;
  /** How to end each engine still running, for a run that is interrupted. */
  readonly running: Set<() => void>;
  /** How many processors, the first ones, every engine is held to, or null for all. */
  readonly cores: number | null;
  /** Where readings of the machine and the engines come from, for a machine held free or crowded. */
  readonly sample?: () => Promise<Sample>;
}

/**
 * [param command] and [param args] held to the first [param cores] processors on Linux, through
 * taskset, which execs the command in its own place so the pid is the engine's; as they are
 * elsewhere, since Windows holds a process through the helper and macOS cannot.
 */
export function heldToCores(
  cores: number | null,
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  return cores === null || platform !== 'linux'
    ? { command, args: [...args] }
    : { command: 'taskset', args: ['-c', `0-${String(cores - 1)}`, command, ...args] };
}

/**
 * Starts the engine with [param args], both its streams into [param log] through one handle so
 * their lines stay in the order printed (on Windows one pipe, copied into the log), and waits for it, ending it once it has printed nothing for
 * [param silenceSeconds], has run past the run's deadline, has printed more than
 * {@link LOG_LIMIT_BYTES}, or an autoload has failed to start. Its
 * user data is a `user` folder in [param directory], so two engines never write one save or
 * settings file.
 *
 * [param silenceIn] lengthens the silence for what was running as the engine fell silent, read from
 * what it had printed; it is asked only once a silence passes [param silenceSeconds], since the log
 * is read again each time.
 */
export async function watchedEngine(
  launch: EngineLaunch,
  lock: string,
  args: readonly string[],
  directory: string,
  log: string,
  silenceSeconds: number,
  silenceIn?: (printed: RunPrinted) => number,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  const env = onTheSlot({ ...process.env, APPDATA: user, XDG_DATA_HOME: user }, lock);
  const output = openSync(log, 'w');
  let child: ChildProcess;
  let stop: () => void;
  let piped: readonly Readable[] | null = null;
  let helper: {
    readonly error: string;
    readonly how: string;
    readonly pid: string;
    readonly step: string;
  } | null = null;
  try {
    // On Windows every engine on a desktop of its own, headless too: an engine that fails to start
    // shows a modal alert even with --headless, and on the desktop in use that takes the keyboard of
    // whoever is working there. The helper also clears the bit that keeps a crash from being reported.
    if (process.platform === 'win32') {
      const where = 'on a desktop of its own';
      const compiled = await ensureHelperCompiled();
      if (compiled !== null) {
        return { code: null, signal: null, ended: `the engine could not be started ${where}: ${compiled}` };
      }
      const stopFile = join(directory, 'stop');
      const error = join(directory, 'error');
      helper = { error, how: where, pid: join(directory, 'pid'), step: join(directory, 'step') };
      const how = {
        desktop: HIDDEN_DESKTOP,
        directory: launch.projectPath,
        ...(launch.cores === null ? {} : { affinity: (1n << BigInt(launch.cores)) - 1n }),
      };
      const wrapper = throughHelper(how, launch.godotPath, args, {
        spec: join(directory, 'spec'),
        pid: helper.pid,
        error,
        stop: stopFile,
        step: helper.step,
      });
      // A pipe, copied into the log here: an engine on Windows spends 1.5 to 4 ms on every line it
      // writes to a file and 0.04 ms on one written to a pipe, and gdUnit4 prints a dozen a case. The
      // helper hands the engine its stdout for both streams, so their lines stay in order.
      const helped = spawnHidden(wrapper.command, wrapper.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, [DESKTOP_VARIABLE]: HIDDEN_DESKTOP },
        cwd: directory,
      });
      piped = [helped.stdout, helped.stderr];
      child = helped;
      stop = () => {
        writeFileSync(stopFile, '');
      };
    } else {
      const held = heldToCores(launch.cores, launch.godotPath, args);
      child = spawnHidden(held.command, held.args, {
        stdio: ['ignore', output, output],
        env,
        cwd: launch.projectPath,
        detached: true,
      });
      stop = () => {
        endTree(child);
      };
    }
  } finally {
    if (piped === null) {
      closeSync(output);
    }
  }
  launch.running.add(stop);
  let ended: string | null = null;
  const exited = Promise.race([
    exitOf(child),
    new Promise<{ code: null; signal: null }>((settle) => {
      child.once('error', (error: Error) => {
        ended ??= `the engine did not start: ${error.message}`;
        settle({ code: null, signal: null });
      });
    }),
  ]);
  const copied = piped === null ? null : copiedInto(output, piped, exited);
  const finished = { now: false };
  void exited.then(() => {
    finished.now = true;
  });
  // Read through a call, since the loop's own condition narrows the field for the code after an await.
  const hasFinished = (): boolean => finished.now;
  const reading = openSync(log, 'r');
  // The engine itself: the hidden desktop's helper starts it and writes its pid down.
  const engineAt = (): number | undefined => {
    if (helper === null) {
      return child.pid;
    }
    try {
      const pid = Number(readFileSync(helper.pid, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  // Named in the lock as well, since the lock names this process, and what the engine starts runs on
  // its slot only when the lock names the engine.
  const found = (engine: number): void => {
    watching(engine, true);
    void nameSlotEngineOf(lock, process.pid, engine);
  };
  let pid = engineAt();
  if (pid !== undefined) {
    found(pid);
  }
  try {
    let size = 0;
    const sample = launch.sample ?? sampled;
    const first = await sample();
    const running = new Spent(nowSeconds(), first, pid);
    const quiet = new Spent(nowSeconds(), first, pid);
    // The end of what was scanned, so a marker split between two reads is still found.
    let carried = '';
    // The silence allowed for what the log shows running, read once for each size it reaches.
    let allowed = { size: -1, seconds: silenceSeconds };
    while (!finished.now) {
      await delay(LOOK_MS);
      if (pid === undefined) {
        pid = engineAt();
        if (pid !== undefined) {
          found(pid);
        }
      }
      const taken = await sample();
      running.counted(taken, pid);
      quiet.counted(taken, pid);
      const at = nowSeconds();
      // An engine that exited while the sample was taken has no processor time left to read, so
      // its last stretch counts by the clock and could put past a limit an engine that finished
      // within it.
      // The hidden desktop's helper exits a moment after the engine it started.
      const gone = hasFinished() || (pid !== undefined && !alive(pid));
      // Silence alone never ends an engine that keeps printing, such as a case warning every frame.
      const deadline = launch.deadlineSeconds;
      const over = deadline === null || gone ? null : running.past(deadline, at);
      if (ended === null && deadline !== null && over !== null) {
        const stoppedIn = readRun(readLog(log)).stoppedIn;
        ended = `the engine ran past the ${String(deadline)} s deadline${countedBy(running, over, at)}${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended`;
        stop();
      }
      const now = fstatSync(reading).size;
      if (now > size) {
        const chunk = Buffer.alloc(SCAN_BYTES);
        for (let at = size; at < now; ) {
          const got = readSync(reading, chunk, 0, Math.min(SCAN_BYTES, now - at), at);
          if (got === 0) {
            break;
          }
          const scanned = carried + chunk.toString('utf8', 0, got);
          if (ended === null && scanned.includes(AUTOLOAD_FAILED)) {
            ended = 'an autoload did not start, so the engine was ended rather than run without it';
            stop();
          }
          carried = scanned.slice(-AUTOLOAD_FAILED.length);
          at += got;
        }
        size = now;
        quiet.restart(at);
        if (ended === null && size > LOG_LIMIT_BYTES) {
          ended = `the engine printed more than the ${String(LOG_LIMIT_BYTES / 1024 / 1024)} MiB a log may hold, so it was ended`;
          stop();
        }
      } else if (ended === null && !gone && quiet.past(silenceSeconds, at) !== null) {
        if (allowed.size !== size) {
          allowed = {
            size,
            seconds:
              silenceIn === undefined
                ? silenceSeconds
                : Math.max(silenceSeconds, silenceIn(readRun(readLog(log)))),
          };
        }
        const silent = quiet.past(allowed.seconds, at);
        if (silent === null) {
          continue;
        }
        const { stoppedIn } = readRun(readLog(log));
        // A helper that never wrote the pid never started the engine, which is a start that hung.
        const unstarted =
          helper !== null && !existsSync(helper.pid)
            ? `, and it never started ${helper.how}: ${helperStep(helper.step)}`
            : '';
        ended = `the engine printed nothing for ${String(allowed.seconds)} s${countedBy(quiet, silent, at)}${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended${unstarted}`;
        stop();
      }
    }
  } catch (error) {
    // Ended before the failure goes on, since nothing else holds a way to end it once this returns.
    stop();
    throw error;
  } finally {
    closeSync(reading);
    launch.running.delete(stop);
    if (pid !== undefined) {
      watching(pid, false);
    }
  }
  const { code, signal } = await exited;
  // Read as soon as it is known, while the machine is still as the engine left it.
  const freeBytes = code !== null && code >>> 0 >= WINDOWS_EXCEPTION ? freemem() : undefined;
  if (copied !== null) {
    await copied;
    closeSync(output);
  }
  // The helper's own failure reaches only its file, and the exit code it leaves says nothing.
  const failed = helper === null ? null : helperFailure(helper.error);
  if (failed !== null && helper !== null) {
    ended ??= `the engine could not be started ${helper.how}: ${failed}`;
  }
  return { code, signal, ended, ...(freeBytes === undefined ? {} : { freeBytes }) };
}

/**
 * How long the streams of an engine that has exited are drained for: a process it started and
 * handed them to holds them open, and the run would otherwise wait on that process.
 */
const DRAIN_MS = 5000;

/**
 * Writes everything [param streams] carry into [param output] as it arrives, and settles once all
 * have ended, or [param DRAIN_MS] after [param exited] settles for those still held open. A write
 * that fails stops the writing, not the reading, so the engine is never left blocked on a full pipe.
 */
function copiedInto(output: number, streams: readonly Readable[], exited: Promise<unknown>): Promise<void> {
  let writing = true;
  const ended = streams.map(
    (stream) =>
      new Promise<void>((settle) => {
        stream.on('data', (chunk: Buffer) => {
          if (!writing) {
            return;
          }
          try {
            writeSync(output, chunk);
          } catch {
            // The log then ends short, and the run is judged on what it holds.
            writing = false;
          }
        });
        stream.once('close', settle);
      }),
  );
  const all = Promise.all(ended).then(() => undefined);
  const drained = exited.then(() => delay(DRAIN_MS, undefined, { ref: false }));
  return Promise.race([all, drained]).then(() => {
    writing = false;
    for (const stream of streams) {
      stream.destroy();
    }
  });
}

/** Ends [param child] and everything it started: Godot's console build is a wrapper around the engine. */
function endTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    runHidden('taskkill', ['/T', '/F', '/PID', String(child.pid)]).catch(() => {
      // Gone already.
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}
