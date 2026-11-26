/**
 * Lock files that name their holder, `{"pid": 1234, "started": 1760000000000}` with the time its
 * process started in milliseconds since the epoch. The engine slots and project locks are not among
 * them: those are OS locks (see `os-lock.ts`). A lock is free again once its holder has gone: when no process has its pid,
 * or one does that started more than {@link START_TOLERANCE_MS} away from the time it names. A
 * lock still empty or unreadable {@link UNWRITTEN_MS} after it was made belongs to a taker that
 * died between making and writing it.
 *
 * A free lock is taken over under `<lock>.steal`, made the same way, so that two takers who both
 * judged one free cannot both remove it: the second would be removing the first one's fresh lock.
 */

import { rmSync, statSync } from 'node:fs';
import process from 'node:process';
import { startTimesOf } from './process-children.js';

/** How far a process's start may be from the time its lock names and still be the one that wrote it. */
const START_TOLERANCE_MS = 2000;
/** How long a lock may stay empty before its taker is taken to have died writing it. */
const UNWRITTEN_MS = 10_000;

/** The process a lock names. */
export interface LockHolder {
  readonly pid: number;
  readonly started: number;
}

/** The holder [param content] names, or null for content that names none. */
export function holderOf(content: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { pid, started } = parsed as { pid?: unknown; started?: unknown };
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof started === 'number'
      ? { pid, started }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether a lock holding [param content], last written at [param writtenAt], is free. [param startOf]
 * answers when a pid's process started, or undefined where the platform will not say, which leaves
 * a live pid holding the lock: a lock wrongly kept costs a wait, and one wrongly freed a second holder.
 */
export function lockIsFree(
  content: string,
  writtenAt: number,
  now: number,
  isAlive: (pid: number) => boolean,
  startOf: (pid: number) => number | undefined,
): boolean {
  const holder = holderOf(content);
  if (holder === null) {
    return now - writtenAt > UNWRITTEN_MS;
  }
  if (!isAlive(holder.pid)) {
    return true;
  }
  const started = startOf(holder.pid);
  return started !== undefined && Math.abs(started - holder.started) > START_TOLERANCE_MS;
}

/** When this process started, as the platform reports it, which is what a lock it writes names. */
export async function ownStart(): Promise<number> {
  const said = (await startTimesOf([process.pid])).get(process.pid);
  return said ?? Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Removes [param lock] once [param gone] says its holder has gone, under its steal file, so that a
 * lock another taker has just made in its place is never removed. [param make] makes a file for this
 * process, the steal file and with [param retake] the lock again, unless [param makeLock] makes the
 * lock. Answers whether that was done.
 * It tries the removal once and never waits, because a server calls it from its protocol and its
 * caller looks again.
 */
export async function takenOverUnderSteal(
  lock: string,
  gone: () => Promise<boolean>,
  make: (path: string) => boolean,
  retake = true,
  makeLock = make,
): Promise<boolean> {
  if (!(await gone())) {
    return false;
  }
  const steal = `${lock}.steal`;
  if (!make(steal)) {
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
    if (!(await gone())) {
      return false;
    }
    try {
      rmSync(lock, { force: true });
    } catch {
      // Held open by a tool locking the file itself: Windows will not remove it, and that tool still
      // holds the lock.
      return false;
    }
    return retake ? makeLock(lock) : true;
  } finally {
    rmSync(steal, { force: true });
  }
}
