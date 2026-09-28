import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';

/**
 * Giving back a scratch directory, without letting that decide the call that made it.
 *
 * Every one of these is created, handed to an engine, read back, and removed in a `finally`. The
 * removal is the one step with nothing riding on it, and it is also the step most likely to fail:
 * Windows keeps a directory open while any process holds a handle inside it, and an engine that has
 * just been killed drops those on its own schedule, so a removal issued straight afterwards answers
 * EBUSY, and the handle was measured outlasting the engine's own process by a moment.
 *
 * So a removal that fails is tried again later rather than at once. `rmSync` takes `maxRetries` and
 * `retryDelay` for this, and neither runtime acts on them: Node 24 answered EPERM and Bun 1.4 EBUSY
 * within a millisecond of being given twenty retries a quarter of a second apart. Relied on, they left
 * a user data directory behind for every test run an engine was still letting go of, fourteen of them
 * from one downstream project's ordinary runs.
 *
 * A removal that fails anyway never throws. Thrown from a `finally` it becomes the answer: a test run
 * that finished, wrote its report and had it parsed is reported to the caller as an error about a
 * directory, with the report discarded on the way out, and the paths queued behind the failing line
 * are abandoned as well. The tidying is not worth a single one of those.
 */

const SWEPT = { recursive: true, force: true } as const;

/** When a failed removal is tried again, after the one before it: about half a minute in all. */
const AGAIN_AFTER_MS = [250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Paths waiting to be tried again, so a second failure of one does not start a second schedule. */
const waiting = new Set<string>();

/** Paths every timed try has failed on, left for the one as the process exits. */
const atExit = new Set<string>();

export interface Surviving {
  path: string;
  reason: string;
}

/** What a scratch directory is for, which is the first part of its name. */
export type ScratchKind = 'desktop' | 'export' | 'import' | 'params' | 'runtime-screenshot' | 'tests';

const KINDS: readonly ScratchKind[] = [
  'desktop',
  'export',
  'import',
  'params',
  'runtime-screenshot',
  'tests',
];

/**
 * A new scratch directory in the system temporary directory, named for [param kind] and for this
 * process, which is what lets a later process tell one that was abandoned from one in use.
 */
export function scratchDirectory(kind: ScratchKind): string {
  return mkdtempSync(join(tmpdir(), `gdharness-${kind}-${process.pid}-`));
}

/**
 * Removes the scratch directories whose process is gone, which every try before this one failed on.
 *
 * The tries a process makes end with it, and a server is ended by being killed, which runs nothing
 * on the way out, so a directory still held when it goes stays unless somebody else takes it.
 * Only a directory whose process is gone is touched, because the system temporary directory is
 * shared by every server on the machine and a live one's run is still using its own. A number the
 * system has handed to a new process keeps a directory a while longer, which costs nothing.
 */
export function sweepAbandonedScratch(directory = tmpdir()): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  const named = new RegExp(`^gdharness-(${KINDS.join('|')})-(\\d+)-[A-Za-z0-9]{6}$`);
  for (const entry of entries) {
    const owner = named.exec(entry)?.[2];
    if (owner === undefined || alive(Number(owner))) {
      continue;
    }
    try {
      remove(join(directory, entry));
    } catch {
      // Still held, by something that outlived its server; the next sweep gets it.
    }
  }
}

/**
 * Attempts every path, independently, and answers the ones still there with why.
 *
 * Split from {@link discard} so that the independence can be asserted without arranging a locked
 * handle, which is the one part of this with no portable spelling.
 */
export function discardWith(
  remove: (path: string) => void,
  paths: readonly (string | null | undefined)[],
): Surviving[] {
  const left: Surviving[] = [];
  for (const path of paths) {
    if (!path) {
      continue;
    }
    try {
      remove(path);
    } catch (error) {
      left.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return left;
}

/**
 * Removes every path now, and answers the ones that would not go. Those are tried again on timers
 * that keep nothing alive, and once more as the process exits, so a handle an engine lets go of a
 * second later costs nothing.
 */
export function discard(...paths: (string | null | undefined)[]): Surviving[] {
  const left = discardWith(remove, paths);
  for (const { path } of left) {
    tryAgain(path, 0);
  }
  return left;
}

/**
 * Resolves once nothing is waiting to be tried again, or after [param withinMs], whichever is first.
 * For a caller about to report what was left behind, which is what is still there once the tries are
 * over, not what the first one found.
 */
export async function untilDiscarded(withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (waiting.size > 0 && Date.now() < deadline) {
    await delay(50);
  }
}

function remove(path: string): void {
  rmSync(path, SWEPT);
}

function tryAgain(path: string, attempt: number): void {
  if (attempt === 0) {
    if (waiting.has(path)) {
      return;
    }
    waiting.add(path);
    atExit.delete(path);
    lastTryOnExit();
  }
  const after = AGAIN_AFTER_MS[attempt];
  if (after === undefined || !existsSync(path)) {
    waiting.delete(path);
    if (after === undefined) {
      atExit.add(path);
    }
    return;
  }
  setTimeout(() => {
    try {
      remove(path);
      waiting.delete(path);
    } catch {
      tryAgain(path, attempt + 1);
    }
  }, after).unref();
}

let lastTryWatched = false;

/** The last try, as the process goes: the engine that held a path is usually gone by then. */
function lastTryOnExit(): void {
  if (lastTryWatched) {
    return;
  }
  lastTryWatched = true;
  process.once('exit', () => {
    for (const path of [...waiting, ...atExit]) {
      try {
        remove(path);
      } catch {
        // Left in the system temporary directory, whose contents nobody is promised.
      }
    }
  });
}
