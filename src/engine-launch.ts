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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, exitOf } from './alive.js';
import { copiedInto } from './copied-into.js';
import {
  desktopBoxEnding,
  ensureHelperCompiled,
  HelperRefused,
  HIDDEN_DESKTOP,
  helperExit,
  helperFailure,
  helperPid,
  helperStep,
  spawnOnDesktop,
} from './desktop.js';
import {
  type Ceiling,
  ceilingFor,
  type EngineGuard,
  engineMemory,
  engineNeed,
  gigabytes,
  MEMORY_PER_ENGINE,
  memoryEndedSaid,
  startRefusedSaid,
} from './engine-memory.js';
import { startedUntilItRuns } from './engine-run.js';
import { handedOver, type ShareHandoff, shareMarker, shareText } from './engine-shares.js';
import { nameSlotEngineOf, onTheSlot, reservedMemory } from './engine-slots.js';
import { countedBy, nowSeconds, type Sample, Spent, sampled, watching } from './engine-spent.js';
import { EngineUsageError, errorCode, errorMessage } from './errors.js';
import { GameLog } from './game-log.js';
import { mainCheckoutOf } from './harnesses.js';
import { wholeFlag } from './launch.js';
import { LOG_LIMIT_BYTES, readLog } from './log-read.js';
import { relativeWithin } from './paths.js';
import { keepPipelineCache, seedPipelineCache } from './pipeline-cache.js';
import { belowNormal, priorityOf } from './priority.js';
import { askProcessTable } from './process-table.js';
import { type PeakTool, readEnginePeaks } from './run-record.js';
import { type ChildProcess, runHidden, spawnHidden } from './spawn.js';
import { diedAsItStarted, linesAsPrinted } from './start-race.js';
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

export { MEMORY_PER_ENGINE };

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
 * The file a passing run that kept only the logs of its slow cases leaves in its directory. A
 * directory without it counts as a failed or cut-off run, which is all an older release left.
 */
export const SLOW_RUN_MARK = 'slow-run';

/**
 * Removes what earlier runs left in [param runs], each a `<start>-<pid>` directory, other than a
 * run still going and the [param kept] most recent of those that have ended. Runs marked with
 * {@link SLOW_RUN_MARK} and the rest are counted apart, so neither kind pushes out the other. Answers
 * the directories left because another process holds them, such as an engine that outlived its run.
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
  const ended: { entry: string; started: number; slow: boolean }[] = [];
  for (const entry of readdirSync(runs)) {
    const named = /^(\d+)-(\d+)$/.exec(entry);
    const pid = Number(named?.[2]);
    if (!Number.isInteger(pid)) {
      remove(entry);
    } else if (!alive(pid)) {
      ended.push({
        entry,
        started: Number(named?.[1]),
        slow: existsSync(join(runs, entry, SLOW_RUN_MARK)),
      });
    }
  }
  ended.sort((a, b) => b.started - a.started);
  for (const slow of [false, true]) {
    for (const { entry } of ended.filter((one) => one.slow === slow).slice(kept)) {
      remove(entry);
    }
  }
  return held;
}

/** The line for a run directory a sweep left: see {@link sweepRunDirectories}. */
export function heldRunSaid(directory: string): string {
  return `left ${directory}, which another process holds, such as an engine of that run still going`;
}

export { gigabytes };

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
 * of the two is the room. What other work has reserved on the machine and still owes comes off
 * either ({@link reservedMemory}), since that memory is spoken for before it is taken.
 */
export async function memoryAvailable(): Promise<MemoryRoom> {
  const reserved = await reservedMemory();
  const level = await macMemoryLevel();
  if (level !== null) {
    return lessReserved({ bytes: (totalmem() * level) / 100, said: 'of memory free' }, reserved);
  }
  return memoryRoomOf(freemem(), await windowsCommitLeft(), reserved);
}

/**
 * Why an engine of [param tool] for [param project] is not started, or null: what the project's last
 * engine of that tool held (at most [param ceiling]) is more than the machine has left past what it
 * keeps and what other work has reserved. A project with no peak above the flat
 * figure is never refused, since that figure is an estimate and the machine's free memory alone
 * says nothing against it.
 */
export async function memoryRefusal(
  project: string,
  tool: PeakTool,
  ceiling: Ceiling,
  room: () => Promise<MemoryRoom> = memoryAvailable,
): Promise<string | null> {
  const need = engineNeed(readEnginePeaks(project)[tool], ceiling.bytes, tool);
  if (need.bytes <= MEMORY_PER_ENGINE) {
    return null;
  }
  const free = await room();
  return free.bytes - MEMORY_KEPT >= need.bytes ? null : startRefusedSaid(need, free, MEMORY_KEPT, ceiling);
}

