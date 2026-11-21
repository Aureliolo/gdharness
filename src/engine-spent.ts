/**
 * How long an engine has run, or gone quiet, counted by its own processor time while other work
 * crowds the machine.
 *
 * By the clock alone, a crowded machine ended engines that were starved rather than hung: a gate
 * fault had engines with 465 processor seconds between them in 910 s of clock time, ended at the
 * deadline while doing their usual work at a fraction of a core.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { askProcessTable } from './process-table.js';
import { runHidden as run } from './spawn.js';

/**
 * How many times its limit an engine is given by the clock however busy the machine: a stuck
 * engine uses no processor, so its own work alone would never end it while others keep the machine
 * busy. Load alone has stretched no engine's work past five times its quiet pace.
 */
export const STARVED = 8;

/** The share of the machine others keep busy from which an engine counts as crowded. */
const BUSY = 0.25;

/**
 * How often the machine and the engines whose memory is watched are read, and while it is busy every
 * engine. As often as an engine's watch looks, so an engine that lives a second is still read.
 */
const SAMPLE_MS = 500;

/** A wait the operating system is given to answer, past which the stretch counts by the clock. */
const ASK_TIMEOUT_MS = 3000;

/**
 * One reading: when, the machine's busy processor seconds over all cores, each engine's, and what
 * each engine watched for memory holds.
 */
export interface Sample {
  readonly at: number;
  readonly machine: number;
  /** Null when the machine was quiet enough that no engine's processor time needed reading. */
  readonly processors: ReadonlyMap<number, number> | null;
  readonly held?: ReadonlyMap<number, number>;
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

  /**
   * Starts counting again from [param at]. The stretch up to the next reading counts by the clock,
   * since the last reading's processor and machine seconds were taken before [param at] and would
   * credit the new count with work done in the old one.
   */
  restart(at: number): void {
    this.since = at;
    this.byClock = 0;
    this.byWork = 0;
    this.last = { at: Math.max(this.last.at, at), machine: Number.NaN, processor: undefined };
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

/**
 * How [param spent] came past its limit at [param at], said only when other work crowded the
 * machine, since the plain seconds are then not the clock's.
 */
export function countedBy(spent: Spent, past: Past, at: number): string {
  const clock = Math.round(spent.clock(at));
  if (past === 'clock') {
    return `, ${String(STARVED)} times over on the clock (${String(clock)} s), the machine kept busy by other work`;
  }
  return spent.byWork === 0
    ? ''
    : ` of its own, counted by its processor time while other work kept the machine busy (${String(clock)} s on the clock)`;
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
const withMemory = new Set<number>();
let latest: { readonly taken: number; readonly sample: Promise<Sample> } | null = null;
let quietAt: Sample | null = null;

/** Includes [param pid] in the samples until [param on] is false, and what it holds when [param memory]. */
export function watching(pid: number, on: boolean, memory = false): void {
  if (on) {
    watched.add(pid);
    if (memory && !withMemory.has(pid)) {
      withMemory.add(pid);
      // The newest sample was taken without it, and a short engine may end before the next.
      latest = null;
    }
  } else {
    watched.delete(pid);
    withMemory.delete(pid);
  }
}

/**
 * The newest sample, taken at most once a [param SAMPLE_MS] for every engine watched in this
 * process together, so a run of thirty engines reads the process table once rather than thirty
 * times. Their processor time is read only on a busy machine, their memory every time.
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
  const busy = share >= BUSY && watched.size > 0;
  const [processors, held] = await Promise.all([
    busy ? processorSecondsOf([...watched]) : null,
    withMemory.size === 0 ? null : heldBy([...withMemory]),
  ]);
  return { at, machine, processors, ...(held === null ? {} : { held }) };
}

/** What a process and everything below it hold, and the processes below it. */
export interface TreeHeld {
  readonly bytes: number;
  readonly below: readonly number[];
}

/**
 * The memory each of [param pids] holds with every process below it, without any the platform does
 * not answer for. Private bytes on Windows and resident bytes elsewhere: the memory a process holds
 * for itself, which a shared mapping or a file cache does not add to.
 */
export async function treesHeldBy(pids: readonly number[]): Promise<Map<number, TreeHeld>> {
  const held = new Map<number, TreeHeld>();
  try {
    if (process.platform === 'win32') {
      await readWindowsHeld(pids, held);
    } else {
      const table = process.platform === 'linux' ? await readProcTable() : await readPsTable();
      for (const pid of pids) {
        const tree = treeOf(table, pid);
        if (tree !== undefined) {
          held.set(pid, tree);
        }
      }
    }
  } catch {
    // Unread, so the engine's figure is left out.
  }
  return held;
}

/** The bytes each of [param pids] holds with everything below it: see {@link treesHeldBy}. */
export async function heldBy(pids: readonly number[]): Promise<Map<number, number>> {
  const trees = await treesHeldBy(pids);
  return new Map([...trees].map(([pid, tree]) => [pid, tree.bytes]));
}

async function readWindowsHeld(pids: readonly number[], held: Map<number, TreeHeld>): Promise<void> {
  const said = await askProcessTable(`HeldBy('${pids.join(',')}')`, ASK_TIMEOUT_MS);
  for (const line of said.split(/\r?\n/)) {
    const [pid, bytes, below] = line.trim().split(' ');
    const root = Number(pid);
    const total = Number(bytes);
    if (pid !== undefined && bytes !== undefined && Number.isFinite(root) && Number.isFinite(total)) {
      held.set(root, { bytes: total, below: (below ?? '').split(',').filter(Boolean).map(Number) });
    }
  }
}

/** One process of a table read for its memory: whose child it is and what it holds. */
type Held = ReadonlyMap<number, { readonly parent: number; readonly bytes: number }>;

/** [param pid] and everything below it in [param table], or undefined where it is not listed. */
function treeOf(table: Held, pid: number): TreeHeld | undefined {
  const root = table.get(pid);
  if (root === undefined) {
    return undefined;
  }
  const below: number[] = [];
  const seen = new Set<number>([pid]);
  let bytes = root.bytes;
  for (let next = [pid]; next.length > 0; ) {
    const parents = new Set(next);
    next = [];
    for (const [child, entry] of table) {
      if (parents.has(entry.parent) && !seen.has(child)) {
        seen.add(child);
        below.push(child);
        bytes += entry.bytes;
        next.push(child);
      }
    }
  }
  return { bytes, below };
}

async function readProcTable(): Promise<Held> {
  const page = await pageBytes();
  const table = new Map<number, { parent: number; bytes: number }>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      // The fields after the command, which is in brackets and may hold spaces of its own.
      const fields = (readFileSync(`/proc/${name}/stat`, 'utf8').split(')').pop() ?? '').trim().split(/\s+/);
      const parent = Number(fields[1]);
      const resident = Number(fields[21]);
      if (Number.isFinite(parent) && Number.isFinite(resident)) {
        table.set(Number(name), { parent, bytes: resident * page });
      }
    } catch {
      // Gone between the listing and the read.
    }
  }
  return table;
}

async function readPsTable(): Promise<Held> {
  const table = new Map<number, { parent: number; bytes: number }>();
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: ASK_TIMEOUT_MS });
  for (const line of stdout.split('\n')) {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
    if (
      pid !== undefined &&
      parent !== undefined &&
      rss !== undefined &&
      [pid, parent, rss].every(Number.isFinite)
    ) {
      table.set(pid, { parent, bytes: rss * 1024 });
    }
  }
  return table;
}

