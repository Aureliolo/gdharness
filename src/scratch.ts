import { rmSync } from 'node:fs';

/**
 * Giving back a scratch directory, without letting that decide the call that made it.
 *
 * Every one of these is created, handed to an engine, read back, and removed in a `finally`. The
 * removal is the one step with nothing riding on it, and it is also the step most likely to fail:
 * Windows keeps a directory open while any process holds a handle inside it, and an engine that has
 * just been killed drops those on its own schedule, so a removal issued straight afterwards answers
 * EBUSY. Retrying covers almost all of it.
 *
 * What retrying does not cover is the removal failing anyway, and thrown from a `finally` it becomes
 * the answer. A test run that finished, wrote its report and had it parsed is reported to the caller
 * as an error about a directory, with the report discarded on the way out, and the paths queued
 * behind the failing line are abandoned as well. The tidying is not worth a single one of those, so
 * it never throws and never stops early. A directory that outlives the call is left in the system
 * temporary directory, which is the one place on the machine whose contents nobody is promised.
 */

const SWEPT = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 } as const;

export interface Surviving {
  path: string;
  reason: string;
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

export function discard(...paths: (string | null | undefined)[]): Surviving[] {
  return discardWith((path) => {
    rmSync(path, SWEPT);
  }, paths);
}