/**
 * The room [param free] physical bytes and [param commit], what Windows can still commit (null
 * elsewhere, or why it did not say), leave engines: the smaller of the two, less the [param reserved]
 * bytes other work still owes.
 */
export function memoryRoomOf(free: number, commit: number | string | null, reserved = 0): MemoryRoom {
  if (typeof commit === 'string') {
    return lessReserved({ bytes: free, said: 'of memory free', unread: commit }, reserved);
  }
  return lessReserved(
    commit !== null && commit < free
      ? { bytes: commit, said: 'of memory left to commit' }
      : { bytes: free, said: 'of memory free' },
    reserved,
  );
}

/** [param room] less [param reserved] bytes, the line saying how much when any is. */
function lessReserved(room: MemoryRoom, reserved: number): MemoryRoom {
  return reserved > 0
    ? { ...room, bytes: room.bytes - reserved, said: `${room.said} after ${gigabytes(reserved)} reserved` }
    : room;
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

/**
 * [param run] over every one of [param items], [param at] at most at a time, answered in their
 * order. It is given its own lane's number, counting from 0.
 */
export async function inTurns<T, R>(
  items: readonly T[],
  at: number,
  run: (item: T, index: number, lane: number) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  // One iterator for every lane, so each item is taken by whichever lane is free first, and once.
  const queue = items.entries();
  const lane = async (_: unknown, number: number): Promise<void> => {
    for (const [index, item] of queue) {
      answers[index] = await run(item, index, number);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(at, items.length)) }, lane));
  return answers;
}

/** The file in an engine's run folder that names its lane and its own pid, which is its job's number too. */
export const LANE_FILE = 'lane.json';

/**
 * Writes [param lane] and [param pid] to the lane file in [param directory], under a temporary name
 * and then renamed, so a reader never sees half of it.
 */
