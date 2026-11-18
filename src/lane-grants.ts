import type { EngineSlots } from './engine-slots.js';

type Slots = Pick<EngineSlots, 'take' | 'release'>;

/**
 * How long a run waits at its start for the commands it asked to answer, past which it starts on the
 * slots it holds. The asks still open join the run as they are granted.
 */
const LANE_ASK_GRACE_MS = 2000;

interface Ask {
  readonly abort: AbortController;
  readonly promise: Promise<string>;
  /** Settles once the command has granted the slot, said it queued the request, or failed. */
  readonly decided: Promise<void>;
  lock: string | null;
  failure: { readonly error: unknown } | null;
}

/** The slots a run asked of its slot command up front: those granted, and the rest still open. */
export interface AskedLanes {
  /** The locks granted when the run started, which the lanes start on. */
  readonly taken: string[];
  /**
   * Hands the lanes the asks still open, one to each lane that takes a slot, and takes from
   * the machine's own slots once they are used up. A lane whose ask the command refused waits
   * for the end of the hand-out without a slot, as one waiting on a busy slot does, unless no ask
   * of the run was granted or can still be.
   */
  readonly slots: Slots;
  /** Withdraws the asks no lane took: one granted after the run's work is done is given back unused. */
  end(): void;
}

function asked(slots: Slots): Ask {
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
    },
  );
  return ask;
}

/**
 * Asks the slot command for [param count] slots at once, one for each engine a run may start. It
 * answers once every ask is granted, queued or refused, or after a moment, whichever comes first,
 * so that a run starts on the slots it holds. A command has no answer for a slot free now, so a
 * grant with no `queued` before it stands for a free slot however late it comes: it goes to a lane
 * that asks for it later, and is withdrawn by {@link AskedLanes.end} if none does. Fails with the
 * refusal only when every ask was refused.
 */
export async function askedLanes(
  slots: Slots,
  count: number,
  graceMs: number = LANE_ASK_GRACE_MS,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(asks.map((ask) => ask.decided)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const refused = asks.filter((ask) => ask.failure !== null);
  const first = refused[0]?.failure;
  if (refused.length === asks.length && first !== undefined && first !== null) {
    throw first.error;
  }
  const taken = asks.flatMap((ask) => (ask.lock === null ? [] : [ask.lock]));
  for (const ask of asks) {
    if (ask.lock !== null) {
      open.delete(ask);
    }
  }
  const late = [...open];
  // Whether any ask of the run was granted or may still be, which a refused lane's run goes on for.
  const hoping = (): boolean =>
    asks.some((ask) => ask.lock !== null || (ask.failure === null && !ask.abort.signal.aborted));
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
        } catch (error) {
          if (signal === undefined || signal.aborted || !hoping()) {
            throw error;
          }
          // A refused lane is a lane the run does not get: it waits for the end of the hand-out.
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve();
            });
          });
          signal.throwIfAborted();
          throw error;
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
