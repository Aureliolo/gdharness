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
 * {@link KEPT_SLOTS} slots; a gate's engines take only the others ({@link slotsDrawnOn}).
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
 * `%LOCALAPPDATA%\gdharness\slots` on Windows, else `~/.cache/gdharness/slots`; the count is half
 * the processors, at least one. `GODOT_ENGINE_SLOTS` and `GODOT_ENGINE_SLOT_COUNT`
 * replace either, and a command's `--slots` and `--slot-count` replace those ({@link machineSlots}).
 *
 * The games' own tools take slots in this directory the same way, which is the point of it: the
 * scheme is written out in docs/test-runs.md for them, and a change here is a change there.
 */

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
  watch,
  writeSync,
} from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { callProgress, callSignal, callSlotWaits } from './call-signal.js';
import { EngineUsageError } from './engine-launch.js';
import {
  ancestorsIn,
  type ProcessTree,
  processTree,
  readCommandLine,
  startTimesOf,
} from './process-children.js';
import { readWhole, removeWhole, writeWhole } from './whole-file.js';

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

/** How many of the kept slots are a gate's own steps', the first of them. */
const GATE_KEPT = 1;

/**
 * The slot of [param count] that neither a gate's own steps nor a game editor_run started take while
 * a gate is queued, the last, or null when fewer than two are kept. A gate's steps could take every
 * kept slot, and with two games on the rest, one-off runs waited over an hour while gates kept
 * arriving.
 */
export function reservedSlotOf(count: number): number | null {
  return count - Math.max(1, count - keptSlotsOf(count)) >= 2 ? count - 1 : null;
}

/**
 * How long a one-off take, neither a gate's nor a game's, waits before it may take any free slot
 * the way it does when no gate is queued, gates' slots included, so a steady arrival of gates never
 * holds it back for good.
 */
export const ONE_OFF_AGED_MS = 120_000;

/**
 * How long a take leaves a free slot to a taker waiting longer that may take it, past which it takes
 * the slot itself. One waiting ahead takes a slot within a moment of its coming free, woken as the
 * lock goes, so one left that long is one it cannot take after all, a mark misread or a taker the
 * queue has paused, and a slot never stands idle longer while someone waits who may take it.
 */
export const SLOT_YIELD_MS = 5000;

/** The kind a waiting mark names for a wait for memory, which takes no slot. */
const MEMORY_TAKER = 'memory';

/** A taker waiting for one of the machine's slots, as its mark names it. */
export interface SlotWaiter {
  readonly mark: string;
  readonly taker: SlotTaker;
  /** When it began to wait, in milliseconds since the epoch. */
  readonly since: number;
  readonly game: boolean;
}

/**
 * Each live taker waiting for a slot in [param directory], as its mark names it. A mark's `taker` of
 * another kind is a one-off's, and one naming no `since` (seconds since the epoch, as the games'
 * tools write it) waits since its file was made, which nobody writes again while it waits.
 */
