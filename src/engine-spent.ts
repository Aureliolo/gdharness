/**
 * How long an engine has run, or gone quiet, counted by its own processor time while other work
 * crowds the machine.
 *
 * By the clock alone, a crowded machine ended engines that were starved rather than hung: a gate
 * fault had engines with 465 processor seconds between them in 910 s of clock time, ended at the
 * deadline while doing their usual work at a fraction of a core.
 */

import { readFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { askProcessTable } from './process-table.js';
import { secondsFromClock } from './process-time.js';
import { runHidden as run } from './spawn.js';

/**
 * How many times its limit an engine is given by the clock however busy the machine: a stuck
 * engine uses no processor, so its own work alone would never end it while others keep the machine
 * busy. Load alone has stretched no engine's work past five times its quiet pace.
 */
export const STARVED = 8;

/** The share of the machine others keep busy from which an engine counts as crowded. */
const BUSY = 0.25;

/** How often the machine, and while it is busy the engines, are read. */
const SAMPLE_MS = 1000;

/** A wait the operating system is given to answer, past which the stretch counts by the clock. */
const ASK_TIMEOUT_MS = 3000;

/** One reading: when, the machine's busy processor seconds over all cores, and each engine's. */
export interface Sample {
  readonly at: number;
  readonly machine: number;
  /** Null when the machine was quiet enough that no engine needed reading. */
  readonly processors: ReadonlyMap<number, number> | null;
}

/**
 * Whether others kept the machine busy through a [param stretch] of seconds in which the engine
 * used [param work] and the whole machine [param busy], over [param cores].
 */
export function crowded(stretch: number, work: number, busy: number, cores: number): boolean {
  return stretch > 0 && Math.max(0, busy - work) / (stretch * cores) >= BUSY;
}

/** Why an engine is past its limit: its own time, or the clock's bound for one that is stuck. */
export type Past = 'own' | 'clock';

/** An engine's time from [param since], by the clock where the machine was free and by its work where it was crowded. */
export class Spent {
  byClock = 0;
  byWork = 0;
  private since: number;
  private readonly cores: number;
  private last: { at: number; machine: number; processor: number | undefined };

  constructor(since: number, first: Sample | null, pid: number | undefined, cores = availableParallelism()) {
    this.since = since;
    this.cores = cores;
    this.last = {
      at: since,
      machine: first?.machine ?? Number.NaN,
      processor: pid === undefined ? undefined : first?.processors?.get(pid),
    };
  }

  /** Counts the stretch since the last reading up to [param sample], for the engine [param pid]. */
  counted(sample: Sample, pid: number | undefined): void {
    if (sample.at <= this.last.at) {
      return;
    }
    const stretch = sample.at - this.last.at;
    const processor = pid === undefined ? undefined : sample.processors?.get(pid);
    const work =
      processor === undefined || this.last.processor === undefined
        ? undefined
        : Math.max(0, processor - this.last.processor);
    if (work !== undefined && crowded(stretch, work, sample.machine - this.last.machine, this.cores)) {
      this.byWork += Math.min(work, stretch);
    } else {
      this.byClock += stretch;
    }
    this.last = { at: sample.at, machine: sample.machine, processor };
  }

  /** Starts counting again from [param at], keeping the last reading as the start of the next stretch. */
  restart(at: number): void {
    this.since = at;
    this.byClock = 0;
    this.byWork = 0;
    this.last = { ...this.last, at: Math.max(this.last.at, at) };
  }

  /** Clock seconds from the start of the count to [param now]. */
  clock(now: number): number {
    return now - this.since;
  }

  /** Whether the engine is past [param limit] seconds of its own, or past the clock's bound, at [param now]. */
  past(limit: number, now: number): Past | null {
    if (this.clock(now) > limit * STARVED) {
      return 'clock';
    }
    return this.byClock + this.byWork > limit ? 'own' : null;
  }
}

/** Seconds on a clock that only goes forwards, the one samples are taken on. */
export function nowSeconds(): number {
  return performance.now() / 1000;
}

/** The busy processor seconds of every core together since the machine started. */
function machineSeconds(): number {
  return (
    cpus().reduce(
      (sum, core) => sum + core.times.user + core.times.nice + core.times.sys + core.times.irq,
      0,
    ) / 1000
  );
}

const watched = new Set<number>();
let latest: { readonly taken: number; readonly sample: Promise<Sample> } | null = null;
let quietAt: Sample | null = null;

/** Includes [param pid] in the samples until [param watching] is false. */
export function watching(pid: number, on: boolean): void {
  if (on) {
    watched.add(pid);
  } else {
    watched.delete(pid);
  }
}

/**
 * The newest sample, taken at most once a [param SAMPLE_MS] for every engine watched in this
 * process together, so a run of thirty engines reads the process table once rather than thirty
 * times. The engines are read only while the machine is busy enough that one could be crowded.
 */
export function sampled(): Promise<Sample> {
  const now = Date.now();
  if (latest === null || now - latest.taken >= SAMPLE_MS) {
    latest = { taken: now, sample: take() };
  }
  return latest.sample;
}

async function take(): Promise<Sample> {
  const at = nowSeconds();
  const machine = machineSeconds();
  const previous = quietAt;
  quietAt = { at, machine, processors: null };
  const share =
    previous === null || at <= previous.at
      ? 1
      : (machine - previous.machine) / ((at - previous.at) * availableParallelism());
  if (share < BUSY || watched.size === 0) {
    return quietAt;
  }
  return { at, machine, processors: await processorSecondsOf([...watched]) };
}

/** The processor seconds each of [param pids] has used, leaving out any the platform does not answer for. */
export async function processorSecondsOf(pids: readonly number[]): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  try {
    if (process.platform === 'win32') {
      const said = await askProcessTable(`ProcessorSecondsOf('${pids.join(',')}')`, ASK_TIMEOUT_MS);
      for (const line of said.split(/\r?\n/)) {
        const [pid, seconds] = line.trim().split(' ').map(Number);
        if (pid !== undefined && seconds !== undefined && Number.isFinite(pid) && Number.isFinite(seconds)) {
          found.set(pid, seconds);
        }
      }
    } else if (process.platform === 'linux') {
      const ticks = await ticksASecond();
      for (const pid of pids) {
        try {
          // The fields after the command, which is in brackets and may hold spaces of its own.
          const fields = (
            readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
              .split(')')
              .pop() ?? ''
          )
            .trim()
            .split(/\s+/);
          const used = Number(fields[11]) + Number(fields[12]);
          if (Number.isFinite(used)) {
            found.set(pid, used / ticks);
          }
        } catch {
          // Gone between the listing and the read.
        }
      }
    } else {
      // ps exits 1 when any pid it was given has gone, and still prints the rest; one it cannot
      // take at all leaves it printing nothing, so each is then asked alone.
      const asked = (some: readonly number[]): Promise<string> =>
        run('ps', ['-o', 'pid=,time=', '-p', some.join(',')], { timeout: ASK_TIMEOUT_MS }).then(
          (done) => done.stdout,
          (error: unknown) => {
            const printed = (error as { stdout?: unknown }).stdout;
            return typeof printed === 'string' ? printed : '';
          },
        );
      let stdout = await asked(pids);
      if (stdout.trim() === '' && pids.length > 1) {
        stdout = (await Promise.all(pids.map((pid) => asked([pid])))).join('\n');
      }
      for (const line of stdout.split('\n')) {
        const [pid, time] = line.trim().split(/\s+/);
        const seconds = time === undefined ? undefined : secondsFromClock(time);
        if (pid !== undefined && seconds !== undefined) {
          found.set(Number(pid), seconds);
        }
      }
    }
  } catch {
    // Unread, so the stretch counts by the clock.
  }
  return found;
}

let ticks: Promise<number> | null = null;

/** The clock ticks a second /proc counts processor time in, asked once. */
function ticksASecond(): Promise<number> {
  ticks ??= run('getconf', ['CLK_TCK'], { timeout: ASK_TIMEOUT_MS })
    .then(({ stdout }) => Number(stdout.trim()) || 100)
    .catch(() => 100);
  return ticks;
}
