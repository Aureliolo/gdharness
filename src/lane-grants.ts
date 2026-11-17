import { setTimeout as sleep } from 'node:timers/promises';

import type { EngineSlots } from './engine-slots.js';

/**
 * How long after the first grant the others of a run are waited for. A scheduler with room answers
 * every ask at once, so a grant later than this is a slot some other work holds, which the run does
 * not wait for before it starts.
 */
const LANE_GRANT_GRACE_MS = 1000;

type Slots = Pick<EngineSlots, 'take' | 'release'>;

interface Ask {
  readonly abort: AbortController;
  readonly promise: Promise<string>;
  lock: string | null;
}

/** The slots a run asked of its slot command up front: those granted at once, and the rest still asked. */
export interface AskedLanes {
  /** The locks granted within the grace, which the lanes start on. */
  readonly taken: string[];
  /**
   * Hands the lanes the asks still open, one to each lane that takes a slot, and takes from
   * the machine's own slots once they are used up.
   */
  readonly slots: Slots;
  /** Ends the asks no lane took: one granted after the run's work is done is given back unused. */
  end(): void;
}

function asked(slots: Slots): Ask {
  const abort = new AbortController();
  const promise = slots.take(abort.signal);
  const ask: Ask = { abort, promise, lock: null };
  promise.then(
    (lock) => {
      ask.lock = lock;
    },
    () => undefined,
  );
  return ask;
}

/** Waits for every ask, or for [param ms], and never throws for an ask that failed. */
async function allOrWithin(asks: readonly Ask[], ms: number): Promise<void> {
  const stop = new AbortController();
  try {
    await Promise.race([
      Promise.allSettled(asks.map((ask) => ask.promise)),
      sleep(ms, undefined, { signal: stop.signal }),
    ]);
  } finally {
    stop.abort();
  }
}

/**
 * Asks the slot command for [param count] slots at once, one for each engine a run may start, and
 * answers once the first is granted and the others have had {@link LANE_GRANT_GRACE_MS} to follow.
 * A command has no answer for a slot free now, so a grant that comes at once stands for one.
 * A refusal or a failure of the first fails the asking, and the others are given back.
 */
export async function askedLanes(
  slots: Slots,
  count: number,
  graceMs: number = LANE_GRANT_GRACE_MS,
): Promise<AskedLanes> {
  const asks = Array.from({ length: count }, () => asked(slots));
  const open = new Set(asks);
  const giveBack = (ask: Ask): void => {
    ask.abort.abort();
    ask.promise.then(
      (lock) => {
        slots.release(lock);
      },
      () => undefined,
    );
  };
  try {
    await Promise.race(asks.map((ask) => ask.promise));
    await allOrWithin(asks, graceMs);
  } catch (error) {
    for (const ask of asks) {
      giveBack(ask);
    }
    throw error;
  }
  const taken = asks.flatMap((ask) => (ask.lock === null ? [] : [ask.lock]));
  for (const ask of asks) {
    if (ask.lock !== null) {
      open.delete(ask);
    }
  }
  const late = [...open];
  return {
    taken,
    slots: {
      release: (lock) => {
        slots.release(lock);
      },
      take: async (signal) => {
        const ask = late.shift();
        if (ask === undefined) {
          return await slots.take(signal);
        }
        open.delete(ask);
        const stop = (): void => {
          ask.abort.abort();
        };
        signal?.addEventListener('abort', stop, { once: true });
        try {
          return await ask.promise;
        } finally {
          signal?.removeEventListener('abort', stop);
        }
      },
    },
    end: () => {
      for (const ask of open) {
        giveBack(ask);
      }
      open.clear();
    },
  };
}
