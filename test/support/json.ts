import assert from 'node:assert/strict';
import { isRecord } from './json-rpc.js';

/**
 * Reads into a parsed JSON value without claiming to know its shape.
 *
 * Tool payloads arrive as `unknown`, and the alternative to this is either `any` or an
 * interface per payload that would have to be kept true by hand. `get` walks a path and
 * answers `undefined` for anything missing, so an assertion on the result says exactly which
 * field was wrong rather than throwing on the way there.
 */
export function get(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[step];
    } else {
      if (!isRecord(current) || Array.isArray(current)) return undefined;
      current = current[step];
    }
  }
  return current;
}

export function asObject(value: unknown, what = 'value'): Record<string, unknown> {
  assert.ok(isRecord(value) && !Array.isArray(value), `${what} should be an object`);
  return value;
}

export function asArray(value: unknown, what = 'value'): unknown[] {
  assert.ok(Array.isArray(value), `${what} should be an array`);
  return value as unknown[];
}

export function asString(value: unknown, what = 'value'): string {
  assert.ok(typeof value === 'string', `${what} should be a string`);
  return value;
}

export function asNumber(value: unknown, what = 'value'): number {
  assert.ok(typeof value === 'number', `${what} should be a number`);
  return value;
}

/** A value as text for a message or a pattern match: strings as they are, anything else as JSON. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  // JSON.stringify answers undefined for these three, which its declared return type hides.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return '';
  return JSON.stringify(value);
}

/** The last line of `output` that starts a JSON object, parsed, or an assertion failure. */
export function lastJsonLine(output: string, what = 'output'): unknown {
  const line = output
    .split('\n')
    .map((raw) => raw.trim())
    .findLast((trimmed) => trimmed.startsWith('{'));
  assert.ok(line, `${what} printed no JSON payload:\n${output.trim()}`);
  return JSON.parse(line) as unknown;
}
