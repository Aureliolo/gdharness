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
import { isSameDirectory } from './paths.js';

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
 * between tries. For a caller that has to answer at once: a process exit, a synchronous API. The
 * wait is counted from [param began], which a caller that finished other calls first sets to its
 * own start, so those calls and its own share one wait.
 */
function waitedOutSync<T>(attempt: () => Attempt<T>, began = Date.now()): T {
  const until = began + HELD_FILE_MS;
  for (;;) {
    const tried = attempt();
    if ('done' in tried) {
      return tried.done;
    }
    if (Date.now() >= until) {
      return tried.held();
    }
    sleepBetweenTries();
  }
}

function sleepBetweenTries(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HELD_FILE_RETRY_MS);
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
  const began = Date.now();
  finishTurnsOn(path);
  const partial = stagedBeside(path, text);
  return partial !== null && waitedOutSync(() => renameAttempt(partial, path), began);
}

/**
 * {@link writeWhole} for a caller on the event loop: the wait between tries is a timer, and the
 * write takes its turn behind every call made on the note before it ({@link inTurnOn}).
 */
export function writeWholeAsync(path: string, text: string): Promise<boolean> {
  return inTurnOn(path, () => stagedStep(path, text));
}

/**
 * Replaces [param path] with what [param change] makes of its text, read once the call's turn has
 * come, and answers whether it did. Null from [param change] leaves the file as it is, and so does
 * a read that a reader holding the file shut refuses for the whole wait.
 *
 * For a caller that writes from what the note holds. Read ahead of its turn, the text misses what a
 * call still waiting on a reader goes on to write, and the write puts the older note back.
 */
export function changeWholeAsync(
  path: string,
  change: (text: string | null) => string | null,
): Promise<boolean> {
  return inTurnOn(path, () => {
    const read = readAttempt(path);
    if (!('done' in read)) {
      return { held: () => false };
    }
    const text = change(read.done);
    return text === null ? { done: false } : stagedStep(path, text);
  });
}

/**
 * One try of a call in its turn: an {@link Attempt}, or the tries that follow once its first part
 * is done, which get the whole wait again as they do in a call of their own.
 */
type Step<T> = Attempt<T> | { readonly next: () => Attempt<T> };

/** A call on a note, being tried or waiting behind the ones made before it. */
interface Turn {
  /** Tries the call once, and answers whether it has its answer. */
  readonly tried: () => boolean;
  /**
   * Fixes the call's deadline where it stands, counted from when the call was made if its turn has
   * not come, so a caller finishing it by hand waits no longer than the call would have.
   */
  readonly fixDeadline: () => void;
}

/**
 * The calls on each note that are being tried or waiting, in the order they were made. The first is
 * the one being tried. A note's entry goes with its last call, so a server that runs for days keeps
 * nothing for a note no call is waiting on.
 */
const turns = new Map<string, Turn[]>();

/** How many notes have a call being tried or waiting, for a test of the entries being dropped. */
export function notesInTurn(): number {
  return turns.size;
}

/**
 * Runs the call that begins with [param first] once every call made on [param path] before it has
 * its answer, and answers what it does: tried on a timer until it answers or its wait is spent, as
 * it would be alone.
 *
 * A write that waited on a reader beside a later call on the note landed after that call when the
 * reader let go. A note cleared meanwhile came back, and a lock given back was made again.
 */
function inTurnOn<T>(path: string, first: () => Step<T>): Promise<T> {
  return new Promise<T>((answer, refuse) => {
    const turn = turnOf(first, answer, refuse);
    const key = waitingKeyOf(path) ?? path;
    const line = turns.get(key);
    if (line === undefined) {
      const fresh = [turn];
      turns.set(key, fresh);
      void served(key, fresh);
    } else {
      line.push(turn);
    }
  });
}

/**
 * The key the calls waiting on [param path] are held under, however the first of them spelled it, or
 * undefined when none is waiting. Two spellings of one file are judged as two spellings of one
 * project are: a breakpoint written under the path a caller typed is cleared under the one the
 * editor reports.
 */
function waitingKeyOf(path: string): string | undefined {
  if (turns.has(path)) {
    return path;
  }
  for (const key of turns.keys()) {
    if (isSameDirectory(key, path)) {
      return key;
    }
  }
  return undefined;
}

function turnOf<T>(first: () => Step<T>, answer: (value: T) => void, refuse: (error: unknown) => void): Turn {
  let attempt = first;
  let until: number | undefined;
  const made = Date.now();
  let fixed = false;
  const attempted = (): Attempt<T> => {
    const step = attempt();
    if (!('next' in step)) {
      return step;
    }
    attempt = step.next;
    if (!fixed) {
      until = Date.now() + HELD_FILE_MS;
    }
    return step.next();
  };
  const tried = (): boolean => {
    try {
      until ??= Date.now() + HELD_FILE_MS;
      const step = attempted();
      if ('held' in step && Date.now() < until) {
        return false;
      }
      answer('held' in step ? step.held() : step.done);
    } catch (error) {
      refuse(error);
    }
    return true;
  };
  const fixDeadline = (): void => {
    until ??= made + HELD_FILE_MS;
    fixed = true;
  };
  return { tried, fixDeadline };
}

/** Tries each call of [param line] in turn, on a timer, until none is left. */
async function served(key: string, line: Turn[]): Promise<void> {
  for (let turn = line[0]; turn !== undefined; turn = line[0]) {
    if (turn.tried()) {
      line.shift();
    } else {
      await delay(HELD_FILE_RETRY_MS);
    }
  }
  if (turns.get(key) === line) {
    turns.delete(key);
  }
}

/**
 * Brings every call waiting on [param path] to its answer before a call that cannot wait on a timer
 * goes ahead, sleeping the thread between tries. Each answers what it did by the deadline it had, so
 * the caller's write or removal lands after them and the thread sleeps about one wait in all.
 */
function finishTurnsOn(path: string): void {
  const key = waitingKeyOf(path);
  const line = key === undefined ? undefined : turns.get(key);
  if (key === undefined || line === undefined) {
    return;
  }
  turns.delete(key);
  for (const turn of line) {
    turn.fixDeadline();
  }
  for (let turn = line.shift(); turn !== undefined; turn = line.shift()) {
    while (!turn.tried()) {
      sleepBetweenTries();
    }
  }
}

/**
 * Writes [param text] to the partial file beside [param path], and answers its name, or null when it
 * cannot be written. One name serves every write of this process, since no two are under way at once.
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

/** The first try of a write in its turn: the text staged, then the renames over [param path]. */
function stagedStep(path: string, text: string): Step<boolean> {
  const partial = stagedBeside(path, text);
  return partial === null ? { done: false } : { next: () => renameAttempt(partial, path) };
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
  const began = Date.now();
  finishTurnsOn(path);
  return waitedOutSync(() => removeAttempt(path), began);
}

/**
 * {@link removeWhole} for a caller on the event loop: the wait between tries is a timer, and the
 * removal takes its turn behind every call made on the note before it ({@link inTurnOn}).
 */
export function removeWholeAsync(path: string): Promise<boolean> {
  return inTurnOn(path, () => removeAttempt(path));
}

function removeAttempt(path: string): Attempt<boolean> {
  try {
    rmSync(path, { force: true });
    return { done: true };
  } catch (error) {
    return HELD_BY_A_READER.has(errorCode(error) ?? '') ? { held: () => false } : { done: false };
  }
}
