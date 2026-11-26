/**
 * The engine slots a machine's test engines share, so that every tool starting one counts it.
 *
 * Each slot is a file, ${directory}/<n>.lock for n from 0 below the count, made with an exclusive
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
 * holding it. A lock numbered at or past the count, which only a taker given more slots makes, is
 * removed the same way by every take once its holder has gone.
 *
 * An engine started on a slot has the slot's lock in {@link HELD_VARIABLE}, so the programs it
 * starts run on its slot.
 *
 * Three rules decide who takes a slot. The cap: no more engines than the count run at once. The
 * memory check: an engine starts only when the machine's free memory now, less what is kept for
 * everything else, covers its need and what every running engine still owes
 * ({@link EngineSlots.memoryShort}). The line: a taker that finds every slot held keeps a mark,
 * `${directory}/waiting/<pid>-<n>.json` holding what a lock does and when it began to wait (`since`,
 * in milliseconds), until its take ends. A free slot goes to the oldest waiter that can take it, so
 * each take leaves one free slot to each taker ahead of it ({@link SlotLine}). A mark whose holder
 * has gone is free by the same rule as a lock.
 *
 * One directory and one count serve the whole machine, whichever project an engine is for: every
 * game's tool and this server's own engines draw on the same slots. The directory is
 * `$XDG_CACHE_HOME/gdharness/slots` where that variable is set, else `%LOCALAPPDATA%\gdharness\slots`
 * on Windows, else `~/.cache/gdharness/slots`. The count is half the processors, at least one.
 * `GODOT_ENGINE_SLOT_COUNT` replaces it and a command's `--slots` and `--slot-count` replace those
 * ({@link machineSlots}), and a file `<directory>/count` holding a whole number above 0 replaces
 * all of them, read at every take ({@link SLOT_COUNT_FILE}).
 *
 * Other tools take slots in this directory the same way, which is the point of it: the scheme is
 * written out in docs/test-runs.md for them, and a change here is a change there.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  watch,
} from 'node:fs';
import { availableParallelism, homedir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { callProgress, callSignal, callSlotWaits, waitedUnlessAborted } from './call-signal.js';
import { helperPid } from './desktop.js';
import {
  ceilingFor,
  engineNeed,
  gigabytes,
  MEMORY_KEPT,
  MEMORY_PER_ENGINE,
  memoryAvailable,
} from './engine-memory.js';
import { heldBy as bytesHeldBy } from './engine-spent.js';
import { wholeFlag } from './launch.js';
import {
  ancestorsIn,
  type ProcessTree,
  processTree,
  readCommandLine,
  startTimesOf,
} from './process-children.js';
import { isRecord } from './records.js';
import { type PeakTool, readEnginePeaks } from './run-record.js';
import { Turns } from './turns.js';
import {
  changeWholeAsync,
  madeInPlace,
  makeWhole,
  readWholeAsync,
  removeWhole,
  removeWholeAsync,
  stagedWriterOf,
  writeWhole,
  writeWholeAsync,
} from './whole-file.js';

/**
 * The variable an engine started on a slot is given, naming that slot's lock, so a program the
 * engine starts that takes slots the same way runs on the engine's slot rather than taking a second:
 * a game's trailer and screenshot helpers held a slot of their own beside the game's, and one game
 * held both slots kept for the sessions.
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
/** What a lock counts for its engine until a figure is recorded in it: the flat per-engine figure. */
const ENGINE_MEMORY_BYTES = MEMORY_PER_ENGINE;

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
export const SLOT_COUNT_FILE = 'count';

/**
 * The cap [param directory]'s count file holds, or undefined where there is none or it holds
 * anything but a whole number above 0, which leaves the count the take was made with.
 */
export function slotCountFileOf(directory: string): number | undefined {
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
/** The suffix of the note a wait leaves beside its mark as it ends, in place of the mark's `.json`. */
export const ENDED_SUFFIX = '.ended';
/** How long an ended wait's note is kept, after which the next wait in the folder removes it. */
const ENDED_KEPT_MS = 600_000;

/** The note [param mark]'s wait leaves as it ends. */
export function endedNoteOf(mark: string): string {
  return `${mark.replace(/\.json$/, '')}${ENDED_SUFFIX}`;
}

/** What follows a mark's name in the file whose time says when its taker last looked. */
const SEEN_SUFFIX = '.seen';

/** The file beside [param mark] that its taker writes at each look. */
function seenNoteOf(mark: string): string {
  return `${mark.replace(/\.json$/, '')}${SEEN_SUFFIX}`;
}

/**
 * Sets the time of the look note beside [param mark] to now, making it first where it is not there.
 * Only the time changes after the first look, so the folder a take watches stays quiet.
 */
function lookNoted(mark: string): void {
  const note = seenNoteOf(mark);
  try {
    closeSync(openSync(note, 'a'));
    const now = new Date();
    utimesSync(note, now, now);
  } catch {
    // The wait is marked alive by its mark's own time instead, which costs a moment, never a slot.
  }
}

/**
 * When [param mark] was made, in seconds since the epoch, or undefined when it cannot be read. Summed
 * from whole seconds and nanoseconds as Python's `st_mtime` is, so a reader in Python matching a
 * note to its mark by this start finds the same number.
 */
export function markBegan(mark: string): number | undefined {
  try {
    const ns = statSync(mark, { bigint: true }).mtimeNs;
    return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) * 1e-9;
  } catch {
    return undefined;
  }
}

/** The notes of waits in [param marks] that ended longer ago than they are kept. */
function endedNotesOld(marks: string): string[] {
  let names: string[];
  try {
    names = readdirSync(marks).filter((name) => name.endsWith(ENDED_SUFFIX) || name.endsWith(SEEN_SUFFIX));
  } catch {
    return [];
  }
  return names
    .map((name) => join(marks, name))
    .filter((path) => {
      try {
        return Date.now() - statSync(path).mtimeMs > ENDED_KEPT_MS;
      } catch {
        // Gone already, which the next wait sweeps again.
        return false;
      }
    });
}

/** Removes the notes of waits in [param marks] that ended longer ago than they are kept. */
function endedNotesSwept(marks: string): void {
  for (const path of endedNotesOld(marks)) {
    removeWhole(path);
  }
}

/** {@link endedNotesSwept} for a wait on the event loop. */
async function endedNotesSweptAsync(marks: string): Promise<void> {
  for (const path of endedNotesOld(marks)) {
    await removeWholeAsync(path);
  }
}
/**
 * How long a take leaves a free slot to a taker waiting longer that may take it, past which it takes
 * the slot itself. One waiting ahead takes a slot within a moment of its coming free, woken as the
 * lock goes, so one left that long is one it cannot take after all, a mark misread or a taker the
 * queue has paused, and a slot never stands idle longer while someone waits who may take it. A taker
 * that has looked since, which it says by touching the note beside its mark, is still taking, so the
 * time counts from its last look.
 */
export const SLOT_YIELD_MS = 5000;

/** The kind a waiting mark names for a wait for memory, which takes no slot and holds no place in line. */
const MEMORY_TAKER = 'memory';

/** A taker waiting for one of the machine's slots, as its mark names it. */
interface SlotWaiter {
  readonly mark: string;
  readonly pid: number;
  /** When it began to wait, in milliseconds since the epoch. */
  readonly since: number;
  /** When it last looked, in milliseconds, or when its mark was made where it never says. */
  readonly seen: number;
}

