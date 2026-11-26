/**
 * The engine slots a machine's test engines share, so that every tool starting one counts it.
 *
 * Each slot is a file, ${directory}/<n>.lock for n from 0 below the count, locked for as long as its
 * engine runs by an exclusive lock of the operating system ({@link tryOsLock}). The process that
 * lives as long as the engine holds the lock: the server, or the keeper of a game the keeper runs.
 * The operating system frees it when that process ends, however it ends. Nothing is written to a
 * slot and nothing is read from one.
 *
 * A take opens each slot in turn and takes the first it can lock. When none is free it waits,
 * looks again about once a second, and says what it waits for and for how long.
 *
 * One directory and one count serve the whole machine, whichever project an engine is for. The
 * directory is `$XDG_CACHE_HOME/gdharness/slots` where that variable is set, else
 * `%LOCALAPPDATA%\gdharness\slots` on Windows, else `~/.cache/gdharness/slots`. The count is half
 * the processors, at least one. `GODOT_ENGINE_SLOT_COUNT` replaces it, a command's `--slots` and
 * `--slot-count` replace those ({@link machineSlots}), and a file `<directory>/count` holding a whole
 * number above 0 replaces all of them, read at every take ({@link SLOT_COUNT_FILE}).
 *
 * An engine started on a slot has the slot's file in {@link HELD_VARIABLE}, so a program it starts
 * that takes a slot runs on the engine's slot while the file is still locked.
 *
 * Other programs take slots the same way, which is the point of it: docs/test-runs.md gives the
 * lock each platform uses, and a change here is a change there.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { callProgress, callSignal, callSlotWaits } from './call-signal.js';
import { wholeFlag } from './launch.js';
import { type OsLock, tryOsLock } from './os-lock.js';

/**
 * The variable an engine started on a slot is given, naming that slot's file, so a program the
 * engine starts that takes slots the same way runs on the engine's slot rather than taking a second:
 * a game's trailer and screenshot helpers held a slot of their own beside the game's.
 */
const HELD_VARIABLE = 'GODOT_ENGINE_HELD';

/** [param env] for an engine started on the slot at [param lock]. */
export function onTheSlot(env: NodeJS.ProcessEnv, lock: string): NodeJS.ProcessEnv {
  return { ...env, [HELD_VARIABLE]: lock };
}

/** The variable naming the slot directory in place of the machine's. */
export const SLOTS_VARIABLE = 'GODOT_ENGINE_SLOTS';
/** The variable naming the slot count in place of the machine's. */
export const SLOT_COUNT_VARIABLE = 'GODOT_ENGINE_SLOT_COUNT';
/**
 * Processors to each slot by default. A test engine was measured at 0.5 to 0.86 of a processor, so
 * one slot to five left the machine about half idle.
 */
const PROCESSORS_A_SLOT = 2;

/** Where the slots are and how many there are. */
interface SlotsChosen {
  readonly directory: string;
  readonly count: number;
}

/** What the machine says, handed in so every branch can be asked about without its machine. */
interface SlotsMachine {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly processors: number;
  readonly home: string;
  readonly cwd: string;
}

function thisMachine(): SlotsMachine {
  return {
    env: process.env,
    platform: process.platform,
    processors: availableParallelism(),
    home: homedir(),
    cwd: process.cwd(),
  };
}

/** The machine's own slots directory: the variable, else the cache home's. The count is not read. */
function machineSlotsDirectory(machine: SlotsMachine = thisMachine()): string {
  const named = nonEmpty(machine.env[SLOTS_VARIABLE]);
  return named === undefined
    ? join(cacheHome(machine.env, machine.platform, machine.home), 'slots')
    : resolve(machine.cwd, named);
}

/**
 * The slots a run takes: [param asked] where a command named them, else the variables, else the
 * machine's own directory and count. Every tool on the machine works the default out the same way,
 * so it is one budget whoever starts the engine. The count file of the directory ({@link SLOT_COUNT_FILE})
 * overrides the count at each take.
 */
