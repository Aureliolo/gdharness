import { readFileSync } from 'node:fs';
import process from 'node:process';

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
 * A thread computing has its user or system time growing; one blocked names the kernel function it
 * waits in (do_wait is a wait for a child, futex_wait a lock); major faults climbing are its memory
 * paged back in; and a gap between two samples wider than the interval is this process not getting
 * the processor either. Elsewhere it samples nothing and accounts for nothing.
 */
export function sampleThread(pid: number | undefined): { account: () => string; stop: () => void } {
  const samples: Sample[] = [];
  if (process.platform !== 'linux' || pid === undefined) {
    return { account: () => '', stop: () => undefined };
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
    account: () => describe(samples),
    stop: () => {
      clearInterval(timer);
    },
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

/**
 * One line per change, in clock ticks since the sample before: a run of samples in which the
 * thread sat in the same state, in the same call, using nothing, is folded into its first.
 */
function describe(samples: Sample[]): string {
  const lines: string[] = [];
  let quiet = 0;
  for (const [index, sample] of samples.entries()) {
    const before = samples[index - 1];
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
    if (same) {
      quiet += 1;
      continue;
    }
    if (quiet > 0) {
      lines.push(`  (the same for ${quiet} more)`);
      quiet = 0;
    }
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