/**
 * The processor seconds each of [param pids] has used, within [param withinMs] of waiting on the
 * platform, without any it will not answer for.
 *
 * Best effort on purpose. Every way of asking is a different program on a different platform, any
 * of them can be missing, slow or refused, and the answer a caller builds does not depend on this
 * one: a missing number is left out rather than turned into a failure.
 */
export async function processorSecondsOf(
  pids: readonly number[],
  withinMs = ASK_TIMEOUT_MS,
): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  if (pids.length === 0) {
    return found;
  }
  try {
    if (process.platform === 'win32') {
      await readWindowsSeconds(pids, found, withinMs);
    } else if (process.platform === 'linux') {
      await readProcSeconds(pids, found);
    } else {
      await readPsSeconds(pids, found, withinMs);
    }
  } catch {
    // Unread, so the stretch counts by the clock.
  }
  return found;
}

async function readWindowsSeconds(
  pids: readonly number[],
  found: Map<number, number>,
  withinMs: number,
): Promise<void> {
  const said = await askProcessTable(`ProcessorSecondsOf('${pids.join(',')}')`, withinMs);
  for (const line of said.split(/\r?\n/)) {
    const [pid, seconds] = line.trim().split(' ').map(Number);
    if (pid !== undefined && seconds !== undefined && Number.isFinite(pid) && Number.isFinite(seconds)) {
      found.set(pid, seconds);
    }
  }
}

async function readProcSeconds(pids: readonly number[], found: Map<number, number>): Promise<void> {
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
}

/** What `ps` printed for [param some], also when it exited 1 because one of them had gone. */
function askedPs(some: readonly number[], withinMs: number): Promise<string> {
  return run('ps', ['-o', 'pid=,time=', '-p', some.join(',')], { timeout: withinMs }).then(
    (done) => done.stdout,
    (error: unknown) => {
      const printed = error instanceof Error && 'stdout' in error ? error.stdout : undefined;
      return typeof printed === 'string' ? printed : '';
    },
  );
}

async function readPsSeconds(
  pids: readonly number[],
  found: Map<number, number>,
  withinMs: number,
): Promise<void> {
  // ps exits 1 when any pid it was given has gone, and still prints the rest. One it cannot
  // take at all leaves it printing nothing, so each is then asked alone.
  let stdout = await askedPs(pids, withinMs);
  if (stdout.trim() === '' && pids.length > 1) {
    stdout = (await Promise.all(pids.map((pid) => askedPs([pid], withinMs)))).join('\n');
  }
  for (const line of stdout.split('\n')) {
    const [pid, time] = line.trim().split(/\s+/);
    const seconds = time === undefined ? undefined : secondsFromClock(time);
    if (pid !== undefined && seconds !== undefined) {
      found.set(Number(pid), seconds);
    }
  }
}

/**
 * `ps` prints processor time as `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS` depending on how long it has
 * been going, with fractions of a second on some systems, after a comma in some locales. Anything
 * else is no clock, so a bare dash or colon is not read as zero processor time.
 */
const CLOCK = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/;

export function secondsFromClock(printed: string): number | undefined {
  const parts = CLOCK.exec(printed.trim());
  if (parts === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = parts;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds?.replace(',', '.'))
  );
}

let ticks: Promise<number> | null = null;

/** The clock ticks a second /proc counts processor time in, asked once. */
function ticksASecond(): Promise<number> {
  ticks ??= run('getconf', ['CLK_TCK'], { timeout: ASK_TIMEOUT_MS })
    .then(({ stdout }) => Number(stdout.trim()) || 100)
    .catch(() => 100);
  return ticks;
}

let pages: Promise<number> | null = null;

/** The bytes in a page of /proc's resident count, asked once. */
function pageBytes(): Promise<number> {
  pages ??= run('getconf', ['PAGESIZE'], { timeout: ASK_TIMEOUT_MS })
    .then(({ stdout }) => Number(stdout.trim()) || 4096)
    .catch(() => 4096);
  return pages;
}