export function machineSlots(
  asked: { readonly directory: string | null; readonly count: number | null } = {
    directory: null,
    count: null,
  },
  machine: SlotsMachine = thisMachine(),
): SlotsChosen {
  const { env } = machine;
  const directory = asked.directory ?? machineSlotsDirectory(machine);
  const counted = nonEmpty(env[SLOT_COUNT_VARIABLE]);
  let count = asked.count;
  if (count === null && counted !== undefined) {
    count = wholeFlag(counted, SLOT_COUNT_VARIABLE);
  }
  return { directory, count: count ?? Math.max(1, Math.floor(machine.processors / PROCESSORS_A_SLOT)) };
}

/** The file in the slots folder whose whole number above 0 is the cap, read at every take. */
const SLOT_COUNT_FILE = 'count';

/**
 * The cap [param directory]'s count file holds, or undefined where there is none or it holds
 * anything but a whole number above 0, which leaves the count the take was made with.
 */
function slotCountFileOf(directory: string): number | undefined {
  try {
    const text = readFileSync(join(directory, SLOT_COUNT_FILE), 'utf8').trim();
    const count = /^\d+$/.test(text) ? Number(text) : 0;
    return Number.isSafeInteger(count) && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** How long a wait at a full set of slots goes before it looks again. */
const SLOT_LOOK_MS = 1000;
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
/** How long a keeper looks for the slot its server gave up, before it runs its game without one. */
const TAKE_OVER_MS = 10_000;
const TAKE_OVER_LOOK_MS = 25;
/** How often a slot held for a game another process runs looks for the game's end. */
const GAME_LOOK_MS = 1000;

/**
 * The engine slots in one directory, taken for this process. [param say] is where a take given no
 * listener of its own says it is waiting, a line at a time: a command's output, which several lanes
 * waiting at once share, so it hears one line every interval rather than one from each. It is said
 * only while this process holds no slot, since a run waiting behind its own engines is not held up
 * by anyone else.
 */
export class EngineSlots {
  private readonly held = new Map<string, OsLock>();
  /** The slot of the engine that started this process while one of its engines runs on it. */
  private inherited: string | null = null;
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  /** The cap the take was made with, which the count file of the folder replaces at each take. */
  private readonly configured: number;
  private cap: number;
  private readonly say: ((line: string) => void) | undefined;

  constructor(directory: string, count: number, say?: (line: string) => void) {
    this.directory = directory;
    this.configured = count;
    this.cap = count;
    this.say = say;
  }

  /** How many engines that take slots may run on the machine at once, as of the last take. */
  get count(): number {
    return this.cap;
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its file's path. [param waiting] hears
   * how long the wait has lasted every {@link WAIT_SAID_MS}, and [param blocked] is called once, as a
   * take that finds every slot held begins waiting.
   */
  async take(
    signal?: AbortSignal,
    waiting?: (waitedMs: number) => void,
    blocked?: () => void,
  ): Promise<string> {
    const began = Date.now();
    let said = Number.NEGATIVE_INFINITY;
    let blockedTold = false;
    for (;;) {
      signal?.throwIfAborted();
      const lock = this.takeFree();
      if (lock !== null) {
        return lock;
      }
      if (!blockedTold) {
        blockedTold = true;
        blocked?.();
      }
      const now = Date.now();
      said = this.sayWaiting(now, began, said, waiting);
      const sayAt = this.nextSayAt(began, said, waiting !== undefined);
      await delay(
        Math.max(0, Math.min(SLOT_LOOK_MS, sayAt - Date.now())),
        undefined,
        signal === undefined ? {} : { signal },
      ).catch(() => undefined);
    }
  }

  /**
   * Says how long a take has waited, to its own listener or to the command's output, when one is
   * due. Answers when the listener last heard, which a take with a listener of its own keeps.
   */
  private sayWaiting(
    now: number,
    began: number,
    said: number,
    waiting: ((waitedMs: number) => void) | undefined,
  ): number {
    if (waiting !== undefined) {
      if (now - said < WAIT_SAID_MS) {
        return said;
      }
      waiting(now - began);
      return now;
    }
    if (
      this.say !== undefined &&
      this.held.size === 0 &&
      now - began >= COMMAND_WAIT_SAID_MS &&
      now - this.saidAt >= WAIT_SAID_MS
    ) {
      this.saidAt = now;
      this.say(slotWaitSaid(now - began, this.count, this.directory));
    }
    return said;
  }

  /** When the next line is due, so a wait wakes for it as well as for the next look. */
  private nextSayAt(began: number, said: number, hasListener: boolean): number {
    if (hasListener) {
      return said + WAIT_SAID_MS;
    }
    if (this.say !== undefined && this.held.size === 0) {
      return Math.max(began + COMMAND_WAIT_SAID_MS, this.saidAt + WAIT_SAID_MS);
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Takes a slot that is free now and answers its file's path, or null when every slot is held. The
   * count is read again from the folder at every look. A slot the engine above this process holds is
   * answered to the one take that finds it unused.
   */
  takeFree(): string | null {
    mkdirSync(this.directory, { recursive: true });
    this.cap = slotCountFileOf(this.directory) ?? this.configured;
    const inherited = this.inheritedByOne();
    if (inherited !== null) {
      return inherited;
    }
    for (let slot = 0; slot < this.cap; slot += 1) {
      const path = join(this.directory, `${String(slot)}.lock`);
      const lock = tryOsLock(path);
      if (lock !== null) {
        this.held.set(path, lock);
        return path;
      }
    }
    return null;
  }

  /**
   * The slot [constant HELD_VARIABLE] names, for one engine of this process to run on, or null. Taken
   * only while some process still holds its lock, so a variable left behind by an engine that has
   * ended names nothing.
   */
  private inheritedByOne(): string | null {
    const named = nonEmpty(process.env[HELD_VARIABLE]);
    if (this.inherited !== null || named === undefined || this.held.has(named)) {
      return null;
    }
    try {
      const probe = tryOsLock(named);
      if (probe !== null) {
        probe.release();
        return null;
      }
    } catch {
      return null;
    }
    this.inherited = named;
    return named;
  }

  /** Gives back the slot at [param lock], or for the inherited one leaves it to its holder. */
  release(lock: string): void {
    if (lock === this.inherited) {
      this.inherited = null;
      return;
    }
    this.held.get(lock)?.release();
    this.held.delete(lock);
  }

  /** Gives back every slot this process holds. */
  releaseAll(): void {
    for (const lock of this.held.keys()) {
      this.release(lock);
    }
    this.inherited = null;
  }
}

let ours: EngineSlots | undefined;
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
 * its slots: made once a process, so every engine it starts is counted against the same holder.
 */
function processSlots(): EngineSlots {
  const chosen = machineSlots();
  ours ??= new EngineSlots(chosen.directory, chosen.count, (line) => {
    saidTo?.(line);
  });
  return ours;
}

/**
 * What waiting for a slot says, after [param waitedMs], to the client of the call that waits.
 */
export function slotWaitSaid(waitedMs: number, count: number, directory: string): string {
  const so = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine`;
  return `${so}: ${slotsSaid(count, directory)} ${count === 1 ? 'is' : 'are'} in use, and the engine starts when ${count === 1 ? 'it is' : 'one is'} given back.`;
}

/** The engine slots of the machine's [param count] in [param directory], named for what a take may use. */
function slotsSaid(count: number, directory: string): string {
  const where = `on this machine (${directory})`;
  return count === 1 ? `the one engine slot ${where}` : `all ${String(count)} engine slots ${where}`;
}

/** What a call's answer says of its waits for slots, [param waitedMs] in all. */
export function slotWaitedSaid(waitedMs: number, count: number, directory: string): string {
  return `This call waited ${String(Math.round(waitedMs / 1000))} s for an engine slot in all. When it first waited, ${slotsSaid(count, directory)} ${count === 1 ? 'was' : 'were'} in use.`;
}

/**
 * Takes a slot for a call and answers it. The wait is reported to the call's client as progress,
 * and counted into the answer's engine_slot_wait.
 */
export async function slotForCall(): Promise<CallSlot> {
  const slots = processSlots();
  const progress = callProgress();
  const waits = callSlotWaits();
  const began = Date.now();
  const wait = { blocked: false };
  const lock = await slots.take(
    callSignal(),
    progress === undefined
      ? undefined
      : (waitedMs) => {
          progress(waitedMs / 1000, slotWaitSaid(waitedMs, slots.count, slots.directory));
        },
    () => {
      wait.blocked = true;
    },
  );
  if (waits !== undefined && wait.blocked) {
    waits.ms += Date.now() - began;
    waits.said ??= (waitedMs) => slotWaitedSaid(waitedMs, slots.count, slots.directory);
  }
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      slots.release(lock);
    }
  };
  return {
    lock,
    release,
    heldUntilGone: (pid) => {
      void untilGone(pid).finally(release);
    },
    leave: release,
  };
}

/** Settles once the process [param pid] has gone. */
async function untilGone(pid: number): Promise<void> {
  while (alive(pid)) {
    await delay(GAME_LOOK_MS);
  }
}

/**
 * Takes over the slot at [param lock] that the server which took it has given up with
 * {@link CallSlot.leave}, for a keeper that runs the game on it: tried until it is free, since the
 * server gives it up as the keeper starts. Answers null when another taker got it first, which leaves
 * the game running on no slot.
 */
export async function takenOverSlot(lock: string): Promise<OsLock | null> {
  const until = Date.now() + TAKE_OVER_MS;
  for (;;) {
    const taken = tryOsLock(lock);
    if (taken !== null || Date.now() >= until) {
      return taken;
    }
    await delay(TAKE_OVER_LOOK_MS);
  }
}

/**
 * Holds the slot of the run the editor plays until the game [param pid] that announced has gone.
 */
export function handedRunSlot(
  run: { slot?: CallSlot; readonly projectPath: string | null },
  pid: number,
): void {
  const slot = run.slot;
  if (slot !== undefined) {
    delete run.slot;
    slot.heldUntilGone(pid);
  }
}

/**
 * Ends what a start did with the slot of the run it played: a game that did not announce inside
 * the wait is tied later or never, and nothing here sees it end, so the slot is given back rather
 * than held for a run it cannot see end.
 */
export function settledRunSlot(run: { slot?: CallSlot }): void {
  if (run.slot !== undefined) {
    run.slot.release();
    delete run.slot;
  }
}

/** A slot taken for a call: see {@link slotForCall}. */
export interface CallSlot {
  readonly lock: string;
  readonly release: () => void;
  /** Keeps the slot until the process [param pid] has gone, which this process cannot wait on. */
  readonly heldUntilGone: (pid: number) => void;
  /** Gives the slot up for the keeper that runs the game to take over ({@link takenOverSlot}). */
  readonly leave: () => void;
}

/** Set inside {@link withoutASlot}, whose engines take no slot. */
const withoutSlots = new AsyncLocalStorage<true>();
const keptForSteps = new AsyncLocalStorage<{ held: Promise<CallSlot> | null }>();

/**
 * The folder under the machine's slots with one file for each project an engine runs for without a
 * slot. Those engines of one project run one at a time across the machine, since each writes the
 * project's .godot, so the count running at once is bounded by the projects in use. Each file is
 * locked as a slot's is.
 */
export const PROJECTS_FOLDER = 'projects';

/** How often an engine waiting for its project's lock looks again. */
const PROJECT_LOOK_MS = 100;

/** The lock in [param directory] that the slotless engines of [param project] take in turn. */
export function projectLockOf(
  project: string | undefined,
  directory: string = machineSlotsDirectory(),
): string {
  const key =
    project === undefined
      ? 'none'
      : createHash('sha256').update(comparable(project)).digest('hex').slice(0, 16);
  return join(directory, PROJECTS_FOLDER, `${key}.lock`);
}

/** [param path] resolved, and lower-cased on Windows, which is how projects are compared. */
function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** What waiting [param waitedMs] for [param project]'s lock says to the client of the call that waits. */
function projectWaitSaid(waitedMs: number, project: string | undefined): string {
  const so = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine`;
  return `${so}: another engine of ${projectNamed(project)} is running, and this one starts when it ends.`;
}

/** What a call's answer says of its wait for [param project]'s lock, [param waitedMs] in all. */
function projectWaitedSaid(waitedMs: number, project: string | undefined): string {
  return `This call waited ${String(Math.round(waitedMs / 1000))} s for another engine of ${projectNamed(project)} in all.`;
}

function projectNamed(project: string | undefined): string {
  return project === undefined ? 'no project' : `the project ${project}`;
}

/**
 * Runs [param body] holding [param project]'s lock, waiting while another engine of it holds it. A
 * call that waits is told so as a slot wait is, and its answer's engine_slot_wait counts the wait.
 * A command with no call to report to says it on its own output ({@link sayWaitsTo}).
 */
async function inTheProjectsTurn<T>(body: () => Promise<T>, project: string | undefined): Promise<T> {
  const path = projectLockOf(project);
  mkdirSync(dirname(path), { recursive: true });
  const signal = callSignal();
  const progress = callProgress();
  const waits = callSlotWaits();
  const began = Date.now();
  let blocked = false;
  let said = Number.NEGATIVE_INFINITY;
  let lock = tryOsLock(path);
  while (lock === null) {
    signal?.throwIfAborted();
    blocked = true;
    const now = Date.now();
    if (progress !== undefined && now - said >= WAIT_SAID_MS) {
      said = now;
      progress((now - began) / 1000, projectWaitSaid(now - began, project));
    } else if (
      progress === undefined &&
      saidTo !== undefined &&
      now - began >= COMMAND_WAIT_SAID_MS &&
      now - said >= WAIT_SAID_MS
    ) {
      said = now;
      saidTo(projectWaitSaid(now - began, project));
    }
    await delay(PROJECT_LOOK_MS);
    lock = tryOsLock(path);
  }
  if (waits !== undefined && blocked) {
    waits.ms += Date.now() - began;
    waits.said ??= (waitedMs) => projectWaitedSaid(waitedMs, project);
  }
  try {
    return await body();
  } finally {
    lock.release();
  }
}

/**
 * Runs [param body] holding one of the machine's slots for the call, handing it the slot's file,
 * and gives it back after. [param project] is the project the call is for. With [param free], or
 * inside {@link withoutASlot}, it takes no slot and [param body] gets null. It waits only for the
 * project's other slotless engines ({@link PROJECTS_FOLDER}). An engine started inside another
 * engine's slot (GODOT_ENGINE_HELD) runs on that slot either way.
 */
export async function inASlot<T>(
  body: (lock: string | null) => Promise<T>,
  project?: string,
  free = false,
): Promise<T> {
  if ((free || withoutSlots.getStore() === true) && nonEmpty(process.env[HELD_VARIABLE]) === undefined) {
    return await inTheProjectsTurn(async () => await body(null), project);
  }
  const kept = keptForSteps.getStore();
  if (kept !== undefined) {
    kept.held ??= slotForCall();
    return await body((await kept.held).lock);
  }
  const held = await slotForCall();
  try {
    return await body(held.lock);
  } finally {
    held.release();
  }
}

/**
 * Runs [param body], a command whose engines are short setup steps, with every engine it starts
 * taking no slot. Setup waited behind runs of forty minutes or more for each of its engines.
 */
export async function withoutASlot<T>(body: () => Promise<T>): Promise<T> {
  return await withoutSlots.run(true, body);
}

/**
 * Runs [param body], a call whose engines run one after another, holding one slot for all of them.
 */
export async function inOneSlot<T>(body: () => Promise<T>): Promise<T> {
  if (keptForSteps.getStore() !== undefined) {
    return await body();
  }
  const kept: { held: Promise<CallSlot> | null } = { held: null };
  try {
    return await keptForSteps.run(kept, body);
  } finally {
    await givenBack(kept);
  }
}

/**
 * Runs [param wait] with the slot {@link inOneSlot} holds given back first, and the next engine step
 * taking one again. A command waiting on another's engine or on an editor would otherwise keep a
 * slot that engine may be queued for. Outside {@link inOneSlot} it only runs [param wait].
 */
export async function withTheSlotFree<T>(wait: () => Promise<T>): Promise<T> {
  const kept = keptForSteps.getStore();
  if (kept !== undefined) {
    await givenBack(kept);
  }
  return await wait();
}

async function givenBack(kept: { held: Promise<CallSlot> | null }): Promise<void> {
  const taken = kept.held;
  kept.held = null;
  // A take that failed was thrown to the engine step that asked for it, and holds nothing.
  const held = await taken?.catch(() => null);
  held?.release();
}
