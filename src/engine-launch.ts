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
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
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
import { Refusal } from './errors.js';
import { mainCheckoutOf } from './harnesses.js';
import { type ChildProcess, runHidden, spawnHidden } from './spawn.js';
import { type EngineEnd, type RunPrinted, readRun } from './suite-judge.js';
import { askWindows } from './windows-ask.js';

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
/** How long Windows is given to say how much it can still commit, on a machine the run may load. */
const COMMIT_ASK_MS = 15_000;
/** What the engine prints when an autoload did not start, after which nothing it does can mean anything. */
const AUTOLOAD_FAILED = 'Failed to instantiate an autoload';

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
    const said = await askWindows(
      '(Get-CimInstance Win32_OperatingSystem -Property FreeVirtualMemory).FreeVirtualMemory',
      COMMIT_ASK_MS,
    );
    const kilobytes = Number(said.trim());
    return Number.isFinite(kilobytes) && kilobytes > 0
      ? kilobytes * 1024
      : `it answered ${JSON.stringify(said.trim())}`;
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
 * their lines stay in the order printed, and waits for it, ending it once it has printed nothing for
 * [param silenceSeconds], has run past the run's deadline, or an autoload has failed to start. Its
 * user data is a `user` folder in [param directory], so two engines never write one save or
 * settings file.
 *
 * [param silenceIn] lengthens the silence for what was running as the engine fell silent, read from
 * what it had printed; it is asked only once a silence passes [param silenceSeconds], since a long
 * log is read whole each time.
 */
export async function watchedEngine(
  launch: EngineLaunch,
  args: readonly string[],
  directory: string,
  log: string,
  silenceSeconds: number,
  silenceIn?: (printed: RunPrinted) => number,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  const env = { ...process.env, APPDATA: user, XDG_DATA_HOME: user };
  const output = openSync(log, 'w');
  let child: ChildProcess;
  let stop: () => void;
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
      child = spawnHidden(wrapper.command, wrapper.args, {
        stdio: ['ignore', output, output],
        env: { ...env, [DESKTOP_VARIABLE]: HIDDEN_DESKTOP },
        cwd: directory,
      });
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
    closeSync(output);
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
  const finished = { now: false };
  void exited.then(() => {
    finished.now = true;
  });
  const reading = openSync(log, 'r');
  try {
    let size = 0;
    const started = Date.now();
    let lastGrowth = started;
    let text = '';
    // The silence allowed for what the log shows running, read once for each size it reaches.
    let allowed = { size: -1, seconds: silenceSeconds };
    while (!finished.now) {
      await delay(LOOK_MS);
      // Silence alone never ends an engine that keeps printing, such as a case warning every frame.
      const deadline = launch.deadlineSeconds;
      if (ended === null && deadline !== null && Date.now() - started > deadline * 1000) {
        const stoppedIn = readRun(text).stoppedIn;
        ended = `the engine ran past the ${String(deadline)} s deadline${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended`;
        stop();
      }
      const now = fstatSync(reading).size;
      if (now > size) {
        const chunk = Buffer.alloc(now - size);
        readSync(reading, chunk, 0, chunk.length, size);
        text += chunk.toString('utf8');
        size = now;
        lastGrowth = Date.now();
        if (ended === null && text.includes(AUTOLOAD_FAILED)) {
          ended = 'an autoload did not start, so the engine was ended rather than run without it';
          stop();
        }
      } else if (ended === null && Date.now() - lastGrowth > silenceSeconds * 1000) {
        if (allowed.size !== size) {
          allowed = {
            size,
            seconds:
              silenceIn === undefined ? silenceSeconds : Math.max(silenceSeconds, silenceIn(readRun(text))),
          };
        }
        if (Date.now() - lastGrowth <= allowed.seconds * 1000) {
          continue;
        }
        const { stoppedIn } = readRun(text);
        // A helper that never wrote the pid never started the engine, which is a start that hung.
        const unstarted =
          helper !== null && !existsSync(helper.pid)
            ? `, and it never started ${helper.how}: ${helperStep(helper.step)}`
            : '';
        ended = `the engine printed nothing for ${String(allowed.seconds)} s${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended${unstarted}`;
        stop();
      }
    }
  } finally {
    closeSync(reading);
    launch.running.delete(stop);
  }
  const { code, signal } = await exited;
  // Read as soon as it is known, while the machine is still as the engine left it.
  const freeBytes = code !== null && code >>> 0 >= WINDOWS_EXCEPTION ? freemem() : undefined;
  // The helper's own failure reaches only its file, and the exit code it leaves says nothing.
  const failed = helper === null ? null : helperFailure(helper.error);
  if (failed !== null && helper !== null) {
    ended ??= `the engine could not be started ${helper.how}: ${failed}`;
  }
  return { code, signal, ended, ...(freeBytes === undefined ? {} : { freeBytes }) };
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
