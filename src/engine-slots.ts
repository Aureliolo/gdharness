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
 * Gates come first. A gate in the machine's queue keeps a mark, `<directory>/queued/<ticket>.json`
 * holding what a lock does, and while one is live an engine outside a gate takes only the last
 * {@link KEPT_SLOTS} slots; a gate's engines take only the others ({@link slotsDrawnOn}).
 *
 * A taker that finds every slot held keeps a mark, `<directory>/waiting/<pid>-<n>.json` holding
 * what its lock will, until its take ends, so that a gate counting its own time can tell a wait for
 * slots others hold from its own work. A mark whose holder has gone is free by the same rule as a
 * lock.
 *
 * One directory and one count serve the whole machine, whichever project an engine is for: every
 * game's gate, bench and tool, and this server's own engines, draw on the same budget. The directory
 * is `$XDG_CACHE_HOME/gdharness/slots` where that variable is set, else
 * `%LOCALAPPDATA%\gdharness\slots` on Windows, else `~/.cache/gdharness/slots`; the count is half
 * the processors, at least one. `GODOT_ENGINE_SLOTS` and `GODOT_ENGINE_SLOT_COUNT`
 * replace either, and a command's `--slots` and `--slot-count` replace those ({@link machineSlots}).
 *
 * The games' own tools take slots in this directory the same way, which is the point of it: the
 * scheme is written out in docs/test-runs.md for them, and a change here is a change there.
 */

import {
  closeSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeSync,
} from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { callProgress, callSignal, callSlotWaits } from './call-signal.js';
import { EngineUsageError } from './engine-launch.js';
import { startTimesOf } from './process-children.js';
import { readWhole, removeWhole, writeWhole } from './whole-file.js';

/** The variable naming the slot directory in place of the machine's. */
export const SLOTS_VARIABLE = 'GODOT_ENGINE_SLOTS';
/** The variable naming the slot count in place of the machine's. */
export const SLOT_COUNT_VARIABLE = 'GODOT_ENGINE_SLOT_COUNT';
/**
 * Processors to each slot by default. A test engine was measured at 0.5 to 0.86 of a processor, so
 * one slot to five left the machine about half idle while gates waited in line for engines.
 */
const PROCESSORS_A_SLOT = 2;

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
  const cache = cacheHome(env, machine.platform, machine.home);
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
/**
 * How long a wait at a full set of slots goes without looking when nothing in their folder changes:
 * the look that finds a holder gone without giving its slot back. Every slot given back changes the
 * folder, and a wait looked twenty times a second before, some 2.7% of a core for each waiting
 * taker for as long as a gate held the slots.
 */
const SLOT_LOOK_MS = 1000;
/**
 * How long after a change in the folder a wait looks, so the several events one release reaches a
 * watcher as are taken as one look, made as soon after the release as the twentieth of a second the
 * looks used to be apart.
 */
const SLOT_SETTLE_MS = 50;
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
/**
 * The folder, inside the slots', of the marks the gates in the machine's queue keep, one a gate's
 * ticket, from its arrival to its release, holding what a lock does.
 */
export const QUEUED_FOLDER = 'queued';
/**
 * The variables naming the share of the gate a process runs in, set in every process a gate runs,
 * so both set says the engine is a gate's.
 */
export const SHARE_VARIABLE = 'GODOT_ENGINE_SHARE';
export const SHARE_COUNT_VARIABLE = 'GODOT_ENGINE_SHARE_COUNT';
/**
 * The slots kept for engines outside a gate while a gate is queued: the last two. The gates draw on
 * the rest alone, and an engine outside a gate takes one of those only while no gate is queued, so
 * work started beside the gates never leaves them waiting: one morning engines outside the queue
 * held 12 of 16 slots while gates stood in line for hours.
 */
const KEPT_SLOTS = 2;

/** Which of a machine's slots a take is held to, when it is held to some. */
type SlotLimit = 'gate' | 'kept';

/** The slot numbers a take may try, in order, and what holds it to them when something does. */
export interface SlotsDrawn {
  readonly numbers: readonly number[];
  readonly limit?: SlotLimit;
}

/**
 * The slot numbers of [param count] a take may try now, in the order it tries them, and what holds it
 * to them. A gate's engine ([param inAGate]) takes the first count less {@link KEPT_SLOTS}, at least
 * one. Any other takes every slot while no gate is queued, and only the kept ones while one is
 * ([param gateQueued]), trying the kept ones first either way so the gates' stay free longest.
 */