export function slotWaiters(directory: string): SlotWaiter[] {
  const marks = join(directory, WAITING_FOLDER);
  let names: string[];
  try {
    names = readdirSync(marks).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found: SlotWaiter[] = [];
  for (const mark of names.sort()) {
    let content: string | null;
    let madeAt: number;
    try {
      content = readWhole(join(marks, mark));
      madeAt = statSync(join(marks, mark)).mtimeMs;
    } catch {
      continue;
    }
    const holder = content === null ? null : holderOf(content);
    if (content === null || holder === null || !alive(holder.pid)) {
      continue;
    }
    const { taker, since } = JSON.parse(content) as { taker?: unknown; since?: unknown };
    if (taker === MEMORY_TAKER) {
      continue;
    }
    found.push({
      mark,
      taker: taker === 'gate' || taker === 'timing' || taker === 'tier' ? taker : 'other',
      // In whole milliseconds, as a take's own clock reads: a file's time has a fraction, so a mark
      // made in the millisecond a take began read as made after it, and the take went first.
      since: Math.floor(typeof since === 'number' && Number.isFinite(since) ? since * 1000 : madeAt),
      game: holder.game === true,
    });
  }
  return found;
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
 * is no exception, since a one-off past {@link ONE_OFF_AGED_MS} may take a gate's slot; a timing,
 * whose turn the queue already gave it, leaves nothing. Agent runs of one game waited 38 to 80
 * minutes for one slot while runs of seconds took turns on it with no order among them.
 */
export class SlotLine {
  readonly since: number;
  /** The name of its own waiting mark once it has one. */
  mark: string | undefined;
  /** The slots it leaves to those ahead, each with when it first left it. */
  private left = new Map<number, number>();

  readonly taker: SlotTaker;
  readonly game: boolean;
  private readonly clock: () => number;

  constructor(taker: SlotTaker, game = false, clock: () => number = Date.now) {
    this.taker = taker;
    this.game = game;
    this.clock = clock;
    this.since = clock();
  }

  /** What its waiting mark holds beside [param holder]: its kind and when it began, in seconds. */
  marked(holder: SlotHolder): object {
    return { ...holder, ...(this.game ? { game: true } : {}), taker: this.taker, since: this.since / 1000 };
  }

  /** The takers of [param waiters] waiting longer than this one, the longest first. */
  ahead(waiters: readonly SlotWaiter[]): SlotWaiter[] {
    // Before it has a mark of its own, a mark begun in the same millisecond was there at its look.
    const own = this.mark ?? '￿';
    return waiters
      .filter(
        (one) =>
          one.mark !== this.mark && (one.since < this.since || (one.since === this.since && one.mark < own)),
      )
      .sort((a, b) => a.since - b.since || (a.mark < b.mark ? -1 : 1));
  }

  /**
   * Those of [param numbers] it may take now, the order kept: it leaves out each of [param theirs],
   * the free slots those ahead take first, until it has left it {@link SLOT_YIELD_MS}.
   */
  admitted(numbers: readonly number[], theirs: ReadonlySet<number>): number[] {
    const now = this.clock();
    this.left = new Map([...theirs].map((slot) => [slot, this.left.get(slot) ?? now]));
    return numbers.filter((slot) => !theirs.has(slot) || now - (this.left.get(slot) ?? now) >= SLOT_YIELD_MS);
  }

  /** The free slots it leaves to those waiting longer, lowest first. */
  leaves(): number[] {
    return [...this.left.keys()].sort((a, b) => a - b);
  }
}

/**
 * How many kept slots of [param kept] the games editor_run started may hold between them while a
 * gate is queued: half, leaving at least one beside the gate's own steps' for a short headless call
 * no running game can take.
 */
export function gamesKeptOf(kept: number): number {
  return Math.max(0, Math.min(Math.floor(kept / 2), kept - GATE_KEPT - 1));
}

/** The variable a timing sets in what it runs, naming the slot it holds; a timing takes any slot. */
const TIMED_VARIABLE = 'GODOT_ENGINE_TIMED';
/**
 * The variable a gate sets, `fast` or `full`, in each of its own steps, which run outside its seat
 * and take the kept slots while a gate is queued.
 */
const TIER_VARIABLE = 'GODOT_ENGINE_TIER';
/** The file beside a gate's mark in the queue once the gate has its seat. */
const SEATED_SUFFIX = '.seated';
/**
 * Which of a machine's slots a take is held to, when it is held to some: `tier` the kept ones a
 * gate's own steps take, and `games` none, for a game while games hold as many kept slots as they
 * may, its numbers then those the games hold.
 */
type SlotLimit = 'gate' | 'kept' | 'tier' | 'games';

/** The slot numbers a take may try, in order, and what holds it to them when something does. */
export interface SlotsDrawn {
  readonly numbers: readonly number[];
  readonly limit?: SlotLimit;
  /** Free ones of them the take leaves to takers waiting longer: see {@link SlotLine}. */
  readonly left?: readonly number[];
}

/** What takes a slot, as its environment says: see {@link slotsDrawnOn}. */
export type SlotTaker = 'gate' | 'timing' | 'tier' | 'other';

/** The machine's queue as a take reads it: whether a live gate is in it. */
export type GateQueue = 'none' | 'queued';

/**
 * The slot numbers of [param count] a take by [param taker] may try now, in the order it tries
 * them, and what holds it to them, given [param queue]. A gate's engine takes the first count less
 * the kept ones ({@link keptSlotsOf}), at least one, and a timing takes any. With no gate queued every
 * other takes any, the kept ones first so the gates' stay free longest. While one is queued a gate's
 * own step takes the kept ones but {@link reservedSlotOf}, the first of them first, and any other the
 * kept ones but the {@link GATE_KEPT} first. A gate's seat counts only the gates' slots, so work in the kept ones never
 * holds a seat back.
 */
export function slotsDrawnOn(count: number, taker: SlotTaker, queue: GateQueue): SlotsDrawn {
  const gated = Math.max(1, count - keptSlotsOf(count));
  if (taker === 'gate') {
    return { numbers: Array.from({ length: gated }, (_, slot) => slot), limit: 'gate' };
  }
  const every = Array.from({ length: count }, (_, slot) => count - 1 - slot);
  const kept = every.slice(0, count - gated);
  if (taker === 'timing' || queue === 'none' || kept.length === 0) {
    return { numbers: every };
  }
  if (taker === 'tier') {
    const reserve = reservedSlotOf(count);
    return { numbers: [...kept].reverse().filter((slot) => slot !== reserve), limit: 'tier' };
  }
  return { numbers: kept.slice(0, Math.max(1, kept.length - GATE_KEPT)), limit: 'kept' };
}

/** Whether [param env] says this process runs inside a gate, which names its share in both. */
export function inAGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env[SHARE_VARIABLE]) !== undefined && nonEmpty(env[SHARE_COUNT_VARIABLE]) !== undefined;
}

