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
  writeSync,
} from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, exitOf } from './alive.js';
import {
  ensureHelperCompiled,
  HIDDEN_DESKTOP,
  helperExit,
  helperFailure,
  helperPid,
  helperStep,
  spawnOnDesktop,
} from './desktop.js';
import { diedAsItStarted, startedUntilItRuns } from './engine-run.js';
import { nameSlotEngineOf, onTheSlot } from './engine-slots.js';
import { countedBy, nowSeconds, type Sample, Spent, sampled, watching } from './engine-spent.js';
import { EngineUsageError, errorCode, errorMessage } from './errors.js';
import { mainCheckoutOf } from './harnesses.js';
import { wholeFlag } from './launch.js';
import { LOG_LIMIT_BYTES, readLog } from './log-read.js';
import { relativeWithin } from './paths.js';
import { keepPipelineCache, seedPipelineCache } from './pipeline-cache.js';
import { belowNormal } from './priority.js';
import { askProcessTable } from './process-table.js';
import { type ChildProcess, runHidden, spawnHidden } from './spawn.js';
import { type EngineEnd, type RunPrinted, readRun } from './suite-judge.js';

/** Most engines a run starts, whatever the machine has. */
export const MOST_ENGINES = 4;
/** The least time an engine may print nothing before it is ended. */
export const SILENCE_FLOOR_SECONDS = 300;

/** The least exit code that is a Windows exception status, such as 0xC0000005, read unsigned. */
export const WINDOWS_EXCEPTION = 0xc0000000;
/**
 * Memory left to the rest of the machine, and what an engine is taken to need while no peak is kept
 * for its suites.
 */
const MEMORY_KEPT = 4 * 1024 ** 3;
export const MEMORY_PER_ENGINE = 1.5 * 1024 ** 3;
const LOOK_MS = 500;

/** How long Windows is given to say how much it can still commit, on a machine the run may load. */
const COMMIT_ASK_MS = 15_000;
/** What the engine prints when an autoload did not start, after which nothing it does can mean anything. */
const AUTOLOAD_FAILED = 'Failed to instantiate an autoload';

/** How much of a growing log is read at a time while it is scanned. */
const SCAN_BYTES = 1024 * 1024;

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The engine `--godot` names, made whole against [param cwd]. The locator judges it. */
export function godotNamed(value: string | undefined, cwd: string): string | null {
  return value === undefined ? null : resolve(cwd, value);
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

/**
 * The version [param text] says, or null. It is the first line that is two or three numbers joined
 * by dots and then dotted words, the first starting with a letter, as `--version` prints it.
 */
export function versionPrinted(text: string): string | null {
  for (const line of text.split(/\r?\n/u)) {
    const version = line.trim();
    if (/^\d+\.\d+(?:\.\d+)?\.[A-Za-z][\w-]*(?:\.[\w-]+)*$/u.test(version)) {
      return version;
    }
  }
  return null;
}

export function versionNamed(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const version = value.replace(/^v/, '');
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version) && versionPrinted(version) !== version) {
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
  const inside = relativeWithin(projectPath, absolute);
  if (inside === null) {
    throw new EngineUsageError(`${entry} is not inside the project at ${projectPath}.`);
  }
  const path = `res://${inside}`;
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
 * run still going and the [param kept] most recent of those that have ended. Answers the directories
 * left because another process holds them, such as an engine that outlived its run.
 */
export function sweepRunDirectories(runs: string, kept = KEPT_RUN_DIRECTORIES): string[] {
  if (!existsSync(runs)) {
    return [];
  }
  const held: string[] = [];
  const remove = (entry: string): void => {
    try {
      rmSync(join(runs, entry), { recursive: true, force: true });
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) {
        throw error;
      }
      held.push(join(runs, entry));
    }
  };
  const ended: { entry: string; started: number }[] = [];
  for (const entry of readdirSync(runs)) {
    const named = /^(\d+)-(\d+)$/.exec(entry);
    const pid = Number(named?.[2]);
    if (!Number.isInteger(pid)) {
      remove(entry);
    } else if (!alive(pid)) {
      ended.push({ entry, started: Number(named?.[1]) });
    }
  }
  ended.sort((a, b) => b.started - a.started);
  for (const { entry } of ended.slice(kept)) {
    remove(entry);
  }
  return held;
}

