/**
 * A file written whole or not at all, for the notes one process writes while others read them.
 *
 * Written in place, a note is empty between the truncate and the write, and a reader landing there
 * reads no note: measured on Windows, about one read in twelve that overlapped a rewrite failed to
 * parse. A server reading no run note can take a running game for none and start a second beside
 * it. So the text goes to a file of its own and is renamed over the note, which a reader sees as one
 * step.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { errorCode } from './errors.js';

/** How long a write waits out a reader holding the file, and how long it sleeps between tries. */
const HELD_FILE_MS = 1000;
const HELD_FILE_RETRY_MS = 10;

/**
 * The codes Windows answers a rename, a removal or an open with while another process holds the
 * file in a way that shuts the call out.
 */
const HELD_BY_A_READER = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * The text of [param path], waiting out a moment in which another process holds it shut, or null
 * when there is no such file.
 *
 * The editor rewrites the class cache at the end of every scan, and on Windows an open landing on
 * that write is refused with EBUSY: a script_edit read the cache as the editor's scan of the edit
 * wrote it, and the call ended in a crash report.
 */
export function readWhole(path: string): string | null {
  const until = Date.now() + HELD_FILE_MS;
  for (;;) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (code === 'ENOENT') {
        return null;
      }
      if (!HELD_BY_A_READER.has(code) || Date.now() >= until) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HELD_FILE_RETRY_MS);
    }
  }
}

/**
 * Writes [param text] to [param path] whole, and answers whether it did; a write that did not leaves
 * the file as it was.
 *
 * Windows refuses to rename over a file another process has open, and every note here is opened by
 * whichever server asks about it, so a refusal is waited out for a moment. What still fails is
 * answered rather than thrown, because some writers cannot afford a throw: the keeper is one, where
 * a throw ends it and the run it holds goes on with nobody holding it.
 */
export function writeWhole(path: string, text: string): boolean {
  const partial = `${path}.${process.pid}.partial`;
  try {
    writeFileSync(partial, text, 'utf8');
  } catch {
    return false;
  }
  const until = Date.now() + HELD_FILE_MS;
  for (;;) {
    try {
      renameSync(partial, path);
      return true;
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (!HELD_BY_A_READER.has(code) || Date.now() >= until) {
        try {
          rmSync(partial, { force: true });
        } catch {
          // Left behind, and swept with the transcripts once it is old enough.
        }
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HELD_FILE_RETRY_MS);
    }
  }
}

/**
 * Removes [param path], waiting out a reader that holds it open, and answers whether it is gone.
 *
 * Python opens a file without delete sharing, and Windows will not remove a file opened so: the
 * games' tools read the slot locks and the wait marks every half second, and a lock left behind by
 * a removal that landed on such a read names a live holder and keeps its slot for the whole run.
 */
export function removeWhole(path: string): boolean {
  const until = Date.now() + HELD_FILE_MS;
  for (;;) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (!HELD_BY_A_READER.has(code) || Date.now() >= until) {
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HELD_FILE_RETRY_MS);
    }
  }
}
