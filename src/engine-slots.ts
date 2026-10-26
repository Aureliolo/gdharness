/**
 * The engine slots a machine's test engines share, so that every tool starting one counts it.
 *
 * Each slot is a file, `<directory>/<n>.lock` for n from 0 below the count, made with an exclusive
 * create, so two takers can never both make the same one. It holds the taker's pid and the time its
 * process started, `{"pid": 1234, "started": 1760000000000}` in milliseconds since the epoch, and
 * the taker removes it when it is done. A lock is free again once its holder has gone: when no
 * process has its pid, or one does that started more than {@link START_TOLERANCE_MS} away from the
 * time it names, which is a later process given the same number. A lock still empty or unreadable
 * {@link UNWRITTEN_MS} after it was made belongs to a taker that died between making and writing it.
 *
 * A free lock is taken over under `<n>.lock.steal`, made the same way, so that two takers who both
 * judged one free cannot both remove it: the second would be removing the first one's fresh lock.
 * Whoever holds the steal file reads the lock again, removes it if it is still free, makes its own,
 * and removes the steal file. A steal file older than {@link UNWRITTEN_MS} is a taker that died
 * holding it.
 *
 * A taker that finds every slot held keeps a mark, `<directory>/waiting/<pid>-<n>.json` holding
 * what its lock will, until its take ends, so that a gate counting its own time can tell a wait for
 * slots others hold from its own work. A mark whose holder has gone is free by the same rule as a
 * lock.
 *
 * One directory and one count serve the whole machine, whichever project an engine is for: every
 * game's gate, bench and tool, and this server's own engines, draw on the same budget. The directory
 * is `$XDG_CACHE_HOME/gdharness/slots` where that variable is set, else
 * `%LOCALAPPDATA%\gdharness\slots` on Windows, else `~/.cache/gdharness/slots`; the count is a fifth
 * of the processors, at least one. `GODOT_ENGINE_SLOTS` and `GODOT_ENGINE_SLOT_COUNT`
 * replace either, and a command's `--slots` and `--slot-count` replace those ({@link machineSlots}).
 *
 * The games' own tools take slots in this directory the same way, which is the point of it: the
 * scheme is written out in docs/test-runs.md for them, and a change here is a change there.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { callProgress, callSignal } from './call-signal.js';
import { EngineUsageError } from './engine-launch.js';
import { startTimesOf } from './process-children.js';
import { removeWhole } from './whole-file.js';

/** The variable naming the slot directory in place of the machine's. */
export const SLOTS_VARIABLE = 'GODOT_ENGINE_SLOTS';
/** The variable naming the slot count in place of the machine's. */
export const SLOT_COUNT_VARIABLE = 'GODOT_ENGINE_SLOT_COUNT';
/** Processors to each slot by default, which leaves most of the machine to whoever is at it. */
const PROCESSORS_A_SLOT = 5;

/** Where the slots are and how many there are. */
export interface SlotsChosen {
  readonly directory: string;
  readonly count: number;
}

/** What the machine says, handed in so every branch can be asked about without its machine. */
export interface SlotsMachine {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly processors: number;
  readonly home: string;
  readonly cwd: string;
}

/**
 * The slots a run takes: [param asked] where a command named them, else the variables, else the
 * machine's own directory and count. Every tool on the machine works the default out the same way,
 * so it is one budget whoever starts the engine.
 */
