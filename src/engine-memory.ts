/**
 * What an engine this process started may hold: a ceiling that ends it, and the peak of each project's
 * engines kept so the next start of that project counts what it is likely to take.
 *
 * One watcher judges every guarded engine from the shared sample, which reads each engine's memory
 * once with the processes below it, so an engine that forks workers is counted whole and an engine
 * also watched for its time is read once. It runs only while an engine is guarded. Each reading
 * also takes the machine's free memory, and while that is under {@link SHORT_FLOOR} the largest
 * guarded engine is ended, one a reading, so engines each under their ceiling do not together take
 * what the machine holds.
 */

import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { alive } from './alive.js';
import { type Sample, sampled, watching } from './engine-spent.js';
import { EngineUsageError } from './errors.js';
import { parseProjectGodot } from './resources.js';
import { type PeakTool, recordEnginePeak } from './run-record.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What an engine is taken to need while its project has no peak kept. */
export const MEMORY_PER_ENGINE = 1.5 * GIB;

/** The variable that sets the ceiling of every engine this server starts, in megabytes. */
export const CEILING_VARIABLE = 'GDHARNESS_ENGINE_MEMORY_CEILING_MB';

/** The project setting that sets the ceiling of every engine started for that project, in megabytes. */
const CEILING_SETTING = 'gdharness/engine/memory_ceiling_mb';

/** The least the default ceiling is, whatever the machine has. */
const CEILING_FLOOR_BYTES = 4 * GIB;

/** How often the guarded engines are read. */
const POLL_MS = 1000;

/**
 * The free memory under which the machine is short: the larger of the two figures. While it is
 * short, the largest guarded engine holding at least {@link MEMORY_PER_ENGINE} is ended.
 */
const SHORT_FLOOR = { leastBytes: 2 * GIB, shareOfMemory: 0.05 } as const;

/** The free memory under which a machine of [param memory] bytes is short: see {@link SHORT_FLOOR}. */
export function shortFloorBytes(memory: number): number {
  return Math.max(SHORT_FLOOR.leastBytes, Math.floor(memory * SHORT_FLOOR.shareOfMemory));
}

/** [param bytes] as gigabytes to one decimal place. */
export const gigabytes = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

/** A quarter of the machine's [param memory], and at least 4 GiB. */
function defaultCeilingBytes(memory: number = totalmem()): number {
  return Math.max(CEILING_FLOOR_BYTES, Math.floor(memory / 4));
}

/** Where a ceiling's figure comes from: the project's setting, the server's variable, or the default. */
type CeilingSource = 'project' | 'variable' | 'default';

/** The most one engine may hold, and where that figure comes from. */
export interface Ceiling {
  readonly bytes: number;
  readonly source: CeilingSource;
}

/** The setting of the project at [param project] as read from its project.godot, or undefined when it is not set. */
function settingOf(project: string): string | number | boolean | null | undefined {
  try {
    return parseProjectGodot(readFileSync(join(project, 'project.godot'), 'utf8'))['gdharness']?.[
      CEILING_SETTING.slice('gdharness/'.length)
    ];
  } catch {
    return undefined;
  }
}

/**
 * The ceiling for one engine started for [param project]: the project's setting, else the variable in
 * [param env], else a quarter of [param memory] and at least 4 GiB. A setting or variable that is not a
 * whole number of megabytes above 0 is refused.
 */
export function ceilingFor(
  project: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  memory: number = totalmem(),
): Ceiling {
  const set = project === undefined ? undefined : settingOf(project);
  if (set !== undefined) {
    if (typeof set === 'string') {
      throw new EngineUsageError(
        `${CEILING_SETTING} in project.godot is the text ${JSON.stringify(set)}, and takes a whole number of megabytes above 0, written without quotes.`,
      );
    }
    if (typeof set !== 'number' || !Number.isInteger(set) || set <= 0) {
      throw new EngineUsageError(
        `${CEILING_SETTING} in project.godot takes a whole number of megabytes above 0, not ${String(set)}.`,
      );
    }
    return { bytes: set * MIB, source: 'project' };
  }
  const named = env[CEILING_VARIABLE]?.trim() ?? '';
  if (named === '') {
    return { bytes: defaultCeilingBytes(memory), source: 'default' };
  }
  if (!/^[1-9]\d*$/.test(named)) {
    throw new EngineUsageError(
      `${CEILING_VARIABLE} takes a whole number of megabytes above 0, not ${named}.`,
    );
  }
  return { bytes: Number(named) * MIB, source: 'variable' };
}

/** The ceiling of an engine started for no project: see {@link ceilingFor}. */
export function ceilingBytes(env: NodeJS.ProcessEnv = process.env, memory: number = totalmem()): number {
  return ceilingFor(undefined, env, memory).bytes;
}

/**
 * An engine ended for its memory: the most it held, its ceiling and where that came from. [param
 * short] is set for an engine ended because the machine ran short, with the free memory read then
 * and the floor it was under, and peakBytes is then what the engine held at that reading.
 */