/**
 * Each live taker waiting for a slot in [param directory], as its mark names it, the mark file
 * names given by [param marks] read as [param read]. A mark that names no holder, no time it began
 * to wait or a holder that has gone is no waiter, and one of kind {@link MEMORY_TAKER} is a run's
 * own wait for memory.
 */
async function slotWaitersAsync(
  directory: string,
  isFree: (content: string, writtenAt: number) => Promise<boolean>,
): Promise<SlotWaiter[]> {
  const marks = join(directory, WAITING_FOLDER);
  const found: SlotWaiter[] = [];
  for (const mark of markNames(marks)) {
    let content: string | null;
    try {
      content = await readWholeAsync(join(marks, mark));
    } catch {
      continue;
    }
    const madeAt = fileTimeOr(join(marks, mark), Number.NaN);
    if (content === null || Number.isNaN(madeAt)) {
      continue;
    }
    const waiter = waiterOfMark(marks, mark, content, madeAt);
    if (waiter !== null && !(await isFree(content, madeAt))) {
      found.push(waiter);
    }
  }
  return found;
}

/** The names of the mark files in [param marks], in order, none where the folder cannot be listed. */
function markNames(marks: string): string[] {
  try {
    return readdirSync(marks)
      .filter((name) => name.endsWith('.json'))
      .toSorted();
  } catch {
    return [];
  }
}

/**
 * The waiter the mark file [param mark] in [param marks] names, which read as [param content] and
 * was made at [param madeAt], or null when it names none: no holder, no whole millisecond time it
 * began to wait, or a wait for memory.
 */
function waiterOfMark(marks: string, mark: string, content: string, madeAt: number): SlotWaiter | null {
  const holder = holderOf(content);
  const parsed: unknown = holder === null ? null : JSON.parse(content);
  if (holder === null || !isRecord(parsed)) {
    return null;
  }
  const { since, taker } = parsed;
  if (taker === MEMORY_TAKER || typeof since !== 'number' || !Number.isFinite(since)) {
    return null;
  }
  return {
    mark,
    pid: holder.pid,
    // In whole milliseconds, as a take's own clock reads: a file's time has a fraction.
    since: Math.floor(since),
    // No look written: the wait has only its mark's time to show it is alive.
    seen: Math.floor(fileTimeOr(join(marks, seenNoteOf(mark)), madeAt)),
  };
}
/**
 * When the file of [param stats] was last written, in whole milliseconds rounded down. It is read
 * from the nanoseconds, since `mtimeMs` is a double that rounds a time ending in .9999 ms up to the
 * next millisecond.
 */
function fileTimeMs(stats: { readonly mtimeNs: bigint }): number {
  return Number(stats.mtimeNs / 1_000_000n);
}

/** When the file at [param path] was last written, or [param otherwise] where it cannot be read. */
function fileTimeOr(path: string, otherwise: number): number {
  try {
    return fileTimeMs(statSync(path, { bigint: true }));
  } catch {
    return otherwise;
  }
}

/**
 * A take's place among those waiting for the machine's slots: it leaves each free slot to the takers
 * waiting longer, in the order they began to wait, so a taker waiting its hour is never overtaken by
 * the next one to look, whichever wakes first as a lock goes. Takers that began in the same
 * millisecond go by pid, then by the name of their mark. A wait for several slots is one mark for
 * each, all with the one start, so it keeps its place for each and takes them as they come free.
 */
export class SlotLine {
  readonly since: number;
  /** The name of its own waiting mark once it has one. */
  mark: string | undefined;
  /** The slots it leaves to those ahead at its last look. */
  private left = new Set<number>();
  /**
   * Each free slot it has left to a taker ahead at every look since, with the first of those looks,
   * whichever taker ahead it left the slot to at each.
   */
  private readonly freeSince = new Map<number, number>();
  private readonly pid: number;
  /** The bytes its engine will hold, which the memory check counts. */
  need = 0;

  constructor(pid: number, since: number = Date.now()) {
    this.pid = pid;
    this.since = since;
  }

  /** What its waiting mark holds beside [param holder]: when it began, in milliseconds. */
  marked(holder: SlotHolder): object {
    return { ...holder, since: this.since };
  }

  /**
   * The takers of [param waiters] ahead of this one, the first first: those that began to wait
   * before it, then those of a lower pid, then those of a lower mark name.
   */
  ahead(waiters: readonly SlotWaiter[]): SlotWaiter[] {
    const own = { since: this.since, pid: this.pid, mark: this.mark ?? '￿' };
    const before = (a: { since: number; pid: number; mark: string }, b: typeof a): number =>
      a.since - b.since || a.pid - b.pid || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0);
    return waiters
      .filter((one) => one.mark !== this.mark && before(one, own) < 0)
      .toSorted((a, b) => before(a, b));
  }

  /**
   * Those of [param numbers] it may take now, the order kept: it leaves out each of [param theirs],
   * the free slots those ahead take first. How long they are left is counted per slot
   * ({@link SlotLine.stoodFree}).
   */
  admitted(numbers: readonly number[], theirs: ReadonlySet<number>): number[] {
    this.left = new Set(theirs);
    return numbers.filter((slot) => !theirs.has(slot));
  }

  /** The free slots it leaves to those waiting longer, lowest first. */
  leaves(): number[] {
    return [...this.left].toSorted((a, b) => a - b);
  }

  /**
   * Notes that the look at [param now] leaves the free slots [param claimed] to takers ahead, and
   * answers those of them it has left at every look for {@link SLOT_YIELD_MS}. Each slot keeps a
   * clock of its own, started at the first look that leaves it.
   */
  stoodFree(claimed: Iterable<number>, now: number): Set<number> {
    const stood = new Set<number>();
    for (const slot of claimed) {
      const since = this.freeSince.get(slot) ?? now;
      this.freeSince.set(slot, since);
      if (now - since >= SLOT_YIELD_MS) {
        stood.add(slot);
      }
    }
    return stood;
  }

  /**
   * Ends a look that left [param left] to takers ahead: a slot it did not leave, held or taken,
   * starts again at the next look that leaves it.
   */
  forgetAllBut(left: ReadonlySet<number>): void {
    for (const slot of this.freeSince.keys()) {
      if (!left.has(slot)) {
        this.freeSince.delete(slot);
      }
    }
  }
}

/** Why a take with a free slot waits: the machine's memory does not cover what its engine needs. */
interface MemoryShort {
  /** The memory the machine can give engines now, in bytes. */
  readonly free: number;
  /** What the machine keeps for everything else. */
  readonly kept: number;
  /** What the engines already running still owe: their recorded peaks less what they hold now. */
  readonly owed: number;
  /** What this take's engine needs. */
  readonly need: number;
}

/** The slot numbers a take may try, in order, and what holds it back when something does. */
interface SlotsDrawn {
  readonly numbers: readonly number[];
  /** Free ones of them the take leaves to takers waiting longer: see {@link SlotLine}. */
  readonly left?: readonly number[];
  /** Set where a free slot is held back by the memory check. */
  readonly short?: MemoryShort;
}

