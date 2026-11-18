/**
 * A file written whole or not at all, for the notes one process writes while others read them.
 *
 * Written in place, a note is empty between the truncate and the write, and a reader landing there
 * reads no note: measured on Windows, about one read in twelve that overlapped a rewrite failed to
 * parse. A server reading no run note can take a running game for none and start a second beside
 * it. So the text goes to a file of its own and is renamed over the note, which a reader sees as one
 * step.
 */

import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';
import { alive } from './alive.js';
import { errorCode } from './errors.js';

/** The notes whose folder has been looked through for a dead writer's partial file. */
const sweptNotes = new Set<string>();

/**
 * Removes the partial files beside [param path] that a writer left when it died between writing and
 * renaming. Once per note and process, because a folder can hold thousands of files and a live
 * writer's partial is never touched: only a name carrying the pid of a process that has gone.
 */
function sweepDeadPartials(path: string): void {
  if (sweptNotes.has(path)) {
    return;
  }
  sweptNotes.add(path);
  const prefix = `${basename(path)}.`;
  try {
    for (const entry of readdirSync(dirname(path))) {
      const found = entry.startsWith(prefix) ? /^(\d+)\.partial$/.exec(entry.slice(prefix.length)) : null;
      const pid = Number(found?.[1]);
      if (found !== null && pid !== process.pid && !alive(pid)) {
        rmSync(join(dirname(path), entry), { force: true });
      }
    }
  } catch {
    // A folder that cannot be listed has no partials to find, and the write says what it needs to.
  }
}

/**
 * Whether [param path] refuses a rename over it for good rather than while a reader holds it: a
 * folder, or a file marked read-only. Windows answers both with the code a held file gets.
 */
function refusesForGood(path: string): boolean {
  try {
    const found = statSync(path);
    return found.isDirectory() || (found.mode & 0o222) === 0;
  } catch {
    return false;
  }
}

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
  return waitedOutSync(() => readAttempt(path));
}

/** {@link readWhole} for a caller on the event loop: the wait between tries is a timer. */
export async function readWholeAsync(path: string): Promise<string | null> {
  return await waitedOut(() => readAttempt(path));
}

/**
 * One try at a call that a reader holding the file can refuse for a moment: its answer, or what to
 * answer once the wait is spent. Both ways of waiting judge a refusal by it, so they cannot differ.
 */
type Attempt<T> = { readonly done: T } | { readonly held: () => T };

/**
 * Tries [param attempt] until it answers or [constant HELD_FILE_MS] has passed, sleeping the thread
 * between tries. For a caller that has to answer at once: a process exit, a synchronous API.
 */
function waitedOutSync<T>(attempt: () => Attempt<T>): T {
  const until = Date.now() + HELD_FILE_MS;
  for (;;) {
    const tried = attempt();
    if ('done' in tried) {
      return tried.done;
    }
    if (Date.now() >= until) {
      return tried.held();
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HELD_FILE_RETRY_MS);
  }
}

/**
 * Tries [param attempt] as {@link waitedOutSync} does, with a timer between tries so the event loop
 * keeps running while a reader holds the file.
 */
async function waitedOut<T>(attempt: () => Attempt<T>): Promise<T> {
  const until = Date.now() + HELD_FILE_MS;
  for (;;) {
    const tried = attempt();
    if ('done' in tried) {
      return tried.done;
    }
    if (Date.now() >= until) {
      return tried.held();
    }
    await delay(HELD_FILE_RETRY_MS);
  }
}

function readAttempt(path: string): Attempt<string | null> {
  try {
    return { done: readFileSync(path, 'utf8') };
  } catch (error) {
    const code = errorCode(error) ?? '';
    if (code === 'ENOENT') {
      return { done: null };
    }
    if (!HELD_BY_A_READER.has(code)) {
      throw error;
    }
    return {
      held: () => {
        throw error;
      },
    };
  }
}

