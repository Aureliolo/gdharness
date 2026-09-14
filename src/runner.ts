/**
 * Which of the two package runners is spelling our name, and how that line reads.
 *
 * Its own module because both halves need it and neither should reach into the other: the CLI
 * writes this line into a harness config, and the server puts it in front of an agent when there
 * is a newer release. Somebody who installed with `bunx` may not have Node at all, so answering
 * either of them with `npx` hands over a command that does not exist on their machine.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

export type Runner = 'npx' | 'bunx';

/** Whichever runner is running us. */
export function currentRunner(): Runner {
  // Bun's own types declare versions.bun as always present, which it is not under Node.
  const versions: Readonly<Record<string, string | undefined>> = process.versions;
  return versions['bun'] === undefined ? 'npx' : 'bunx';
}

/** What a runner is typed as, which is the same line a config holds. */
export function runLine(runner: Runner, version: string, rest = ''): string {
  // `-y` is npm's "do not stop and ask before fetching this"; bunx has no such prompt.
  const flag = runner === 'npx' ? '-y ' : '';
  return `${runner} ${flag}gdharness@${version}${rest === '' ? '' : ` ${rest}`}`;
}

/** How a harness is told to start us: the program to spawn and the arguments before ours. */
export interface Spawn {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * What actually spawns [param runner] on this machine, preferring a path to a bare name.
 *
 * A harness spawns whatever a config names, and it spawns it the way the operating system does:
 * by name, through PATH. The runner's name is not always there. A Bun installed under a project
 * rather than into a home directory, which is what a pinned toolchain looks like, ships a `bun`
 * and no `bunx` beside it, so `bunx` resolves to nothing and the entry we wrote starts no server
 * at all. Found by a project that installs Bun under `.tools/`: setup reported success and the
 * harness could not spawn the thing it had just been told about.
 *
 * Naming the binary we are already running removes the question, and costs nothing: every entry
 * carries an absolute GODOT_PATH already, so one of these configs was never portable between
 * machines. `bunx x` is `bun x`, which is why Bun needs no second executable to be found.
 *
 * The bare name is still the answer when the runner asked for is not the one running us, because
 * then there is no path to know: somebody on Node asking for the bunx line gets the bunx line.
 *
 * **`--bun` on every Bun entry.** Our published bundles carry a Node shebang, because npx is Node
 * and that line has to work; a runner honours a shebang, so a plain `bun x` hands the file to
 * whatever Node the machine happens to have. An entry naming a pinned Bun and then starting a
 * server under an unpinned Node is a config that says one thing and does another, and it makes
 * the runtime the server runs under depend on machine state. The flag says run it under the Bun
 * the entry names. Nothing is lost where there is no Node: that is what Bun would have done.
 */
export function spawnFor(runner: Runner, version: string, execPath = process.execPath): Spawn {
  const spec = `gdharness@${version}`;
  if (runner !== currentRunner()) {
    return { command: runner, args: runner === 'npx' ? ['-y', spec] : ['--bun', spec] };
  }
  if (runner === 'bunx') {
    return { command: execPath, args: ['x', '--bun', spec] };
  }
  return { command: alongside(execPath, 'npx') ?? 'npx', args: ['-y', spec] };
}

/**
 * npm's runner beside the Node that is running us, or nothing when it is not there.
 *
 * npx ships with Node and sits in the same directory, so the Node we were started with names it
 * without a search. Absent in one real case worth allowing for, a Node built or unpacked without
 * npm, and then the bare name is all there is to offer.
 */
function alongside(execPath: string, name: string): string | undefined {
  const runner = join(dirname(execPath), process.platform === 'win32' ? `${name}.cmd` : name);
  return existsSync(runner) ? runner : undefined;
}
