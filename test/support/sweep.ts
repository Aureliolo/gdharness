import { discard, type Surviving } from '../../src/scratch.js';

/**
 * A fixture's temporary directories, removed the way the server removes its own.
 *
 * The removal itself is `discard`, so the fixtures exercise the production sweep rather than a
 * second copy of it that could drift. What is added here is the part only a test run wants: the
 * paths that survived are collected across the whole run and named at the end, because a suite that
 * leaks quietly leaks for months. This one had, on six separate days, and the run that leaked a pair
 * of directories had swept the first of them before failing on the second.
 */

const survived: (Surviving & { during: string | null })[] = [];

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
  survived.push(...discard(...paths).map((left) => ({ ...left, during })));
}

/**
 * Names what is still there, and answers whether anything is.
 *
 * Worth a line but not a failed run: these sit in the system temporary directory, the operating
 * system clears them eventually, and failing the suite over one would make a green run depend on how
 * promptly Windows let go of a handle.
 */
export function reportUnswept(): boolean {
  if (survived.length === 0) {
    return false;
  }
  console.error(`${survived.length} temporary director${survived.length === 1 ? 'y' : 'ies'} left behind:`);
  for (const { path, reason, during: fixture } of survived) {
    console.error(`  ${path}${fixture === null ? '' : ` (${fixture})`}: ${reason}`);
  }
  return true;
}
