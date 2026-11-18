import type { EngineSlots } from './engine-slots.js';

type Slots = Pick<EngineSlots, 'take' | 'release'>;

interface Ask {
  readonly abort: AbortController;
  readonly promise: Promise<string>;
  /** Settles once the command has granted the slot, said it queued the request, or failed. */
  readonly decided: Promise<void>;
  lock: string | null;
  failure: { readonly error: unknown } | null;
}

/** The slots a run asked of its slot command up front: those granted, and the rest still queued. */
export interface AskedLanes {
  /** The locks granted when the run started, which the lanes start on. */
  readonly taken: string[];
  /**
   * Hands the lanes the asks still open, one to each lane that takes a slot, and takes from
   * the machine's own slots once they are used up.
   */
  readonly slots: Slots;
  /** Withdraws the asks no lane took: one granted after the run's work is done is given back unused. */
  end(): void;
}

function asked(slots: Slots, failed: () => void): Ask {
  const abort = new AbortController();
  let decide: () => void = () => undefined;
  const decided = new Promise<void>((resolve) => {
    decide = resolve;
  });
  const ask: Ask = {
    abort,
    decided,
    lock: null,
    failure: null,
    promise: slots.take(abort.signal, undefined, undefined, false, undefined, decide),
  };
  ask.promise.then(
    (lock) => {
      ask.lock = lock;
      decide();
    },
    (error: unknown) => {
      ask.failure = { error };
      decide();
      failed();
    },
  );
  return ask;
}

/**
 * Asks the slot command for [param count] slots at once, one for each engine a run may start, and
 * answers once every ask is granted or queued. A command has no answer for a slot free now, so a
 * grant with no `queued` before it stands for a free slot however late it comes, and a queued ask
 * for a busy one, which the run does not wait for: it goes to whichever lane asks for it later,
 * or withdrawn by {@link AskedLanes.end}. A refusal or failure fails the asking, and the others are
 * given back.
 */
export async function askedLanes(slots: Slots, count: number): Promise<AskedLanes> {
  let failedFirst: () => void = () => undefined;
  const aFailure = new Promise<void>((resolve) => {
    failedFirst = resolve;
  });
  const asks = Array.from({ length: count }, () => asked(slots, failedFirst));
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
  await Promise.race([Promise.all(asks.map((ask) => ask.decided)), aFailure]);
  const failure = asks.find((ask) => ask.failure !== null)?.failure ?? null;
  if (failure !== null) {
    for (const ask of asks) {
      giveBack(ask);
    }
    throw failure.error;
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
        // A lane that asks once every share is out is refused at once, as a take on a busy slots folder is.
        signal?.throwIfAborted();
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
