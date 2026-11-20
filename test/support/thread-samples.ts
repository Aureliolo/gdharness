import { readFileSync } from 'node:fs';
import process from 'node:process';
import { describeStackSamples, sampleStacks } from './stack-samples.js';

/** A quarter second, so a stall of a second or more shows as several samples. */
const SAMPLE_MS = 250;
/** The last forty seconds, which reaches back past any one tool's wait to where it began. */
const KEPT = 160;

interface Sample {
  at: number;
  state: string;
  wchan: string;
  utime: number;
  stime: number;
  majflt: number;
}

/**
 * What a process's main thread was doing, sampled from /proc on Linux, for a case that fails on
 * an engine that stopped answering and was answering again before anything could ask it why.
 *
 * A thread computing has its user or system time growing. One blocked names the kernel function it
 * waits in (do_wait is a wait for a child, futex_wait a lock). Major faults climbing are its memory
 * paged back in. A gap between two samples wider than the interval is this process not getting
 * the processor either.
 *
 * On Windows it samples the thread's call stack instead (stack-samples.ts), and the account ends
 * with every thread's stack as it stands when the account is asked for, which for a stall still
 * going on is the stall itself. Elsewhere it samples nothing and accounts for nothing.
 */
export function sampleThread(pid: number | undefined): {
  account: () => Promise<string>;
  stop: () => void;
} {
  const samples: Sample[] = [];
  if (process.platform === 'win32' && pid !== undefined) {
    return sampleWindowsThread(pid);
  }
  if (process.platform !== 'linux' || pid === undefined) {
    return { account: async () => await Promise.resolve(''), stop: () => undefined };
  }
  const started = Date.now();
  const timer = setInterval(() => {
    const sample = read(pid, Date.now() - started);
    if (sample === null) {
      return;
    }
    samples.push(sample);
    if (samples.length > KEPT) {
      samples.shift();
    }
  }, SAMPLE_MS);
  timer.unref();
  return {
    account: async () => await Promise.resolve(describe(samples)),
    stop: () => {
      clearInterval(timer);
    },
  };
}

/** How a Windows account that has no stacks begins, so a fixture can tell a sampler that never ran. */
export const NO_STACKS = 'no stacks:';

/** How many frames of each sample the account shows, which reaches from a wait up past the save. */
const STACK_DEPTH = 40;
/** How long the account waits for the sampler to walk every thread. */
const ALL_THREADS_MS = 10_000;

function sampleWindowsThread(pid: number): { account: () => Promise<string>; stop: () => void } {
  const stacks = sampleStacks(pid, SAMPLE_MS);
  return {
    account: async () => {
      const why = stacks.why();
      if (why !== null) {
        return `${NO_STACKS} ${why}`;
      }
      const since = Date.now() - KEPT * SAMPLE_MS;
      const kept = stacks.samples().filter((sample) => sample.at >= since);
      if (kept.length === 0) {
        return `${NO_STACKS} the sampler took none in the last ${String((KEPT * SAMPLE_MS) / 1000)}s`;
      }
      const threads = await stacks.allThreads(ALL_THREADS_MS);
      const every = threads
        .split(/\r?\n/)
        .filter((line) => line !== '')
        .map((line) => {
          const [id, user, kernel, ...frames] = line.split('|');
          const used = (Number(user) + Number(kernel)) / 10_000;
          return `thread ${id ?? ''}, cpu ${used.toFixed(0)}ms: ${frames.slice(0, STACK_DEPTH).join(' < ')}`;
        });
      return [
        describeStackSamples(kept, STACK_DEPTH, since),
        '',
        every.length === 0 ? 'Every thread: the sampler did not answer.' : 'Every thread now:',
        ...every,
      ].join('\n');
    },
    stop: stacks.stop,
  };
}

function read(pid: number, at: number): Sample | null {
  try {
    const stat = readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
    // The command name is in brackets and may hold spaces, so the fields are counted after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      at,
      state: fields[0] ?? '?',
      wchan: readFileSync(`/proc/${pid}/task/${pid}/wchan`, 'utf8').trim() || '0',
      majflt: Number(fields[9]),
      utime: Number(fields[11]),
      stime: Number(fields[12]),
    };
  } catch {
    return null;
  }
}

/** How [param sample] differs from [param before], and whether the thread did nothing new between them. */
function changeSince(
  before: Sample | undefined,
  sample: Sample,
): { user: number; system: number; faults: number; gap: number; same: boolean } {
  const user = before === undefined ? 0 : sample.utime - before.utime;
  const system = before === undefined ? 0 : sample.stime - before.stime;
  const faults = before === undefined ? 0 : sample.majflt - before.majflt;
  const gap = before === undefined ? SAMPLE_MS : sample.at - before.at;
  const same =
    before !== undefined &&
    before.state === sample.state &&
    before.wchan === sample.wchan &&
    user === 0 &&
    system === 0 &&
    faults === 0 &&
    gap < SAMPLE_MS * 2;
  return { user, system, faults, gap, same };
}

/**
 * One line per change, in clock ticks since the sample before: a run of samples in which the
 * thread sat in the same state, in the same call, using nothing, is folded into its first.
 */
function describe(samples: Sample[]): string {
  const lines: string[] = [];
  let quiet = 0;
  for (const [index, sample] of samples.entries()) {
    const change = changeSince(samples[index - 1], sample);
    if (change.same) {
      quiet += 1;
      continue;
    }
    if (quiet > 0) {
      lines.push(`  (the same for ${quiet} more)`);
      quiet = 0;
    }
    const { user, system, faults, gap } = change;
    lines.push(
      `+${sample.at}ms ${sample.state} in ${sample.wchan}, user +${user} system +${system} ticks, ` +
        `major faults +${faults}${gap >= SAMPLE_MS * 2 ? `, ${gap}ms after the sample before` : ''}`,
    );
  }
  if (quiet > 0) {
    lines.push(`  (the same for ${quiet} more)`);
  }
  return lines.join('\n');
}
