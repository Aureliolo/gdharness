/**
 * Narrowing for `unknown` caught values.
 *
 * A `catch` binding is `unknown` because a throw can carry anything, and every site that
 * wants a sentence or an Error out of one needs the same few lines. They live here so the
 * answer is the same everywhere rather than whatever each call site remembered to write.
 */

/**
 * A failure that was anticipated, thrown where returning it is not an option.
 *
 * The line it draws is what tells the other kind apart: a port variable holding "banana", a
 * script path outside the project, an editor that is not connected are all the caller's or their
 * machine's to fix, and they say so in their own words. Anything else reaching a boundary as a
 * throw is a state this program does not model, which is a defect, and answering one as though
 * it were the other sends somebody to fix their own typo or buries a bug in advice.
 *
 * Most refusals are returned rather than thrown. This is for the places that cannot: a
 * constructor's default argument, a validator several frames below the tool that called it.
 */
export class Refusal extends Error {}

/**
 * The sentence to show a caller. `fallback` is what a throw with no usable message reads as.
 * Objects and symbols are deliberately not stringified: "[object Object]" tells a reader
 * nothing, and `String(symbol)` throws. `toError` keeps the thrown value on `cause` instead.
 */
export function errorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === 'string') {
    return error || fallback;
  }
  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  return fallback;
}

/**
 * The caught value as an Error, so a rejection or a rethrow always carries a `.message` and
 * a `.stack`. Anything already an Error passes through untouched, keeping its own stack.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
}