/**
 * Whether the process [param pid] in [param tree] runs on the slot [param holder] holds: whether the
 * nearest process above it whose executable is not [param executable] is the holder, or the engine
 * the lock names with a start within {@link START_TOLERANCE_MS} of the one written. Those running
 * [param executable] are passed over as launchers of its own, a `bun` under `bun run`; a game an
 * editor plays runs the editor's executable, so the editor is passed over too and the game takes a
 * slot of its own. [param engineStarted] is when the named engine's pid started, for a tree that
 * does not list it; an engine whose start cannot be read lends nothing.
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
  /** Set for a game editor_run started, which may hold only some of the kept slots: {@link gamesKeptOf}. */
  readonly game?: true;
  /**
   * The engine whose programs run on the slot, for a holder that is not it: a keeper holding the
   * slot for its game, which comes back under another pid when it restarts itself, or a process
   * waiting on an engine it started. Named as the holder is, and judged the same way.
   */
  readonly engine?: SlotEngine;
}

/** An engine a lock names beside its holder. */
export interface SlotEngine {
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
    const { by, game, engine } = parsed as { by?: unknown; game?: unknown; engine?: unknown };
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
  /**
   * The waiting marks this process has left a free slot to, each with when it first did. One that
   * lets a slot left to it stand {@link SLOT_YIELD_MS} is waiting for something else, a share or
   * memory under a release whose marks named no kind, so no take of this process leaves it another:
   * one such wait kept every short call of a server waiting 5 s for a slot that stood free.
   */
  private readonly passedOver = new Map<string, number>();
  /** The slot of the engine that started this process while one of its engines runs on it. */
  private inherited: string | null = null;
  /** The slots the last look could take, in the order it tried them, and what held it to them. */
  drawn: SlotsDrawn = { numbers: [] };
  private saidAt = Number.NEGATIVE_INFINITY;