/**
 * Writes [param text] to [param path] whole, and answers whether it did. A write that did not leaves
 * the file as it was.
 *
 * Windows refuses to rename over a file another process has open, and every note here is opened by
 * whichever server asks about it, so a refusal is waited out for a moment. What still fails is
 * answered rather than thrown, because some writers cannot afford a throw: the keeper is one, where
 * a throw ends it and the run it holds goes on with nobody holding it.
 */
export function writeWhole(path: string, text: string): boolean {
  const partial = stagedBeside(path, text);
  return partial !== null && waitedOutSync(() => renameAttempt(partial, path));
}

/** {@link writeWhole} for a caller on the event loop: the wait between tries is a timer. */
export async function writeWholeAsync(path: string, text: string): Promise<boolean> {
  const partial = stagedBeside(path, text);
  return partial !== null && (await waitedOut(() => renameAttempt(partial, path)));
}

/**
 * Writes [param text] to the partial file beside [param path], and answers its name, or null when it
 * cannot be written.
 */
function stagedBeside(path: string, text: string): string | null {
  const partial = `${path}.${process.pid}.partial`;
  sweepDeadPartials(path);
  try {
    writeFileSync(partial, text, 'utf8');
    return partial;
  } catch {
    return null;
  }
}

/** One try at renaming [param partial] over [param path], which a refusal for good ends at once. */
function renameAttempt(partial: string, path: string): Attempt<boolean> {
  try {
    renameSync(partial, path);
    return { done: true };
  } catch (error) {
    const gaveUp = (): boolean => {
      try {
        rmSync(partial, { force: true });
      } catch {
        // Left behind, and swept with the transcripts once it is old enough.
      }
      return false;
    };
    const code = errorCode(error) ?? '';
    return !HELD_BY_A_READER.has(code) || refusesForGood(path) ? { done: gaveUp() } : { held: gaveUp };
  }
}

/**
 * Makes [param path] holding [param text], and answers whether this call made it. Another process
 * reading the file finds it whole or not there, never empty. For marks and steal files, which are
 * never raced for as slot locks are ({@link madeInPlace}).
 *
 * The text goes to a file beside it, named as the gates' Python queue names its own
 * ({@link stagedWriterOf}), and is linked into place, which fails where the path exists. A rename
 * would replace a file there on Windows. On a disk that cannot link, the file is created exclusively
 * and written, which leaves it empty for a moment.
 */
export function makeWhole(path: string, text: string): boolean {
  // A path already there is passed over without a staged file, whose making and removal would wake
  // every taker watching the folder at each look.
  if (existsSync(path)) {
    return false;
  }
  const partial = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}-${String(threadId)}.writing`,
  );
  try {
    writeFileSync(partial, text, 'utf8');
  } catch {
    return false;
  }
  try {
    linkSync(partial, path);
    return true;
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? false : madeInPlace(path, text);
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * The pid of the process writing the staged file [param name], `.<file>.<pid>-<thread>.writing`, or
 * undefined for any other name. No listing of a slot folder takes one for a lock or a mark, and a
 * reader never opens it: a rename onto its name from the other side would be refused meanwhile.
 */
export function stagedWriterOf(name: string): number | undefined {
  const pid = /^\..+\.(\d+)-\d+\.writing$/.exec(name)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

/**
 * Makes [param path] by creating its name exclusively and then writing [param text], and answers
 * whether this call made it. A reader landing between the two finds the file empty. A slot lock is
 * made so, since a taker that stages its text first loses nearly every race to one that only
 * creates the name: every reader that takes, steals or removes a lock holds an empty one as held
 * ({@link lockIsFree}). Also what {@link makeWhole} falls back on where a link cannot be made.
 */
export function madeInPlace(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
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
  return waitedOutSync(() => removeAttempt(path));
}

/** {@link removeWhole} for a caller on the event loop: the wait between tries is a timer. */
export async function removeWholeAsync(path: string): Promise<boolean> {
  return await waitedOut(() => removeAttempt(path));
}

function removeAttempt(path: string): Attempt<boolean> {
  try {
    rmSync(path, { force: true });
    return { done: true };
  } catch (error) {
    return HELD_BY_A_READER.has(errorCode(error) ?? '') ? { held: () => false } : { done: false };
  }
}