export interface MemoryEnd {
  readonly peakBytes: number;
  readonly ceilingBytes: number;
  readonly source: CeilingSource;
  readonly short?: { readonly freeBytes: number; readonly floorBytes: number };
}

/** Why a machine short of memory ended [param end]'s engine, and the setting that caps its project's engines lower. */
function shortSaid(end: MemoryEnd & { readonly short: NonNullable<MemoryEnd['short']> }): string {
  return `the machine ran short of memory, with ${gigabytes(end.short.freeBytes)} free under the ${gigabytes(end.short.floorBytes)} floor while the engine held ${gigabytes(end.peakBytes)}, the most of the engines this server guards. Set ${CEILING_SETTING} in project.godot to cap this project's engines lower`;
}

/**
 * What an engine held past its ceiling, and the setting or variable that raises the ceiling. For an
 * engine ended because the machine ran short, why, and the setting that caps its project lower.
 */
function memoryCeilingSaid(end: MemoryEnd): string {
  if (end.short !== undefined) {
    return shortSaid({ ...end, short: end.short });
  }
  const held = `the engine held ${gigabytes(end.peakBytes)}, past the ${gigabytes(end.ceilingBytes)} ceiling`;
  if (end.source === 'project') {
    return `${held}. Set ${CEILING_SETTING} in project.godot to raise it`;
  }
  if (end.source === 'variable') {
    return `${held}. Set ${CEILING_VARIABLE} to raise it`;
  }
  return `${held}, the default. Set ${CEILING_VARIABLE} or ${CEILING_SETTING} in project.godot to raise it`;
}

/** [param subject] ended for its memory, in one sentence that names what sets the ceiling. */
export function memoryEndSentence(subject: string, end: MemoryEnd): string {
  if (end.short !== undefined) {
    return `${subject} was ended because ${shortSaid({ ...end, short: end.short })}.`;
  }
  const held = `${subject} was ended for its memory: it held ${gigabytes(end.peakBytes)}, past`;
  if (end.source === 'project') {
    return `${held} the ${gigabytes(end.ceilingBytes)} ceiling ${CEILING_SETTING} in project.godot sets.`;
  }
  if (end.source === 'variable') {
    return `${held} the ${gigabytes(end.ceilingBytes)} ceiling ${CEILING_VARIABLE} sets.`;
  }
  return `${held} the default ${gigabytes(end.ceilingBytes)} ceiling, which ${CEILING_VARIABLE} or ${CEILING_SETTING} in project.godot raises.`;
}

/** Why an engine was ended for its memory, as the reason an answer gives. */
export function memoryEndedSaid(end: MemoryEnd): string {
  return end.short === undefined
    ? `ended for its memory: ${memoryCeilingSaid(end)}`
    : `ended because ${memoryCeilingSaid(end)}`;
}

