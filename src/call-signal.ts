/**
 * The abort signal of the tool call being answered, and its way of saying it is still going, for
 * the code that starts an engine on its behalf.
 *
 * A client that stops waiting for a call sends a cancellation, and the SDK turns it into this
 * signal. Nothing read it, so an engine a call had started for itself ran on to its own timeout
 * after nobody was left to read its answer: a test tier cancelled from the client kept its engine
 * for the remaining ten minutes. Held here rather than passed down, because the places that start
 * an engine are several calls below the handler and none of the calls between them has any other
 * use for it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Tells the client how far a call has got, as a message, with a number that only goes up. */
export type CallProgress = (progress: number, message: string) => void;

/**
 * How long a call has waited for engine slots in all, and what its answer says of that wait, from
 * who held the slots when it first waited: what it was told while waiting went only to a client
 * that asked for progress.
 */
export interface SlotWaits {
  ms: number;
  said: ((waitedMs: number) => string) | undefined;
}

interface Call {
  readonly signal: AbortSignal | undefined;
  readonly progress: CallProgress | undefined;
  readonly slotWaits: SlotWaits | undefined;
}

const current = new AsyncLocalStorage<Call>();

/**
 * How long a call whose client asked for progress goes without a notification before it is sent
 * one saying it is still going. Claude Code ends a call that says nothing for thirty minutes, and
 * the SDK's own default is a minute.
 */
export const CALL_HEARTBEAT_MS = 20_000;

/** The message a call of [param tool] and [param op] is sent [param elapsedMs] in. */
export function stillGoingSaid(tool: string, op: string | null, elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${op === null || op === '' ? tool : `${tool} ${op}`} is still going; ${took} in.`;
}

/** What a call says, and how often, when it has said nothing else for that long. */
export interface StillGoing {
  readonly everyMs: number;
  readonly said: (elapsedMs: number) => string;
}

/**
 * Runs [param answer] with [param signal] as the call's own, and [param progress] as the way it
 * reports, which is there only when the client asked for progress with a token. Such a call is
 * also sent [param still] whenever it has said nothing for its interval: only the calls that
 * reported for themselves were heard during a long wait, so a game watched for forty-five minutes
 * was cut off at thirty while it was still running. Every wait for an engine slot during the call
 * is added to [param slotWaits].
 */
export async function withCallSignal<T>(
  signal: AbortSignal | undefined,
  answer: () => Promise<T>,
  progress?: CallProgress,
  still?: StillGoing,
  slotWaits?: SlotWaits,
): Promise<T> {
  if (progress === undefined) {
    return signal === undefined && slotWaits === undefined
      ? await answer()
      : await current.run({ signal, progress: undefined, slotWaits }, answer);
  }
  const began = Date.now();
  const rising = risingOnly(progress);
  let going = still;
  let quiet: NodeJS.Timeout | undefined;
  const rearm = (): void => {
    clearTimeout(quiet);
    if (going === undefined) {
      return;
    }
    const { everyMs, said } = going;
    quiet = setTimeout(() => {
      const elapsed = Date.now() - began;
      told(Math.floor(elapsed / 1000), said(elapsed));
    }, everyMs);
    quiet.unref();
  };
  const told: CallProgress = (number, message) => {
    rising(number, message);
    rearm();
  };
  rearm();
  try {
    return await current.run({ signal, progress: told, slotWaits }, answer);
  } finally {
    // A ticker of the call's own can still fire once after it has answered.
    going = undefined;
    clearTimeout(quiet);
  }
}

/**
 * [param progress] with every number above the one before it, as the protocol requires of one
 * call's notifications. A call can report from two places, such as the wait for an engine slot
 * and then the run it waited for, and each counts from its own start.
 */
function risingOnly(progress: CallProgress): CallProgress {
  let last = Number.NEGATIVE_INFINITY;
  return (number, message) => {
    last = number > last ? number : last + 1;
    progress(last, message);
  };
}

/** The signal of the call being answered, or undefined outside one. */
export function callSignal(): AbortSignal | undefined {
  return current.getStore()?.signal;
}

/** How the call being answered reports progress, or undefined when its client asked for none. */
export function callProgress(): CallProgress | undefined {
  return current.getStore()?.progress;
}

/** Where the call being answered adds up its waits for engine slots, or undefined. */
export function callSlotWaits(): SlotWaits | undefined {
  return current.getStore()?.slotWaits;
}