/** The slots of [param count], all of which any take may try. */
function slotsDrawnOn(count: number): SlotsDrawn {
  return { numbers: Array.from({ length: count }, (_, slot) => slot) };
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
      await new Promise<void>((release) => {
        const done = (): void => {
          clearTimeout(timer);
          this.wake = null;
          signal?.removeEventListener('abort', done);
          release();
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
 * Whether the process [param pid] in [param tree] runs on the slot [param holder] holds: whether the
 * nearest process above it whose executable is not [param executable] is the holder, or the engine
 * the lock names with a start within {@link START_TOLERANCE_MS} of the one written. Those running
 * [param executable] are passed over as launchers of its own, a `bun` under `bun run`. A game an
 * editor plays runs the editor's executable, so the editor is passed over too and the game takes a
 * slot of its own. [param engineStarted] is when the named engine's pid started, for a tree that
 * does not list it. An engine whose start cannot be read lends nothing.
 */
export function inheritsSlot(
  tree: ProcessTree,
  pid: number,
  holder: Pick<SlotHolder, 'pid' | 'engine'>,
  executable: string,
  engineStarted?: number,
): boolean {
  // A command line names a program with or without its extension, in either case, on Windows.
  const program = (name: string): string => name.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
  const own = program(executable);
  for (const above of ancestorsIn(tree, pid, holder.pid)) {
    if (program(readCommandLine(tree.get(above)?.command ?? '').executable) !== own) {
      if (above === holder.pid) {
        return true;
      }
      const started = tree.get(above)?.startedAt ?? engineStarted;
      return (
        above === holder.engine?.pid &&
        started !== undefined &&
        Math.abs(started - holder.engine.started) <= START_TOLERANCE_MS
      );
    }
  }
  return false;
}
/**
 * Who holds a lock, as its file says. [member by] is what took it, such as a test run and its
 * project, so a wait can say who it waits behind. A lock written without it is named by its pid.
 */
export interface SlotHolder {
  readonly pid: number;
  readonly started: number;
  readonly by?: string;
  /**
   * The engine whose programs run on the slot, for a holder that is not it: a keeper holding the
   * slot for its game, which comes back under another pid when it restarts itself, or a process
   * waiting on an engine it started. Named as the holder is, and judged the same way.
   */
  readonly engine?: SlotEngine;
  /**
   * The most the engine on the slot is expected to hold, in bytes: its recorded peak, which the
   * memory check counts less what the engine holds now ({@link EngineSlots.memoryShort}). A lock
   * without it counts {@link ENGINE_MEMORY_BYTES}.
   */
  readonly memory?: number;
}

/** An engine a lock names beside its holder. */
interface SlotEngine {
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
    const { by, engine, memory } = parsed as {
      by?: unknown;
      engine?: unknown;
      memory?: unknown;
    };
    const named = namedProcess(parsed);
    if (named === null) {
      return null;
    }
    const runs = namedProcess(engine);
    return {
      ...named,
      ...(typeof by === 'string' && by !== '' ? { by } : {}),
      ...(runs === null ? {} : { engine: runs }),
      ...(typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? { memory } : {}),
    };
  } catch {
    return null;
  }
}

/** The `{"pid", "started"}` [param value] holds, or null. */
function namedProcess(value: unknown): SlotEngine | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { pid, started } = value as { pid?: unknown; started?: unknown };
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof started === 'number'
    ? { pid, started }
    : null;
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
/** [param path] resolved, and lower-cased on Windows, which is how marks are compared. */
function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
  /** Each waiting mark this process keeps, with when its wait began as {@link markBegan} reads it. */
  private readonly marks = new Map<string, number>();
  /**
   * The waiting marks this process has left a free slot to, each with when it first did. One that
   * lets a slot left to it stand {@link SLOT_YIELD_MS} is waiting for something else, memory or a
   * hold of its own, so no take of this process leaves it another.
   */
  private readonly passedOver = new Map<string, number>();
  /** The slot of the engine that started this process while one of its engines runs on it. */
  private inherited: string | null = null;
  /** The last look at the inherited slot, which the next one waits for. */
  private readonly inheriting = new Turns();
  /** The slots the last look could take, in the order it tried them, and what held it to them. */
  drawn: SlotsDrawn;
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  /** The cap the take was made with, which the count file of the folder replaces at each take. */
  private readonly configured: number;
  private cap: number;
  readonly holder: SlotHolder;
  private readonly say: ((line: string) => void) | undefined;
  /** The Godot project this process's takes are for, which its engines' kept peaks are read for. */
  private readonly project: string | undefined;

  /** The physical memory of the machine, which an engine's ceiling is counted from. */
  private readonly machineMemory: number;
  /** The tool whose kept peak counts an engine this process takes a slot for, where a take names none. */
  private readonly tool: PeakTool;
  /** The memory the machine can give engines now, in bytes. */
  private readonly available: () => Promise<number>;
  /** What each of [param pids] and the processes below it hold now, in bytes. */
  private readonly heldNow: (pids: readonly number[]) => Promise<Map<number, number>>;
  /** The bytes every engine this takes counts for, in place of what its project's peaks give. */
  private readonly fixedNeed: number | undefined;

  constructor(
    directory: string,
    count: number,
    holder: SlotHolder,
    say?: (line: string) => void,
    project?: string,
    machine: {
      readonly memory?: number;
      readonly tool?: PeakTool;
      readonly available?: () => Promise<number>;
      readonly held?: (pids: readonly number[]) => Promise<Map<number, number>>;
      readonly need?: number;
    } = {},
  ) {
    this.directory = directory;
    this.configured = count;
    this.cap = count;
    this.holder = holder;
    this.say = say;
    this.project = project;
    this.machineMemory = machine.memory ?? totalmem();
    this.tool = machine.tool ?? 'project_test';
    this.available = machine.available ?? (async () => (await memoryAvailable()).bytes);
    this.heldNow = machine.held ?? bytesHeldBy;
    this.fixedNeed = machine.need;
    this.drawn = slotsDrawnOn(count);
  }

  /** How many engines that take slots may run on the machine at once, as of the last take. */
  get count(): number {
    return this.cap;
  }

  /**
   * What an engine of [param tool] for [param project] may hold, which its lock counts: the flat
   * figure or the project's kept peak, at most its ceiling. A ceiling that cannot be read caps nothing
   * here, since the start that reads it refuses it in its own words.
   */
  private memoryNeeded(game: boolean, project: string | undefined, tool?: PeakTool): number {
    if (this.fixedNeed !== undefined) {
      return this.fixedNeed;
    }
    const kind = tool ?? (game ? 'editor_run' : this.tool);
    let ceiling = Number.POSITIVE_INFINITY;
    try {
      ceiling = ceilingFor(project, process.env, this.machineMemory).bytes;
    } catch {
      // Refused by the start itself.
    }
    return engineNeed(project === undefined ? undefined : readEnginePeaks(project)[kind], ceiling, kind)
      .bytes;
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its lock's path. A take that finds every
   * slot held keeps a mark of its wait until it ends, however it ends, and calls [param blocked]
   * once, as it begins waiting. [param game] is a take for a game editor_run started, whose engine
   * counts the memory of that tool. [param project] is the Godot project the take is for, in place
   * of the one this process's takes are for.
   */
  async take(
    signal?: AbortSignal,
    waiting?: (waitedMs: number) => void,
    blocked?: () => void,
    game = false,
    project?: string,
    tool?: PeakTool,
  ): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    const line = new SlotLine(this.holder.pid);
    line.need = this.memoryNeeded(game, project ?? this.project, tool);
    const began = line.since;
    let said = Number.NEGATIVE_INFINITY;
    let mark: string | undefined;
    let changes: FolderChanges | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const lock = await this.takeFree(game, line);
        if (lock !== null) {
          return lock;
        }
        if (mark === undefined) {
          mark = await this.waitMarkedAsync(line);
          blocked?.();
        }
        const now = Date.now();
        said = this.sayWaiting(now, began, said, waiting);
        if (changes === undefined) {
          // Looked at again once watched, since a slot given back before the watch began says nothing.
          changes = new FolderChanges(this.directory);
          continue;
        }
        const sayAt = this.nextSayAt(began, said, waiting !== undefined);
        await changes.next(Math.max(0, Math.min(SLOT_LOOK_MS, sayAt - Date.now())), SLOT_SETTLE_MS, signal);
      }
    } finally {
      changes?.close();
      if (mark !== undefined) {
        await this.waitEndedAsync(mark);
      }
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
      this.say(slotWaitSaid(now - began, this.count, this.directory, this.holders(), this.drawn));
    }
    return said;
  }

  /**
   * When the next line is due. A wait is woken for the next line as well as for the next look, so it
   * comes when it is due: said only at a look, the line due two seconds in came near three, as the
   * first look read a holder's start for 1.9 s on a loaded machine and the next came a second after
   * that.
   */
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
   * Takes a slot that is free now and answers its lock's path, or null when none may be taken: every
   * slot is held, the free ones are left to the takers waiting longer, or the machine's memory does
   * not cover the engine ({@link EngineSlots.memoryShort}). The count is read again from the folder
   * at every look. A slot already held is kept to its end whatever arrives. A take leaves the free
   * slots the takers ahead of [param line] take first ({@link SlotLine}). One given no line came last.
   */
  async takeFree(game = false, line?: SlotLine): Promise<string | null> {
    mkdirSync(this.directory, { recursive: true });
    this.cap = slotCountFileOf(this.directory) ?? this.configured;
    await this.sweep();
    const inherited = await this.inheritedByOne();
    if (inherited !== null) {
      return inherited;
    }
    const placed = line ?? new SlotLine(this.holder.pid);
    this.drawn = slotsDrawnOn(this.cap);
    if (placed.mark !== undefined) {
      // A look says its taker still looks, so the slots left to a wait last their yield. A taker
      // that stops looking stops holding the takers behind it.
      lookNoted(join(this.directory, WAITING_FOLDER, placed.mark));
    }
    const tried = await this.leftAfterThoseAhead(placed);
    if (tried.length === 0) {
      return null;
    }
    const need = placed.need > 0 ? placed.need : this.memoryNeeded(game, this.project);
    if (await this.memoryHoldsBack(need)) {
      return null;
    }
    const lock = await this.lockOneOf(tried, need);
    if (lock !== null && (await this.overTheMemory(lock, need))) {
      this.release(lock);
      return null;
    }
    return lock;
  }

  /**
   * What the engines on the machine still owe, summed over every slot lock whose holder lives: its
   * recorded peak less what the engine it names holds now, never below 0. A lock naming no engine
   * yet, or one whose engine cannot be read, owes its whole figure. With [param before], only the
   * locks written before it count, by the time and then the slot, and [param own] is no lock's.
   */
  private async owedByLocks(
    before?: { at: number; slot: number },
    own?: string,
  ): Promise<{ owed: number; engines: number }> {
    const live: { lock: string; slot: number; at: number; holder: SlotHolder }[] = [];
    for (const { slot, lock, content } of await this.heldLocks(true)) {
      const holder = content === null ? null : holderOf(content);
      const at = this.writtenAt(lock) ?? 0;
      if (
        holder !== null &&
        lock !== own &&
        (before === undefined || at < before.at || (at === before.at && slot < before.slot))
      ) {
        live.push({ lock, slot, at, holder });
      }
    }
    const named = live.flatMap((one) => (one.holder.engine === undefined ? [] : [one.holder.engine.pid]));
    const now = named.length === 0 ? new Map<number, number>() : await this.heldNow(named);
    const owed = live.reduce((sum, one) => {
      const peak = one.holder.memory ?? ENGINE_MEMORY_BYTES;
      const holding = one.holder.engine === undefined ? 0 : (now.get(one.holder.engine.pid) ?? 0);
      return sum + Math.max(0, peak - holding);
    }, 0);
    return { owed, engines: live.length };
  }

  /**
   * Why an engine needing [param need] may not start now: the free memory read now, less
   * {@link MEMORY_KEPT} and what the engines running still owe ({@link owedByLocks}), does not cover
   * it. Undefined where it does, and where no other engine holds a slot, since nothing would give
   * memory back and an engine alone on the machine starts. With [param before], only the engines
   * ahead of that lock are counted.
   */
  private async memoryShort(
    need: number,
    before?: { at: number; slot: number; lock: string },
  ): Promise<MemoryShort | undefined> {
    const { owed, engines } = await this.owedByLocks(before, before?.lock);
    if (engines === 0) {
      return undefined;
    }
    const free = await this.available();
    return free - MEMORY_KEPT - owed >= need ? undefined : { free, kept: MEMORY_KEPT, owed, need };
  }

  /** Whether the engine of a take may not start now for want of memory, which it records in the draw. */
  private async memoryHoldsBack(need: number): Promise<boolean> {
    const short = await this.memoryShort(need);
    if (short === undefined) {
      return false;
    }
    this.drawn = { ...this.drawn, short };
    return true;
  }

  /**
   * Whether the lock just taken at [param lock] is one too many: counting only the locks written
   * before it, the engines still owe too much for it. Two takers that both counted room for one
   * engine before either took it then cannot both keep theirs, since the later one counts the
   * earlier and the earlier counts nothing of it.
   */
  private async overTheMemory(lock: string, need: number): Promise<boolean> {
    const slot = Number(/(\d+)\.lock$/.exec(lock)?.[1]);
    const short = await this.memoryShort(need, { at: this.writtenAt(lock) ?? Date.now(), slot, lock });
    if (short === undefined) {
      return false;
    }
    this.drawn = { ...this.drawn, short };
    return true;
  }

  /** The slots with no lock or a lock whose holder has gone, the lowest first. */
  private async openSlots(): Promise<number[]> {
    const held = new Set((await this.heldLocks()).map((one) => one.slot));
    return Array.from({ length: this.cap }, (_, slot) => slot).filter((slot) => !held.has(slot));
  }

  /**
   * The slots whose lock is there and whose holder has not gone, the lowest first, each with its
   * lock and what it read as, or null where it went before it could be read. Those of the count, or
   * with [param all] every numbered lock of the folder, which the memory check reads.
   */
  private async heldLocks(all = false): Promise<{ slot: number; lock: string; content: string | null }[]> {
    const held: { slot: number; lock: string; content: string | null }[] = [];
    let slots = Array.from({ length: this.cap }, (_, slot) => slot);
    if (all) {
      try {
        const named = readdirSync(this.directory).flatMap((name) => {
          const numbered = /^(\d+)\.lock$/.exec(name)?.[1];
          return numbered === undefined ? [] : [Number(numbered)];
        });
        slots = [...new Set([...slots, ...named])].toSorted((a, b) => a - b);
      } catch {
        // No folder yet: no lock.
      }
    }
    for (const slot of slots) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (existsSync(lock) && !(await this.free(lock))) {
        held.push({ slot, lock, content: await readWholeAsync(lock) });
      }
    }
    return held;
  }

  /** Locks the first of [param slots] that is made fresh or taken over, and answers its path. */
  private async lockOneOf(slots: readonly number[], memory: number): Promise<string | null> {
    const holder: SlotHolder = { ...this.holder, memory: Math.round(memory) };
    for (const slot of slots) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (madeInPlace(lock, JSON.stringify(holder)) || (await this.takenOver(lock, holder, true))) {
        this.held.add(lock);
        return lock;
      }
    }
    return null;
  }

  /**
   * The free slots [param placed] may try, once the free ones the takers ahead of it
   * take first are left to them. It records the slots it left for them in the draw. Each taker ahead
   * that has looked within {@link SLOT_YIELD_MS} takes one free slot, the lowest first. A slot
   * left to them at every look for {@link SLOT_YIELD_MS} is not left any longer, since a taker
   * that holds it and does not take it waits for something else.
   */
  private async leftAfterThoseAhead(placed: SlotLine): Promise<number[]> {
    const drawn = this.drawn;
    const now = Date.now();
    const waiting = await slotWaitersAsync(this.directory, (content, writtenAt) =>
      this.freeAsRead(content, writtenAt),
    );
    for (const mark of this.passedOver.keys()) {
      if (!waiting.some((one) => one.mark === mark)) {
        this.passedOver.delete(mark);
      }
    }
    const ahead = placed
      .ahead(waiting)
      .filter((one) => now - Math.max(this.passedOver.get(one.mark) ?? now, one.seen) < SLOT_YIELD_MS);
    const open = await this.openSlots();
    const claimed = open.slice(0, ahead.length);
    for (const one of ahead.slice(0, claimed.length)) {
      if (!this.passedOver.has(one.mark)) {
        this.passedOver.set(one.mark, now);
      }
    }
    const stood = placed.stoodFree(claimed, now);
    const theirs = new Set(claimed.filter((slot) => !stood.has(slot)));
    placed.forgetAllBut(new Set(claimed));
    const left = placed.leaves();
    if (left.length > 0 && this.drawn === drawn) {
      this.drawn = { ...drawn, left };
    }
    return placed.admitted(open, theirs);
  }

  /**
   * The inherited slot for the one take that finds it unused, or null. Looks run one at a time, so
   * two takes begun together cannot both read it as unused before either has claimed it.
   */
  private inheritedByOne(): Promise<string | null> {
    return this.inheriting.run(async () => {
      if (this.inherited !== null) {
        return null;
      }
      const lock = await this.inheritedLock();
      this.inherited = lock;
      return lock;
    });
  }

  /**
   * The slot [constant HELD_VARIABLE] names, for one engine of this process to run on, or null. Taken
   * only while the lock's holder is the nearest process above this one running another executable,
   * past the launchers of this one's own: a game an editor plays inherits the editor's environment,
   * so the variable alone would put it on the editor's slot.
   */
  private async inheritedLock(): Promise<string | null> {
    return await this.engineLock();
  }

  /** The lock of the engine above this process, which [constant HELD_VARIABLE] names, or null. */
  private async engineLock(): Promise<string | null> {
    const lock = nonEmpty(process.env[HELD_VARIABLE]);
    const content = lock === undefined ? null : await readWholeAsync(lock);
    const holder = content === null ? null : holderOf(content);
    if (lock === undefined || holder === null || (await this.free(lock))) {
      return null;
    }
    const tree = await processTree();
    const engine = holder.engine?.pid;
    const engineStarted =
      engine === undefined || tree?.get(engine)?.startedAt !== undefined
        ? undefined
        : (await startTimesOf([engine])).get(engine);
    return tree !== undefined &&
      inheritsSlot(tree, process.pid, holder, basename(process.execPath), engineStarted)
      ? lock
      : null;
  }
  /**
   * Puts down the mark of a wait for something other than a slot, memory for one, and answers what
   * takes it up again, so another queue counting its own time reads that wait as held up by others too. It
   * names its kind as `memory`, which no take lets go first, since it takes no slot.
   */
  markWaiting(): () => void {
    const mark = this.waitMarked({ ...this.holder, taker: MEMORY_TAKER });
    return () => {
      if (mark !== undefined) {
        this.waitEnded(mark);
      }
    };
  }

  /**
   * Puts down the mark of a wait, holding [param line]'s place or [param line] itself, and answers
   * its path, or undefined when it could not be made, which the next look tries again.
   */
  private waitMarked(line: SlotLine | object): string | undefined {
    const place = this.markPlace();
    if (place === undefined) {
      return undefined;
    }
    endedNotesSwept(place.marks);
    return this.markPut(place.mark, line);
  }

  /** {@link waitMarked} for a take on the event loop. */
  private async waitMarkedAsync(line: SlotLine | object): Promise<string | undefined> {
    const place = this.markPlace();
    if (place === undefined) {
      return undefined;
    }
    await endedNotesSweptAsync(place.marks);
    return this.markPut(place.mark, line);
  }

  /** The next wait mark's path in the waiting folder, made if need be, or undefined where it cannot be. */
  private markPlace(): { marks: string; mark: string } | undefined {
    const marks = join(this.directory, WAITING_FOLDER);
    waitsMarked += 1;
    const mark = join(marks, `${String(this.holder.pid)}-${String(waitsMarked)}.json`);
    try {
      mkdirSync(marks, { recursive: true });
    } catch {
      return undefined;
    }
    return { marks, mark };
  }

  private markPut(mark: string, line: SlotLine | object): string | undefined {
    if (!this.made(mark, line instanceof SlotLine ? line.marked(this.holder) : line)) {
      return undefined;
    }
    if (line instanceof SlotLine) {
      line.mark = basename(mark);
    }
    this.marks.set(mark, markBegan(mark) ?? Date.now() / 1000);
    return mark;
  }

  /**
   * Takes up the mark [param mark], first writing beside it when its wait began and ended. A reader
   * whose looks come seconds apart under load would otherwise end the wait at its last sighting:
   * measured, a 10.7 s wait was counted as 7.2 s.
   */
  private waitEnded(mark: string): void {
    const began = this.marks.get(mark);
    if (began === undefined) {
      return;
    }
    this.marks.delete(mark);
    writeWhole(endedNoteOf(mark), JSON.stringify({ began, ended: Date.now() / 1000 }));
    removeWhole(mark);
    removeWhole(seenNoteOf(mark));
  }

  /** {@link waitEnded} for a take on the event loop. */
  private async waitEndedAsync(mark: string): Promise<void> {
    const began = this.marks.get(mark);
    if (began === undefined) {
      return;
    }
    this.marks.delete(mark);
    await writeWholeAsync(endedNoteOf(mark), JSON.stringify({ began, ended: Date.now() / 1000 }));
    await removeWholeAsync(mark);
    await removeWholeAsync(seenNoteOf(mark));
  }
  /** When the file at [param path] was last written, in milliseconds, or undefined where it is not there. */
  private writtenAt(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /**
   * Makes [param path] as a lock is made, or takes it over under its steal file once its holder has
   * gone. Answers whether this call made it. The file counts as no slot.
   */
  async takeFile(path: string): Promise<boolean> {
    return this.made(path) || (await this.takenOver(path, this.holder));
  }

  /** Who holds the slots the last look could take, in the order it tried them, leaving out a lock that cannot be read. */
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
    for (const mark of this.marks.keys()) {
      this.waitEnded(mark);
    }
  }

  /** Gives back the slot at [param lock], or for the inherited one leaves it to its holder. */
  release(lock: string): void {
    if (lock === this.inherited) {
      this.inherited = null;
      return;
    }
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

  /**
   * Hands the slot at [param lock] to [param to], answering whether it did: see {@link handSlot}.
   */
  async hand(lock: string, to: SlotHolder): Promise<boolean> {
    const handed = await handSlot(lock, this.holder.pid, to);
    if (handed) {
      this.held.delete(lock);
    }
    return handed;
  }

  /**
   * Makes [param path] holding [param holder], never readable empty. Answers false when it is there
   * already.
   */
  private made(path: string, holder: object = this.holder): boolean {
    return makeWhole(path, JSON.stringify(holder));
  }

  /**
   * Removes every lock numbered at or past the count whose holder has gone. No taker of this count
   * reads them, so no take ever frees them: a taker given more slots left two there for seven hours.
   * One a live holder names is a taker's of more slots, and stays.
   */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return;
    }
    await this.clearedStaged(this.directory, names);
    for (const name of names) {
      const numbered = /^(\d+)\.lock$/.exec(name)?.[1];
      if (numbered !== undefined && Number(numbered) >= this.count) {
        await this.cleared(join(this.directory, name), false);
      }
    }
    await this.sweepWaits();
  }

  /**
   * Removes the wait marks of takers that have gone, by the rule a lock is freed by: a taker killed
   * while it waited leaves its mark, and a reader would count a wait that is not happening.
   */
  private async sweepWaits(): Promise<void> {
    const marks = join(this.directory, WAITING_FOLDER);
    let waits: string[];
    try {
      waits = readdirSync(marks);
    } catch {
      return;
    }
    await this.clearedStaged(marks, waits);
    for (const name of waits) {
      if (stagedWriterOf(name) !== undefined || !name.endsWith('.json')) {
        continue;
      }
      let content: string | null;
      try {
        content = await readWholeAsync(join(marks, name));
      } catch {
        // Held by a reader past the retries, which the next look tries again.
        continue;
      }
      const madeAt = fileTimeOr(join(marks, name), Number.NaN);
      if (content !== null && holderOf(content) !== null && !Number.isNaN(madeAt)) {
        if (await this.freeAsRead(content, madeAt)) {
          await removeWholeAsync(join(marks, name));
        }
      }
    }
  }

  /**
   * Removes the staged files among [param names] in [param folder] whose writer has gone, by the pid
   * in the name alone. A live writer's is left, and none is ever opened.
   */
  private async clearedStaged(folder: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      const writer = stagedWriterOf(name);
      if (writer !== undefined && writer !== process.pid && !alive(writer)) {
        await removeWholeAsync(join(folder, name));
      }
    }
  }

  /**
   * Takes over [param lock] for [param holder] when its holder has gone, under the steal file. A
   * machine slot [param inPlace] is made as a fresh take makes it, so its time is the take's own:
   * the memory check orders locks by it, and a lock put in place from a staged file would keep that
   * file's older time.
   */
  private takenOver(lock: string, holder: SlotHolder, inPlace = false): Promise<boolean> {
    return this.cleared(lock, true, holder, inPlace);
  }

  /**
   * Removes [param lock] when its holder has gone, under its steal file, so that a lock another
   * taker has just made in its place is never removed. With [param retake] it makes it again for
   * this process, written as [param holder]. Answers whether that was done.
   */
  private cleared(
    lock: string,
    retake: boolean,
    holder: SlotHolder = this.holder,
    inPlace = false,
  ): Promise<boolean> {
    return takenOverUnderSteal(
      lock,
      () => this.free(lock),
      (path) => this.made(path, holder),
      retake,
      inPlace ? (path) => madeInPlace(path, JSON.stringify(holder)) : undefined,
    );
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
    return await this.freeAsRead(content, writtenAt);
  }

  /** Whether a lock that read as [param content] and was last written at [param writtenAt] is free. */
  private async freeAsRead(content: string, writtenAt: number): Promise<boolean> {
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
 * Removes [param lock] once [param gone] says its holder has gone, under its steal file, so that a
 * lock another taker has just made in its place is never removed. [param make] makes a file for this
 * process, the steal file and with [param retake] the lock again, unless [param makeLock] makes the
 * lock. Answers whether that was done.
 * It tries the removal once and never waits, because a server calls it from its protocol and its
 * caller looks again.
 */
export async function takenOverUnderSteal(
  lock: string,
  gone: () => Promise<boolean>,
  make: (path: string) => boolean,
  retake = true,
  makeLock = make,
): Promise<boolean> {
  if (!(await gone())) {
    return false;
  }
  const steal = `${lock}.steal`;
  if (!make(steal)) {
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
    if (!(await gone())) {
      return false;
    }
    try {
      rmSync(lock, { force: true });
    } catch {
      // Held open by a tool locking the file itself: Windows will not remove it, and that tool still
      // holds the lock.
      return false;
    }
    return retake ? makeLock(lock) : true;
  } finally {
    rmSync(steal, { force: true });
  }
}
/**
 * Hands the slot at [param lock] to [param to] when it still names [param from], answering whether
 * it did. For an engine that outlives the process that waited for its slot, a game a keeper holds or
 * one an editor plays: the lock then names that engine's holder and is free once it has gone, by the
 * rule every lock is judged by. Renamed over the lock, so a taker reading it never finds it empty.
 */
export async function handSlot(lock: string, from: number, to: SlotHolder): Promise<boolean> {
  try {
    return await changeWholeAsync(lock, (content) => handedText(content, from, to));
  } catch {
    return false;
  }
}

/** What a lock that read as [param content] holds once handed from [param from] to [param to], or null. */
function handedText(content: string | null, from: number, to: SlotHolder): string | null {
  const holder = content === null ? null : holderOf(content);
  if (holder?.pid !== from) {
    return null;
  }
  // The slot counts the memory it did in the hands of whatever runs it.
  return JSON.stringify({
    ...to,
    ...(holder.memory === undefined || to.memory !== undefined ? {} : { memory: holder.memory }),
  });
}

/**
 * Raises the `memory` of the slot at [param lock] to [param bytes] where it counts less and this
 * process holds it, so the memory check counts an engine that grew past what its take counted. A figure is
 * never lowered. Renamed over the lock, as {@link handSlot} is.
 *
 * Answers what the lock counts after: [param bytes] once it is rewritten, and the figure it held
 * where that was as much already or the rewrite failed, as it does while a reader holds the lock
 * open. 0 where the lock could not be read, and null for a lock this process does not hold. An
 * answer below [param bytes] is a raise to ask again.
 */
export async function raiseSlotMemory(lock: string, bytes: number): Promise<number | null> {
  // Set in the change, which runs again on each try: null for a lock held elsewhere.
  const read: { held?: number | null } = {};
  let written = false;
  try {
    written = await changeWholeAsync(lock, (content) => {
      const holder = content === null ? null : holderOf(content);
      if (holder?.pid !== process.pid) {
        read.held = null;
        return null;
      }
      const was = holder.memory ?? ENGINE_MEMORY_BYTES;
      read.held = was;
      return bytes > was ? JSON.stringify({ ...holder, memory: bytes }) : null;
    });
  } catch {
    // Not rewritten, and the figure read, if any, stands.
  }
  if (read.held === null) {
    return null;
  }
  return written ? bytes : (read.held ?? 0);
}

/**
 * Names [param engine] in the slot at [param lock] as the engine running on it, when the lock still
 * names [param holder]. Answers whether it did. Renamed over the lock, as {@link handSlot} is.
 */
export async function nameSlotEngine(lock: string, holder: number, engine: SlotEngine): Promise<boolean> {
  try {
    // Read in the naming's turn, so a lock given back ahead of it is not made again.
    return await changeWholeAsync(lock, (content) => namedText(content, holder, engine));
  } catch {
    return false;
  }
}

/** What a lock that read as [param content] holds once it names [param engine], or null. */
function namedText(content: string | null, holder: number, engine: SlotEngine): string | null {
  const named = content === null ? null : holderOf(content);
  return named?.pid === holder ? JSON.stringify({ ...named, engine }) : null;
}

/**
 * Names the engine [param pid] started in the slot at [param lock], which [param holder] holds, once
 * its start has been read. A start the platform will not give names nothing, since an engine named
 * without one would lend its slot to nobody.
 */
export async function nameSlotEngineOf(lock: string, holder: number, pid: number): Promise<void> {
  const started = (await startTimesOf([pid])).get(pid);
  if (started !== undefined) {
    await nameSlotEngine(lock, holder, { pid, started });
  }
}

/**
 * Names in the slot at [param lock], which this process holds, the engine [param run] started: its
 * own pid, or the one a desktop helper writes to [param pidFile] once it has started the engine,
 * looked for until the run settles.
 */
export async function slotEngineNamed(
  lock: string,
  run: { readonly pid: number | null; readonly settled: Promise<void> },
  pidFile?: string,
): Promise<void> {
  if (pidFile === undefined) {
    if (run.pid !== null) {
      await nameSlotEngineOf(lock, process.pid, run.pid);
    }
    return;
  }
  // Held in an object, since it is set by the run settling, which no flow analysis follows.
  const state = { settled: false };
  void run.settled.finally(() => {
    state.settled = true;
  });
  while (!state.settled) {
    const written = helperPid(pidFile);
    if (written !== undefined) {
      await nameSlotEngineOf(lock, process.pid, written);
      return;
    }
    await delay(ENGINE_PID_LOOK_MS);
  }
}

/** How often the pid a desktop helper writes for its engine is looked for. */
const ENGINE_PID_LOOK_MS = 100;
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

/** {@link giveBackSlot} for a caller on the event loop. */
export async function giveBackSlotAsync(lock: string, pid: number): Promise<void> {
  try {
    if (holderOf(readFileSync(lock, 'utf8'))?.pid === pid) {
      await removeWholeAsync(lock);
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
    return new EngineSlots(
      chosen.directory,
      chosen.count,
      holder,
      (line) => {
        saidTo?.(line);
      },
      undefined,
      { tool: 'headless' },
    );
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
  const so = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine`;
  if (drawn.short !== undefined) {
    return `${so}: ${memoryShortSaid(drawn.short, false)}, so it starts once enough memory is given back.`;
  }
  const allLeft = allLeftSaid(drawn, directory, false);
  if (allLeft !== '') {
    return `${so}: ${allLeft}`;
  }
  const using = inUseOf(drawn, count);
  const slots = `${slotsInUseSaid(drawn, count, directory)} ${using === 1 ? 'is' : 'are'} in use`;
  const named = holdersNamed(using, holders);
  const waiting = `${so}: ${slots}`;
  const starts = `the engine starts when ${using === 1 ? 'it' : 'one'} is given back`;
  const said =
    named.length === 0
      ? `${waiting}, by other programs, and ${starts}.`
      : using === 1
        ? `${waiting}, by ${named.join(', ')}, and ${starts}.`
        : `${waiting}: ${listed(named)}. ${starts.charAt(0).toUpperCase()}${starts.slice(1)}.`;
  return `${said}${leftSaid(drawn)}`;
}

/**
 * What a take says when a slot is free and its engine does not fit the machine's memory: what the
 * machine has free, what it keeps, what the running engines still owe, and what it needs.
 * [param past] words it as it was when the take first waited.
 */
function memoryShortSaid(short: MemoryShort, past: boolean): string {
  return `the machine ${past ? 'had' : 'has'} ${gigabytes(Math.max(0, short.free))} of memory free, ${gigabytes(short.kept)} of it kept for everything else, the engines running ${past ? 'still owed' : 'still owe'} ${gigabytes(short.owed)} and this engine ${past ? 'needed' : 'needs'} ${gigabytes(short.need)}`;
}

/** Slot numbers [param slots] as a reader names them: "slot 2", "slots 1 and 2". */
function slotsNamed(slots: readonly number[]): string {
  return slots.length === 1 ? `slot ${String(slots[0])}` : `slots ${listed(slots.map(String))}`;
}

/**
 * What a take says when every slot of [param drawn] it may take is free and left to takers ahead of
 * it, or was when it first waited ([param past]). Empty when any of them is in use.
 */
function allLeftSaid(drawn: SlotsDrawn, directory: string, past: boolean): string {
  const left = drawn.left ?? [];
  if (left.length === 0 || drawn.numbers.some((slot) => !left.includes(slot))) {
    return '';
  }
  const one = left.length === 1;
  const may = `${one ? 'the one slot' : `the ${String(left.length)} slots`} it ${past ? 'could' : 'may'} take`;
  const free = past ? (one ? 'was' : 'were') : one ? 'is' : 'are';
  const said = `${may} on this machine (${directory}), ${slotsNamed(left)}, ${free} free and left to takers ahead of it in line`;
  return past ? `${said}.` : `${said}, which go first.`;
}

/** The slots of [param drawn] a take may try and does not leave free to a taker ahead, lowest first. */
function notLeftOf(drawn: SlotsDrawn): number[] {
  const left = drawn.left ?? [];
  return drawn.numbers.filter((slot) => !left.includes(slot)).toSorted((a, b) => a - b);
}

/** How many of the [param count] slots of [param drawn] are in use: all, or those it does not leave free. */
function inUseOf(drawn: SlotsDrawn, count: number): number {
  return (drawn.left?.length ?? 0) === 0 ? count : notLeftOf(drawn).length;
}

/** The slots of [param drawn] in use, of the [param count] of the machine: all of them, or by number where some are left free. */
function slotsInUseSaid(drawn: SlotsDrawn, count: number, directory: string): string {
  const all = slotsSaid(count, directory);
  return (drawn.left?.length ?? 0) === 0
    ? all
    : `${slotsNamed(notLeftOf(drawn))} of ${all.replace(/^all /u, 'the ')}`;
}

/** What a take says of the free slots of [param drawn] it leaves, or [param past] left, to takers ahead of it. */
function leftSaid(drawn: SlotsDrawn, past = false): string {
  const left = drawn.left ?? [];
  if (left.length === 0) {
    return '';
  }
  return past
    ? ` It left free ${slotsNamed(left)} to takers ahead of it in line.`
    : ` It leaves free ${slotsNamed(left)} to takers ahead of it in line, which go first.`;
}

/** The engine slots of the machine's [param count] in [param directory], named for what a take may use. */
function slotsSaid(count: number, directory: string): string {
  const where = `on this machine (${directory})`;
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
  if (drawn.short !== undefined) {
    return `This call waited ${String(Math.round(waitedMs / 1000))} s for engine memory in all. When it first waited, ${memoryShortSaid(drawn.short, true)}.`;
  }
  const allLeft = allLeftSaid(drawn, directory, true);
  if (allLeft !== '') {
    return `${waited} When it first waited, ${allLeft}`;
  }
  const using = inUseOf(drawn, count);
  const slots = `${slotsInUseSaid(drawn, count, directory)} ${using === 1 ? 'was' : 'were'} in use`;
  const named = holdersNamed(using, holders);
  const said =
    named.length === 0
      ? `${waited} When it first waited, ${slots}, by other programs.`
      : using === 1
        ? `${waited} When it first waited, ${slots}, by ${named.join(', ')}.`
        : `${waited} When it first waited, ${slots}: ${listed(named)}.`;
  return `${said}${leftSaid(drawn, true)}`;
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
 * [param game] is a take for a game editor_run starts, which counts that tool's peak. [param project]
 * is the project the take is for. [param tool] names the engine's tool, whose kept peak
 * for the project is the memory its lock counts: a game's is `editor_run`, any other engine's
 * `headless`.
 */
export async function slotForCall(game = false, project?: string, tool?: PeakTool): Promise<CallSlot> {
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
    game,
    project,
    tool,
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
    handTo: async (holder) => await slots.hand(lock, holder),
    leave: () => {
      slots.forget(lock);
    },
  };
}

/**
 * Hands [param slot] to the played game [param pid], so its lock is freed by the game ending. The
 * slot is given back when the game's start cannot be read or the lock is no longer this server's
 * to hand.
 */
async function handSlotToGame(
  slot: Pick<CallSlot, 'handTo' | 'release'>,
  pid: number,
  projectPath: string | null,
): Promise<void> {
  await handedOrReleased(
    slot,
    pid,
    `a game${projectPath === null ? '' : ` of ${projectPath}`} the editor played for editor_run`,
  );
}

async function handedOrReleased(
  slot: Pick<CallSlot, 'handTo' | 'release'>,
  pid: number | undefined,
  by: string,
): Promise<void> {
  const started = pid === undefined ? undefined : (await startTimesOf([pid])).get(pid);
  if (pid === undefined || started === undefined || !(await slot.handTo({ pid, started, by }))) {
    slot.release();
  }
}

/**
 * Hands the slot of the run the editor plays to the game [param pid] that announced, and keeps the
 * hand on the run for {@link settledRunSlot} to wait for.
 */
export function handedRunSlot(
  run: { slot?: CallSlot; slotHanded?: Promise<void>; readonly projectPath: string | null },
  pid: number,
): void {
  const slot = run.slot;
  if (slot !== undefined) {
    delete run.slot;
    run.slotHanded = handSlotToGame(slot, pid, run.projectPath);
  }
}

/**
 * Ends what a start did with the slot of the run it played: a game that did not announce inside
 * the wait is tied later or never, and nothing ends a lock naming this server until it goes, so the
 * slot is given back rather than held for a run it cannot see end. A hand to the game that did
 * announce is waited for, until [param signal] aborts, so that a command that will not take it says
 * so in the answer of the call that started the run.
 */
export async function settledRunSlot(
  run: { slot?: CallSlot; slotHanded?: Promise<void> },
  signal: AbortSignal | undefined,
): Promise<void> {
  if (run.slot !== undefined) {
    run.slot.release();
    delete run.slot;
  }
  if (run.slotHanded !== undefined) {
    await waitedUnlessAborted(run.slotHanded, signal);
  }
}

/** A slot taken for a call: see {@link slotForCall}. */
export interface CallSlot {
  readonly lock: string;
  /** The pid the lock names until it is handed on. */
  readonly from: number;
  readonly release: () => void;
  /** Hands the slot to [param holder], which keeps it until it has gone, and answers whether it did. */
  readonly handTo: (holder: SlotHolder) => Promise<boolean>;
  /** Leaves the lock for another process to take over. It names this one until it does. */
  readonly leave: () => void;
}

/** Set inside {@link withoutASlot}, whose engines take no slot. */
const withoutSlots = new AsyncLocalStorage<true>();
const keptForSteps = new AsyncLocalStorage<{ held: Promise<CallSlot> | null; project?: string }>();

/**
 * The folder under the machine's slots with one lock for each project an engine runs for without a
 * slot. Those engines of one project run one at a time across the machine, since each writes the
 * project's .godot, so the count running at once is bounded by the projects in use. A lock is taken
 * and judged as a slot's is, so a dead holder's is taken over.
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

/** Who holds the lock at [param lock], or null where it cannot be read or names nobody. */
function projectHolderOf(lock: string): SlotHolder | null {
  try {
    return holderOf(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What waiting [param waitedMs] for [param project]'s lock, held by [param holder], says to the
 * client of the call that waits.
 */
function projectWaitSaid(waitedMs: number, project: string | undefined, holder: SlotHolder | null): string {
  const so = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine`;
  return `${so}: another engine of ${projectNamed(project)} is running${heldBySaid(holder)}, and this one starts when it ends.`;
}

/** What a call's answer says of its wait for [param project]'s lock, [param waitedMs] in all. */
function projectWaitedSaid(waitedMs: number, project: string | undefined, holder: SlotHolder | null): string {
  return `This call waited ${String(Math.round(waitedMs / 1000))} s for another engine of ${projectNamed(project)} in all. When it first waited, that engine was run${holder === null ? ' by another call' : heldBySaid(holder)}.`;
}

function projectNamed(project: string | undefined): string {
  return project === undefined ? 'no project' : `the project ${project}`;
}

function heldBySaid(holder: SlotHolder | null): string {
  return holder === null ? '' : ` by ${holdersNamed(1, [holder]).join('')}`;
}

/**
 * Runs [param body] holding [param project]'s lock, waiting while another engine of it holds it. A
 * call that waits is told so as a slot wait is, and its answer's engine_slot_wait counts the wait.
 * A command with no call to report to says it on its own output ({@link sayWaitsTo}).
 */
async function inTheProjectsTurn<T>(body: () => Promise<T>, project: string | undefined): Promise<T> {
  const lock = projectLockOf(project);
  mkdirSync(dirname(lock), { recursive: true });
  const slots = await processSlots();
  const signal = callSignal();
  const progress = callProgress();
  const waits = callSlotWaits();
  const began = Date.now();
  let blockedBy: SlotHolder | null | undefined;
  let said = Number.NEGATIVE_INFINITY;
  while (!(await slots.takeFile(lock))) {
    signal?.throwIfAborted();
    blockedBy ??= projectHolderOf(lock);
    const now = Date.now();
    if (progress !== undefined && now - said >= WAIT_SAID_MS) {
      said = now;
      progress((now - began) / 1000, projectWaitSaid(now - began, project, projectHolderOf(lock)));
    } else if (
      progress === undefined &&
      saidTo !== undefined &&
      now - began >= COMMAND_WAIT_SAID_MS &&
      now - said >= WAIT_SAID_MS
    ) {
      said = now;
      saidTo(projectWaitSaid(now - began, project, projectHolderOf(lock)));
    }
    await delay(PROJECT_LOOK_MS);
  }
  if (waits !== undefined && blockedBy !== undefined) {
    waits.ms += Date.now() - began;
    const heldBy = blockedBy;
    waits.said ??= (waitedMs) => projectWaitedSaid(waitedMs, project, heldBy);
  }
  try {
    return await body();
  } finally {
    await giveBackSlotAsync(lock, slots.holder.pid);
  }
}

/**
 * Runs [param body] holding one of the machine's slots for the call, handing it the slot's lock,
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
    kept.held ??= slotForCall(false, project ?? kept.project);
    return await body((await kept.held).lock);
  }
  const held = await slotForCall(false, project);
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
  const kept: { held: Promise<CallSlot> | null; project?: string } = { held: null };
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