export function writeLaneFile(directory: string, lane: number, pid: number): void {
  const file = join(directory, LANE_FILE);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ lane, pid })}\n`);
  renameSync(temporary, file);
}

/**
 * Gives [param to] the lane file of [param from], for the folder of a further share an engine is
 * handed: the engine and its lane are the same one, so the file says the same.
 */
export function carryLaneFile(from: string, to: string): void {
  const said = readFileSync(join(from, LANE_FILE), 'utf8');
  const temporary = join(to, `${LANE_FILE}.tmp`);
  writeFileSync(temporary, said);
  renameSync(temporary, join(to, LANE_FILE));
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
  /** The lane the engine runs in, counting from 0, which its `lane.json` names. Lane 0 where unset. */
  readonly lane?: number;
  /**
   * The name the engine's memory peak is kept under for the project, which the slot lock of the
   * next engine of that name counts. Kept nowhere where unset.
   */
  readonly peakKept?: PeakTool;
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
 * The lane the engine runs in is [code]launch.lane[/code], written with its pid to `lane.json` in
 * [param directory] before the engine runs.
 *
 * An engine that dies as it starts, with a Windows exception status before printing a line (or past
 * its banner, for 0xC06D007F), is started again, as a headless call's is: a suite run failed on
 * 0xC06D007F with every suite unrun.
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
  shares?: ShareHandoff,
): Promise<EngineEnd> {
  const user = join(directory, 'user');
  const seeded = await seedPipelineCache(user, launch.projectPath, launch.godotPath);
  try {
    return await startedUntilItRuns(
      () => engineWatchedOnce(launch, lock, args, directory, log, silenceSeconds, silenceIn, holds, shares),
      undefined,
      (end) =>
        end.ended === null && end.signal === null && diedAsItStarted(end.code, linesAsPrinted(readLog(log))),
    );
  } finally {
    await keepPipelineCache(user, launch.projectPath, launch.godotPath, undefined, seeded);
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
  shares?: ShareHandoff,
): Promise<EngineEnd> {
  let ceiling: Ceiling;
  try {
    ceiling = ceilingFor(launch.projectPath);
  } catch (error) {
    return { code: null, signal: null, ended: errorMessage(error) };
  }
  const user = join(directory, 'user');
  const env = onTheSlot({ ...process.env, APPDATA: user, XDG_DATA_HOME: user }, lock);
  const output = openSync(log, 'w');
  const lane = launch.lane ?? 0;
  const started = await startEngine({ launch, args, directory, lane, output, env });
  if (started.kind === 'refused') {
    return started.end;
  }
  // Windows has the helper write it before the engine runs. Elsewhere the pid is known as soon as
  // the start returns.
  if (process.platform !== 'win32' && started.child.pid !== undefined) {
    writeLaneFile(directory, lane, started.child.pid);
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
      priority: undefined,
      size: 0,
      // The end of what was scanned, so a marker split between two reads is still found.
      carried: '',
      // The silence allowed for what the log shows running, read once for each size it reaches.
      allowed: { size: -1, seconds: silenceSeconds },
      shares,
      shareNumber: 0,
      shareFrom: 0,
      shareTail: Buffer.alloc(0),
      deciding: null,
      failure: undefined,
      ceiling,
      guard: undefined,
    };
    while (!finished.now) {
      await delay(LOOK_MS);
      await lookAtTheEngine(watch);
    }
    await watch.deciding;
  } catch (error) {
    // Ended before the failure goes on, since nothing else holds a way to end it once this returns.
    stop();
    throw error;
  } finally {
    closeSync(reading);
    launch.running.delete(stop);
    watch?.guard?.release();
    const pid = watch?.pid ?? engine;
    if (pid !== undefined) {
      watching(pid, false);
    }
  }
  if (watch.failure !== undefined) {
    throw watch.failure;
  }
  return await endOfTheEngine({
    started,
    told: await exited,
    copied,
    output,
    log,
    outcome,
    peakBytes: watch.peakBytes,
    priority: watch.priority,
  });
}

/** Guards the watched engine against its ceiling once its pid is known, ending it past the ceiling. */
function guardTheEngine(watch: Watch): void {
  if (watch.pid === undefined || watch.guard !== undefined) {
    return;
  }
  const { peakKept, projectPath } = watch.launch;
  watch.guard = engineMemory.guard(
    watch.pid,
    watch.ceiling,
    (end) => {
      watch.outcome.ended ??= memoryEndedSaid(end);
      watch.started.stop();
    },
    peakKept === undefined ? undefined : { project: projectPath, tool: peakKept },
  );
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
  readonly lane: number;
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
  const { launch, args, directory, lane, env } = start;
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
    lane: { file: join(directory, LANE_FILE), number: lane },
    ...(launch.cores === null ? {} : { affinity: (1n << BigInt(launch.cores)) - 1n }),
  };
  // A pipe, copied into the log here: an engine on Windows spends 1.5 to 4 ms on every line it
  // writes to a file and 0.04 ms on one written to a pipe, and gdUnit4 prints a dozen a case. The
  // helper hands the engine its stdout for both streams, so their lines stay in order.
  let onDesktop: ReturnType<typeof spawnOnDesktop>;
  try {
    onDesktop = spawnOnDesktop(how, launch.godotPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: directory,
    });
  } catch (error) {
    if (error instanceof HelperRefused) {
      return { kind: 'refused', end: { code: null, signal: null, ended: error.message } };
    }
    throw error;
  }
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
  /** The engine's priority as last read while it ran, which a log kept for a slow case records. */
  priority: string | undefined;
  size: number;
  carried: string;
  allowed: { size: number; seconds: number };
  /** The shares an engine that takes more than one is handed, when it does. */
  readonly shares: ShareHandoff | undefined;
  /** How many shares have ended, which is the number of the one running. */
  shareNumber: number;
  /** The byte of the log the running share's lines begin at. */
  shareFrom: number;
  /** The end of what was scanned, in case a share's marker is split between two reads. */
  shareTail: Buffer;
  /** Settles once the run has answered with the next share, while the engine waits for it. */
  deciding: Promise<void> | null;
  /** Why handing over a share failed, thrown once the engine has ended. */
  failure: Error | undefined;
  /** The most the engine may hold, and where that figure comes from. */
  readonly ceiling: Ceiling;
  /** The engine's guard against its ceiling, once its pid is known. */
  guard: EngineGuard | undefined;
}

/** One look at the engine: its pid, what it holds, whether it is past a limit and what the log has gained. */
async function lookAtTheEngine(watch: Watch): Promise<void> {
  if (watch.pid === undefined) {
    watch.pid = engineAt(watch.started);
    if (watch.pid !== undefined) {
      foundEngine(watch.lock, watch.pid);
    }
  }
  // At the first look also for an engine whose pid was known at its start, as off Windows.
  guardTheEngine(watch);
  if (watch.pid !== undefined) {
    watch.priority = priorityOf(watch.pid) ?? watch.priority;
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
  endIfPastTheDeadline(watch, gone || watch.deciding !== null, at);
  const now = fstatSync(watch.reading).size;
  if (now > watch.size) {
    scanWhatTheLogGained(watch, now, at);
  } else if (
    watch.outcome.ended === null &&
    !gone &&
    watch.deciding === null &&
    watch.quiet.past(watch.silenceSeconds, at) !== null
  ) {
    endIfSilent(watch, at);
  }
}

/** Ends the engine once it has run past the run's deadline. */
function endIfPastTheDeadline(watch: Watch, gone: boolean, at: number): void {
  // Silence alone never ends an engine that keeps printing, such as a case warning every frame.
  const deadline = watch.launch.deadlineSeconds;
  const over = deadline === null || gone ? null : watch.running.past(deadline, at);
  if (watch.outcome.ended === null && deadline !== null && over !== null) {
    const stoppedIn = printedNow(watch).stoppedIn;
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
    if (watch.shares !== undefined && watch.deciding === null) {
      noticeShareEnd(watch, chunk.subarray(0, got), offset);
    }
    offset += got;
  }
  watch.size = now;
  watch.quiet.restart(at);
  if (watch.outcome.ended === null && watch.size - watch.shareFrom > LOG_LIMIT_BYTES) {
    watch.outcome.ended = `the engine printed more than the ${String(LOG_LIMIT_BYTES / 1024 / 1024)} MiB a log may hold, so it was ended`;
    watch.started.stop();
  }
}

/** What the engine has printed for the share it is running. */
function printedNow(watch: Watch): RunPrinted {
  return readRun(watch.shares === undefined ? readLog(watch.log) : shareText(watch.log, watch.shareFrom));
}

/**
 * Looks in [param chunk], read from byte [param offset] of the log, for the line saying the running
 * share ended, and hands the engine its next share once the line is whole.
 */
function noticeShareEnd(watch: Watch, chunk: Buffer, offset: number): void {
  const marker = Buffer.from(shareMarker(watch.shareNumber));
  const joined = Buffer.concat([watch.shareTail, chunk]);
  const base = offset - watch.shareTail.length;
  const found = joined.indexOf(marker);
  const newline = found < 0 ? -1 : joined.indexOf(0x0a, found + marker.length);
  if (newline < 0) {
    watch.shareTail = joined.subarray(found < 0 ? Math.max(0, joined.length - marker.length + 1) : found);
    return;
  }
  watch.shareTail = Buffer.alloc(0);
  const code = Number.parseInt(joined.toString('utf8', found + marker.length, newline), 10);
  handedTheNext(watch, base + newline + 1, code);
}

/**
 * Asks the run for the share after the one that ended with [param code] and whose lines end at byte
 * [param to], and writes it for the engine, which waits for it. The engine is not silent or late
 * meanwhile, and the next share counts from the moment it is handed over.
 */
function handedTheNext(watch: Watch, to: number, code: number): void {
  const { shares } = watch;
  if (shares === undefined) {
    return;
  }
  const number = watch.shareNumber;
  watch.shareNumber += 1;
  const end: EngineEnd = {
    code,
    signal: null,
    ended: null,
    ...(watch.peakBytes > 0 ? { peakBytes: watch.peakBytes } : {}),
    ...(watch.priority === undefined ? {} : { priority: watch.priority }),
  };
  const from = watch.shareFrom;
  watch.deciding = shares
    .ended({ number, from, to, end })
    .then((next) => {
      if (next !== null) {
        watch.shareFrom = to;
        watch.peakBytes = 0;
      }
      handedOver(shares.directory, number + 1, next?.args ?? null);
    })
    .catch((error: unknown) => {
      watch.failure ??= error instanceof Error ? error : new Error(errorMessage(error));
      handedOver(shares.directory, number + 1, null);
    })
    .finally(() => {
      const at = nowSeconds();
      watch.running.restart(at);
      watch.quiet.restart(at);
      watch.allowed = { size: -1, seconds: watch.silenceSeconds };
      watch.deciding = null;
    });
}

/** Ends the engine once it has printed nothing for as long as what it was running is allowed. */
function endIfSilent(watch: Watch, at: number): void {
  if (watch.allowed.size !== watch.size) {
    watch.allowed = {
      size: watch.size,
      seconds:
        watch.silenceIn === undefined
          ? watch.silenceSeconds
          : Math.max(watch.silenceSeconds, watch.silenceIn(printedNow(watch))),
    };
  }
  const silent = watch.quiet.past(watch.allowed.seconds, at);
  if (silent === null) {
    return;
  }
  const { stoppedIn } = printedNow(watch);
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
  readonly log: string;
  readonly outcome: { ended: string | null };
  readonly peakBytes: number;
  readonly priority: string | undefined;
}

/** How much of a log is read for the helper's word on a message box: the lines before it and the one it ends on. */
const BOX_READ_BYTES = 64 * 1024;

/** How the engine ended, once its process has exited and its streams are copied into the log. */
async function endOfTheEngine(finish: EngineFinish): Promise<EngineEnd> {
  const { started, told, copied, output, log, outcome, peakBytes, priority } = finish;
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
  if (helper !== null && outcome.ended === null) {
    const printed = new GameLog();
    printed.append('stdout', readLog(log, BOX_READ_BYTES));
    printed.finish();
    outcome.ended = desktopBoxEnding(printed.all);
  }
  return {
    code,
    signal,
    ended: outcome.ended,
    ...(freeBytes === undefined ? {} : { freeBytes }),
    ...(peakBytes > 0 ? { peakBytes } : {}),
    ...(priority === undefined ? {} : { priority }),
  };
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