export function slotsDrawnOn(count: number, inAGate: boolean, gateQueued: boolean): SlotsDrawn {
  const gated = Math.max(1, count - KEPT_SLOTS);
  if (inAGate) {
    return { numbers: Array.from({ length: gated }, (_, slot) => slot), limit: 'gate' };
  }
  const every = Array.from({ length: count }, (_, slot) => count - 1 - slot);
  const kept = every.slice(0, count - gated);
  return gateQueued && kept.length > 0 ? { numbers: kept, limit: 'kept' } : { numbers: every };
}

/** Whether [param env] says this process runs inside a gate, which names its share in both. */
export function inAGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env[SHARE_VARIABLE]) !== undefined && nonEmpty(env[SHARE_COUNT_VARIABLE]) !== undefined;
}
/** The waits this process has marked, which makes each mark's name its own. */
let waitsMarked = 0;

/**
 * The changes in a folder, waited for one at a time. A folder that cannot be watched is waited on
 * by the clock alone, which still finds every slot given back, a look later.
 */
export class FolderChanges {
  private changed = false;
  private wake: (() => void) | null = null;
  private readonly watcher: FSWatcher | null;

  constructor(directory: string) {
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(directory, () => {
        this.changed = true;
        this.wake?.();
      });
      watcher.on('error', () => {
        watcher?.close();
      });
    } catch {
      watcher = null;
    }
    this.watcher = watcher;
  }

  /**
   * Waits for a change, then [param settleMs] more, or [param lookMs] with none, or until
   * [param signal] aborts.
   */
  async next(lookMs: number, settleMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (!this.changed) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.wake = null;
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, lookMs);
        this.wake = done;
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (this.changed && signal?.aborted !== true) {
      await delay(settleMs, undefined, signal === undefined ? {} : { signal }).catch(() => undefined);
    }
    this.changed = false;
  }

  close(): void {
    this.watcher?.close();
  }
}

/**
 * Who holds a lock, as its file says. [member by] is what took it, such as a test run and its
 * project, so a wait can say who it waits behind; a lock written without it is named by its pid.
 */
export interface SlotHolder {
  readonly pid: number;
  readonly started: number;
  readonly by?: string;
}