/** The line for a run directory a sweep left: see {@link sweepRunDirectories}. */
export function heldRunSaid(directory: string): string {
  return `left ${directory}, which another process holds, such as an engine of that run still going`;
}

/** [param bytes] as gigabytes to one decimal place. */
export const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * How many of the [param most] engines asked for the machine has room for, given its [param
 * processors] and the memory [param available] past what it keeps, with what held it below
 * [param most] when something did, each taken at [param engine]'s bytes.
 */
export function roomFor(
  most: number,
  processors: number,
  available: number,
  said = 'of memory free',
  processorsSaid = `the machine has ${plural(processors, 'processor')}`,
  engine: { readonly bytes: number; readonly said: string } = {
    bytes: MEMORY_PER_ENGINE,
    said: 'taken for each engine',
  },
): { engines: number; held: string | undefined } {
  const byMemory = Math.floor((available - MEMORY_KEPT) / engine.bytes);
  const engines = Math.max(1, Math.min(most, processors, byMemory));
  if (engines >= most) {
    return { engines, held: undefined };
  }
  return {
    engines,
    held:
      byMemory < processors
        ? `the machine has ${gigabytes(Math.max(0, available))} ${said}, ${gigabytes(MEMORY_KEPT)} of it kept for everything else and ${gigabytes(engine.bytes)} ${engine.said}`
        : processorsSaid,
  };
}

/**
 * Whether the memory [param available] has room for an engine needing [param need], past what the
 * machine keeps and the [param owed] bytes the going engines have yet to take.
 */
export function roomForAnother(available: number, owed: number, need: number): boolean {
  return available - MEMORY_KEPT - owed >= need;
}