/** What ended a game for its memory, as a run's `endedBy` says it. */
export function memoryEndedBy(end: MemoryEnd): string {
  return end.short === undefined
    ? `its memory ceiling: ${memoryCeilingSaid(end)}`
    : `its memory, because ${memoryCeilingSaid(end)}`;
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

/**
 * Why a start was refused: what the engine needs and from what, and what the machine has free. Then
 * what lets it start: the memory to free, or a ceiling that caps what it is counted at, named by
 * where [param ceiling] comes from. The ceiling named leaves a margin of a quarter of the room, and
 * at least 1 GiB, since free memory moves between this start and the next. It is never below the
 * flat figure, which every start fits.
 */
export function startRefusedSaid(
  need: { readonly bytes: number; readonly said: string },
  room: { readonly bytes: number; readonly said: string },
  kept: number,
  ceiling: Ceiling,
): string {
  const left = room.bytes - kept;
  const margin = Math.max(GIB, left / 4);
  const fits = Math.max(MEMORY_PER_ENGINE, Math.floor((left - margin) / MIB) * MIB) / MIB;
  // Rounded up to the tenth said, so freeing what is named is enough.
  const toFree = (Math.ceil(((need.bytes - left) * 10) / GIB) * GIB) / 10;
  const set =
    ceiling.source === 'project'
      ? `${CEILING_SETTING} in project.godot`
      : `${CEILING_VARIABLE} or ${CEILING_SETTING} in project.godot`;
  return `Not started: the engine needs ${gigabytes(need.bytes)} (${need.said}), and the machine has ${gigabytes(Math.max(0, room.bytes))} ${room.said}, ${gigabytes(kept)} of it kept for everything else. Free ${gigabytes(toFree)} of memory, or set ${set} to ${String(fits)} or less, which caps what the engine may hold and is counted at.`;
}

/** The project and tool an engine's peak is kept for. */
interface EngineKeep {
  readonly project: string;
  readonly tool: PeakTool;
}

/** One engine under guard. */
interface Guarded {
  readonly pid: number;
  readonly ceiling: Ceiling;
  readonly ended: (end: MemoryEnd) => void;
  readonly keep: EngineKeep | undefined;
  peak: number;
  /** What it and the processes below it held at the last reading, and which those were. */
  last: { readonly bytes: number; readonly below: readonly number[] } | undefined;
  /** Why it was ended, once it was: past its ceiling, or the largest when the machine ran short. */
  endedFor: 'ceiling' | 'short' | null;
}

/** An engine's guard: what it has held at most, and the way to stop guarding it once it has ended. */
export interface EngineGuard {
  /** The most the engine and everything below it has held. */
  readonly peak: () => number;
  /** Stops guarding it, keeps its peak for its project unless it was ended for it, and answers the peak. */
  readonly release: () => number;
}

export class MemoryWatch {
  private readonly guards = new Set<Guarded>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private readonly sample: () => Promise<Sample>;
  private readonly everyMs: number;
  private readonly free: () => number;
  private readonly memory: number;

  /**
   * Reads with [param sample] every [param everyMs], and takes the machine's free memory from
   * [param free] at each reading, judged against the floor of a machine of [param memory] bytes.
   */
  constructor(
    sample: () => Promise<Sample> = sampled,
    everyMs: number = POLL_MS,
    free: () => number = freemem,
    memory: number = totalmem(),
  ) {
    this.sample = sample;
    this.everyMs = everyMs;
    this.free = free;
    this.memory = memory;
  }

  /** Whether the watcher is reading: only while an engine is guarded. */
  get polling(): boolean {
    return this.timer !== null;
  }

  /** Whether the engine [param pid] is guarded already. */
  isGuarding(pid: number): boolean {
    return [...this.guards].some((one) => one.pid === pid);
  }

  /**
   * Guards the engine [param pid]. Once it and everything below it hold more than [param ceiling],
   * the processes below it are ended and [param ended] is called, once. The caller ends the
   * engine itself there. The peak is kept for [param keep]'s project and tool when the guard is
   * released, unless the engine was ended for passing it. [param ended] is also called for the
   * largest guarded engine when the machine runs short of memory, with the shortfall on the end.
   */
  guard(pid: number, ceiling: Ceiling, ended: (end: MemoryEnd) => void, keep?: EngineKeep): EngineGuard {
    const guarded: Guarded = {
      pid,
      ceiling,
      ended,
      keep,
      peak: 0,
      last: undefined,
      endedFor: null,
    };
    this.guards.add(guarded);
    watching(pid, true, true);
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
    watching(guarded.pid, false);
    if (this.guards.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // An engine ended past its ceiling keeps no peak: its figure is the fault, not what the project
    // needs, and kept it would refuse the project's next start. One ended for a machine short of
    // memory held what the project needs, so it keeps its peak.
    if (guarded.keep !== undefined && guarded.peak > 0 && guarded.endedFor !== 'ceiling') {
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
      const taken = await this.sample();
      const free = this.free();
      for (const one of live) {
        if (this.guards.has(one)) {
          this.judge(one, taken.held?.get(one.pid), taken.below?.get(one.pid) ?? []);
        }
      }
      this.endTheLargestIfShort(free);
    } finally {
      this.reading = false;
    }
  }

  /** Records the [param bytes] [param one] holds with [param below] against its ceiling, ending the engine past it. */
  private judge(one: Guarded, bytes: number | undefined, below: readonly number[]): void {
    one.last = undefined;
    if (bytes === undefined) {
      // An engine nobody released, such as a game that outlives the call that started it.
      if (!alive(one.pid)) {
        this.release(one);
      }
      return;
    }
    if (one.endedFor !== null) {
      return;
    }
    one.peak = Math.max(one.peak, bytes);
    one.last = { bytes, below };
    if (bytes <= one.ceiling.bytes) {
      return;
    }
    one.endedFor = 'ceiling';
    endBelow(below);
    one.ended({ peakBytes: one.peak, ceilingBytes: one.ceiling.bytes, source: one.ceiling.source });
  }

  /**
   * Ends the guarded engine that held the most at this reading when [param free], the machine's free
   * memory, is under its floor. One a reading, so what the last end freed is read before another
   * goes, and never one holding less than {@link MEMORY_PER_ENGINE}.
   */
  private endTheLargestIfShort(free: number): void {
    const floor = shortFloorBytes(this.memory);
    if (free >= floor) {
      return;
    }
    let largest: Guarded | undefined;
    for (const one of this.guards) {
      if (
        one.endedFor === null &&
        one.last !== undefined &&
        one.last.bytes >= MEMORY_PER_ENGINE &&
        one.last.bytes > (largest?.last?.bytes ?? 0)
      ) {
        largest = one;
      }
    }
    if (largest?.last === undefined) {
      return;
    }
    largest.endedFor = 'short';
    endBelow(largest.last.below);
    largest.ended({
      peakBytes: largest.last.bytes,
      ceilingBytes: largest.ceiling.bytes,
      source: largest.ceiling.source,
      short: { freeBytes: free, floorBytes: floor },
    });
  }
}

/** Ends the processes [param below] an engine, which its caller cannot reach. */
function endBelow(below: readonly number[]): void {
  for (const child of below) {
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
}

/** The watcher every engine this process starts is guarded by. */
export const engineMemory = new MemoryWatch();
