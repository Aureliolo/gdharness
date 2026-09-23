/**
 * The abort signal of the tool call being answered, for the code that starts an engine on its
 * behalf.
 *
 * A client that stops waiting for a call sends a cancellation, and the SDK turns it into this
 * signal. Nothing read it, so an engine a call had started for itself ran on to its own timeout
 * after nobody was left to read its answer: a test tier cancelled from the client kept its engine
 * for the remaining ten minutes. Held here rather than passed down, because the places that start
 * an engine are several calls below the handler and none of the calls between them has any other
 * use for it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<AbortSignal>();

/** Runs [param answer] with [param signal] as the call's own. */
export function withCallSignal<T>(signal: AbortSignal | undefined, answer: () => Promise<T>): Promise<T> {
  return signal === undefined ? answer() : current.run(signal, answer);
}

/** The signal of the call being answered, or undefined outside one. */
export function callSignal(): AbortSignal | undefined {
  return current.getStore();
}
