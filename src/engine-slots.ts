/**
 * The engine slots a machine's test engines share, so that every tool starting one counts it.
 *
 * Each slot is a file, `<directory>/<n>.lock` for n from 0 below the count, made with an exclusive
 * create, so two takers can never both make the same one. It holds the taker's pid and the time its
 * process started, `{"pid": 1234, "started": 1760000000000}` in milliseconds since the epoch, and
 * the taker removes it when it is done. A lock is free again once its holder has gone: when no
 * process has its pid, or one does that started more than {@link START_TOLERANCE_MS} away from the
 * time it names, which is a later process given the same number. A lock still empty or unreadable
 * {@link UNWRITTEN_MS} after it was made belongs to a taker that died between making and writing it.
 *
 * A free lock is taken over under `<n>.lock.steal`, made the same way, so that two takers who both
 * judged one free cannot both remove it: the second would be removing the first one's fresh lock.
 * Whoever holds the steal file reads the lock again, removes it if it is still free, makes its own,
 * and removes the steal file. A steal file older than {@link UNWRITTEN_MS} is a taker that died
 * holding it.
 *
 * The games' own tools take slots in this directory the same way, which is the point of it: the
 * scheme is written out in docs/test-runs.md for them, and a change here is a change there.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { startTimesOf } from './process-children.js';

/** How far a process's start may be from the time its lock names and still be the one that wrote it. */
export const START_TOLERANCE_MS = 2000;
/** How long a lock may stay empty before its taker is taken to have died writing it. */
export const UNWRITTEN_MS = 10_000;
/** How long between looks at a full set of slots. */
const SLOT_WAIT_MS = 50;
/** How long a holder's start time, once read, is believed before it is read again. */
const START_READ_MS = 10_000;

/** Who holds a lock, as its file says. */
export interface SlotHolder {
  readonly pid: number;
  readonly started: number;
}

/** The holder [param content] names, or null for content that names none. */
export function holderOf(content: string): SlotHolder | null {
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
 * a live pid holding the lock: a slot wrongly kept costs a wait, and one wrongly freed an engine
 * more than the machine was meant to run.
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

/** The engine slots in one directory, taken for this process. */
export class EngineSlots {
  private readonly starts = new Map<number, { started: number | undefined; readAt: number }>();
  private readonly held = new Set<string>();

  readonly directory: string;
  readonly count: number;
  private readonly holder: SlotHolder;

  constructor(directory: string, count: number, holder: SlotHolder) {
    this.directory = directory;
    this.count = count;
    this.holder = holder;
  }

  /** Takes a slot, waiting for one to come free, and answers its lock's path. */
  async take(signal?: AbortSignal): Promise<string> {
    mkdirSync(this.directory, { recursive: true });
    for (;;) {
      signal?.throwIfAborted();
      for (let slot = 0; slot < this.count; slot += 1) {
        const lock = join(this.directory, `${String(slot)}.lock`);
        if (this.made(lock) || (await this.takenOver(lock))) {
          this.held.add(lock);
          return lock;
        }
      }
      await delay(SLOT_WAIT_MS, undefined, signal === undefined ? {} : { signal });
    }
  }

  /** Gives back every slot this process holds, as it ends. */
  releaseAll(): void {
    for (const lock of this.held) {
      this.release(lock);
    }
  }

  /** Gives back the slot at [param lock]. */
  release(lock: string): void {
    this.held.delete(lock);
    try {
      if (holderOf(readFileSync(lock, 'utf8'))?.pid === this.holder.pid) {
        rmSync(lock, { force: true });
      }
    } catch {
      // Already gone.
    }
  }

  /** Makes [param path] holding this process, answering false when it is there already. */
  private made(path: string): boolean {
    let made: number;
    try {
      made = openSync(path, 'wx');
    } catch {
      return false;
    }
    try {
      writeSync(made, JSON.stringify(this.holder));
    } finally {
      closeSync(made);
    }
    return true;
  }

  /** Takes over [param lock] when its holder has gone, under the steal file. */
  private async takenOver(lock: string): Promise<boolean> {
    if (!(await this.free(lock))) {
      return false;
    }
    const steal = `${lock}.steal`;
    if (!this.made(steal)) {
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
      if (!(await this.free(lock))) {
        return false;
      }
      try {
        rmSync(lock, { force: true });
      } catch {
        // Held open by a tool locking the file itself, as the games' tools did before this scheme:
        // Windows will not remove it, and that tool still holds the slot.
        return false;
      }
      return this.made(lock);
    } finally {
      rmSync(steal, { force: true });
    }
  }

  private async free(lock: string): Promise<boolean> {
    let content: string;
    let writtenAt: number;
    try {
      content = readFileSync(lock, 'utf8');
      writtenAt = statSync(lock).mtimeMs;
    } catch {
      // Gone since it was found there, which the next look takes.
      return false;
    }
    const pid = holderOf(content)?.pid;
    if (pid !== undefined && alive(pid)) {
      await this.readStart(pid);
    }
    return lockIsFree(content, writtenAt, Date.now(), alive, (asked) => this.starts.get(asked)?.started);
  }

  /** Reads when [param pid] started unless that was read lately: on Windows each read is a query. */
  private async readStart(pid: number): Promise<void> {
    const known = this.starts.get(pid);
    if (known !== undefined && Date.now() - known.readAt < START_READ_MS) {
      return;
    }
    const started = (await startTimesOf([pid])).get(pid);
    this.starts.set(pid, { started, readAt: Date.now() });
  }
}
