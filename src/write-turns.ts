/**
 * Headless writes to one scene or resource file, one at a time across every server on the machine.
 *
 * A headless write loads the file, changes it and saves it whole. Two at once each loaded the file,
 * and the later save put back what it had read: a game's eight adds to one scene, two of them left
 * running by its client, lost a Line2D and gave its antialiased to a Polygon2D. Two sessions each
 * run a server of their own, so the turn is a lock file in the project's .godot folder rather than
 * anything one server holds.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { holderOf, lockIsFree, ownStart, takenOverUnderSteal } from './engine-slots.js';
import { startTimesOf } from './process-children.js';
import { removeWhole } from './whole-file.js';

/** The folder under a project's .godot that holds a lock for each file a write is under way to. */
const WRITES_FOLDER = 'gdharness-writes';

/** How often a write waiting its turn looks at the lock again. */
const TURN_LOOK_MS = 100;

/** How many times a refused give-back is tried, each after a look's wait. */
const GIVE_BACK_TRIES = 5;

/** The lock for writes to [param file], an absolute path in [param projectPath]. */
export function writeLockOf(projectPath: string, file: string): string {
  const named = relative(projectPath, file).split('\\').join('/');
  const key = process.platform === 'win32' ? named.toLowerCase() : named;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(projectPath, '.godot', WRITES_FOLDER, `${hash}.lock`);
}

/**
 * Runs [param write] once no other write to [param file] in [param projectPath] is under way, this
 * server's or another's, and holds the turn until it ends however it ends. A lock whose holder has
 * gone is taken over under its steal file, as an engine slot's is, so a lock another waiter has just
 * made in its place is never removed.
 *
 * Writes from this server to one file run in the order they asked, since a client sends a later
 * call while an earlier one is still queued and the file must end as the later call left it. Across
 * servers the lock is polled, so whichever looks first after the turn is given back takes it.
 */
export async function inTurnFor<T>(projectPath: string, file: string, write: () => Promise<T>): Promise<T> {
  const lock = writeLockOf(projectPath, file);
  const before = queueTails.get(lock) ?? Promise.resolve();
  let release = (): void => undefined;
  const mine = new Promise<void>((done) => {
    release = done;
  });
  const tail = before.then(() => mine);
  queueTails.set(lock, tail);
  await before;
  try {
    return await takeTurn(projectPath, file, lock, write);
  } finally {
    release();
    if (queueTails.get(lock) === tail) {
      queueTails.delete(lock);
    }
  }
}

/** The last write this server has queued for each lock, which the next one waits behind. */
const queueTails = new Map<string, Promise<void>>();

async function takeTurn<T>(projectPath: string, file: string, lock: string, write: () => Promise<T>): Promise<T> {
  mkdirSync(join(projectPath, '.godot', WRITES_FOLDER), { recursive: true });
  const holder = JSON.stringify({ pid: process.pid, started: await ownStart(), file });
  const starts = new Map<number, number | undefined>();
  while (
    !made(lock, holder) &&
    !(await takenOverUnderSteal(
      lock,
      () => gone(lock, starts),
      (path) => made(path, holder),
    ))
  ) {
    await delay(TURN_LOOK_MS);
  }
  let result: T;
  try {
    result = await write();
  } catch (error) {
    await giveBack(lock);
    throw error;
  }
  if (!(await giveBack(lock))) {
    throw new Error(
      `The write to ${file} finished, but its lock file ${lock} could not be removed. Remove it so later writes to ${file} can run.`,
    );
  }
  return result;
}

/**
 * Removes [param lock], trying again for a moment, and answers whether it is gone. A lock left
 * behind names this live server, so every later write to the file waits on it with no limit.
 */
async function giveBack(lock: string): Promise<boolean> {
  for (let tries = 0; tries < GIVE_BACK_TRIES; tries += 1) {
    if (removeWhole(lock)) {
      return true;
    }
    await delay(TURN_LOOK_MS);
  }
  return false;
}

/** Makes [param path] holding [param content] unless it exists, and answers whether it did. */
function made(path: string, content: string): boolean {
  let file: number;
  try {
    file = openSync(path, 'wx');
  } catch {
    return false;
  }
  try {
    writeSync(file, content);
  } finally {
    closeSync(file);
  }
  return true;
}

/** Whether the holder [param lock] names has gone, each holder's start read once into [param starts]. */
async function gone(lock: string, starts: Map<number, number | undefined>): Promise<boolean> {
  let content: string;
  let writtenAt: number;
  try {
    content = readFileSync(lock, 'utf8');
    writtenAt = statSync(lock).mtimeMs;
  } catch {
    // Given back since it was found, which the next make takes.
    return false;
  }
  const pid = holderOf(content)?.pid;
  if (pid !== undefined && !starts.has(pid) && alive(pid)) {
    starts.set(pid, (await startTimesOf([pid])).get(pid));
  }
  return lockIsFree(content, writtenAt, Date.now(), alive, (asked) => starts.get(asked));
}