export function machineSlots(
  asked: { readonly directory: string | null; readonly count: number | null } = {
    directory: null,
    count: null,
  },
  machine: SlotsMachine = {
    env: process.env,
    platform: process.platform,
    processors: availableParallelism(),
    home: homedir(),
    cwd: process.cwd(),
  },
): SlotsChosen {
  const { env } = machine;
  const named = nonEmpty(env[SLOTS_VARIABLE]);
  // The cache home in the same order on every platform, so a machine that sets XDG_CACHE_HOME on
  // Windows too has one answer whichever tool works it out.
  const xdg = nonEmpty(env['XDG_CACHE_HOME']);
  const local = machine.platform === 'win32' ? nonEmpty(env['LOCALAPPDATA']) : undefined;
  const cache = join(xdg ?? local ?? join(machine.home, '.cache'), 'gdharness');
  const directory =
    asked.directory ?? (named === undefined ? join(cache, 'slots') : resolve(machine.cwd, named));
  const counted = nonEmpty(env[SLOT_COUNT_VARIABLE]);
  let count = asked.count;
  if (count === null && counted !== undefined) {
    count = Number(counted);
    if (!Number.isInteger(count) || count < 1) {
      throw new EngineUsageError(`${SLOT_COUNT_VARIABLE} takes a whole number above 0, not ${counted}.`);
    }
  }
  return { directory, count: count ?? Math.max(1, Math.floor(machine.processors / PROCESSORS_A_SLOT)) };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** How far a process's start may be from the time its lock names and still be the one that wrote it. */
export const START_TOLERANCE_MS = 2000;
/** How long a lock may stay empty before its taker is taken to have died writing it. */
export const UNWRITTEN_MS = 10_000;
/** How long between looks at a full set of slots. */
const SLOT_WAIT_MS = 50;
/**
 * How often a wait for a slot says it is still waiting: inside the minute the SDK lets a call stay
 * silent by default, since a gate can hold every slot for far longer.
 */
const WAIT_SAID_MS = 20_000;
/**
 * How long a command waits for a slot before it first says so: a slot given back at once is not
 * worth a line, and a wait of minutes printing nothing reads as a hang.
 */
const COMMAND_WAIT_SAID_MS = 2000;
/** How long a holder's start time, once read, is believed before it is read again. */
const START_READ_MS = 10_000;
/** The folder, inside the slots', of the marks takers keep while they wait. */
export const WAITING_FOLDER = 'waiting';
/** The waits this process has marked, which makes each mark's name its own. */
let waitsMarked = 0;

/** Who holds a lock, as its file says. */
export interface SlotHolder {
  readonly pid: number;
  readonly started: number;
}

/** The holder [param content] names, or null for content that names none. */
export function holderOf(content: string): SlotHolder | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { pid, started } = parsed as { pid?: unknown; started?: unknown };
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof started === 'number'
      ? { pid, started }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether a lock holding [param content], last written at [param writtenAt], is free. [param startOf]
 * answers when a pid's process started, or undefined where the platform will not say, which leaves
 * a live pid holding the lock: a slot wrongly kept costs a wait, and one wrongly freed an engine
 * more than the machine was meant to run.
 */
export function lockIsFree(
  content: string,
  writtenAt: number,
  now: number,
  isAlive: (pid: number) => boolean,
  startOf: (pid: number) => number | undefined,
): boolean {
  const holder = holderOf(content);
  if (holder === null) {
    return now - writtenAt > UNWRITTEN_MS;
  }
  if (!isAlive(holder.pid)) {
    return true;
  }
  const started = startOf(holder.pid);
  return started !== undefined && Math.abs(started - holder.started) > START_TOLERANCE_MS;
}

/** When this process started, as the platform reports it, which is what a lock it writes names. */
export async function ownStart(): Promise<number> {
  const said = (await startTimesOf([process.pid])).get(process.pid);
  return said ?? Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * The engine slots in one directory, taken for this process. [param say] is where a take given no
 * listener of its own says it is waiting, a line at a time: a command's output, which several lanes
 * waiting at once share, so it hears one line every interval rather than one from each. It is said
 * only while this process holds no slot, since a run waiting behind its own engines is not held up
 * by anyone else.
 */
export class EngineSlots {
  private readonly starts = new Map<number, { started: number | undefined; readAt: number }>();
  private readonly held = new Set<string>();
  private readonly marks = new Set<string>();
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  readonly count: number;
  private readonly holder: SlotHolder;
  private readonly say: ((line: string) => void) | undefined;

  constructor(directory: string, count: number, holder: SlotHolder, say?: (line: string) => void) {
    this.directory = directory;
    this.count = count;
    this.holder = holder;
    this.say = say;
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its lock's path. A take that finds every
   * slot held keeps a mark of its wait until it ends, however it ends.
   */
  async take(signal?: AbortSignal, waiting?: (waitedMs: number) => void): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    const began = Date.now();
    let said = Number.NEGATIVE_INFINITY;
    let mark: string | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        for (let slot = 0; slot < this.count; slot += 1) {
          const lock = join(this.directory, `${String(slot)}.lock`);
          if (this.made(lock) || (await this.takenOver(lock))) {
            this.held.add(lock);
            return lock;
          }
        }
        mark ??= this.waitMarked();
        const now = Date.now();
        if (waiting !== undefined) {
          if (now - said >= WAIT_SAID_MS) {
            said = now;
            waiting(now - began);
          }
        } else if (
          this.say !== undefined &&
          this.held.size === 0 &&
          now - began >= COMMAND_WAIT_SAID_MS &&
          now - this.saidAt >= WAIT_SAID_MS
        ) {
          this.saidAt = now;
          this.say(slotWaitSaid(now - began, this.count, this.directory));
        }
        await delay(SLOT_WAIT_MS, undefined, signal === undefined ? {} : { signal });
      }
    } finally {
      if (mark !== undefined && this.marks.delete(mark)) {
        removeWhole(mark);
      }
    }
  }

  /**
   * Puts down the mark of a wait and answers its path, or undefined when it could not be made, which
   * the next look tries again.
   */
  private waitMarked(): string | undefined {
    const marks = join(this.directory, WAITING_FOLDER);
    waitsMarked += 1;
    const mark = join(marks, `${String(this.holder.pid)}-${String(waitsMarked)}.json`);
    try {
      mkdirSync(marks, { recursive: true });
    } catch {
      return undefined;
    }
    if (!this.made(mark)) {
      return undefined;
    }
    this.marks.add(mark);
    return mark;
  }

  /** Gives back every slot this process holds, as it ends. */
  releaseAll(): void {
    for (const lock of this.held) {
      this.release(lock);
    }
    for (const mark of this.marks) {
      this.marks.delete(mark);
      removeWhole(mark);
    }
  }

  /** Gives back the slot at [param lock]. */
  release(lock: string): void {
    this.held.delete(lock);
    try {
      if (holderOf(readFileSync(lock, 'utf8'))?.pid === this.holder.pid) {
        removeWhole(lock);
      }
    } catch {
      // Already gone.
    }
  }

  /** Makes [param path] holding this process, answering false when it is there already. */
  private made(path: string): boolean {
    let made: number;
    try {
      made = openSync(path, 'wx');
    } catch {
      return false;
    }
    try {
      writeSync(made, JSON.stringify(this.holder));
    } finally {
      closeSync(made);
    }
    return true;
  }

  /** Takes over [param lock] when its holder has gone, under the steal file. */
  private async takenOver(lock: string): Promise<boolean> {
    if (!(await this.free(lock))) {
      return false;
    }
    const steal = `${lock}.steal`;
    if (!this.made(steal)) {
      try {
        if (Date.now() - statSync(steal).mtimeMs > UNWRITTEN_MS) {
          rmSync(steal, { force: true });
        }
      } catch {
        // Gone between the two, which is its taker finishing.
      }
      return false;
    }
    try {
      if (!(await this.free(lock))) {
        return false;
      }
      try {
        rmSync(lock, { force: true });
      } catch {
        // Held open by a tool locking the file itself, as the games' tools did before this scheme:
        // Windows will not remove it, and that tool still holds the slot.
        return false;
      }
      return this.made(lock);
    } finally {
      rmSync(steal, { force: true });
    }
  }

  private async free(lock: string): Promise<boolean> {
    let content: string;
    let writtenAt: number;
    try {
      content = readFileSync(lock, 'utf8');
      writtenAt = statSync(lock).mtimeMs;
    } catch {
      // Gone since it was found there, which the next look takes.
      return false;
    }
    const pid = holderOf(content)?.pid;
    if (pid !== undefined && alive(pid)) {
      await this.readStart(pid);
    }
    return lockIsFree(content, writtenAt, Date.now(), alive, (asked) => this.starts.get(asked)?.started);
  }

  /** Reads when [param pid] started unless that was read lately: on Windows each read is a query. */
  private async readStart(pid: number): Promise<void> {
    const known = this.starts.get(pid);
    if (known !== undefined && Date.now() - known.readAt < START_READ_MS) {
      return;
    }
    const started = (await startTimesOf([pid])).get(pid);
    this.starts.set(pid, { started, readAt: Date.now() });
  }
}

