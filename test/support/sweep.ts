import { existsSync } from 'node:fs';
import { discard, type Surviving, untilDiscarded } from '../../src/scratch.js';
import { type EndedEngine, endEnginesUnder } from './engines.js';

/**
 * A fixture's temporary directories, removed the way the server removes its own.
 *
 * The removal itself is `discard`, so the fixtures exercise the production sweep rather than a
 * second copy of it that could drift. What is added here is the part only a test run wants: the
 * paths that survived are collected across the whole run and named at the end, because a suite that
 * leaks quietly leaks for months. This one had, on six separate days, and the run that leaked a pair
 * of directories had swept the first of them before failing on the second.
 */

let survived: (Surviving & { during: string | null })[] = [];

/** How long the report waits on removals still being tried, which is every try there is. */
const UNSWEPT_WAIT_MS = 35_000;

/**
 * Every path swept, whether or not it went, by fixture: an engine still running names its project
 * on its command line after the directory is gone, which on Linux and macOS it is at once, since
 * neither refuses to remove a directory a process has open.
 */
const swept: { path: string; during: string | null }[] = [];

/**
 * The fixture whose directories are being swept, named beside anything it leaves. A path under the
 * system temporary directory says which helper made it and not which case, and leftovers found
 * after a whole run could not be traced to the fixture that left them.
 */
let during: string | null = null;

export function sweepingFor(fixture: string | null): void {
  during = fixture;
}

export function sweep(...paths: (string | null | undefined)[]): void {
  for (const path of paths) {
    if (path) {
      swept.push({ path, during });
    }
  }
  survived.push(...discard(...paths).map((left) => ({ ...left, during })));
}

/** Whether [param fixture] left a directory behind, which on Windows is what a running engine does. */
export function leftBehindBy(fixture: string): boolean {
  return survived.some((left) => left.during === fixture);
}

/**
 * Ends every engine still running under a directory [param fixture] swept, or under any directory
 * swept at all when no fixture is named, and sweeps again what those engines were holding.
 *
 * A server hands a game it starts to a keeper outside its own process tree, so the game survives
 * the server by design, and a fixture that failed before its own stop left one running: a headless
 * game held at a frame cap took a core for as long as the machine was up, and the directory it held
 * was the only sign, reported as left behind with nothing said about why.
 */
export async function endEnginesLeft(fixture?: string): Promise<(EndedEngine & { during: string | null })[]> {
  const mine = swept.filter((entry) => fixture === undefined || entry.during === fixture);
  const ended = await endEnginesUnder(...new Set(mine.map((entry) => entry.path)));
  const whose = new Map(mine.map((entry) => [entry.path, entry.during]));
  const retried = survived.filter((left) => fixture === undefined || left.during === fixture);
  survived = survived.filter((left) => !retried.includes(left));
  for (const left of retried) {
    survived.push(...discard(left.path).map((still) => ({ ...still, during: left.during })));
  }
  return ended.map((engine) => ({ ...engine, during: whose.get(engine.under) ?? null }));
}

/**
 * Names what is still there once the removals tried again have had their chance, and answers
 * whether anything is.
 *
 * Worth a line but not a failed run: these sit in the system temporary directory, the operating
 * system clears them eventually, and failing the suite over one would make a green run depend on how
 * promptly Windows let go of a handle.
 */
export async function reportUnswept(): Promise<boolean> {
  await untilDiscarded(UNSWEPT_WAIT_MS);
  const still = survived.filter(({ path }) => existsSync(path));
  if (still.length === 0) {
    return false;
  }
  console.error(`${still.length} temporary director${still.length === 1 ? 'y' : 'ies'} left behind:`);
  for (const { path, reason, during: fixture } of still) {
    console.error(`  ${path}${fixture === null ? '' : ` (${fixture})`}: ${reason}`);
  }
  return true;
}
