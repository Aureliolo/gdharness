/**
 * What an engine this server started may hold: a ceiling that ends it, and the peak of each project's
 * engines kept so the next start of that project counts what it is likely to take.
 *
 * One watcher reads every guarded engine's memory together, with the processes below it, so an engine
 * that forks workers is counted whole. It runs only while an engine is guarded.
 */

import { totalmem } from 'node:os';
import { alive } from './alive.js';
import { type TreeHeld, treesHeldBy } from './engine-spent.js';
import { EngineUsageError } from './errors.js';
import { type PeakTool, recordEnginePeak } from './run-record.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What an engine is taken to need while its project has no peak kept. */
export const MEMORY_PER_ENGINE = 1.5 * GIB;

/** The variable that sets the ceiling of every engine this server starts, in megabytes. */
export const CEILING_VARIABLE = 'GDHARNESS_ENGINE_MEMORY_CEILING_MB';

/** The least the default ceiling is, whatever the machine has. */
const CEILING_FLOOR_BYTES = 4 * GIB;

/** How often the guarded engines are read. */
const POLL_MS = 1000;

/** [param bytes] as gigabytes to one decimal place. */
export const gigabytes = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

/** A quarter of the machine's [param memory], and at least 4 GiB. */
function defaultCeilingBytes(memory: number = totalmem()): number {
  return Math.max(CEILING_FLOOR_BYTES, Math.floor(memory / 4));
}

/**
 * The ceiling for one engine, in bytes: the variable in [param env], else {@link defaultCeilingBytes}
 * of [param memory].
 */
export function ceilingBytes(env: NodeJS.ProcessEnv = process.env, memory: number = totalmem()): number {
  const named = env[CEILING_VARIABLE]?.trim() ?? '';
  if (named !== '' && !/^[1-9]\d*$/.test(named)) {
    throw new EngineUsageError(
      `${CEILING_VARIABLE} takes a whole number of megabytes above 0, not ${named}.`,
    );
  }
  return named === '' ? defaultCeilingBytes(memory) : Number(named) * MIB;
}

/** An engine that held more than its ceiling: the most it held and the ceiling it passed. */
export interface MemoryEnd {
  readonly peakBytes: number;
  readonly ceilingBytes: number;
}

/** What an engine held past its ceiling, and [param raisedBy], the argument or variable that raises it. */
export function memoryCeilingSaid(end: MemoryEnd, raisedBy: string): string {
  return `the engine held ${gigabytes(end.peakBytes)}, past the ${gigabytes(end.ceilingBytes)} ceiling. Set ${raisedBy} to raise it`;
}

/** Why an engine was ended for its memory, as the reason an answer gives. */
export function memoryEndedSaid(end: MemoryEnd, raisedBy: string): string {
  return `ended for its memory: ${memoryCeilingSaid(end, raisedBy)}`;
}

/** What a start of [param tool]'s engine needs, and what that figure is taken from. */
export function engineNeed(
  peakBytes: number | undefined,
  ceiling: number,
  tool: PeakTool,
): { readonly bytes: number; readonly said: string } {
  const wanted = Math.max(MEMORY_PER_ENGINE, peakBytes ?? 0);
  const from =
    peakBytes === undefined || peakBytes <= MEMORY_PER_ENGINE
      ? `${gigabytes(MEMORY_PER_ENGINE)} taken for each engine`
      : `the ${gigabytes(peakBytes)} the last ${tool} engine of this project held`;
  return wanted <= ceiling
    ? { bytes: wanted, said: from }
    : { bytes: ceiling, said: `${from}, capped at the ${gigabytes(ceiling)} ceiling` };
}

/** Why a start was refused: what the engine needs and from what, and what the machine has free. */
export function startRefusedSaid(
  need: { readonly bytes: number; readonly said: string },
  room: { readonly bytes: number; readonly said: string },
  kept: number,
): string {
  return `Not started: the engine needs ${gigabytes(need.bytes)} (${need.said}), and the machine has ${gigabytes(Math.max(0, room.bytes))} ${room.said}, ${gigabytes(kept)} of it kept for everything else.`;
}

/** One engine under guard. */
interface Guarded {
  readonly pid: number;
  readonly ceilingBytes: number;
  readonly ended: (end: MemoryEnd) => void;
  readonly keep: { readonly project: string; readonly tool: PeakTool } | undefined;
  peak: number;
  over: boolean;
}

/** An engine's guard: what it has held at most, and the way to stop guarding it once it has ended. */
export interface EngineGuard {
  /** The most the engine and everything below it has held. */
  readonly peak: () => number;
  /** Stops guarding it, keeps its peak for its project, and answers the peak. */
  readonly release: () => number;
}

export class MemoryWatch {
  private readonly guards = new Set<Guarded>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private readonly read: (pids: readonly number[]) => Promise<ReadonlyMap<number, TreeHeld>>;
  private readonly everyMs: number;

  constructor(
    read: (pids: readonly number[]) => Promise<ReadonlyMap<number, TreeHeld>> = treesHeldBy,
    everyMs: number = POLL_MS,
  ) {
    this.read = read;
    this.everyMs = everyMs;
  }

  /** Whether the watcher is reading: only while an engine is guarded. */
  get polling(): boolean {
    return this.timer !== null;
  }

  /**
   * Guards the engine [param pid]. Once it and everything below it hold more than [param ceiling]
   * bytes, the processes below it are ended and [param ended] is called, once. The caller ends the
   * engine itself there. The peak is kept for [param keep]'s project and tool when the guard is released.
   */
  guard(
    pid: number,
    ceiling: number,
    ended: (end: MemoryEnd) => void,
    keep?: { readonly project: string; readonly tool: PeakTool },
  ): EngineGuard {
    const guarded: Guarded = { pid, ceilingBytes: ceiling, ended, keep, peak: 0, over: false };
    this.guards.add(guarded);
    this.timer ??= setInterval(() => {
      void this.poll();
    }, this.everyMs);
    this.timer.unref();
    return {
      peak: () => guarded.peak,
      release: () => this.release(guarded),
    };
  }

  private release(guarded: Guarded): number {
    if (!this.guards.delete(guarded)) {
      return guarded.peak;
    }
    if (this.guards.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (guarded.keep !== undefined && guarded.peak > 0) {
      void recordEnginePeak(guarded.keep.project, guarded.keep.tool, guarded.peak);
    }
    return guarded.peak;
  }

  private async poll(): Promise<void> {
    if (this.reading) {
      return;
    }
    this.reading = true;
    try {
      const live = [...this.guards];
      if (live.length === 0) {
        return;
      }
      const held = await this.read(live.map((one) => one.pid));
      for (const one of live) {
        if (this.guards.has(one)) {
          this.judge(one, held.get(one.pid));
        }
      }
    } finally {
      this.reading = false;
    }
  }

  /** Records what [param tree] holds against [param one]'s ceiling, ending the engine past it. */
  private judge(one: Guarded, tree: TreeHeld | undefined): void {
    if (tree === undefined) {
      // An engine nobody released, such as a game that outlives the call that started it.
      if (!alive(one.pid)) {
        this.release(one);
      }
      return;
    }
    if (one.over) {
      return;
    }
    one.peak = Math.max(one.peak, tree.bytes);
    if (tree.bytes <= one.ceilingBytes) {
      return;
    }
    one.over = true;
    for (const below of tree.below) {
      try {
        process.kill(below, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    one.ended({ peakBytes: one.peak, ceilingBytes: one.ceilingBytes });
  }
}

/** The watcher every engine this server starts is guarded by. */
export const engineMemory = new MemoryWatch();
