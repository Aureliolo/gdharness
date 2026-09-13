import type { OperationParams } from './server-types.js';

/**
 * Readers for tool arguments.
 *
 * What a client sends is not checked by anything before it reaches a handler: the MCP SDK
 * hands over `Record<string, unknown> | undefined` and the JSON schema in the tool definition
 * is advice to the caller, not a gate. So each read states the type it wants and gets
 * `undefined` when the value is something else, which is the same answer a missing key gives.
 * A handler that requires an argument is then checking one thing rather than two.
 */

/** Any value that is a plain object, as arguments, or an empty set of them. */
export function asParams(value: unknown): OperationParams {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as OperationParams)
    : {};
}

export function readString(params: OperationParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(params: OperationParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A string with something in it. An argument sent as `""` is an omission rather than a value:
 * every caller that has a default wants the default, and passing the empty string through
 * gives a version comparison nothing to parse or a node path that resolves to nowhere.
 */
export function readNonEmptyString(params: OperationParams, key: string): string | undefined {
  const value = readString(params, key);
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * A number greater than zero. Zero is not a usable limit or depth anywhere it is read here,
 * so it means the same as not sending the argument at all.
 */
export function readPositiveNumber(params: OperationParams, key: string): number | undefined {
  const value = readNumberLike(params, key);
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * A number, or a string that is wholly one. Clients that build their arguments as text send
 * `"3"` where the schema says 3, and refusing those would turn a working call into a missing
 * argument; the same mismatch is why the runtime bridge had to fit arguments to their types.
 */
export function readNumberLike(params: OperationParams, key: string): number | undefined {
  const value = params[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * A boolean, or the strings "true" and "false". Same reason as readNumberLike: a client that
 * builds its arguments as text sends "true", and the old untyped reads forwarded that string
 * to Godot, where it was truthy. Anything else is not an answer and reads as absent.
 */
export function readBoolean(params: OperationParams, key: string): boolean | undefined {
  const value = params[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

/** An array whose every element is a string; a mixed array reads as absent rather than partial. */
export function readStringArray(params: OperationParams, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item): item is string => typeof item === 'string') ? value : undefined;
}

export function readArray(params: OperationParams, key: string): unknown[] | undefined {
  const value = params[key];
  return Array.isArray(value) ? value : undefined;
}

export function readParams(params: OperationParams, key: string): OperationParams | undefined {
  const value = params[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as OperationParams)
    : undefined;
}

/** Present under either key, so a caller may spell an argument in snake_case or camelCase. */
export function readStringEither(params: OperationParams, first: string, second: string): string | undefined {
  return readString(params, first) ?? readString(params, second);
}

export function readBooleanEither(
  params: OperationParams,
  first: string,
  second: string,
): boolean | undefined {
  return readBoolean(params, first) ?? readBoolean(params, second);
}