/** The memory the machine can give engines, how the line on room words it, and why a reading failed. */
interface MemoryRoom {
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
 * ullAvailPageFile. Null off Windows, or why Windows did not say.
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
    return errorMessage(error);
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
  // One iterator for every lane, so each item is taken by whichever lane is free first, and once.
  const queue = items.entries();
  const lane = async (): Promise<void> => {
    for (const [index, item] of queue) {
      answers[index] = await run(item, index);
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
 * taskset, which execs the command in its own place so the pid is the engine's. As they are
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

/** Where util-linux puts setpriv: see {@link endingWithRunner}. */
const SETPRIV_PATHS = ['/usr/bin/setpriv', '/bin/setpriv'];

/**
 * [param command] and [param args] killed by the kernel once the process starting them has gone,
 * through setpriv on Linux, which execs the command in its own place so the pid is the engine's. As
 * they are where Linux has no setpriv, and on macOS, which has no such signal. Windows ties the
 * engine to the runner through the helper's job.
 */
export function endingWithRunner(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  setpriv: string | null = SETPRIV_PATHS.find((path) => existsSync(path)) ?? null,
): { command: string; args: string[] } {
  return platform !== 'linux' || setpriv === null
    ? { command, args: [...args] }
    : { command: setpriv, args: ['--pdeathsig', 'KILL', '--', command, ...args] };
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
 * what it had printed. It is asked only once a silence passes [param silenceSeconds], since the log
 * is read again each time.
 *
 * [param holds] is told each reading of what the engine holds.
 *
 * An engine that dies as it starts, with a Windows exception status before printing a line, is
 * started again, as a headless call's is: a suite run failed on 0xC06D007F with every suite unrun.
 */
export async function watchedEngine(
  launch: EngineLaunch,
  lock: string,
  args: readonly string[],
  directory: string,
  log: string,
  silenceSeconds: number,
  silenceIn?: (printed: RunPrinted) => number,
  holds?: (bytes: number) => void,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  seedPipelineCache(user, launch.projectPath, launch.godotPath);
  try {
    return await startedUntilItRuns(
      () => engineWatchedOnce(launch, lock, args, directory, log, silenceSeconds, silenceIn, holds),
      undefined,
      (end) => end.ended === null && end.signal === null && diedAsItStarted(end.code, readLog(log) === ''),
    );
  } finally {
    await keepPipelineCache(user, launch.projectPath, launch.godotPath);
  }
}

async function engineWatchedOnce(
  launch: EngineLaunch,
  lock: string,
  args: readonly string[],
  directory: string,
  log: string,
  silenceSeconds: number,
  silenceIn?: (printed: RunPrinted) => number,
  holds?: (bytes: number) => void,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  const env = onTheSlot({ ...process.env, APPDATA: user, XDG_DATA_HOME: user }, lock);
  const output = openSync(log, 'w');
  const started = await startEngine({ launch, args, directory, output, env });
  if (started.kind === 'refused') {
    return started.end;
  }
  const { child, stop, piped } = started;
  launch.running.add(stop);
  const outcome: { ended: string | null } = { ended: null };
  const exited = Promise.race([
    exitOf(child),
    new Promise<{ code: null; signal: null }>((settle) => {
      child.once('error', (error: Error) => {
        outcome.ended ??= `the engine did not start: ${error.message}`;
        settle({ code: null, signal: null });
      });
    }),
  ]);
  const copied = piped === null ? null : copiedInto(output, piped, exited);
  const finished = { now: false };
  void exited.then(() => {
    finished.now = true;
  });
  const reading = openSync(log, 'r');
  const engine = engineAt(started);
  if (engine !== undefined) {
    foundEngine(lock, engine);
  }
  let watch: Watch | undefined;
  try {
    const sample = launch.sample ?? sampled;
    const first = await sample();
    watch = {
      launch,
      lock,
      log,
      started,
      reading,
      finished,
      outcome,
      silenceSeconds,
      silenceIn,
      holds,
      sample,
      running: new Spent(nowSeconds(), first, engine),
      quiet: new Spent(nowSeconds(), first, engine),
      pid: engine,
      peakBytes: 0,
      size: 0,
      // The end of what was scanned, so a marker split between two reads is still found.
      carried: '',
      // The silence allowed for what the log shows running, read once for each size it reaches.
      allowed: { size: -1, seconds: silenceSeconds },
    };
    while (!finished.now) {
      await delay(LOOK_MS);
      await lookAtTheEngine(watch);
    }
  } catch (error) {
    // Ended before the failure goes on, since nothing else holds a way to end it once this returns.
    stop();
    throw error;
  } finally {
    closeSync(reading);
    launch.running.delete(stop);
    const pid = watch?.pid ?? engine;
    if (pid !== undefined) {
      watching(pid, false);
    }
  }
  return await endOfTheEngine({
    started,
    told: await exited,
    copied,
    output,
    outcome,
    peakBytes: watch.peakBytes,
  });
}

/** The files the hidden desktop's helper leaves, and where it was asked to start the engine. */
interface HelperFiles {
  readonly error: string;
  readonly how: string;
  readonly pid: string;
  readonly step: string;
  readonly exit: string;
}

/** An engine as started: its process, how to end it, the streams to copy into the log and its helper. */
interface StartedEngine {
  readonly kind: 'started';
  readonly child: ChildProcess;
  readonly stop: () => void;
  readonly piped: readonly Readable[] | null;
  readonly helper: HelperFiles | null;
}

/** What starting an engine came to: a running engine, or the end it was refused with. */
type Started = StartedEngine | { readonly kind: 'refused'; readonly end: EngineEnd };

/** What starting an engine needs: its launch and arguments, the folder it works in and the log's handle. */
interface EngineStart {
  readonly launch: EngineLaunch;
  readonly args: readonly string[];
  readonly directory: string;
  readonly output: number;
  readonly env: NodeJS.ProcessEnv;
}

/** Starts the engine, closing the log's handle where nothing is left to write into it. */
async function startEngine(start: EngineStart): Promise<Started> {
  let started: Started | undefined;
  try {
    // On Windows every engine on a desktop of its own, headless too: an engine that fails to start
    // shows a modal alert even with --headless, and on the desktop in use that takes the keyboard of
    // whoever is working there. The helper also clears the bit that keeps a crash from being reported.
    started = process.platform === 'win32' ? await startOnHiddenDesktop(start) : startOnThisDesktop(start);
    return started;
  } finally {
    if (started?.kind !== 'started' || started.piped === null) {
      closeSync(start.output);
    }
  }
}

/** The engine started through the helper, on a desktop of its own. */
async function startOnHiddenDesktop(start: EngineStart): Promise<Started> {
  const { launch, args, directory, env } = start;
  const where = 'on a desktop of its own';
  const compiled = await ensureHelperCompiled();
  if (compiled !== null) {
    return {
      kind: 'refused',
      end: { code: null, signal: null, ended: `the engine could not be started ${where}: ${compiled}` },
    };
  }
  const how = {
    desktop: HIDDEN_DESKTOP,
    directory: launch.projectPath,
    endsWithHelper: true,
    scratch: directory,
    stop: join(directory, 'stop'),
    exit: join(directory, 'exit'),
    ...(launch.cores === null ? {} : { affinity: (1n << BigInt(launch.cores)) - 1n }),
  };
  // A pipe, copied into the log here: an engine on Windows spends 1.5 to 4 ms on every line it
  // writes to a file and 0.04 ms on one written to a pipe, and gdUnit4 prints a dozen a case. The
  // helper hands the engine its stdout for both streams, so their lines stay in order.
  const onDesktop = spawnOnDesktop(how, launch.godotPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: directory,
  });
  const helped = onDesktop.child;
  return {
    kind: 'started',
    child: helped,
    stop: () => {
      onDesktop.stop();
    },
    piped: [helped.stdout, helped.stderr].filter((stream): stream is Readable => stream !== null),
    helper: {
      error: onDesktop.files.error,
      how: where,
      pid: onDesktop.files.pid,
      step: onDesktop.files.step,
      exit: onDesktop.files.exit,
    },
  };
}

/** The engine started directly, its streams written to the log's handle. */
function startOnThisDesktop(start: EngineStart): StartedEngine {
  const { launch, args, output, env } = start;
  const ending = endingWithRunner(launch.godotPath, args);
  const held = heldToCores(launch.cores, ending.command, ending.args);
  const child = spawnHidden(held.command, held.args, {
    stdio: ['ignore', output, output],
    env,
    cwd: launch.projectPath,
    detached: true,
  });
  belowNormal(child);
  return {
    kind: 'started',
    child,
    stop: () => {
      endTree(child);
    },
    piped: null,
    helper: null,
  };
}

/** The engine itself: the hidden desktop's helper starts it and writes its pid down. */
function engineAt(started: StartedEngine): number | undefined {
  return started.helper === null ? started.child.pid : helperPid(started.helper.pid);
}

/**
 * Names [param engine] in the lock as well, since the lock names this process, and what the engine
 * starts runs on its slot only when the lock names the engine.
 */
function foundEngine(lock: string, engine: number): void {
  watching(engine, true, true);
  void nameSlotEngineOf(lock, process.pid, engine);
}

/** What the watch of one engine keeps from one look to the next. */
interface Watch {
  readonly launch: EngineLaunch;
  readonly lock: string;
  readonly log: string;
  readonly started: StartedEngine;
  /** The handle the log is read through. */
  readonly reading: number;
  readonly finished: { readonly now: boolean };
  /** Why the watch ended the engine, once it has. */
  readonly outcome: { ended: string | null };
  readonly silenceSeconds: number;
  readonly silenceIn: ((printed: RunPrinted) => number) | undefined;
  readonly holds: ((bytes: number) => void) | undefined;
  readonly sample: () => Promise<Sample>;
  readonly running: Spent;
  readonly quiet: Spent;
  pid: number | undefined;
  peakBytes: number;
  size: number;
  carried: string;
  allowed: { size: number; seconds: number };
}

/** One look at the engine: its pid, what it holds, whether it is past a limit and what the log has gained. */
async function lookAtTheEngine(watch: Watch): Promise<void> {
  if (watch.pid === undefined) {
    watch.pid = engineAt(watch.started);
    if (watch.pid !== undefined) {
      foundEngine(watch.lock, watch.pid);
    }
  }
  const taken = await watch.sample();
  const holding = watch.pid === undefined ? undefined : taken.held?.get(watch.pid);
  if (holding !== undefined && holding > 0) {
    watch.peakBytes = Math.max(watch.peakBytes, holding);
    watch.holds?.(holding);
  }
  watch.running.counted(taken, watch.pid);
  watch.quiet.counted(taken, watch.pid);
  const at = nowSeconds();
  // An engine that exited while the sample was taken has no processor time left to read, so
  // its last stretch counts by the clock and could put past a limit an engine that finished
  // within it.
  // The hidden desktop's helper exits a moment after the engine it started.
  const gone = watch.finished.now || (watch.pid !== undefined && !alive(watch.pid));
  endIfPastTheDeadline(watch, gone, at);
  const now = fstatSync(watch.reading).size;
  if (now > watch.size) {
    scanWhatTheLogGained(watch, now, at);
  } else if (watch.outcome.ended === null && !gone && watch.quiet.past(watch.silenceSeconds, at) !== null) {
    endIfSilent(watch, at);
  }
}

/** Ends the engine once it has run past the run's deadline. */
function endIfPastTheDeadline(watch: Watch, gone: boolean, at: number): void {
  // Silence alone never ends an engine that keeps printing, such as a case warning every frame.
  const deadline = watch.launch.deadlineSeconds;
  const over = deadline === null || gone ? null : watch.running.past(deadline, at);
  if (watch.outcome.ended === null && deadline !== null && over !== null) {
    const stoppedIn = readRun(readLog(watch.log)).stoppedIn;
    watch.outcome.ended = `the engine ran past the ${String(deadline)} s deadline${countedBy(watch.running, over, at)}${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended`;
    watch.started.stop();
  }
}

/** Reads what the log gained up to [param now], ending the engine on a failed autoload or an oversized log. */
function scanWhatTheLogGained(watch: Watch, now: number, at: number): void {
  const chunk = Buffer.alloc(SCAN_BYTES);
  for (let offset = watch.size; offset < now; ) {
    const got = readSync(watch.reading, chunk, 0, Math.min(SCAN_BYTES, now - offset), offset);
    if (got === 0) {
      break;
    }
    const scanned = watch.carried + chunk.toString('utf8', 0, got);
    if (watch.outcome.ended === null && scanned.includes(AUTOLOAD_FAILED)) {
      watch.outcome.ended = 'an autoload did not start, so the engine was ended rather than run without it';
      watch.started.stop();
    }
    watch.carried = scanned.slice(-AUTOLOAD_FAILED.length);
    offset += got;
  }
  watch.size = now;
  watch.quiet.restart(at);
  if (watch.outcome.ended === null && watch.size > LOG_LIMIT_BYTES) {
    watch.outcome.ended = `the engine printed more than the ${String(LOG_LIMIT_BYTES / 1024 / 1024)} MiB a log may hold, so it was ended`;
    watch.started.stop();
  }
}

/** Ends the engine once it has printed nothing for as long as what it was running is allowed. */
function endIfSilent(watch: Watch, at: number): void {
  if (watch.allowed.size !== watch.size) {
    watch.allowed = {
      size: watch.size,
      seconds:
        watch.silenceIn === undefined
          ? watch.silenceSeconds
          : Math.max(watch.silenceSeconds, watch.silenceIn(readRun(readLog(watch.log)))),
    };
  }
  const silent = watch.quiet.past(watch.allowed.seconds, at);
  if (silent === null) {
    return;
  }
  const { stoppedIn } = readRun(readLog(watch.log));
  const { helper } = watch.started;
  // A helper that never wrote the pid never started the engine, which is a start that hung.
  const unstarted =
    helper !== null && !existsSync(helper.pid)
      ? `, and it never started ${helper.how}: ${helperStep(helper.step)}`
      : '';
  watch.outcome.ended = `the engine printed nothing for ${String(watch.allowed.seconds)} s${countedBy(watch.quiet, silent, at)}${stoppedIn === null ? '' : ` while running ${stoppedIn}`}, so it was ended${unstarted}`;
  watch.started.stop();
}

/** What the end of one engine needs to be told. */
interface EngineFinish {
  readonly started: StartedEngine;
  readonly told: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  readonly copied: Promise<void> | null;
  readonly output: number;
  readonly outcome: { ended: string | null };
  readonly peakBytes: number;
}

/** How the engine ended, once its process has exited and its streams are copied into the log. */
async function endOfTheEngine(finish: EngineFinish): Promise<EngineEnd> {
  const { started, told, copied, output, outcome, peakBytes } = finish;
  const { helper } = started;
  const code = helper === null ? told.code : helperExit(helper.exit, told.code);
  const { signal } = told;
  // Read as soon as it is known, while the machine is still as the engine left it.
  const freeBytes = code !== null && code >>> 0 >= WINDOWS_EXCEPTION ? freemem() : undefined;
  if (copied !== null) {
    await copied;
    closeSync(output);
  }
  // The helper's own failure reaches only its file, and the exit code it leaves says nothing.
  const failed = helper === null ? null : helperFailure(helper.error);
  if (failed !== null && helper !== null) {
    outcome.ended ??= `the engine could not be started ${helper.how}: ${failed}`;
  }
  return {
    code,
    signal,
    ended: outcome.ended,
    ...(freeBytes === undefined ? {} : { freeBytes }),
    ...(peakBytes > 0 ? { peakBytes } : {}),
  };
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