let ours: Promise<EngineSlots> | undefined;
let saidTo: ((line: string) => void) | undefined;

/**
 * Has a wait for a slot outside a call that reports progress said through [param say]: a command's
 * own output. The server leaves it unset, because its standard output is the protocol.
 */
export function sayWaitsTo(say: (line: string) => void): void {
  saidTo = say;
}

/**
 * The machine's slots as this process takes them for an engine of its own, outside a run that names
 * its slots: one made once a process, so every engine it starts is counted against the same holder.
 */
function processSlots(): Promise<EngineSlots> {
  ours ??= ownStart().then((started) => {
    const chosen = machineSlots();
    return new EngineSlots(chosen.directory, chosen.count, { pid: process.pid, started }, (line) => {
      saidTo?.(line);
    });
  });
  return ours;
}

/** What waiting for a slot says, after [param waitedMs], to the client of the call that waits. */
export function slotWaitSaid(waitedMs: number, count: number, directory: string): string {
  const slots =
    count === 1
      ? `the one engine slot on this machine (${directory}) is in use`
      : `all ${String(count)} engine slots on this machine (${directory}) are in use`;
  return `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine: ${slots}, by a gate or another tool, and the engine starts when one is given back.`;
}

/**
 * Takes one of the machine's slots for the call being answered, waiting for one: a cancelled call
 * stops waiting, and one whose client asked for progress is told that it is waiting and why.
 * Answers how to give it back.
 */
export async function slotForCall(): Promise<{ readonly release: () => void }> {
  const slots = await processSlots();
  const progress = callProgress();
  const lock = await slots.take(
    callSignal(),
    progress === undefined
      ? undefined
      : (waitedMs) => {
          progress(waitedMs / 1000, slotWaitSaid(waitedMs, slots.count, slots.directory));
        },
  );
  return {
    release: () => {
      slots.release(lock);
    },
  };
}

/** Runs [param body] holding one of the machine's slots for the call, and gives it back after. */
export async function inASlot<T>(body: () => Promise<T>): Promise<T> {
  const held = await slotForCall();
  try {
    return await body();
  } finally {
    held.release();
  }
}
