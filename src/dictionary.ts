/**
 * Dictionaries that are safe to index with a name somebody else chose.
 *
 * An object literal carries `Object.prototype` behind it, so a lookup for `constructor`,
 * `toString`, `valueOf` or `hasOwnProperty` answers with an inherited function rather than
 * `undefined`, and a write to `__proto__` re-parents the object instead of storing a key. Every
 * dictionary here is keyed by text off the wire or out of a file, which makes both of those
 * reachable: a `??` accepts the inherited function because it is not nullish, an existence check
 * passes because it is truthy, and the value then travels on as if it had been supplied.
 *
 * Nothing behind the object means nothing for a name to reach, which is why this is a property of
 * the container rather than a guard at each of the forty-odd places one is indexed.
 */

/** An empty dictionary with no prototype. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * The same, filled from a literal. Written this way so a table keeps reading as a table and the
 * annotation on it still checks, which a hand-built `Object.create(null, descriptors)` does not.
 */
export function dictionary<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(emptyRecord<T>(), entries);
}
