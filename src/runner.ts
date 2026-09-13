/**
 * Which of the two package runners is spelling our name, and how that line reads.
 *
 * Its own module because both halves need it and neither should reach into the other: the CLI
 * writes this line into a harness config, and the server puts it in front of an agent when there
 * is a newer release. Somebody who installed with `bunx` may not have Node at all, so answering
 * either of them with `npx` hands over a command that does not exist on their machine.
 */

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