  readonly directory: string;
  readonly count: number;
  readonly holder: SlotHolder;
  /** What this process is as a taker, asked at every look, since a turn ends when its ticket goes. */
  private readonly taker: () => SlotTaker;
  private readonly say: ((line: string) => void) | undefined;

  constructor(
    directory: string,
    count: number,
    holder: SlotHolder,
    say?: (line: string) => void,
    taker: () => SlotTaker = () => slotTaker(),
  ) {
    this.directory = directory;
    this.count = count;
    this.holder = holder;
    this.say = say;
    this.taker = taker;
    this.drawn = slotsDrawnOn(count, taker(), 'none');
  }

  /**
   * Takes a slot, waiting for one to come free, and answers its lock's path. A take that finds every
   * slot held keeps a mark of its wait until it ends, however it ends, and calls [param blocked]
   * once, as it begins waiting. [param game] is a take for a game editor_run started.
   */
  async take(
    signal?: AbortSignal,
    waiting?: (waitedMs: number) => void,
    blocked?: () => void,
    game = false,
  ): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    const line = new SlotLine(this.taker(), game);
    const began = line.since;
    let said = Number.NEGATIVE_INFINITY;
    let mark: string | undefined;
    let changes: FolderChanges | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const lock = await this.takeFree(game, Date.now() - began, line);
        if (lock !== null) {
          return lock;
        }
        if (mark === undefined) {
          mark = this.waitMarked(line);
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
   * last one leaving changes them; a slot already held is kept to its end whatever arrives. A take
   * for a [param game] editor_run started marks its lock as a game's, and while a gate is queued finds
   * none free once the games hold as many of the kept slots as {@link gamesKeptOf} gives them, nor
   * {@link reservedSlotOf}. A one-off take that has waited [param waitedMs] of
   * {@link ONE_OFF_AGED_MS} takes any slot. A take but a timing's leaves the free slots the takers
   * waiting longer than [param line] take first ({@link SlotLine}); one given no line came last.
   */
  async takeFree(game = false, waitedMs = 0, line?: SlotLine): Promise<string | null> {
    mkdirSync(this.directory, { recursive: true });
    await this.sweep();
    const inherited = this.inherited === null ? await this.inheritedLock() : null;
    if (inherited !== null) {
      this.inherited = inherited;
      return inherited;
    }
    const taker = this.taker();
    const aged = taker === 'other' && !game && waitedMs >= ONE_OFF_AGED_MS;
    let queue: GateQueue | undefined;
    const queued = async (): Promise<GateQueue> => (queue ??= await this.gateQueue());
    this.drawn = slotsDrawnOn(
      this.count,
      taker,
      taker === 'gate' || taker === 'timing' || aged ? 'none' : await queued(),
    );
    if (game && this.drawn.limit === 'kept') {
      const reserve = reservedSlotOf(this.count);
      this.drawn = { ...this.drawn, numbers: this.drawn.numbers.filter((slot) => slot !== reserve) };
      const kept = this.count - Math.max(1, this.count - keptSlotsOf(this.count));
      const games = await this.heldByGames(Array.from({ length: kept }, (_, at) => this.count - kept + at));
      if (games.length >= gamesKeptOf(kept)) {
        this.drawn = { numbers: games, limit: 'games' };
        return null;
      }
    }
    let tried = this.drawn.numbers;
    if (taker !== 'timing') {
      const placed = line ?? new SlotLine(taker, game);
      const now = Date.now();
      const waiting = slotWaiters(this.directory);
      for (const mark of this.passedOver.keys()) {
        if (!waiting.some((one) => one.mark === mark)) {
          this.passedOver.delete(mark);
        }
      }
      const ahead = placed
        .ahead(waiting)
        .filter((one) => now - (this.passedOver.get(one.mark) ?? now) < SLOT_YIELD_MS);
      const claims = await this.claimedAhead(ahead, queued);
      for (const mark of claims.values()) {
        if (!this.passedOver.has(mark)) {
          this.passedOver.set(mark, now);
        }
      }
      tried = placed.admitted(tried, new Set(claims.keys()));
      const left = placed
        .leaves()
        .filter((slot) => this.drawn.numbers.includes(slot) && !tried.includes(slot));
      if (left.length > 0) {
        this.drawn = { ...this.drawn, left };
      }
    }
    const holder: SlotHolder = game ? { ...this.holder, game: true } : this.holder;
    for (const slot of tried) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (this.made(lock, holder) || (await this.takenOver(lock, holder))) {
        this.held.add(lock);
        return lock;
      }
    }
    return null;
  }

