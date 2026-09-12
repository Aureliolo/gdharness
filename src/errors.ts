/**
 * Narrowing for `unknown` caught values.
 *
 * A `catch` binding is `unknown` because a throw can carry anything, and every site that
 * wants a sentence or an Error out of one needs the same few lines. They live here so the
 * answer is the same everywhere rather than whatever each call site remembered to write.
 */

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
