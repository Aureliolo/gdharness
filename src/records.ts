/**
 * A plain object whose keys have not been read yet: what `JSON.parse`, a note on disk or a message
 * off the wire gives before anything has checked it. Arrays are excluded, because every reader of
 * one of these looks values up by name, and an array reaching such a reader is a malformed value
 * rather than a record with no keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An array whose every element is a string, which an empty array is. */
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