  /**
   * The free slots the takers [param ahead] take first, in their order, each with the mark of the one
   * taking it: see {@link slotsClaimed}.
   */
  private async claimedAhead(
    ahead: readonly SlotWaiter[],
    queued: () => Promise<GateQueue>,
  ): Promise<Map<number, string>> {
    if (ahead.length === 0) {
      return new Map();
    }
    const open: number[] = [];
    for (let slot = 0; slot < this.count; slot += 1) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      if (!existsSync(lock) || (await this.free(lock))) {
        open.push(slot);
      }
    }
    if (open.length === 0) {
      return new Map();
    }
    const now = Date.now();
    const reserve = reservedSlotOf(this.count);
    const drawn: (readonly number[])[] = [];
    for (const one of ahead) {
      const aged = one.taker === 'other' && !one.game && now - one.since >= ONE_OFF_AGED_MS;
      const theirs = slotsDrawnOn(
        this.count,
        one.taker,
        one.taker === 'gate' || one.taker === 'timing' || aged ? 'none' : await queued(),
      );
      drawn.push(
        one.game && theirs.limit === 'kept'
          ? theirs.numbers.filter((slot) => slot !== reserve)
          : theirs.numbers,
      );
    }
    return new Map(
      [...slotsClaimed(drawn, open)].map(([slot, at]): [number, string] => [slot, ahead[at]?.mark ?? '']),
    );
  }

  /**
   * The slot [constant HELD_VARIABLE] names, for one engine of this process to run on, or null. Taken
   * only while the lock's holder is the nearest process above this one running another executable,
   * past the launchers of this one's own: a game an editor plays inherits the editor's environment,
   * so the variable alone would put it on the editor's slot.
   */
  private async inheritedLock(): Promise<string | null> {
    const lock = nonEmpty(process.env[HELD_VARIABLE]);
    const content = lock === undefined ? null : readWhole(lock);
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
   * takes it up again, so a gate counting its own time reads that wait as held up by others too. It
   * names its kind as `memory`, which no take lets go first, since it takes no slot.
   */
  markWaiting(): () => void {
    const mark = this.waitMarked({ ...this.holder, taker: MEMORY_TAKER });
    return () => {
      if (mark !== undefined && this.marks.delete(mark)) {
        removeWhole(mark);
      }
    };
  }

  /**
   * Puts down the mark of a wait, holding [param line]'s place or [param line] itself, and answers
   * its path, or undefined when it could not be made, which the next look tries again.
   */
  private waitMarked(line: SlotLine | object): string | undefined {
    const marks = join(this.directory, WAITING_FOLDER);
    waitsMarked += 1;
    const mark = join(marks, `${String(this.holder.pid)}-${String(waitsMarked)}.json`);
    try {
      mkdirSync(marks, { recursive: true });
    } catch {
      return undefined;
    }
    if (!this.made(mark, line instanceof SlotLine ? line.marked(this.holder) : line)) {
      return undefined;
    }
    if (line instanceof SlotLine) {
      line.mark = basename(mark);
    }
    this.marks.add(mark);
    return mark;
  }

  /** Which of the slots [param numbers] a live game editor_run started holds. */
  private async heldByGames(numbers: readonly number[]): Promise<number[]> {
    const games: number[] = [];
    for (const slot of numbers) {
      const lock = join(this.directory, `${String(slot)}.lock`);
      const content = readWhole(lock);
      if (content !== null && holderOf(content)?.game === true && !(await this.free(lock))) {
        games.push(slot);
      }
    }
    return games;
  }

  /**
   * The machine's queue: whether a live gate has a mark in it. A mark whose gate has gone is removed
   * with its `.seated` file, by the rule a lock is freed by, and one not yet written names nobody and
   * is passed over.
   */
  private async gateQueue(): Promise<GateQueue> {
    const marks = join(this.directory, QUEUED_FOLDER);
    let names: string[];
    try {
      names = readdirSync(marks).filter((name) => name.endsWith('.json'));
    } catch {
      return 'none';
    }
    let live: GateQueue = 'none';
    for (const name of names) {
      const mark = join(marks, name);
      const content = readWhole(mark);
      if (content === null || holderOf(content) === null) {
        continue;
      }
      if (await this.free(mark)) {
        removeWhole(mark);
        removeWhole(`${mark}${SEATED_SUFFIX}`);
      } else {
        live = 'queued';
      }
    }
    return live;
  }

  /**
   * Who holds the slots the last look could take, in the order it tried them, leaving out a lock
   * that cannot be read; for a game held back by the cap, the games holding the kept slots.
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

  /** Hands the slot at [param lock] to [param to], answering whether it did: see {@link handSlot}. */
  hand(lock: string, to: SlotHolder): boolean {
    const handed = handSlot(lock, this.holder.pid, to);
    if (handed) {
      this.held.delete(lock);
    }
    return handed;
  }

  /** Makes [param path] holding [param holder], answering false when it is there already. */
  private made(path: string, holder: object = this.holder): boolean {
    let made: number;
    try {
      made = openSync(path, 'wx');
    } catch {
      return false;
    }
    try {
      writeSync(made, JSON.stringify(holder));
    } finally {
      closeSync(made);
    }
    return true;
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
    for (const name of names) {
      const numbered = /^(\d+)\.lock$/.exec(name)?.[1];
      if (numbered !== undefined && Number(numbered) >= this.count) {
        await this.cleared(join(this.directory, name), false);
      }
    }
    // By the pid alone, which costs no query: a taker killed while it waited leaves its mark, and a
    // gate reading it counts a wait that is not happening.
    const marks = join(this.directory, WAITING_FOLDER);
    let waits: string[];
    try {
      waits = readdirSync(marks);
    } catch {
      return;
    }
    for (const name of waits) {
      let content: string | null;
      try {
        content = readWhole(join(marks, name));
      } catch {
        // Held by a reader past the retries, which the next look tries again.
        continue;
      }
      const pid = content === null ? undefined : holderOf(content)?.pid;
      if (pid !== undefined && !alive(pid)) {
        removeWhole(join(marks, name));
      }
    }
  }

  /** Takes over [param lock] for [param holder] when its holder has gone, under the steal file. */
  private takenOver(lock: string, holder: SlotHolder): Promise<boolean> {
    return this.cleared(lock, true, holder);
  }

  /**
   * Removes [param lock] when its holder has gone, under its steal file, so that a lock another
   * taker has just made in its place is never removed; with [param retake] makes it again for this
   * process, written as [param holder], answering whether that was done.
   */
  private async cleared(lock: string, retake: boolean, holder: SlotHolder = this.holder): Promise<boolean> {
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
      return retake ? this.made(lock, holder) : true;
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
  const holder = content === null ? null : holderOf(content);
  // A game's slot stays a game's in the hands of whatever runs it.
  return (
    holder?.pid === from &&
    writeWhole(lock, JSON.stringify(holder.game === true ? { ...to, game: true } : to))
  );
}

/**
 * Names [param engine] in the slot at [param lock] as the engine running on it, when the lock still
 * names [param holder], answering whether it did. Renamed over the lock, as {@link handSlot} is.
 */
export function nameSlotEngine(lock: string, holder: number, engine: SlotEngine): boolean {
  let content: string | null;
  try {
    content = readWhole(lock);
  } catch {
    return false;
  }
  const named = content === null ? null : holderOf(content);
  return named?.pid === holder && writeWhole(lock, JSON.stringify({ ...named, engine }));
}

/**
 * Names the engine [param pid] started in the slot at [param lock], which [param holder] holds, once
 * its start has been read; a start the platform will not give names nothing, since an engine named
 * without one would lend its slot to nobody.
 */
export async function nameSlotEngineOf(lock: string, holder: number, pid: number): Promise<void> {
  const started = (await startTimesOf([pid])).get(pid);
  if (started !== undefined) {
    nameSlotEngine(lock, holder, { pid, started });
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
    let written = Number.NaN;
    try {
      written = Number(readFileSync(pidFile, 'utf8').trim());
    } catch {
      // Not written yet.
    }
    if (Number.isInteger(written) && written > 0) {
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
  const so = `Waiting${waitedMs >= 1000 ? ` ${String(Math.round(waitedMs / 1000))} s so far` : ''} for an engine`;
  const taking = drawn.limit === undefined ? count : drawn.numbers.length;
  const slots = `${slotsSaid(taking, count, directory, drawn.limit)} ${taking === 1 ? 'is' : 'are'} in use`;
  const named = holdersNamed(taking, holders);
  const waiting = `${so}: ${slots}`;
  const back = `the engine starts when ${taking === 1 ? 'it' : 'one'} is given back`;
  const starts =
    drawn.limit === 'kept' || drawn.limit === 'tier' || drawn.limit === 'games'
      ? `${back} or no gate is queued`
      : back;
  const said =
    named.length === 0
      ? `${waiting}, by a gate or another tool, and ${starts}.`
      : taking === 1
        ? `${waiting}, by ${named.join(', ')}, and ${starts}.`
        : `${waiting}: ${listed(named)}. ${starts.charAt(0).toUpperCase()}${starts.slice(1)}.`;
  return `${said}${leftSaid(drawn)}`;
}

/** What a take says of the free slots of [param drawn] it leaves, or [param past] left, to takers waiting longer. */
function leftSaid(drawn: SlotsDrawn, past = false): string {
  const left = drawn.left ?? [];
  if (left.length === 0) {
    return '';
  }
  const slots = left.length === 1 ? `slot ${String(left[0])}` : `slots ${listed(left.map(String))}`;
  return past
    ? ` It left free ${slots} to takers that had begun waiting before it, which go first.`
    : ` It leaves free ${slots} to takers that began waiting before it, which go first.`;
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
  if (limit === 'tier') {
    return `${taking === 1 ? 'the one engine slot' : `the ${String(taking)} engine slots`} of the ${String(count)} ${where} a gate's own steps take while a gate is queued`;
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
  const taking = drawn.limit === undefined ? count : drawn.numbers.length;
  const slots = `${slotsSaid(taking, count, directory, drawn.limit)} ${taking === 1 ? 'was' : 'were'} in use`;
  const named = holdersNamed(taking, holders);
  const said =
    named.length === 0
      ? `${waited} When it first waited, ${slots}, by a gate or another tool.`
      : taking === 1
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
 * {@link gamesKeptOf}.
 */
export async function slotForCall(game = false): Promise<CallSlot> {
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

/**
 * Runs [param body] holding one of the machine's slots for the call, handing it the slot's lock,
 * and gives it back after.
 */
export async function inASlot<T>(body: (lock: string) => Promise<T>): Promise<T> {
  const held = await slotForCall();
  try {
    return await body(held.lock);
  } finally {
    held.release();
  }
}
