import { type Profiler, Session } from 'node:inspector';
import { performance } from 'node:perf_hooks';

type CpuProfile = Profiler.Profile;
type ProfileNode = Profiler.ProfileNode;

/** How the loop was kept, and what the process was doing in its widest gap. */
export interface LoopWatch {
  /** The widest interval between two ticks, in milliseconds. */
  readonly widest: number;
  /** The top frames by self time inside the widest gap, one line each, or a note that none was sampled. */
  readonly accounted: string;
}

const TICK_MS = 20;
const SAMPLE_US = 1000;
const FRAMES_NAMED = 6;
const CALLERS_NAMED = 4;

function post(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((settle, fail) => {
    session.post(method, params, (error: Error | null, result?: object) => {
      if (error === null) {
        settle(result);
      } else {
        fail(error);
      }
    });
  });
}

function stopped(session: Session): Promise<CpuProfile> {
  return new Promise((settle, fail) => {
    session.post('Profiler.stop', (error, result) => {
      if (error === null) {
        settle(result.profile);
      } else {
        fail(error);
      }
    });
  });
}

/**
 * The self time per function over the samples of [param profile] that fall between [param from] and
 * [param to], in milliseconds since the profile began, heaviest first.
 */
function selfTimeBetween(profile: CpuProfile, from: number, to: number): string {
  const byNode = new Map<number, ProfileNode>(profile.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parentOf.set(child, node.id);
    }
  }
  // A native call has no script of its own, so its callers say where it was made from.
  const named = (id: number): string => {
    const chain: string[] = [];
    for (
      let at: number | undefined = id;
      at !== undefined && chain.length < CALLERS_NAMED;
      at = parentOf.get(at)
    ) {
      const frame = byNode.get(at)?.callFrame;
      const fn =
        frame?.functionName === undefined || frame.functionName === '' ? '(anonymous)' : frame.functionName;
      chain.push(`${fn} ${frame?.url.split(/[\\/]/).pop() ?? '?'}:${String((frame?.lineNumber ?? 0) + 1)}`);
    }
    return chain.join(' < ');
  };
  const spent = new Map<string, number>();
  let at = 0;
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const delta = (profile.timeDeltas?.[index] ?? 0) / 1000;
    const start = at;
    at += delta;
    const inside = Math.min(at, to) - Math.max(start, from);
    if (inside > 0) {
      const name = named(id);
      spent.set(name, (spent.get(name) ?? 0) + inside);
    }
  }
  const top = [...spent].toSorted((a, b) => b[1] - a[1]).slice(0, FRAMES_NAMED);
  return top.length === 0
    ? 'no sample fell in the gap'
    : top.map(([name, ms]) => `${ms.toFixed(0)} ms ${name}`).join('; ');
}

/**
 * Ticks an interval while a CPU profile runs, for a case that asserts its process stays free to run.
 * The tick measures the whole process, so a failure has to say which code held the loop: [method
 * stop] answers the widest gap with the frames that spent its time, whoever's they were.
 */
export async function watchTheLoop(): Promise<{ stop: () => Promise<LoopWatch> }> {
  const session = new Session();
  session.connect();
  await post(session, 'Profiler.enable');
  await post(session, 'Profiler.setSamplingInterval', { interval: SAMPLE_US });
  await post(session, 'Profiler.start');
  const began = performance.now();
  let last = began;
  let widest = 0;
  let from = 0;
  let to = 0;
  const ticking = setInterval(() => {
    const now = performance.now();
    if (now - last > widest) {
      widest = now - last;
      from = last - began;
      to = now - began;
    }
    last = now;
  }, TICK_MS);
  return {
    stop: async () => {
      clearInterval(ticking);
      // A loop held until now has ticked no more since its last tick, which is a gap too.
      const now = performance.now();
      if (now - last > widest) {
        widest = now - last;
        from = last - began;
        to = now - began;
      }
      let accounted = 'no profile was taken';
      try {
        const profile = await stopped(session);
        accounted = selfTimeBetween(profile, from, to);
        await post(session, 'Profiler.disable');
      } finally {
        session.disconnect();
      }
      return { widest, accounted };
    },
  };
}
