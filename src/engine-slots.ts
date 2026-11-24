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
 * holding it. A lock numbered at or past the count, which only a taker given more slots makes, is
 * removed the same way by every take once its holder has gone.
 *
 * An engine started on a slot has the slot's lock in {@link HELD_VARIABLE}, so the programs it
 * starts run on its slot.
 *
 * Gates come first. A gate in the machine's queue keeps a mark, `<directory>/queued/<ticket>.json`
 * holding what a lock does, and while one is live an engine outside a gate takes at most the last
 * {@link KEPT_SLOTS} slots. A gate's engines take only the others ({@link slotsDrawnOn}).
 *
 * A taker that finds every slot held keeps a mark, `<directory>/waiting/<pid>-<n>.json` holding
 * what its lock will, its kind (`taker`) and when it began to wait (`since`), until its take ends, so
 * that a gate counting its own time can tell a wait for slots others hold from its own work, and
 * each take leaves a free slot to the takers waiting longer that may take it ({@link SlotLine}). A
 * mark whose holder has gone is free by the same rule as a lock.
 *
 * One directory and one count serve the whole machine, whichever project an engine is for: every
 * game's gate, bench and tool, and this server's own engines, draw on the same budget. The directory
 * is `$XDG_CACHE_HOME/gdharness/slots` where that variable is set, else
 * `%LOCALAPPDATA%\gdharness\slots` on Windows, else `~/.cache/gdharness/slots`. The count is half
 * the processors, but no more than the physical memory above 16 GiB holds at 1.5 GiB an engine, and
 * at least one. `GODOT_ENGINE_SLOTS` and `GODOT_ENGINE_SLOT_COUNT`
 * replace either, and a command's `--slots` and `--slot-count` replace those ({@link machineSlots}).
 *
 * Where `GODOT_ENGINE_SLOT_COMMAND` names a command, none of this scheme runs for a take: the
 * command grants the slot and holds it until its input ends ({@link askForSlot}).
 *
 * The games' own tools take slots in this directory the same way, which is the point of it: the
 * scheme is written out in docs/test-runs.md for them, and a change here is a change there.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
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
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { callNotes, callProgress, callSignal, callSlotWaits, waitedUnlessAborted } from './call-signal.js';
import { helperPid } from './desktop.js';
import { memoryAvailable } from './engine-launch.js';
import { ceilingFor, engineNeed, gigabytes, MEMORY_PER_ENGINE } from './engine-memory.js';
import { wholeFlag } from './launch.js';
import {
  ancestorsIn,
  type ProcessTree,
  processTree,
  readCommandLine,
  startTimesOf,
} from './process-children.js';
import { isRecord } from './records.js';
import { repositoryNameOf } from './repository.js';
import { type PeakTool, readEnginePeaks } from './run-record.js';
import {
  askForSlot,
  delegateWaitedSaid,
  delegateWaitSaid,
  type SlotGrant,
  type SlotKind,
  slotCommandOf,
} from './slot-delegate.js';
import { Turns } from './turns.js';
import {
  changeWholeAsync,
  madeInPlace,
  makeWhole,
  readWhole,
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
 * one slot to five left the machine about half idle while gates waited in line for engines.
 */
const PROCESSORS_A_SLOT = 2;
/** The memory one slot stands for, as the machine's queue counts it. */
const ENGINE_MEMORY_BYTES = MEMORY_PER_ENGINE;
/** The physical memory no slot stands for: editors, language servers and sessions. */
const OUTSIDE_MEMORY_BYTES = 16 * 1024 ** 3;

/**
 * What the engines of a machine with [param memory] bytes of physical memory may hold together: the
 * memory above {@link OUTSIDE_MEMORY_BYTES}. The slot count and the memory a take counts both come
 * from it.
 */
function engineMemoryBudget(memory: number): number {
  return Math.max(0, memory - OUTSIDE_MEMORY_BYTES);
}

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
  /** The physical memory in bytes. */
  readonly memory: number;
  readonly home: string;
  readonly cwd: string;
}

