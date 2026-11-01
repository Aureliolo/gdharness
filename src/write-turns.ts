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
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { holderOf, lockIsFree, ownStart, UNWRITTEN_MS } from './engine-slots.js';
import { startTimesOf } from './process-children.js';
import { removeWhole } from './whole-file.js';

/** The folder under a project's .godot that holds a lock for each file a write is under way to. */
const WRITES_FOLDER = 'gdharness-writes';

/** How often a write waiting its turn looks at the lock again. */
const TURN_LOOK_MS = 100;

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
 */
export async function inTurnFor<T>(projectPath: string, file: string, write: () => Promise<T>): Promise<T> {
  const lock = writeLockOf(projectPath, file);
  mkdirSync(join(projectPath, '.godot', WRITES_FOLDER), { recursive: true });
  const holder = JSON.stringify({ pid: process.pid, started: await ownStart(), file });
  const starts = new Map<number, number | undefined>();
  while (!made(lock, holder) && !(await takenOver(lock, holder, starts))) {
    await delay(TURN_LOOK_MS);
  }
  try {
    return await write();
  } finally {
    removeWhole(lock);
  }
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

/** Makes [param lock] again for [param holder] when its holder has gone, under its steal file. */
async function takenOver(
  lock: string,
  holder: string,
  starts: Map<number, number | undefined>,
): Promise<boolean> {
  if (!(await gone(lock, starts))) {
    return false;
  }
  const steal = `${lock}.steal`;
  if (!made(steal, holder)) {
    try {
      if (Date.now() - statSync(steal).mtimeMs > UNWRITTEN_MS) {
        rmSync(steal, { force: true });
      }
    } catch {
      // Gone between the two, which is its taker finishing.
    }
    return false;
  }
  try {
    return (await gone(lock, starts)) && removeWhole(lock) && made(lock, holder);
  } finally {
    rmSync(steal, { force: true });
  }
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