/** The holder [param content] names, or null for content that names none. */
export function holderOf(content: string): SlotHolder | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { pid, started, by } = parsed as { pid?: unknown; started?: unknown; by?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof started !== 'number') {
      return null;
    }
    return typeof by === 'string' && by !== '' ? { pid, started, by } : { pid, started };
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
  /** The slots the last look could take, in the order it tried them, and what held it to them. */
  drawn: SlotsDrawn = { numbers: [] };
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  readonly count: number;
  readonly holder: SlotHolder;
  /** Whether this process runs inside a gate, which holds its takes to the gates' slots. */
  readonly inAGate: boolean;
  private readonly say: ((line: string) => void) | undefined;

  constructor(
    directory: string,
    count: number,
    holder: SlotHolder,
    say?: (line: string) => void,
    gated: boolean = inAGate(),
  ) {
    this.directory = directory;
    this.count = count;
    this.holder = holder;
    this.say = say;
    this.inAGate = gated;
    this.drawn = slotsDrawnOn(count, gated, false);
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its lock's path. A take that finds every
   * slot held keeps a mark of its wait until it ends, however it ends, and calls [param blocked]
   * once, as it begins waiting.
   */
  async take(
    signal?: AbortSignal,
    waiting?: (waitedMs: number) => void,
    blocked?: () => void,
  ): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    const began = Date.now();
    let said = Number.NEGATIVE_INFINITY;
    let mark: string | undefined;
    let changes: FolderChanges | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const lock = await this.takeFree();
        if (lock !== null) {
          return lock;
        }
        if (mark === undefined) {
          mark = this.waitMarked();
          blocked?.();
        }
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
          this.say(slotWaitSaid(now - began, this.count, this.directory, this.holders(), this.drawn));
        }
        if (changes === undefined) {
          // Looked at again once watched, since a slot given back before the watch began says nothing.
          changes = new FolderChanges(this.directory);
          continue;
        }
        // Woken for the next line as well as for the next look, so it comes when it is due: said only
        // at a look, the line due two seconds in came near three, as the first look read a holder's
        // start for 1.9 s on a loaded machine and the next came a second after that.
        const sayAt =
          waiting !== undefined
            ? said + WAIT_SAID_MS
            : this.say !== undefined && this.held.size === 0
              ? Math.max(began + COMMAND_WAIT_SAID_MS, this.saidAt + WAIT_SAID_MS)
              : Number.POSITIVE_INFINITY;
        await changes.next(Math.max(0, Math.min(SLOT_LOOK_MS, sayAt - Date.now())), SLOT_SETTLE_MS, signal);
      }
    } finally {
      changes?.close();
      if (mark !== undefined && this.marks.delete(mark)) {
        removeWhole(mark);
      }
    }
  }

  /**
   * Takes a slot that is free now and answers its lock's path, or null when every slot it may take is
   * held. Which it may take is asked again at every look, since a gate arriving in the queue or the
   * last one leaving changes them; a slot already held is kept to its end whatever arrives.
   */
  async takeFree(): Promise<string | null> {
    mkdirSync(this.directory, { recursive: true });
    this.drawn = slotsDrawnOn(this.count, this.inAGate, !this.inAGate && (await this.aGateIsQueued()));
    for (const slot of this.drawn.numbers) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (this.made(lock) || (await this.takenOver(lock))) {
        this.held.add(lock);
        return lock;
      }
    }
    return null;
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

  /**
   * Whether a live gate has a mark in the machine's queue. A mark whose gate has gone is removed, by
   * the rule a lock is freed by, and one not yet written names nobody and is passed over.
   */
  private async aGateIsQueued(): Promise<boolean> {
    const marks = join(this.directory, QUEUED_FOLDER);
    let names: string[];
    try {
      names = readdirSync(marks).filter((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
    let live = false;
    for (const name of names) {
      const mark = join(marks, name);
      const content = readWhole(mark);
      if (content === null || holderOf(content) === null) {
        continue;
      }
      if (await this.free(mark)) {
        removeWhole(mark);
      } else {
        live = true;
      }
    }
    return live;
  }

  /**
   * Who holds the slots the last look could take, in the order it tried them, leaving out a lock
   * that cannot be read.
   */
  holders(): SlotHolder[] {
    const found: SlotHolder[] = [];
    for (const slot of this.drawn.numbers) {
      try {
        const holder = holderOf(readFileSync(join(this.directory, `${String(slot)}.lock`), 'utf8'));
        if (holder !== null) {
          found.push(holder);
        }
      } catch {
        // Given back since the take looked, which the next look finds.
      }
    }
    return found;
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
    giveBackSlot(lock, this.holder.pid);
  }

  /**
   * Stops counting the slot at [param lock] as this process's without giving it back, for a lock
   * another process takes over in its own time: see {@link handSlot}.
   */
  forget(lock: string): void {
    this.held.delete(lock);
  }

  /** Hands the slot at [param lock] to [param to], answering whether it did: see {@link handSlot}. */
  hand(lock: string, to: SlotHolder): boolean {
    const handed = handSlot(lock, this.holder.pid, to);
    if (handed) {
      this.held.delete(lock);
    }
    return handed;
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

/**
 * Hands the slot at [param lock] to [param to] when it still names [param from], answering whether
 * it did. For an engine that outlives the process that waited for its slot, a game a keeper holds or
 * one an editor plays: the lock then names that engine's holder and is free once it has gone, by the
 * rule every lock is judged by. Renamed over the lock, so a taker reading it never finds it empty.
 */
export function handSlot(lock: string, from: number, to: SlotHolder): boolean {
  let content: string | null;
  try {
    content = readWhole(lock);
  } catch {
    return false;
  }
  return content !== null && holderOf(content)?.pid === from && writeWhole(lock, JSON.stringify(to));
}

/** Gives back the slot at [param lock] when [param pid] holds it. */
export function giveBackSlot(lock: string, pid: number): void {
  try {
    if (holderOf(readFileSync(lock, 'utf8'))?.pid === pid) {
      removeWhole(lock);
    }
  } catch {
    // Already gone.
  }
}

let ours: Promise<EngineSlots> | undefined;
let saidTo: ((line: string) => void) | undefined;
let takenBy: string | undefined;

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
    const holder = { pid: process.pid, started, ...(takenBy === undefined ? {} : { by: takenBy }) };
    return new EngineSlots(chosen.directory, chosen.count, holder, (line) => {
      saidTo?.(line);
    });
  });
  return ours;
}

/**
 * Names what this process's own engines are taken for, written into each lock it takes outside a
 * run that names its slots, such as a command and its project or a server.
 */
export function nameSlotTaker(by: string): void {
  takenBy = by;
}

/**
 * What waiting for a slot says, after [param waitedMs], to the client of the call that waits:
 * [param holders] are who hold the slots, one entry a slot, grouped by process in what is said.
 */
export function slotWaitSaid(
  waitedMs: number,
  count: number,
  directory: string,
  holders: readonly SlotHolder[] = [],
  drawn: SlotsDrawn = { numbers: [] },
): string {
  const taking = drawn.limit === undefined ? count : drawn.numbers.length;
  const slots = `${slotsSaid(taking, count, directory, drawn.limit)} ${taking === 1 ? 'is' : 'are'} in use`;
  const named = holdersNamed(taking, holders);
  const waiting = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine: ${slots}`;
  const back = `the engine starts when ${taking === 1 ? 'it' : 'one'} is given back`;
  const starts = drawn.limit === 'kept' ? `${back} or no gate is queued` : back;
  if (named.length === 0) {
    return `${waiting}, by a gate or another tool, and ${starts}.`;
  }
  if (taking === 1) {
    return `${waiting}, by ${named.join(', ')}, and ${starts}.`;
  }
  return `${waiting}: ${listed(named)}. ${starts.charAt(0).toUpperCase()}${starts.slice(1)}.`;
}

/**
 * The slots a take may use, [param taking] of the machine's [param count] in [param directory], named
 * for what holds it to them.
 */
function slotsSaid(taking: number, count: number, directory: string, limit: SlotLimit | undefined): string {
  const where = `on this machine (${directory})`;
  if (limit === 'kept') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} kept for engines outside a gate while a gate is queued`;
  }
  if (limit === 'gate') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} a gate's engines draw on`;
  }
  return count === 1 ? `the one engine slot ${where}` : `all ${String(count)} engine slots ${where}`;
}