function thisMachine(): SlotsMachine {
  return {
    env: process.env,
    platform: process.platform,
    processors: availableParallelism(),
    memory: totalmem(),
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
 * so it is one budget whoever starts the engine.
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
  const byProcessors = Math.max(1, Math.floor(machine.processors / PROCESSORS_A_SLOT));
  const byMemory = Math.floor(engineMemoryBudget(machine.memory) / ENGINE_MEMORY_BYTES);
  return { directory, count: count ?? Math.max(1, Math.min(byProcessors, byMemory)) };
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
 * The folder, inside the slots', of the marks the gates in the machine's queue keep, one a gate's
 * ticket from its arrival to its release. A mark holds what a lock does.
 */
export const QUEUED_FOLDER = 'queued';
/**
 * The variables naming the pool of the gate a process runs in, its folder and its number of lock
 * numbers, which is never the share. Both set says the engine is a gate's.
 */
export const SHARE_VARIABLE = 'GODOT_ENGINE_SHARE';
export const SHARE_COUNT_VARIABLE = 'GODOT_ENGINE_SHARE_COUNT';
/** The variable naming the lanes file a gate's paced portion writes in the pool, which a run follows. */
export const LANES_VARIABLE = 'GODOT_ENGINE_LANES';
/** What follows a lanes file's name in the mark a run holds while it follows the file. */
export const FOLLOWS_SUFFIX = '.follows';

/**
 * The pool's number of lock numbers as [param env] gives it, null where it is unset or empty. A
 * following run needs it as a number, for its ceiling.
 */
export function poolCount(env: NodeJS.ProcessEnv = process.env): number | null {
  return wholeFlag(nonEmpty(env[SHARE_COUNT_VARIABLE]), SHARE_COUNT_VARIABLE);
}
/**
 * How many slots of [param count] are kept for engines outside a gate while a gate is queued, the
 * last ones: a quarter, at least two. The gates draw on the rest alone, and an engine outside a gate
 * takes one of those only while no gate is queued, so work started beside the gates never leaves
 * them waiting: one morning engines outside the queue held 12 of 16 slots while gates stood in line
 * for hours. Two of sixteen were too few the other way: a game one session had started held the one
 * left to every other session, and a probe's headless scene edit waited an hour behind it.
 */
export function keptSlotsOf(count: number): number {
  return Math.max(2, Math.floor(count / 4));
}

/**
 * How long a one-off take, a game's included, waits before it stands with gate work in the line
 * ({@link SlotLine}). A high-priority one counts from it always, any other only while no
 * high-priority taker waits. Its wait changes its place there, never which slots it may take.
 */
const ONE_OFF_AGED_MS = 120_000;

/**
 * How long high-priority side work may hold an ordinary one-off back: while a high-priority taker
 * waits, a one-off of another repository goes after every high-priority one until it has waited this long,
 * then stands as one past {@link ONE_OFF_AGED_MS} does. The other side of the scheme names it
 * `ONE_OFF_HELD`.
 */
const ONE_OFF_HELD_MS = 600_000;

/**
 * How long a take leaves a free slot to a taker waiting longer that may take it, past which it takes
 * the slot itself. One waiting ahead takes a slot within a moment of its coming free, woken as the
 * lock goes, so one left that long is one it cannot take after all, a mark misread or a taker the
 * queue has paused, and a slot never stands idle longer while someone waits who may take it. A taker
 * that has looked since, which it says by touching the note beside its mark, is still taking, so the
 * time counts from its last look.
 */
export const SLOT_YIELD_MS = 5000;

/**
 * The file in the slot folder that lists the repositories whose side work has high priority:
 * `{"high": ["<repository>", ...]}`. A repository is the name of a project's git top-level folder.
 */
const PRIORITY_FILE = 'priority.json';

/** The repositories no list names, for a look that has read none. */
const NO_HIGH_PRIORITY: ReadonlySet<string> = new Set();

/** What {@link PRIORITY_FILE} in a folder names, and why it was not read where it is malformed. */
interface PriorityRead {
  readonly high: ReadonlySet<string>;
  /** Why the file was not read, null where it is missing, empty or read. */
  readonly malformed: string | null;
}

/**
 * The high-priority repositories [param directory] names. The file is read only, and its writer
 * replaces it whole, so a read meets the old list or the new. A missing, empty or unreadable file, or
 * one whose `high` is not an array of strings, names none.
 */
function readPriority(directory: string): PriorityRead {
  let text: string;
  try {
    text = readFileSync(join(directory, PRIORITY_FILE), 'utf8');
  } catch {
    return { high: NO_HIGH_PRIORITY, malformed: null };
  }
  if (text.trim() === '') {
    return { high: NO_HIGH_PRIORITY, malformed: null };
  }
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    return { high: NO_HIGH_PRIORITY, malformed: `${PRIORITY_FILE} is not JSON` };
  }
  const high = isRecord(said) ? said['high'] : undefined;
  if (!Array.isArray(high) || !high.every((one): one is string => typeof one === 'string')) {
    return { high: NO_HIGH_PRIORITY, malformed: `${PRIORITY_FILE} has no "high" array of strings` };
  }
  return { high: new Set(high), malformed: null };
}

/** The malformed priority files this process has said so of, each by its path and text. */
const priorityFilesSaid = new Set<string>();

/**
 * The high-priority repositories of [param directory], as {@link readPriority} reads them. A
 * malformed file is said once per process, through [param say], and never stops a look.
 */
function highPriorityOf(directory: string, say?: (line: string) => void): ReadonlySet<string> {
  const read = readPriority(directory);
  if (read.malformed !== null && say !== undefined) {
    const key = `${join(directory, PRIORITY_FILE)}\n${read.malformed}`;
    if (!priorityFilesSaid.has(key)) {
      priorityFilesSaid.add(key);
      say(`${read.malformed} in ${directory}, so no repository has high priority.`);
    }
  }
  return read.high;
}

/** The kind a waiting mark names for a wait for memory, which takes no slot. */
const MEMORY_TAKER = 'memory';

/** A taker waiting for one of the machine's slots, as its mark names it. */
interface SlotWaiter {
  readonly mark: string;
  readonly taker: SlotTaker;
  /** When it began to wait, in milliseconds since the epoch. */
  readonly since: number;
  /** When it began to wait in seconds, as its mark gives it, which the line's order compares. */
  readonly sinceSeconds: number;
  readonly game: boolean;
  /** The repository its mark names, where it names one. */
  readonly repository?: string;
  /** Whether it is a one-off of a high-priority repository, as the list read with its mark has it. */
  readonly high: boolean;
  /** How many slots it waits for at once: above 1 only for a job needing several, else 1. */
  readonly wants: number;
  /** When it last looked, in milliseconds, or when its mark was made where it never says. */
  readonly seen: number;
  /** The bytes its engine will hold, where it waits for memory in line, else 0. */
  readonly memory?: number;
  /**
   * The bytes of memory its mark says a wait for several slots needs, else 0. A taker of several
   * that memory refuses a start on fewer than it wants is passed, at the look that finds it so.
   */
  readonly need?: number;
}

/**
 * How long a taker waiting for several slots at once has the slots freed meanwhile left to it, past
 * which takers behind it take them and it starts on what is free. Written as the machine's queue
 * writes it.
 */
const SLOTS_DRAIN_MS = 300_000;

/**
 * Each live taker waiting for a slot in [param directory], as its mark names it. A mark's `taker` of
 * another kind is a one-off's, and one naming no `since` (seconds since the epoch, as the games'
 * tools write it) waits since its file was made, which nobody writes again while it waits.
 */
export function slotWaiters(
  directory: string,
  high: ReadonlySet<string> = highPriorityOf(directory),
): SlotWaiter[] {
  const marks = join(directory, WAITING_FOLDER);
  const found: SlotWaiter[] = [];
  for (const mark of markNames(marks)) {
    let content: string | null;
    try {
      content = readWhole(join(marks, mark));
    } catch {
      continue;
    }
    const waiter = waiterOfMark(marks, mark, content, high);
    if (waiter !== null) {
      found.push(waiter);
    }
  }
  return found;
}

/** {@link slotWaiters} for a take on the event loop, whose waits for a held mark are timers. */
async function slotWaitersAsync(directory: string, high: ReadonlySet<string>): Promise<SlotWaiter[]> {
  const marks = join(directory, WAITING_FOLDER);
  const found: SlotWaiter[] = [];
  for (const mark of markNames(marks)) {
    let content: string | null;
    try {
      content = await readWholeAsync(join(marks, mark));
    } catch {
      continue;
    }
    const waiter = waiterOfMark(marks, mark, content, high);
    if (waiter !== null) {
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
 * When the file of [param stats] was last written, in whole milliseconds rounded down. It is read
 * from the nanoseconds, since `mtimeMs` is a double that rounds a time ending in .9999 ms up to the
 * next millisecond.
 */
export function fileTimeMs(stats: { readonly mtimeNs: bigint }): number {
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
 * The live waiter the mark file [param mark] in [param marks] names, which read as [param content],
 * or null when it names none. Its repository is judged against [param highList] as the mark is read.
 */
function waiterOfMark(
  marks: string,
  mark: string,
  content: string | null,
  highList: ReadonlySet<string>,
): SlotWaiter | null {
  const madeAt = fileTimeOr(join(marks, mark), Number.NaN);
  const holder = content === null ? null : holderOf(content);
  if (Number.isNaN(madeAt) || content === null || holder === null || !alive(holder.pid)) {
    return null;
  }
  const { parsed, whole } = parsedWithWholes(content);
  const {
    taker: marked,
    since,
    wants,
    repository,
    kind: waiting,
    memory,
  }: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  // A memory mark that names no time is a run's own wait for the memory of an engine it holds a slot
  // for, which takes no place in line. One that names it is a take waiting for memory in line.
  const begun = typeof since === 'number' && Number.isFinite(since) ? since : undefined;
  if (marked === MEMORY_TAKER && begun === undefined) {
    return null;
  }
  const taker = marked === MEMORY_TAKER ? waiting : marked;
  return {
    wants: Number.isInteger(wants) && positiveOr0(wants) > 1 ? Number(wants) : 1,
    // In whole milliseconds, as a take's own clock reads: a file's time has a fraction, so a waiter
    // let a slot stand its whole yield still read as inside it, and kept the slot standing.
    // No look written: the wait has only its mark's time to show it is alive.
    seen: Math.floor(fileTimeOr(join(marks, seenNoteOf(mark)), madeAt)),
    mark,
    taker: takerNamed(taker),
    // In whole milliseconds, as a take's own clock reads: a file's time has a fraction, so a mark
    // made in the millisecond a take began read as made after it, and the take went first.
    since: Math.floor(begun === undefined ? madeAt : begun * 1000),
    // Exact where the mark says it, since the other side of the scheme compares exact seconds and
    // two sides rounding differently each rank the other ahead for a mark begun in one millisecond.
    sinceSeconds: begun ?? Math.floor(madeAt) / 1000,
    game: holder.game === true,
    ...repositoryOfMark(repository, takerNamed(taker), highList),
    memory: marked === MEMORY_TAKER ? positiveOr0(memory) : 0,
    need: marked === MEMORY_TAKER ? 0 : positiveOr0(whole.get(NEED_KEY)),
  };
}

/** Where a mark of several names the bytes of memory its start needs, and a lock the bytes its start was short. */
const NEED_KEY = 'need';
const SHORT_KEY = 'short';

/** What a JSON reviver is given third where the runtime gives it: the text a number was read from. */
interface ReadFrom {
  readonly source?: string;
}

/**
 * [param content] read as JSON, with each of its top-level keys whose number is written as a whole
 * number. A figure written with a point or an exponent, such as 6.0, is not one, as the other takers
 * of the line read it, though JSON.parse makes the same number of both.
 */
function parsedWithWholes(content: string): { parsed: unknown; whole: ReadonlyMap<string, number> } {
  const wholes = new Map<unknown, Map<string, number>>();
  const parsed: unknown = JSON.parse(
    content,
    function noteWhole(this: unknown, key: string, value: unknown, context?: ReadFrom): unknown {
      if (typeof value === 'number' && /^-?\d+$/u.test(context?.source ?? '')) {
        const keys = wholes.get(this) ?? new Map<string, number>();
        keys.set(key, value);
        wholes.set(this, keys);
      }
      return value;
    },
  );
  return { parsed, whole: wholes.get(parsed) ?? new Map() };
}

/**
 * The bytes the start a lock's [param content] records was short of memory, by the job it names, or
 * undefined where it records none: what that job has yet to take of the memory free now.
 */
function shortStartOf(content: string): { job: string; short: number } | undefined {
  let read: ReturnType<typeof parsedWithWholes>;
  try {
    read = parsedWithWholes(content);
  } catch {
    return undefined;
  }
  const short = read.whole.get(SHORT_KEY);
  const job = isRecord(read.parsed) ? read.parsed['job'] : undefined;
  return short === undefined || typeof job !== 'string' ? undefined : { job, short };
}

/**
 * The repository a mark names ([param value], where it is a non-empty string) and whether it makes
 * the mark high priority: a one-off of [param taker] whose repository [param highList] names.
 */
function repositoryOfMark(
  value: unknown,
  taker: SlotTaker,
  highList: ReadonlySet<string>,
): { readonly repository?: string; readonly high: boolean } {
  if (typeof value !== 'string' || value === '') {
    return { high: false };
  }
  return { repository: value, high: taker === 'other' && highList.has(value) };
}

/** The kind of taker a mark names, with any other name read as a one-off. */
function takerNamed(name: unknown): SlotTaker {
  return name === 'gate' || name === 'timing' || name === 'tier' ? name : 'other';
}

/** [param value] where it is a number above 0, otherwise 0. */
function positiveOr0(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : 0;
}

/**
 * The slots of [param open] the takers ahead take, in their order, given the slots each may take,
 * each with the place in [param ahead] of the one taking it: each takes the first open one of its
 * own not taken by one before it, and one finding none takes none.
 */
export function slotsClaimed(
  ahead: readonly (readonly number[])[],
  open: readonly number[],
): Map<number, number> {
  const left = new Set(open);
  const taken = new Map<number, number>();
  for (const [at, numbers] of ahead.entries()) {
    const first = numbers.find((slot) => left.has(slot));
    if (first !== undefined) {
      left.delete(first);
      taken.set(first, at);
    }
  }
  return taken;
}

/**
 * A take's place among those waiting for the machine's slots: it leaves each free slot to the takers
 * waiting longer that may take it, in the order they began to wait, so a one-off waiting its hour is
 * never overtaken by the next taker to look, whichever wakes first as a lock goes. A gate's engine
 * is no exception, since a one-off past {@link ONE_OFF_AGED_MS} can stand with gate work. A timing,
 * whose turn the queue already gave it, leaves nothing. Agent runs of one game waited 38 to 80
 * minutes for one slot while runs of seconds took turns on it with no order among them.
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

  readonly taker: SlotTaker;
  readonly game: boolean;
  /** The repository of the project the take is for, where it is in a git work tree. */
  readonly repository: string | undefined;
  /** Whether it is a one-off of a high-priority repository, as of the last {@link judge}. */
  high: boolean;
  private readonly clock: () => number;

  constructor(
    taker: SlotTaker,
    game = false,
    clock: () => number = Date.now,
    high = false,
    repository?: string,
  ) {
    this.taker = taker;
    this.game = game;
    this.repository = repository;
    this.high = taker === 'other' && high;
    this.clock = clock;
    this.since = clock();
  }

  /** Judges its repository against [param list], read at the look, as it judges the marks of others. */
  judge(list: ReadonlySet<string>): void {
    this.high = this.taker === 'other' && this.repository !== undefined && list.has(this.repository);
  }

  /**
   * The bytes its engine will hold, and whether its wait began for want of memory rather than a
   * slot. Set by the take before its mark is made.
   */
  need = 0;
  memoryWait = false;

  /**
   * What its waiting mark holds beside [param holder]: its kind and when it began, in seconds. A wait
   * for memory names `memory` as its kind, with its own kind under `kind` and the bytes it needs.
   */
  marked(holder: SlotHolder): object {
    return {
      ...holder,
      ...(this.game ? { game: true } : {}),
      ...(this.repository === undefined ? {} : { repository: this.repository }),
      taker: this.memoryWait ? MEMORY_TAKER : this.taker,
      ...(this.memoryWait ? { kind: this.taker, memory: this.need } : {}),
      since: this.since / 1000,
    };
  }

  /**
   * The takers of [param waiters] ahead of this one, the first first, in three groups. The first
   * holds every taker that is no one-off and the high-priority one-offs that have waited
   * {@link ONE_OFF_AGED_MS}. The second holds the other high-priority one-offs. The
   * third holds every other one-off younger than {@link ONE_OFF_HELD_MS} while a high-priority taker
   * waits, since the work of a repository named in the priority list goes before other side work, and
   * younger than {@link ONE_OFF_AGED_MS} while none waits. Past that, an ordinary one-off stands with
   * gate work, so neither gates nor high-priority work arriving all day keep it waiting for good. A
   * game editor_run
   * started is placed as any other one-off is: it holds its slot for as long as it plays, and what
   * limits that is how many of the kept slots games may hold ({@link gamesKeptOf}), not its place
   * here. Each group goes in the order it began to wait. The class moves a place in line only,
   * never what a taker may take.
   */
  ahead(waiters: readonly SlotWaiter[]): SlotWaiter[] {
    const now = this.clock();
    // A high-priority waiter holds others back only while it looks, which every looker reads alike
    // from its mark. A taker held back stops looking, and so stops holding the takers behind it.
    const highWaits = this.high || waiters.some((one) => one.high && now - one.seen < SLOT_YIELD_MS);
    // The age is read from the exact seconds the order compares, as the other side of the scheme reads it.
    const waited = (since: number, ms: number): boolean => now / 1000 - since >= ms / 1000;
    const groupOf = (taker: SlotTaker, high: boolean, since: number): number => {
      if (taker !== 'other') {
        return 0;
      }
      if (high) {
        return waited(since, ONE_OFF_AGED_MS) ? 0 : 1;
      }
      return waited(since, highWaits ? ONE_OFF_HELD_MS : ONE_OFF_AGED_MS) ? 0 : 2;
    };
    // Before it has a mark of its own, a mark begun in the same millisecond was there at its look.
    const own = {
      group: groupOf(this.taker, this.high, this.since / 1000),
      since: this.since / 1000,
      mark: this.mark ?? '￿',
    };
    const placeOf = (one: SlotWaiter): typeof own => ({
      group: groupOf(one.taker, one.high, one.sinceSeconds),
      since: one.sinceSeconds,
      mark: one.mark,
    });
    const before = (a: typeof own, b: typeof own): number =>
      a.group - b.group || a.since - b.since || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0);
    return waiters
      .filter((one) => one.mark !== this.mark && before(placeOf(one), own) < 0)
      .toSorted((a, b) => before(placeOf(a), placeOf(b)));
  }

  /**
   * Those of [param numbers] it may take now, the order kept: it leaves out each of [param theirs],
   * the free slots those ahead take first. How long they are left is counted per slot
   * ({@link SlotLine.stoodFree}), and a wait for several slots keeps all of them for its drain.
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

/**
 * How many kept slots of [param kept] the games editor_run started may hold between them while a
 * gate is queued: every one but the last, which stays for a short headless call.
 */
export function gamesKeptOf(kept: number): number {
  return Math.max(0, kept - 1);
}

/** How many slots of a machine of [param count] the games editor_run started may hold while a gate is queued. */
function gamesMayHold(count: number): number {
  return gamesKeptOf(count - Math.max(1, count - keptSlotsOf(count)));
}

/** The variable a timing sets in what it runs, with the slot it holds. A timing takes any slot. */
const TIMED_VARIABLE = 'GODOT_ENGINE_TIMED';
/**
 * The variable a gate sets, `fast` or `full`, in each of its own steps, which run outside its seat
 * and take the kept slots while a gate is queued.
 */
const TIER_VARIABLE = 'GODOT_ENGINE_TIER';
/** The file beside a gate's mark in the queue once the gate has its seat. */
const SEATED_SUFFIX = '.seated';
/**
 * Which of a machine's slots a take is held to, when it is held to some: `gate` the gates' own,
 * `kept` the kept ones, and `games` none, for a game while games hold as many kept slots as they may,
 * its numbers then those the games hold.
 */
type SlotLimit = 'gate' | 'kept' | 'games' | 'starved';

/** Why a take with a free slot waits: the machine's engines hold what its engine would not fit beside. */
interface MemoryShort {
  /** What the machine's engines may hold together, in bytes. */
  readonly budget: number;
  /** What the live locks hold. */
  readonly held: number;
  /** What takers waiting for memory ahead of this one need, which they are left. */
  readonly ahead: number;
  /** What this take's engine needs. */
  readonly need: number;
}

/** The slot numbers a take may try, in order, and what holds it to them when something does. */
type SlotsDrawn =
  | {
      readonly numbers: readonly number[];
      readonly limit?: Exclude<SlotLimit, 'starved'>;
      /** Free ones of them the take leaves to takers waiting longer: see {@link SlotLine}. */
      readonly left?: readonly number[];
      /** Set where a free slot is held back by the memory budget. */
      readonly short?: MemoryShort;
      /** The last kept slot, which a game's draw leaves out for a short headless call. */
      readonly forACall?: number;
      readonly heldFor?: undefined;
    }
  | {
      readonly numbers: readonly number[];
      readonly limit: 'starved';
      readonly left?: readonly number[];
      readonly short?: MemoryShort;
      readonly forACall?: undefined;
      /** What a starved measurement's claim holds the take back for: see {@link STARVED_FILE}. */
      readonly heldFor: string;
    };

/**
 * The file in the slots folder a measurement that has waited two hours for its turn writes to claim
 * the machine, as `{"pid", "started", "what", "starved"}`, `starved` in seconds. While a live claim
 * stands, a taker outside a gate starts no engine, so the gates seated finish and the measurement
 * runs. The queue that writes it reads it the same way.
 */
export const STARVED_FILE = 'starved.json';

/** The claim a program inherits from the measurement that started it, as `pid:started`. */
const STARVING_VARIABLE = 'GODOT_ENGINE_STARVING';

/** A starved measurement's claim on the machine. */
interface StarvedClaim extends SlotEngine {
  readonly what: string;
  readonly starvedSeconds: number;
}

/** The claim [param content] holds, or null for content that names no holder. */
function starvedClaimOf(content: string): StarvedClaim | null {
  const holder = holderOf(content);
  const parsed: unknown = holder === null ? null : JSON.parse(content);
  if (holder === null || typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { what, starved } = parsed as { what?: unknown; starved?: unknown };
  return {
    pid: holder.pid,
    started: holder.started,
    what: typeof what === 'string' && what !== '' ? what : 'a measurement',
    starvedSeconds: typeof starved === 'number' && Number.isFinite(starved) ? starved : 0,
  };
}

/** Whether [param claim] is this process's, or that of the measurement that started it. */
export function claimIsOurs(
  claim: StarvedClaim,
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
): boolean {
  return (
    claim.pid === pid ||
    nonEmpty(env[STARVING_VARIABLE]) === `${String(claim.pid)}:${claim.started.toFixed(0)}`
  );
}

/** What [param claim] holds a take back for, in the words the queue uses. */
export function starvedSaid(claim: StarvedClaim): string {
  const hours = Number((claim.starvedSeconds / 3600).toPrecision(6));
  return `held for ${claim.what}, a measurement starved ${String(hours)} h`;
}

/** What takes a slot, as its environment says: see {@link slotsDrawnOn}. */
type SlotTaker = 'gate' | 'timing' | 'tier' | 'other';

/**
 * The machine's queue as a take reads it: whether a live gate is in it, and `spare` when the
 * queue says how many of the gates' free slots no queued gate can take now, which side work may take
 * between all of it ({@link SPARE_FILE}).
 */
type GateQueue = 'none' | 'queued' | number;

/**
 * One look at the machine's queue: {@link GateQueue}, the gates' free slots it was counted from, and
 * how many side work may hold in all ([param limit], unlimited where no count bounds it) with the
 * gates' slots taken since the count, oldest first ([param since]). A take names its slots from the
 * same free slots the share was counted from.
 */
interface GateLook {
  readonly queue: GateQueue;
  readonly free: readonly number[];
  readonly limit: number;
  readonly since: readonly number[];
}

/**
 * The slot numbers of [param count] a take by [param taker] may try now, in the order it tries
 * them, and what holds it to them, given [param queue]. A gate's engine takes the first count less
 * the kept ones ({@link keptSlotsOf}), at least one, and a timing takes any. Gate work outside a seat
 * (`tier`), a build or an upload among it, takes any, queued or not, the gates' from the top first,
 * so it leaves the kept ones to side work and the lowest to the gates' engines: three uploads waited
 * 50 minutes for the kept slots while gates' slots stood free. With no gate queued every other takes
 * any, the kept ones first so the gates' stay free longest, and while one is queued the kept ones,
 * then as many of the gates' free ones as are spare ([param free], the highest first, where it
 * is known), whatever the take has waited. A gate's seat counts only the gates' slots, so work in
 * the kept ones never holds a seat back. A [param game] editor_run started never draws the last kept
 * slot, queue or none, which stays for a short headless call. A machine of one slot has no kept slot
 * at all, so a game draws slot 0 there. While a gate is queued a game takes it no more than it
 * takes the kept slot of two, by the games limit its take reads.
 */
export function slotsDrawnOn(
  count: number,
  taker: SlotTaker,
  queue: GateQueue,
  free?: readonly number[],
  game = false,
): SlotsDrawn {
  const drawn = drawnOn(count, taker, queue, free);
  if (!game || taker === 'gate' || taker === 'timing') {
    return drawn;
  }
  const last = Math.max(1, count - keptSlotsOf(count));
  if (drawn.limit === 'starved' || !drawn.numbers.includes(last)) {
    return drawn;
  }
  return { ...drawn, numbers: drawn.numbers.filter((slot) => slot !== last), forACall: last };
}

function drawnOn(count: number, taker: SlotTaker, queue: GateQueue, free?: readonly number[]): SlotsDrawn {
  const gated = Math.max(1, count - keptSlotsOf(count));
  if (taker === 'gate') {
    return { numbers: Array.from({ length: gated }, (_, slot) => slot), limit: 'gate' };
  }
  const every = Array.from({ length: count }, (_, slot) => count - 1 - slot);
  const kept = every.slice(0, count - gated);
  if (taker === 'tier') {
    return { numbers: [...every.slice(count - gated), ...kept] };
  }
  if (taker === 'timing' || queue === 'none' || kept.length === 0) {
    return { numbers: every };
  }
  if (typeof queue === 'number') {
    const open = free?.filter((slot) => slot < gated).toSorted((a, b) => b - a) ?? every.slice(count - gated);
    return { numbers: [...kept, ...open.slice(0, queue)] };
  }
  return { numbers: kept, limit: 'kept' };
}

/**
 * The file in the slots folder where the gates' queue writes how many of the gates' free slots no
 * queued gate can take now, as `{"spare", "pid", "started", "written"}`. `written` is the moment the
 * count began, in milliseconds by the folder's clock, with or without a fraction.
 * The queue alone knows its seats, pool and memory, so a fresh count stands for what the seated
 * gates are owed ({@link EngineSlots.sideShare}).
 */
export const SPARE_FILE = 'spare.json';

/** The file a measurement holding the machine's quiet window writes, `{"pid", "started", "what", "until"}`. */
const WINDOW_FILE = 'window.json';

/**
 * How old a spare count may be. Its writer writes it again every five seconds while a gate waits. A
 * lanes file is held to the same age.
 */
export const SPARE_STALE_MS = 10_000;

/**
 * The whole number [param content] holds under [param key] at [param now], or 0 for none, a
 * malformed one, one below 1 or a stale one.
 */
export function countSaid(content: string | null, now: number, key: string): number {
  return countWritten(content, now, key)?.count ?? 0;
}

/**
 * The whole number [param content] holds under [param key] at [param now] and when it was written in
 * milliseconds, or null for none, a malformed one or a stale one. A count below 0 reads as 0.
 */
function countWritten(
  content: string | null,
  now: number,
  key: string,
): { count: number; written: number } | null {
  let said: unknown;
  try {
    said = JSON.parse(content ?? '');
  } catch {
    return null;
  }
  if (!isRecord(said)) {
    return null;
  }
  const { [key]: count, written } = said;
  if (typeof count !== 'number' || !Number.isInteger(count) || typeof written !== 'number') {
    return null;
  }
  return now - written > SPARE_STALE_MS ? null : { count: Math.max(0, count), written };
}

/** [param queue] as a game reads it: a game holds its slot for as long as it plays, so never a spare one. */
function forAGame(queue: GateQueue, game: boolean): GateQueue {
  return game && typeof queue === 'number' ? 'queued' : queue;
}

/** Whether [param env] says this process runs inside a gate, which names its pool in both. */
export function inAGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env[SHARE_VARIABLE]) !== undefined && nonEmpty(env[SHARE_COUNT_VARIABLE]) !== undefined;
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

/** What [param env] says takes the slot. */
export function slotTaker(env: NodeJS.ProcessEnv = process.env): SlotTaker {
  if (inAGate(env)) {
    return 'gate';
  }
  if (nonEmpty(env[TIMED_VARIABLE]) !== undefined) {
    return 'timing';
  }
  return nonEmpty(env[TIER_VARIABLE]) !== undefined ? 'tier' : 'other';
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
 * A process following the lanes file a gate's paced portion writes in the pool. It reads the number
 * as the spare count is read and holds a mark beside the file as a lock is held, so the portion
 * grows past the number it told only while a run stands behind it. It takes no lock in the pool.
 * A run that cannot rise above the lanes it began on only reads the number, for a fall, and holds no
 * mark, since the portion has nothing to gain from a run that cannot take more lanes.
 */
export class FollowedLanes {
  readonly ceiling: number;
  /** Whether it may still hold the mark: false for a run that cannot rise, and once the mark is given back. */
  private rises: boolean;
  private readonly mark: string;
  private changes: FolderChanges | null = null;
  private holding = false;
  private taking: Promise<boolean> | null = null;

  private readonly slots: Pick<EngineSlots, 'takeFile' | 'countIn' | 'holder'>;
  private readonly file: string;
  private readonly lookMs: number;

  constructor(
    slots: Pick<EngineSlots, 'takeFile' | 'countIn' | 'holder'>,
    file: string,
    ceiling: number,
    lookMs = SLOT_LOOK_MS,
    rises = true,
  ) {
    this.slots = slots;
    this.file = file;
    this.ceiling = ceiling;
    this.rises = rises;
    this.lookMs = lookMs;
    this.mark = `${file}${FOLLOWS_SUFFIX}`;
  }

  /**
   * Answers the lanes the file tells, at most the ceiling, once that passes [param above]. A number
   * at or below it adds none. At the ceiling there is nothing to add, so it waits for [param signal]
   * to abort without a mark.
   */
  async past(above: number, signal: AbortSignal): Promise<number> {
    if (above >= this.ceiling) {
      await this.untilAborted(signal);
    }
    for (;;) {
      if (signal.aborted) {
        this.end();
        throw signal.reason;
      }
      const said = await this.look();
      // Only a run holding the mark may rise, as the writer grows no further for another.
      if (said > above && (this.holding || !this.rises)) {
        if (said >= this.ceiling) {
          this.end();
          // A run at its ceiling goes on reading the number for a fall, without the mark.
          this.rises = false;
        }
        return said;
      }
      this.changes ??= new FolderChanges(dirname(this.file));
      await this.changes.next(this.lookMs, SLOT_SETTLE_MS, signal);
    }
  }

  /**
   * The lanes the file tells now, at most the ceiling, or null while it tells none: its writer has
   * gone or it holds no number. A mark held by another reader does not hide the number.
   */
  async told(): Promise<number | null> {
    const said = await this.look();
    return said > 0 ? said : null;
  }

  /**
   * Settles once the file tells a number above [param lane] or tells none, and at once when
   * [param signal] aborts. A lane at or past the number told waits here for it to grow.
   */
  async untilTold(lane: number, signal: AbortSignal): Promise<void> {
    const changes = new FolderChanges(dirname(this.file));
    try {
      while (!signal.aborted) {
        const told = await this.told();
        if (told === null || lane < told) {
          return;
        }
        await changes.next(this.lookMs, SLOT_SETTLE_MS, signal);
      }
    } finally {
      changes.close();
    }
  }

  /** Rejects once [param signal] aborts, giving the mark back first. */
  private untilAborted(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
      const stop = (): void => {
        this.end();
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      if (signal.aborted) {
        stop();
      } else {
        signal.addEventListener('abort', stop, { once: true });
      }
    });
  }

  /**
   * The lanes the file tells now, at most the ceiling, and 0 while it cannot be read. The mark is
   * tried first but the number is read without it: a mark another reader holds, or one that failed
   * to be taken, only stops the run rising, never the fall the number tells.
   */
  private async look(): Promise<number> {
    if (this.rises) {
      try {
        await this.holdMark();
      } catch {
        // Held by a reader or failed for now, which the next look tries again.
      }
    }
    try {
      return Math.min(await this.slots.countIn(this.file, 'lanes'), this.ceiling);
    } catch {
      return 0;
    }
  }

  /**
   * Takes the mark unless it is held. Looks begun together share one attempt: the lanes of a run
   * ask at once, and a failing attempt finishing after a succeeding one must not undo it.
   */
  private async holdMark(): Promise<void> {
    if (this.holding) {
      return;
    }
    this.taking ??= this.slots.takeFile(this.mark).finally(() => {
      this.taking = null;
    });
    const took = await this.taking;
    if (took && !this.rises) {
      // Ended while the mark was being taken, so it is given straight back.
      await giveBackSlotAsync(this.mark, this.slots.holder.pid);
      return;
    }
    this.holding = took;
  }

  /** Gives the mark back while it names this process, and stops watching. */
  end(): void {
    this.changes?.close();
    this.changes = null;
    this.holding = false;
    giveBackSlot(this.mark, this.slots.holder.pid);
  }
}

/**
 * Who holds a lock, as its file says. [member by] is what took it, such as a test run and its
 * project, so a wait can say who it waits behind. A lock written without it is named by its pid.
 */
export interface SlotHolder {
  readonly pid: number;
  readonly started: number;
  readonly by?: string;
  /** Set for a game editor_run started, which may hold only some of the kept slots: {@link gamesKeptOf}. */
  readonly game?: true;
  /**
   * The engine whose programs run on the slot, for a holder that is not it: a keeper holding the
   * slot for its game, which comes back under another pid when it restarts itself, or a process
   * waiting on an engine it started. Named as the holder is, and judged the same way.
   */
  readonly engine?: SlotEngine;
  /**
   * The bytes the engine on the slot may hold, which the machine's memory budget counts
   * ({@link engineMemoryBudget}). A lock without it counts {@link ENGINE_MEMORY_BYTES}.
   */
  readonly memory?: number;
  /** The slots one lock stands for, above 1, where a tool holds several in one file. */
  readonly wants?: number;
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
    const { by, game, engine, memory, wants } = parsed as {
      by?: unknown;
      game?: unknown;
      engine?: unknown;
      memory?: unknown;
      wants?: unknown;
    };
    const named = namedProcess(parsed);
    if (named === null) {
      return null;
    }
    const runs = namedProcess(engine);
    return {
      ...named,
      ...(typeof by === 'string' && by !== '' ? { by } : {}),
      ...(game === true ? { game } : {}),
      ...(runs === null ? {} : { engine: runs }),
      ...(typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? { memory } : {}),
      ...(typeof wants === 'number' && Number.isInteger(wants) && wants > 1 ? { wants } : {}),
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

/** The folder under the machine's slots where other work marks the memory it has reserved. */
export const RESERVED_FOLDER = 'reserved';

/** One reservation mark: who holds it, how much it still owes, and what the file said. */
interface ReservationMark {
  readonly holder: SlotHolder;
  readonly owed: number;
  readonly content: string;
  readonly writtenAt: number;
  readonly path: string;
}

/** The marks in [param directory]'s reserved folder that name a holder and a positive whole `owed`. */
function reservationMarks(directory: string): ReservationMark[] {
  const folder = join(directory, RESERVED_FOLDER);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const marks: ReservationMark[] = [];
  for (const name of names.filter((one) => one.endsWith('.json'))) {
    try {
      const content = readFileSync(join(folder, name), 'utf8');
      const holder = holderOf(content);
      const parsed: unknown = JSON.parse(content);
      const owed = isRecord(parsed) ? parsed['owed'] : undefined;
      if (holder !== null && typeof owed === 'number' && Number.isInteger(owed) && owed > 0) {
        const path = join(folder, name);
        marks.push({ holder, owed, content, writtenAt: statSync(path).mtimeMs, path });
      }
    } catch {
      // Unreadable or not JSON: it reserves nothing.
    }
  }
  return marks;
}

/**
 * The variable a holder of a reservation sets, for everything it starts, to the path of its mark.
 * Nested holders join their paths with the platform's path-list separator. A program started inside
 * a reservation does not wait on it.
 */
export const RESERVED_VARIABLE = 'GODOT_ENGINE_RESERVED';

/** [param path] resolved, and lower-cased on Windows, which is how marks are compared. */
function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The bytes other work has reserved and still owes, summed over the live marks in
 * `<directory>/reserved`. A mark counts by the rule a lock does ({@link lockIsFree}), and one
 * [param env] names in {@link RESERVED_VARIABLE} counts nothing, since a gate that reserved its peak
 * runs this inside it. The default directory is the machine's, never a pool's.
 */
export async function reservedMemory(
  directory: string = machineSlotsDirectory(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const own = new Set(
    (nonEmpty(env[RESERVED_VARIABLE]) ?? '')
      .split(delimiter)
      .filter((path) => path !== '')
      .map(comparable),
  );
  const live = reservationMarks(directory).filter(
    (mark) => alive(mark.holder.pid) && !own.has(comparable(mark.path)),
  );
  if (live.length === 0) {
    return 0;
  }
  const starts = await startTimesOf([...new Set(live.map((mark) => mark.holder.pid))]);
  const now = Date.now();
  return live
    .filter((mark) => !lockIsFree(mark.content, mark.writtenAt, now, alive, (asked) => starts.get(asked)))
    .reduce((sum, mark) => sum + mark.owed, 0);
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
   * lets a slot left to it stand {@link SLOT_YIELD_MS} is waiting for something else, a share or
   * memory under a release whose marks named no kind, so no take of this process leaves it another:
   * one such wait kept every short call of a server waiting 5 s for a slot that stood free.
   */
  private readonly passedOver = new Map<string, number>();
  /** The slot of the engine that started this process while one of its engines runs on it. */
  private inherited: string | null = null;
  /**
   * Whether the inherited slot is one a timing or a heavy job lends, which a program inside it takes
   * no slot beside: its engines wait for the lent one, as a job started inside a job does.
   */
  private jobLent = false;
  /** The last look at the inherited slot, which the next one waits for. */
  private readonly inheriting = new Turns();
  /** The slots a delegate command granted this process and still holds, by lock: {@link slotCommandOf}. */
  private readonly delegated = new Map<string, SlotGrant>();
  /** When a wait for a grant was last said, so that asks waiting together say it once. */
  private delegateSaidAt = Number.NEGATIVE_INFINITY;
  /** The slots the last look could take, in the order it tried them, and what held it to them. */
  drawn: SlotsDrawn = { numbers: [] };
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  readonly count: number;
  readonly holder: SlotHolder;
  /** What this process is as a taker, asked at every look, since a turn ends when its ticket goes. */
  private readonly taker: () => SlotTaker;
  private readonly say: ((line: string) => void) | undefined;
  /** The Godot project this process's takes are for, which names the repository its marks carry. */
  private readonly project: string | undefined;

  /** The physical memory of the machine, which the memory budget is counted from. */
  private readonly machineMemory: number;
  /** The tool whose kept peak counts an engine this process takes a slot for, where a take names none. */
  private readonly tool: PeakTool;
  /** The memory free now, read afresh at every look that asks. */
  private readonly available: () => Promise<number>;

  constructor(
    directory: string,
    count: number,
    holder: SlotHolder,
    say?: (line: string) => void,
    taker: () => SlotTaker = () => slotTaker(),
    project?: string,
    machine: {
      readonly memory?: number;
      readonly tool?: PeakTool;
      readonly available?: () => Promise<number>;
    } = {},
  ) {
    this.directory = directory;
    this.count = count;
    this.holder = holder;
    this.say = say;
    this.taker = taker;
    this.project = project;
    this.machineMemory = machine.memory ?? totalmem();
    this.tool = machine.tool ?? 'project_test';
    this.available = machine.available ?? (async () => (await memoryAvailable()).bytes);
    this.drawn = slotsDrawnOn(count, taker(), 'none');
  }

  /**
   * What the engines of this directory may hold together: the machine's budget, and at least what
   * its slots stand for, since a count that was set stands for 1.5 GiB each whatever the machine has.
   */
  get memoryBudget(): number {
    return Math.max(engineMemoryBudget(this.machineMemory), this.count * ENGINE_MEMORY_BYTES);
  }

  /**
   * What an engine of [param tool] for [param project] may hold, which its lock counts: the flat
   * figure or the project's kept peak, at most its ceiling. A ceiling that cannot be read caps nothing
   * here, since the start that reads it refuses it in its own words.
   */
  private memoryNeeded(game: boolean, project: string | undefined, tool?: PeakTool): number {
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
   * A line for a take of [param taker], carrying the repository of its project where that is in a git
   * work tree. The repository is found once for the take, and the priority list at each look.
   */
  private lineFor(taker: SlotTaker, game: boolean, project: string | undefined = this.project): SlotLine {
    return new SlotLine(taker, game, Date.now, false, this.repositoryOf(project));
  }

  /** The repository of [param project], where it is in a git work tree, which a waiting mark carries. */
  private repositoryOf(project: string | undefined): string | undefined {
    return (project === undefined ? null : repositoryNameOf(project)) ?? undefined;
  }

  /**
   * Says [param line] in the answer of the call being answered, where there is one, else through
   * this process's own way of saying: a server's standard output is the protocol.
   */
  private noted(line: string): void {
    const notes = callNotes();
    if (notes === undefined) {
      this.say?.(line);
    } else {
      notes.slotNotes.add(line);
    }
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its lock's path. A take that finds every
   * slot held keeps a mark of its wait until it ends, however it ends, and calls [param blocked]
   * once, as it begins waiting. [param game] is a take for a game editor_run started. [param project]
   * is the Godot project the take is for, in place of the one this process's takes are for.
   */
  async take(
    signal?: AbortSignal,
    waiting?: (waitedMs: number) => void,
    blocked?: () => void,
    game = false,
    project?: string,
    queued?: () => void,
    tool?: PeakTool,
  ): Promise<string> {
    const delegate = slotCommandOf();
    return delegate === undefined
      ? await this.takenFromFolder(signal, waiting, blocked, game, project, tool)
      : await this.takenFromCommand(
          delegate,
          { signal, waiting, blocked, queued },
          game,
          project ?? this.project,
        );
  }

  private async takenFromFolder(
    signal: AbortSignal | undefined,
    waiting: ((waitedMs: number) => void) | undefined,
    blocked: (() => void) | undefined,
    game: boolean,
    project: string | undefined,
    tool: PeakTool | undefined,
  ): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    const forProject = project ?? this.project;
    const line = this.lineFor(this.taker(), game, forProject);
    line.need = this.memoryNeeded(game, forProject, tool);
    const began = line.since;
    let said = Number.NEGATIVE_INFINITY;
    let mark: string | undefined;
    let lentWaitSaid = false;
    let changes: FolderChanges | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const lock = await this.takeFree(game, line);
        if (lock !== null) {
          return lock;
        }
        if (this.waitsOnTheLentSlot()) {
          // The wait is for the slot the job lent alone, which no other program could take, so
          // nothing in the machine's waiting folder says it waits.
          if (!lentWaitSaid) {
            lentWaitSaid = true;
            blocked?.();
          }
        } else if (mark === undefined) {
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
   * The slot [param command] grants, in place of a take from the slots folder, which this touches
   * nowhere: the slot's inheritance is read as for any take, and the engine's own lock is the one
   * the command names. The take's kind is the line it draws: a gate's, side work (a timing's or a
   * tier's, which the machine's queue runs) or a one-off, and a [param game] editor_run starts is
   * one of its own. [param blocked] is called when the grant took as long as a wait is first said.
   */
  private async takenFromCommand(
    command: string,
    asked: {
      readonly signal: AbortSignal | undefined;
      readonly waiting: ((waitedMs: number) => void) | undefined;
      readonly blocked: (() => void) | undefined;
      readonly queued: (() => void) | undefined;
    },
    game: boolean,
    project: string | undefined,
  ): Promise<string> {
    const { signal, waiting, blocked, queued } = asked;
    signal?.throwIfAborted();
    const inherited = await this.inheritedByOne();
    if (inherited !== null) {
      return inherited;
    }
    const taker = this.taker();
    const kind: SlotKind = game ? 'game' : taker === 'gate' ? 'gate' : taker === 'other' ? 'one-off' : 'side';
    const began = Date.now();
    const notes = callNotes();
    const grant = await askForSlot({
      command,
      kind,
      project,
      signal,
      firstNoteMs: COMMAND_WAIT_SAID_MS,
      noteEveryMs: WAIT_SAID_MS,
      onQueued: queued,
      onLost: (said) => {
        if (notes === undefined) {
          this.say?.(said);
        } else {
          notes.slotNotes.add(said);
        }
      },
      note: (waitedMs) => {
        if (waiting !== undefined) {
          waiting(waitedMs);
        } else if (this.say !== undefined && Date.now() - this.delegateSaidAt >= WAIT_SAID_MS / 2) {
          // Every ask outstanding notes on the same schedule, and one line says it for them all.
          this.delegateSaidAt = Date.now();
          this.say(delegateWaitSaid(waitedMs, command));
        }
      },
    });
    if (this.delegated.has(grant.lock)) {
      grant.release();
      await grant.gone;
      throw new Error(
        `The engine slot command \`${command}\` granted ${grant.lock}, which this process holds.`,
      );
    }
    this.delegated.set(grant.lock, grant);
    if (Date.now() - began >= COMMAND_WAIT_SAID_MS) {
      blocked?.();
    }
    return grant.lock;
  }

  /** The grant the delegate command made for [param lock], when it did. */
  grantOf(lock: string): SlotGrant | undefined {
    return this.delegated.get(lock);
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
   * Takes a slot that is free now and answers its lock's path, or null when every slot it may take is
   * held. Which it may take is asked again at every look, since a gate arriving in the queue or the
   * last one leaving changes them. A slot already held is kept to its end whatever arrives. A take
   * for a [param game] editor_run started marks its lock as a game's, and while a gate is queued finds
   * none free once the games hold as many of the kept slots as {@link gamesKeptOf} gives them. A
   * one-off take takes the kept slots and as many of the gates' free ones as are spare, however
   * long it has waited. A take but a timing's leaves the free slots the takers ahead of
   * [param line] take first ({@link SlotLine}). One given no line came last.
   */
  async takeFree(game = false, line?: SlotLine): Promise<string | null> {
    if (slotCommandOf() !== undefined) {
      // A command has no free-now answer to give, so only the inherited slot is free.
      return await this.inheritedByOne();
    }
    mkdirSync(this.directory, { recursive: true });
    await this.sweep();
    const inherited = await this.inheritedByOne();
    if (inherited !== null) {
      return inherited;
    }
    if (this.waitsOnTheLentSlot()) {
      return null;
    }
    const taker = this.taker();
    if (await this.starvedOutFor(taker)) {
      return null;
    }
    let look: GateLook | undefined;
    const queued = async (): Promise<GateLook> => (look ??= await this.gateLook());
    this.drawn = await this.drawnFor(taker, game, queued);
    if (this.drawn.limit === 'games') {
      return null;
    }
    if (line?.mark !== undefined) {
      // A look that may take something says its taker still looks, so the slots left to a wait for
      // several last its drain. A taker held back says nothing and stops holding the takers behind it.
      lookNoted(join(this.directory, WAITING_FOLDER, line.mark));
    }
    const ahead =
      taker === 'timing'
        ? { tried: this.drawn.numbers, memory: 0 }
        : await this.leftAfterThoseAhead(line ?? this.lineFor(taker, game), queued);
    const need = line?.need ?? this.memoryNeeded(game, this.project);
    if (await this.shortOfMemory(ahead.tried, need, ahead.memory, line)) {
      return null;
    }
    const lock = await this.lockOneOf(ahead.tried, game, need);
    if (lock !== null && typeof look?.queue === 'number' && (await this.overTheShare(lock))) {
      this.release(lock);
      this.drawn = slotsDrawnOn(this.count, taker, 'queued');
      return null;
    }
    if (lock !== null && (await this.overTheBudget(lock, need, line))) {
      this.release(lock);
      return null;
    }
    return lock;
  }

  /**
   * What the held slots' locks hold, and when each was written: the slots {@link heldLocks} reads. A
   * lock without a figure of its own counts the flat figure for each slot it stands for. One that
   * names no holder yet counts nothing, as a lock past the count does, since neither takes a slot.
   */
  private async liveMemory(): Promise<{ slot: number; at: number; bytes: number }[]> {
    const live: { slot: number; at: number; bytes: number }[] = [];
    for (const { slot, lock, content } of await this.heldLocks()) {
      const holder = content === null ? null : holderOf(content);
      if (holder !== null) {
        live.push({
          slot,
          at: this.writtenAt(lock) ?? 0,
          bytes: holder.memory ?? ENGINE_MEMORY_BYTES * (holder.wants ?? 1),
        });
      }
    }
    return live;
  }

  /**
   * The memory a taker of several may start short by: the memory free now less
   * {@link OUTSIDE_MEMORY_BYTES}, never past what the slots leave of physical memory, less what each
   * job a held lock records as started short has yet to take, once a job.
   */
  private async shortRoom(): Promise<number> {
    const starts = new Map<string, number>();
    for (const { content } of await this.heldLocks()) {
      const start = content === null ? undefined : shortStartOf(content);
      if (start !== undefined) {
        starts.set(start.job, start.short);
      }
    }
    const free = Math.min(await this.available(), this.machineMemory - this.count * ENGINE_MEMORY_BYTES);
    return [...starts.values()].reduce((left, short) => left - short, free - OUTSIDE_MEMORY_BYTES);
  }

  /**
   * Whether the engine of a take may not start now for want of memory, which it then records in the
   * draw and in [param line]. It is held back only where a slot of [param tried] is free, since
   * otherwise the wait is for a slot. The live locks' memory, with the [param ahead] bytes of
   * takers waiting for memory ahead of it and its own [param need], must stay inside the budget. A
   * take that finds no other lock live starts, so the machine's first engine always does.
   */
  private async shortOfMemory(
    tried: readonly number[],
    need: number,
    ahead: number,
    line: SlotLine | undefined,
  ): Promise<boolean> {
    if (tried.length === 0) {
      return false;
    }
    const live = await this.liveMemory();
    if (!tried.some((slot) => !live.some((one) => one.slot === slot))) {
      return false;
    }
    const held = live.reduce((sum, one) => sum + one.bytes, 0);
    if (live.length === 0 || held + ahead + need <= this.memoryBudget) {
      return false;
    }
    this.drawn = { ...this.drawn, short: { budget: this.memoryBudget, held, ahead, need } };
    await this.waitsForMemory(line);
    return true;
  }

  /**
   * Makes the wait of [param line] one for memory. A take that began waiting for a slot rewrites its
   * mark as a memory mark, with the time it began, so it keeps its place in line and the takers behind
   * it count what it needs.
   */
  private async waitsForMemory(line: SlotLine | undefined): Promise<void> {
    if (line === undefined || line.memoryWait) {
      return;
    }
    line.memoryWait = true;
    if (line.mark !== undefined) {
      await writeWholeAsync(
        join(this.directory, WAITING_FOLDER, line.mark),
        JSON.stringify(line.marked(this.holder)),
      );
    }
  }

  /**
   * Whether the lock just taken at [param lock] is one too many: the folder counted again holds more
   * than the budget, with another lock live, and this one is the newest. Two takers that both counted
   * room for one engine before either took it then cannot both keep theirs, since each names the
   * same newest lock.
   */
  private async overTheBudget(lock: string, need: number, line: SlotLine | undefined): Promise<boolean> {
    const live = await this.liveMemory();
    const held = live.reduce((sum, one) => sum + one.bytes, 0);
    if (live.length < 2 || held <= this.memoryBudget) {
      return false;
    }
    const slot = Number(/(\d+)\.lock$/.exec(lock)?.[1]);
    const newest = live.toSorted((a, b) => b.at - a.at || b.slot - a.slot)[0];
    if (newest?.slot !== slot) {
      return false;
    }
    this.drawn = { ...this.drawn, short: { budget: this.memoryBudget, held: held - need, ahead: 0, need } };
    await this.waitsForMemory(line);
    return true;
  }

  /**
   * Whether the gate slot at [param lock], just taken by side work, is one too many: the folder
   * counted again holds more gate slots of side work than its share, and this one is among the
   * newest. Two takers that both counted one spare slot before either took it then cannot both keep
   * theirs. Every taker orders the locks by when they were written and names the same one.
   */
  private async overTheShare(lock: string): Promise<boolean> {
    const slot = Number(/(\d+)\.lock$/.exec(lock)?.[1]);
    const again = await this.gateLook();
    return again.since.length > again.limit && again.since.indexOf(slot) >= again.limit;
  }

  /**
   * The slots a [param taker] may take now, given the machine's queue [param queued] reads. A game
   * the games limit holds back draws none: its limit is `games` and its numbers are the slots the
   * games hold, as many as they may. On one slot and on two, games may hold none while a gate is
   * queued, so a game then draws none. A game's own take and the takers behind it both read its draw
   * here.
   */
  private async drawnFor(
    taker: SlotTaker,
    game: boolean,
    queued: () => Promise<GateLook>,
  ): Promise<SlotsDrawn> {
    const look = taker === 'other' ? await queued() : undefined;
    const queue = look === undefined ? 'none' : forAGame(look.queue, game);
    const drawn = slotsDrawnOn(
      this.count,
      taker,
      queue,
      typeof queue === 'number' ? look?.free : undefined,
      game,
    );
    if (game && queue !== 'none') {
      const held = await this.heldByGamesOfTheKept();
      const may = gamesMayHold(this.count);
      if (held.length >= may) {
        return { numbers: held.slice(0, may), limit: 'games' };
      }
    }
    return drawn;
  }

  /** The slots with no lock or a lock whose holder has gone, the lowest first. */
  private async openSlots(): Promise<number[]> {
    const held = new Set((await this.heldLocks()).map((one) => one.slot));
    return Array.from({ length: this.count }, (_, slot) => slot).filter((slot) => !held.has(slot));
  }

  /**
   * The slots of the count whose lock is there and whose holder has not gone, the lowest first, each
   * with its lock and what it read as, or null where it went before it could be read.
   */
  private async heldLocks(): Promise<{ slot: number; lock: string; content: string | null }[]> {
    const held: { slot: number; lock: string; content: string | null }[] = [];
    for (let slot = 0; slot < this.count; slot += 1) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (existsSync(lock) && !(await this.free(lock))) {
        held.push({ slot, lock, content: await readWholeAsync(lock) });
      }
    }
    return held;
  }

  /** Whether this process runs inside a job, whose lent slot it already holds and no take can add to. */
  private waitsOnTheLentSlot(): boolean {
    return this.inherited !== null && this.jobLent;
  }

  /** Locks the first of [param slots] that is made fresh or taken over, and answers its path. */
  private async lockOneOf(slots: readonly number[], game: boolean, memory: number): Promise<string | null> {
    const holder: SlotHolder = {
      ...this.holder,
      ...(game ? { game: true as const } : {}),
      memory: Math.round(memory),
    };
    for (const slot of slots) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (madeInPlace(lock, JSON.stringify(holder)) || (await this.takenOver(lock, holder, true))) {
        this.held.add(lock);
        return lock;
      }
    }
    return null;
  }

  /** Whether a taker of one-off kind is starved out, which it then records as why it drew nothing. */
  private async starvedOutFor(taker: SlotTaker): Promise<boolean> {
    const claim = taker === 'other' ? await this.starvedOut() : null;
    if (claim === null) {
      return false;
    }
    this.drawn = { numbers: [], limit: 'starved', heldFor: starvedSaid(claim) };
    return true;
  }

  /** The kept slots a live game holds. */
  private async heldByGamesOfTheKept(): Promise<number[]> {
    const kept = this.count - Math.max(1, this.count - keptSlotsOf(this.count));
    return await this.heldByGames(Array.from({ length: kept }, (_, at) => this.count - kept + at));
  }

  /**
   * The slots of the last draw that [param placed] may try, once the free ones the takers ahead of it
   * take first are left to them. It records the slots it left for them in the draw.
   */
  private async leftAfterThoseAhead(
    placed: SlotLine,
    queued: () => Promise<GateLook>,
  ): Promise<{ tried: number[]; memory: number }> {
    // The draw of this take, held across the awaits below: another take of the process may record
    // its own in the field meanwhile.
    const drawn = this.drawn;
    const drawnBefore = drawn.numbers;
    const now = Date.now();
    const high = highPriorityOf(this.directory, (line) => {
      this.noted(line);
    });
    placed.judge(high);
    const waiting = await slotWaitersAsync(this.directory, high);
    for (const mark of this.passedOver.keys()) {
      if (!waiting.some((one) => one.mark === mark)) {
        this.passedOver.delete(mark);
      }
    }
    const ahead = placed
      .ahead(waiting)
      .filter((one) => now - Math.max(this.passedOver.get(one.mark) ?? now, one.seen) < SLOT_YIELD_MS);
    const claimed = await this.claimedAhead(ahead, queued);
    const claims = await this.standFreeForTheYield(placed, ahead, claimed, queued, now);
    const tried = placed.admitted(drawnBefore, new Set(claims.keys()));
    const left = placed.leaves().filter((slot) => drawnBefore.includes(slot) && !tried.includes(slot));
    if (left.length > 0 && this.drawn === drawn) {
      this.drawn = { ...drawn, left };
    }
    return { tried, memory: ahead.reduce((sum, one) => sum + (one.memory ?? 0), 0) };
  }

  /**
   * The free slots the takers [param ahead] of [param placed] take first once the yield is counted,
   * from [param claims], those they take at the look at [param now]. Those ahead have all looked
   * within {@link SLOT_YIELD_MS}, or been left a slot for less, so takers that each place the others
   * ahead, in a ring of any size, would leave a free slot to each other for good. A slot left to
   * takers ahead at every look for {@link SLOT_YIELD_MS}, whichever of them took it at each, passes
   * each taker ahead that takes it and wants one slot, never a gate's engine while a gate is queued, until it falls to none of
   * them or to one that is waited for.
   */
  private async standFreeForTheYield(
    placed: SlotLine,
    ahead: readonly SlotWaiter[],
    claims: Map<number, string>,
    queued: () => Promise<GateLook>,
    now: number,
  ): Promise<Map<number, string>> {
    const left = new Set<number>();
    const passed = new Map<string, Set<number>>();
    let taken = claims;
    for (;;) {
      // A slot a taker ahead is given once it is passed for another is timed from this look too.
      const stood = placed.stoodFree(taken.keys(), now);
      const passing: [string, number][] = [];
      for (const [slot, mark] of taken) {
        left.add(slot);
        // A taker ahead that stops looking is dropped SLOT_YIELD_MS after it was first left a slot,
        // whichever pass gave it the slot.
        if (!this.passedOver.has(mark)) {
          this.passedOver.set(mark, now);
        }
        const one = ahead.find((waiter) => waiter.mark === mark);
        if (stood.has(slot) && one !== undefined && (await this.passable(one, queued, now))) {
          passing.push([mark, slot]);
        }
      }
      if (passing.length === 0) {
        placed.forgetAllBut(left);
        return taken;
      }
      for (const [mark, slot] of passing) {
        passed.set(mark, (passed.get(mark) ?? new Set()).add(slot));
      }
      taken = await this.claimedAhead(ahead, queued, passed);
    }
  }

  /**
   * Whether [param one], a taker ahead, may be passed for a slot that has stood free: it wants one
   * slot, and it is no gate's engine while a gate is queued. A taker wanting several keeps the slots
   * freed for it through its drain, however many are free, as the machine's queue keeps them.
   */
  private async passable(one: SlotWaiter, queued: () => Promise<GateLook>, now: number): Promise<boolean> {
    if (one.wants > 1 && now - one.since < SLOTS_DRAIN_MS) {
      return false;
    }
    return one.taker !== 'gate' || (await queued()).queue === 'none';
  }

  /**
   * The free slots the takers [param ahead] take first, in their order, each with the mark of the one
   * taking it: see {@link slotsClaimed}. A game the games limit holds back draws only slots that are
   * held, so it claims none. A taker never takes a slot [param passed] names for its mark. A taker of
   * several, whose mark names the memory it needs, claims none at a look where its draw is fewer
   * than it wants and its need, less what that draw's slots stand for, is past {@link shortRoom}, since
   * it cannot start on that draw. It claims again at the first look where the memory allows. Its
   * wants and need are read from its mark, and the memory free, at each look.
   */
  private async claimedAhead(
    ahead: readonly SlotWaiter[],
    queued: () => Promise<GateLook>,
    passed: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  ): Promise<Map<number, string>> {
    if (ahead.length === 0) {
      return new Map();
    }
    const open = await this.openSlots();
    if (open.length === 0) {
      return new Map();
    }
    const now = Date.now();
    const drawn: (readonly number[])[] = [];
    const draws = new Map<string, readonly number[]>();
    let room: number | undefined;
    const refused = async (one: SlotWaiter, draw: readonly number[]): Promise<boolean> => {
      const most = Math.min(one.wants, draw.length);
      const need = one.need ?? 0;
      if (need === 0 || most === 0 || most >= one.wants) {
        return false;
      }
      room ??= await this.shortRoom();
      return need - most * ENGINE_MEMORY_BYTES > room;
    };
    for (const one of ahead) {
      const draw = (await this.drawnFor(one.taker, one.game, queued)).numbers;
      draws.set(one.mark, (await refused(one, draw)) ? [] : draw);
    }
    // A taker waiting for several slots at once is ahead once for each, for its first drain.
    const places = ahead.flatMap((one) =>
      Array.from({ length: now - one.since < SLOTS_DRAIN_MS ? one.wants : 1 }, () => one),
    );
    for (const one of places) {
      const numbers = draws.get(one.mark) ?? [];
      drawn.push(numbers.filter((slot) => passed.get(one.mark)?.has(slot) !== true));
    }
    return new Map(
      [...slotsClaimed(drawn, open)].map(([slot, at]): [number, string] => [slot, places[at]?.mark ?? '']),
    );
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
    this.jobLent = false;
    const engines = await this.engineLock();
    if (engines !== null) {
      return engines;
    }
    const lent = nonEmpty(process.env[TIMED_VARIABLE]);
    const content = lent === undefined ? null : await readWholeAsync(lent);
    const holder = content === null ? null : holderOf(content);
    if (lent === undefined || holder === null || holder.pid === process.pid || (await this.free(lent))) {
      return null;
    }
    this.jobLent = true;
    return lent;
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
   * The starved measurement's claim that holds this process's engines back, or null where none
   * stands or the claim is ours. A claimer that has gone frees it here, as a slot's holder does.
   */
  private async starvedOut(): Promise<StarvedClaim | null> {
    const path = join(this.directory, STARVED_FILE);
    if (await this.cleared(path, false)) {
      return null;
    }
    let content: string | null;
    try {
      content = await readWholeAsync(path);
    } catch {
      return null;
    }
    const claim = content === null ? null : starvedClaimOf(content);
    return claim === null || claimIsOurs(claim) ? null : claim;
  }

  /**
   * Puts down the mark of a wait for something other than a slot, memory for one, and answers what
   * takes it up again, so a gate counting its own time reads that wait as held up by others too. It
   * names its kind as `memory`, which no take lets go first, since it takes no slot, and the
   * repository of this process's project as a take's mark does.
   */
  markWaiting(): () => void {
    if (slotCommandOf() !== undefined) {
      // The waiting folder is the built-in taker's.
      return () => undefined;
    }
    const repository = this.repositoryOf(this.project);
    const mark = this.waitMarked({
      ...this.holder,
      ...(repository === undefined ? {} : { repository }),
      taker: MEMORY_TAKER,
    });
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

  /**
   * Which of the slots [param numbers] a live game editor_run started holds. A lock that names no
   * holder yet is a taker still writing it, which may be a game's, so it counts as one.
   */
  private async heldByGames(numbers: readonly number[]): Promise<number[]> {
    const games: number[] = [];
    for (const slot of numbers) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      const content = await readWholeAsync(lock);
      const holder = content === null ? null : holderOf(content);
      if (content !== null && (holder === null || holder.game === true) && !(await this.free(lock))) {
        games.push(slot);
      }
    }
    return games;
  }

  /**
   * One look at the machine's queue, with the free slots read once for the whole look. A mark whose
   * gate has gone is removed with its `.seated` file, by the rule a lock is freed by, and one not
   * yet written names nobody and is passed over.
   */
  private async gateLook(): Promise<GateLook> {
    const marks = await this.gateMarks();
    if (marks.live === 0) {
      return { queue: 'none', free: [], limit: Number.POSITIVE_INFINITY, since: [] };
    }
    const share = await this.sideShare(marks.newestSeat);
    return { ...share.look, queue: share.side > 0 ? share.side : 'queued' };
  }

  /** The live gates' marks in the queue folder, and when the newest of them was seated. */
  private async gateMarks(): Promise<{ live: number; newestSeat: number }> {
    const folder = join(this.directory, QUEUED_FOLDER);
    let names: string[];
    try {
      names = readdirSync(folder).filter((name) => name.endsWith('.json'));
    } catch {
      return { live: 0, newestSeat: 0 };
    }
    let live = 0;
    let newestSeat = 0;
    for (const name of names) {
      const mark = join(folder, name);
      const content = await readWholeAsync(mark);
      if (content === null || holderOf(content) === null) {
        continue;
      }
      if (await this.free(mark)) {
        await removeWholeAsync(mark);
        await removeWholeAsync(`${mark}${SEATED_SUFFIX}`);
      } else {
        live += 1;
        newestSeat = Math.max(newestSeat, this.writtenAt(`${mark}${SEATED_SUFFIX}`) ?? 0);
      }
    }
    return { live, newestSeat };
  }

  /**
   * How many of the gates' free slots side work may take now, and the look it was counted from, as
   * the gates' Python queue counts it: `Shares.side` (the free gate slots less those the seated
   * gates are owed, none while a measurement holds the quiet window) and `drawn` give side work that
   * many, named from the top, all from one read of the folder.
   *
   * What a seated gate is owed rests on the queue's own tickets, its pool and the machine's memory,
   * which this process cannot read. A queue process counts it and writes the result to
   * {@link SPARE_FILE}. A live gate is in the queue, so side work takes none of the gates' slots
   * unless a fresh count says how many. A count is fresh when a live process wrote it within
   * {@link SPARE_STALE_MS} and no gate was seated at or after the moment its count began
   * (`written`), since it could not have counted that seat. A seat in the same clock tick may or may
   * not be in the count, so a tie reads as stale. The slots taken at or after that moment come off
   * it, since each is one the count could not have given to anything else. A tie there reads as taken.
   */
  private async sideShare(newestSeat: number): Promise<{ side: number; look: Omit<GateLook, 'queue'> }> {
    const gated = Math.max(1, this.count - keptSlotsOf(this.count));
    const free = (await this.openSlots()).filter((slot) => slot < gated);
    const none = { side: 0, look: { free, limit: 0, since: [] } };
    if (await this.windowHeld()) {
      return none;
    }
    const path = join(this.directory, SPARE_FILE);
    const content = await readWholeAsync(path);
    const said = countWritten(content, Date.now(), 'spare');
    // The count's text, its time and its writer's life are read once: a file made anew between
    // separate reads would be judged by one count and its writer by another.
    const writtenAt = said === null ? undefined : this.writtenAt(path);
    if (
      said === null ||
      content === null ||
      writtenAt === undefined ||
      said.written <= newestSeat ||
      (await this.freeAsRead(content, writtenAt))
    ) {
      return none;
    }
    const since = Array.from({ length: gated }, (_, slot) => slot)
      .filter((slot) => !free.includes(slot))
      .flatMap((slot) => {
        const at = this.writtenAt(join(this.directory, `${String(slot)}.lock`));
        return at !== undefined && at >= said.written ? [{ slot, at }] : [];
      })
      .toSorted((a, b) => a.at - b.at || a.slot - b.slot)
      .map((one) => one.slot);
    const side = Math.max(0, Math.min(said.count - since.length, free.length));
    return { side, look: { free, limit: said.count, since } };
  }

  /** When the file at [param path] was last written, in milliseconds, or undefined where it is not there. */
  private writtenAt(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Whether a measurement holds the machine's quiet window, which keeps side work off the gates' slots. */
  private async windowHeld(): Promise<boolean> {
    const path = join(this.directory, WINDOW_FILE);
    const content = await readWholeAsync(path);
    let said: unknown;
    try {
      said = JSON.parse(content ?? '');
    } catch {
      return false;
    }
    return (
      isRecord(said) &&
      holderOf(content ?? '') !== null &&
      typeof said['until'] === 'number' &&
      said['until'] > Date.now() / 1000 &&
      !(await this.free(path))
    );
  }

  /** The whole number under [param key] in the file at [param path], 0 once it is stale or its writer has gone. */
  async countIn(path: string, key: string): Promise<number> {
    const said = countSaid(await readWholeAsync(path), Date.now(), key);
    return said > 0 && !(await this.free(path)) ? said : 0;
  }

  /**
   * Makes [param path] as a lock is made, or takes it over under its steal file once its holder has
   * gone. Answers whether this call made it. The file counts as no slot.
   */
  async takeFile(path: string): Promise<boolean> {
    return this.made(path) || (await this.takenOver(path, this.holder));
  }

  /**
   * Who holds the slots the last look could take, in the order it tried them, leaving out a lock
   * that cannot be read. For a game held back by the cap, the games holding the kept slots.
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
    for (const grant of this.delegated.values()) {
      grant.release();
    }
    this.delegated.clear();
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
    const grant = this.delegated.get(lock);
    if (grant !== undefined) {
      this.delegated.delete(lock);
      grant.release();
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
   * Hands the slot at [param lock] to [param to], answering whether it did: see {@link handSlot}. A
   * slot a command granted is handed through the command ({@link SlotGrant.hand}), which keeps no
   * hold on it after, and a hand it will not make is told in the call's answer.
   */
  async hand(lock: string, to: SlotHolder): Promise<boolean> {
    const grant = this.delegated.get(lock);
    if (grant !== undefined) {
      const notes = callNotes();
      // The grant stays until the caller releases it, so that a failed hand ends in the command's
      // own release and a lock file the command wrote is never touched.
      const failed = await grant.hand(to.pid, to.started);
      if (failed !== null) {
        if (notes === undefined) {
          this.say?.(failed);
        } else {
          notes.slotNotes.add(failed);
        }
      }
      return failed === null;
    }
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
   * Removes the wait marks of takers that have gone. By the pid alone, which costs no query: a taker
   * killed while it waited leaves its mark, and a gate reading it counts a wait that is not happening.
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
      if (stagedWriterOf(name) !== undefined) {
        continue;
      }
      let content: string | null;
      try {
        content = await readWholeAsync(join(marks, name));
      } catch {
        // Held by a reader past the retries, which the next look tries again.
        continue;
      }
      const pid = content === null ? undefined : holderOf(content)?.pid;
      if (pid !== undefined && !alive(pid)) {
        await removeWholeAsync(join(marks, name));
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
   * the spare count judges a take by it ({@link EngineSlots.sideShare}), and a lock put in place
   * from a staged file would keep that file's older time.
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
  // A game's slot stays a game's in the hands of whatever runs it, and counts the memory it did.
  return JSON.stringify({
    ...to,
    ...(holder.game === true ? { game: true } : {}),
    ...(holder.memory === undefined || to.memory !== undefined ? {} : { memory: holder.memory }),
  });
}

/**
 * Raises the `memory` of the slot at [param lock] to [param bytes] where it counts less and this
 * process holds it, so the budget counts an engine that grew past what its take counted. A figure is
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
      const was = holder.memory ?? ENGINE_MEMORY_BYTES * (holder.wants ?? 1);
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
  if (drawn.limit === 'starved') {
    return `${so}: ${drawn.heldFor}. The engine starts once that measurement has run.`;
  }
  if (drawn.limit === 'games' && gamesMayHold(count) === 0) {
    return `${so}: no game may run on this machine (${directory}) while a gate is queued, and the engine starts once no gate is queued.`;
  }
  if (drawn.short !== undefined) {
    return `${so}: ${memoryShortSaid(drawn.short, directory, false)}, so it starts once enough memory is given back.`;
  }
  const allLeft = allLeftSaid(drawn, directory, false);
  if (allLeft !== '') {
    return `${so}: ${allLeft}`;
  }
  const taking = slotsTaking(drawn, count);
  const using = inUseOf(drawn, taking);
  const slots = `${slotsInUseSaid(drawn, count, directory, taking)} ${using === 1 ? 'is' : 'are'} in use`;
  const named = holdersNamed(using, holders);
  const waiting = `${so}: ${slots}`;
  const back = `the engine starts when ${using === 1 ? 'it' : 'one'} is given back`;
  const starts = drawn.limit === 'kept' || drawn.limit === 'games' ? `${back} or no gate is queued` : back;
  const said =
    named.length === 0
      ? `${waiting}, by a gate or another tool, and ${starts}.`
      : using === 1
        ? `${waiting}, by ${named.join(', ')}, and ${starts}.`
        : `${waiting}: ${listed(named)}. ${starts.charAt(0).toUpperCase()}${starts.slice(1)}.`;
  return `${said}${leftSaid(drawn)}`;
}

/**
 * What a take says when a slot is free and its engine does not fit the machine's memory budget: what
 * the engines may hold, what the live locks hold, what is left to takers ahead, and what it needs.
 * [param past] words it as it was when the take first waited.
 */
function memoryShortSaid(short: MemoryShort, directory: string, past: boolean): string {
  const ahead = short.ahead > 0 ? `, ${gigabytes(short.ahead)} is left to takers ahead of it in line` : '';
  return `the engines on this machine (${directory}) ${past ? 'could' : 'may'} hold ${gigabytes(short.budget)} together, those running ${past ? 'held' : 'hold'} ${gigabytes(short.held)}${ahead} and this engine ${past ? 'needed' : 'needs'} ${gigabytes(short.need)}`;
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

/** How many of the [param taking] slots of [param drawn] are in use: all, or those it does not leave free. */
function inUseOf(drawn: SlotsDrawn, taking: number): number {
  return (drawn.left?.length ?? 0) === 0 ? taking : notLeftOf(drawn).length;
}

/**
 * The slots of [param drawn] in use, of the [param taking] of [param count] a take may use: all of
 * them, or by number where it leaves some of them free.
 */
function slotsInUseSaid(drawn: SlotsDrawn, count: number, directory: string, taking: number): string {
  const all = slotsSaid(taking, count, directory, drawn);
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

/**
 * How many slots of the machine's [param count] the take that drew [param drawn] may use: those it
 * draws where something holds it to them or a game's draw leaves the last kept one out, else all.
 */
function slotsTaking(drawn: SlotsDrawn, count: number): number {
  return drawn.limit === undefined && drawn.forACall === undefined ? count : drawn.numbers.length;
}

/**
 * The slots a take may use, [param taking] of the machine's [param count] in [param directory], named
 * for what holds it to them, as [param drawn] gives it.
 */
function slotsSaid(taking: number, count: number, directory: string, drawn: SlotsDrawn): string {
  const where = `on this machine (${directory})`;
  const { limit } = drawn;
  const these = taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`;
  if (drawn.forACall !== undefined) {
    return limit === 'kept'
      ? `${these} of the ${String(count)} ${where} kept for engines outside a gate that a game editor_run started may take while a gate is queued`
      : `${these} of the ${String(count)} ${where} a game editor_run started may take, all but slot ${String(drawn.forACall)}, which stays for a short headless call,`;
  }
  if (limit === 'kept') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} kept for engines outside a gate while a gate is queued`;
  }
  if (limit === 'gate') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} a gate's engines draw on`;
  }
  if (limit === 'games') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} that games editor_run started may hold while a gate is queued, the rest kept for short calls,`;
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
  if (drawn.limit === 'starved') {
    return `${waited} When it first waited, it was ${drawn.heldFor}.`;
  }
  if (drawn.limit === 'games' && gamesMayHold(count) === 0) {
    return `${waited} When it first waited, no game could run on this machine (${directory}) while a gate was queued.`;
  }
  if (drawn.short !== undefined) {
    return `This call waited ${String(Math.round(waitedMs / 1000))} s for engine memory in all. When it first waited, ${memoryShortSaid(drawn.short, directory, true)}.`;
  }
  const allLeft = allLeftSaid(drawn, directory, true);
  if (allLeft !== '') {
    return `${waited} When it first waited, ${allLeft}`;
  }
  const taking = slotsTaking(drawn, count);
  const using = inUseOf(drawn, taking);
  const slots = `${slotsInUseSaid(drawn, count, directory, taking)} ${using === 1 ? 'was' : 'were'} in use`;
  const named = holdersNamed(using, holders);
  const said =
    named.length === 0
      ? `${waited} When it first waited, ${slots}, by a gate or another tool.`
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
 * [param game] is a take for a game editor_run starts, which games may hold only some of: see
 * {@link gamesKeptOf}. [param project] is the project the take is for, which names the
 * repository its mark carries, which gives a one-off high priority where the list names it. [param tool] names the engine's tool, whose kept peak
 * for the project is the memory its lock counts: a game's is `editor_run`, any other engine's
 * `headless`.
 */
export async function slotForCall(game = false, project?: string, tool?: PeakTool): Promise<CallSlot> {
  const slots = await processSlots();
  const progress = callProgress();
  const waits = callSlotWaits();
  const began = Date.now();
  // A command's grant leaves nothing in the slots folder, so there are no holders to name.
  const command = slotCommandOf();
  let blockedBy: readonly SlotHolder[] | undefined;
  let blockedOn: SlotsDrawn | undefined;
  const lock = await slots.take(
    callSignal(),
    progress === undefined
      ? undefined
      : (waitedMs) => {
          progress(
            waitedMs / 1000,
            command === undefined
              ? slotWaitSaid(waitedMs, slots.count, slots.directory, slots.holders(), slots.drawn)
              : delegateWaitSaid(waitedMs, command),
          );
        },
    () => {
      blockedBy = slots.holders();
      blockedOn = slots.drawn;
    },
    game,
    project,
    undefined,
    tool,
  );
  if (waits !== undefined && blockedBy !== undefined) {
    waits.ms += Date.now() - began;
    const heldBy = blockedBy;
    const heldOn = blockedOn;
    waits.said ??=
      command === undefined || slots.grantOf(lock) === undefined
        ? (waitedMs) => slotWaitedSaid(waitedMs, slots.count, slots.directory, heldBy, heldOn)
        : (waitedMs) => delegateWaitedSaid(waitedMs, command);
  }
  const grant = slots.grantOf(lock);
  return {
    lock,
    from: slots.holder.pid,
    delegated: grant !== undefined,
    release: () => {
      slots.release(lock);
    },
    settled: async () => {
      await grant?.gone;
    },
    handTo: async (holder) => await slots.hand(lock, holder),
    leave: () => {
      slots.forget(lock);
    },
  };
}

/**
 * What a run's record says of its slot for the keeper that holds the run, taken from [param slot]
 * and named [param by]. A delegate command's slot is handed to the keeper through the command, so the
 * keeper has no lock file of its own to take over and the record carries none.
 */
export function keeperSlotOf(
  slot: Pick<CallSlot, 'lock' | 'from' | 'delegated'>,
  by: string,
): { slot?: { lock: string; from: number; by: string } } {
  return slot.delegated ? {} : { slot: { lock: slot.lock, from: slot.from, by } };
}

/**
 * Hands [param slot], a delegate command's, to the keeper [param pid] that holds a game for
 * editor_run, which keeps it until the keeper has gone. The keeper outlives the game's first
 * process and follows its restarts. The slot is given back when the keeper is not known, its start
 * cannot be read or the command will not hand it on.
 */
export async function handSlotToKeeper(
  slot: Pick<CallSlot, 'handTo' | 'release'>,
  pid: number | undefined,
  projectPath: string | null,
): Promise<void> {
  await handedOrReleased(
    slot,
    pid,
    `the keeper of a game${projectPath === null ? '' : ` of ${projectPath}`} editor_run started`,
  );
}

/**
 * Hands [param slot] to the played game [param pid], so its lock is freed by the game ending. The
 * slot is given back when the game's start cannot be read or the lock is no longer this server's
 * to hand.
 */
export async function handSlotToGame(
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
  /** Whether a delegate command granted it, which leaves the lock file to that command alone. */
  readonly delegated: boolean;
  readonly release: () => void;
  /** Settles once what {@link release} gave back has gone: the delegate command's exit, at most a few seconds on. */
  readonly settled: () => Promise<void>;
  /** Hands the slot to [param holder], which keeps it until it has gone, and answers whether it did. */
  readonly handTo: (holder: SlotHolder) => Promise<boolean>;
  /** Leaves the lock for another process to take over. It names this one until it does. */
  readonly leave: () => void;
}

/** The slot a command of several engine steps holds for all of them, inside {@link inOneSlot}. */
const keptForSteps = new AsyncLocalStorage<{ held: Promise<CallSlot> | null; project?: string }>();

/**
 * Names the project the command inside {@link inOneSlot} runs for, which gives its slot the
 * project's repository, and high priority where the list names it. Call it before the first engine step. Outside
 * {@link inOneSlot} it does nothing.
 */
export function forTheProject(project: string): void {
  const kept = keptForSteps.getStore();
  if (kept !== undefined) {
    kept.project = project;
  }
}

/**
 * Runs [param body] holding one of the machine's slots for the call, handing it the slot's lock,
 * and gives it back after. Inside {@link inOneSlot} it uses the slot held there. [param project] is
 * the project the call is for, in place of the one {@link forTheProject} named.
 */
export async function inASlot<T>(body: (lock: string) => Promise<T>, project?: string): Promise<T> {
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
    await held.settled();
  }
}

/**
 * Runs [param body], a command whose engines run one after another, holding one slot for all of
 * them. Each engine taking its own slot queued again on a busy machine: one `gdharness setup` waited
 * 122, 933 and 335 seconds for its three, 24 minutes in all. The slot is taken at the first engine,
 * so a command refused before one, for want of Godot or for its arguments, says so at once.
 */
export async function inOneSlot<T>(body: () => Promise<T>): Promise<T> {
  if (keptForSteps.getStore() !== undefined) {
    return await body();
  }
  const kept: { held: Promise<CallSlot> | null; project?: string } = { held: null };
  try {
    return await keptForSteps.run(kept, body);
  } finally {
    // A take that failed was thrown to the engine step that asked for it, and holds nothing.
    const held = await kept.held?.catch(() => null);
    held?.release();
    await held?.settled();
  }
}
