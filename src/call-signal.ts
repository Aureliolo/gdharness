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

interface Call {
  readonly signal: AbortSignal | undefined;
  readonly progress: CallProgress | undefined;
}

const current = new AsyncLocalStorage<Call>();

/**
 * Runs [param answer] with [param signal] as the call's own, and [param progress] as the way it
 * reports, which is there only when the client asked for progress with a token.
 */
export function withCallSignal<T>(
  signal: AbortSignal | undefined,
  answer: () => Promise<T>,
  progress?: CallProgress,
): Promise<T> {
  return signal === undefined && progress === undefined
    ? answer()
    : current.run({ signal, progress }, answer);
}

/** The signal of the call being answered, or undefined outside one. */
export function callSignal(): AbortSignal | undefined {
  return current.getStore()?.signal;
}

/** How the call being answered reports progress, or undefined when its client asked for none. */
export function callProgress(): CallProgress | undefined {
  return current.getStore()?.progress;
}