/**
 * What a call's answer says of its waits for slots, [param waitedMs] in all: [param holders] are
 * who held the slots when it first waited.
 */
export function slotWaitedSaid(
  waitedMs: number,
  count: number,
  directory: string,
  holders: readonly SlotHolder[],
  drawn: SlotsDrawn = { numbers: [] },
): string {
  const waited = `This call waited ${String(Math.round(waitedMs / 1000))} s for an engine slot in all.`;
  const taking = drawn.limit === undefined ? count : drawn.numbers.length;
  const slots = `${slotsSaid(taking, count, directory, drawn.limit)} ${taking === 1 ? 'was' : 'were'} in use`;
  const named = holdersNamed(taking, holders);
  if (named.length === 0) {
    return `${waited} When it first waited, ${slots}, by a gate or another tool.`;
  }
  return taking === 1
    ? `${waited} When it first waited, ${slots}, by ${named.join(', ')}.`
    : `${waited} When it first waited, ${slots}: ${listed(named)}.`;
}

/** [param holders] named one entry a process, with how many slots each holds when there are several. */
function holdersNamed(count: number, holders: readonly SlotHolder[]): string[] {
  const held = new Map<number, { by: string | undefined; slots: number }>();
  for (const holder of holders) {
    const known = held.get(holder.pid);
    held.set(holder.pid, { by: known?.by ?? holder.by, slots: (known?.slots ?? 0) + 1 });
  }
  return [...held].map(([pid, { by, slots: taken }]) => {
    const who =
      pid === process.pid
        ? `this process (pid ${String(pid)})`
        : by === undefined
          ? `pid ${String(pid)}`
          : `${by} (pid ${String(pid)})`;
    return count === 1 ? who : `${String(taken)} by ${who}`;
  });
}

function listed(named: readonly string[]): string {
  return named.length === 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`;
}

/**
 * Takes one of the machine's slots for the call being answered, waiting for one: a cancelled call
 * stops waiting, and one whose client asked for progress is told that it is waiting and why.
 * Answers its lock, how to give it back, and how to hand it to an engine that outlives this process.
 */
export async function slotForCall(): Promise<CallSlot> {
  const slots = await processSlots();
  const progress = callProgress();
  const waits = callSlotWaits();
  const began = Date.now();
  let blockedBy: readonly SlotHolder[] | undefined;
  let blockedOn: SlotsDrawn | undefined;
  const lock = await slots.take(
    callSignal(),
    progress === undefined
      ? undefined
      : (waitedMs) => {
          progress(
            waitedMs / 1000,
            slotWaitSaid(waitedMs, slots.count, slots.directory, slots.holders(), slots.drawn),
          );
        },
    () => {
      blockedBy = slots.holders();
      blockedOn = slots.drawn;
    },
  );
  if (waits !== undefined && blockedBy !== undefined) {
    waits.ms += Date.now() - began;
    const heldBy = blockedBy;
    const heldOn = blockedOn;
    waits.said ??= (waitedMs) => slotWaitedSaid(waitedMs, slots.count, slots.directory, heldBy, heldOn);
  }
  return {
    lock,
    from: slots.holder.pid,
    release: () => {
      slots.release(lock);
    },
    handTo: (holder) => slots.hand(lock, holder),
    leave: () => {
      slots.forget(lock);
    },
  };
}

/** A slot taken for a call: see {@link slotForCall}. */
export interface CallSlot {
  readonly lock: string;
  /** The pid the lock names until it is handed on. */
  readonly from: number;
  readonly release: () => void;
  readonly handTo: (holder: SlotHolder) => boolean;
  /** Leaves the lock for another process to take over, naming this one until it does. */
  readonly leave: () => void;
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
