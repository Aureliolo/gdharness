/**
 * Reads of what a walk over a project has just listed. Another process can remove an entry between
 * the listing and the read: on Windows an engine deletes the `~` copy of each library it loads,
 * and gdharness sweeps the copies it set aside. An entry gone by then reads as never listed, while
 * every other failure still throws.
 */

import {
  closeSync,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
} from 'node:fs';
import { errorCode } from './errors.js';

/** The entries of [param directory], or none when it has gone. */
export function entriesOf(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** The stat of [param file], or undefined when it has gone. */
export function statOf(file: string): Stats | undefined {
  return statSync(file, { throwIfNoEntry: false });
}

/**
 * The bytes of [param file] and when it was modified, both read from one open of it, or null when
 * it has gone. An open file stays readable when another process removes it.
 */
export function contentOf(file: string): { bytes: Buffer; modified: number } | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    return { bytes: readFileSync(descriptor), modified: fstatSync(descriptor).mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

/** The bytes of [param file], or null when it has gone. */
export function bytesOf(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
