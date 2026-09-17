/**
 * The changelog half of a release's notes, split by whether an entry reaches the reader's machine.
 *
 * GitHub's `--generate-notes` writes one flat list of pull request titles, and a title describes
 * the change rather than its blast radius. "A live foreign run is not ended" is a test in this
 * repository; "A transcript answers what was printed" is the server behaving differently. Both
 * read the same in that list, and two projects downstream of this one decided which release to
 * take by reading it. Both picked wrong, in the same direction, on the same day: they upgraded for
 * a fixture that changes nothing they install, while the release that actually answered their
 * problem sat unread one number below.
 *
 * So the split is computed from the files each pull request touched rather than from its title, a
 * label somebody remembers to add, or a naming habit. A release note is otherwise a claim about a
 * release rather than a reading of one.
 *
 * This replaces `--generate-notes`, and with it `.github/release.yml`, whose one job was dropping
 * the version-bump pull request. That exclusion lives in `IS_THE_RELEASE_ITSELF` below. Two things
 * that file knew are worth keeping: the configuration used to be read from the release's target
 * commit rather than from the default branch, so regenerating an old tag's notes to check a change
 * tested the old file and produced a null result that reads like a verdict; and dependency updates
 * stay in, because this is distributed as a bundle and a raised dependency changes what somebody
 * installs.
 */

import { isNewer } from '../src/update-check.js';

/** A tag as the version inside it, since the ordering is over versions and the tags carry a v. */
function version(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/** Everything `package.json`'s `files` ships, plus what decides how the bundle is built. */
const SHIPPED = [
  // Compiled into `build/`, which is the package. The Godot addons live under it too.
  'src/',
  // Dependencies, engines, `bin`: all of it is what `npx gdharness` resolves and runs.
  'package.json',
  // Shipped inside the tarball and the whole of the npm landing page.
  'README.md',
  'LICENSE',
  // Not shipped itself, but it is what assembles the thing that is.
  'scripts/build-release.ts',
];

/** The label `release-prepare.yml` puts on the pull request that only raises the version. */
const IS_THE_RELEASE_ITSELF = 'release';

/**
 * Whether a change reaches somebody who installs this, given every file it touched.
 *
 * One shipped file is enough. A pull request that fixes a tool and adds the fixture for it is a
 * change you install, and listing it anywhere else would be the same misreading in reverse.
 */
export function shipsToUsers(files: readonly string[]): boolean {
  return files.some((file) =>
    SHIPPED.some((shipped) => (shipped.endsWith('/') ? file.startsWith(shipped) : file === shipped)),
  );
}

interface Entry {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly ships: boolean;
}

/** The two lists, as the markdown that goes under the release's own preamble. */
export function renderNotes(entries: readonly Entry[], repository: string, from: string, to: string): string {
  const lines = ["## What's Changed", ''];
  const sections: readonly [string, boolean][] = [
    ['In what you install', true],
    ['Repository only: tests, docs, CI', false],
  ];
  for (const [heading, ships] of sections) {
    const listed = entries.filter((entry) => entry.ships === ships);
    if (listed.length === 0) {
      continue;
    }
    lines.push(`### ${heading}`, '');
    for (const entry of listed) {
      lines.push(
        `* ${entry.title} by @${entry.author} in https://github.com/${repository}/pull/${entry.number}`,
      );
    }
    lines.push('');
  }
  lines.push(`**Full Changelog**: https://github.com/${repository}/compare/${from}...${to}`);
  return `${lines.join('\n')}\n`;
}

/** Every pull request squashed onto this range, in the order they landed. */
export function pullRequestNumbers(subjects: readonly string[]): readonly number[] {
  const seen = new Set<number>();
  for (const subject of subjects) {
    const match = /\(#(\d+)\)\s*$/.exec(subject.split('\n')[0] ?? '');
    if (match?.[1] !== undefined) {
      seen.add(Number(match[1]));
    }
  }
  return [...seen];
}

async function gh<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(process.env['GH_TOKEN'] === undefined
        ? {}
        : { authorization: `Bearer ${process.env['GH_TOKEN']}` }),
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} answered ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const tag = process.argv[2];
  const repository = process.env['GITHUB_REPOSITORY'];
  if (tag === undefined || repository === undefined) {
    throw new Error('Usage: bun scripts/release-notes.ts <tag>, with GITHUB_REPOSITORY set.');
  }

  // The releases list rather than the tags list, because tags come back in an order that is not
  // the order they were cut.
  //
  // The newest release *below this tag*, rather than simply the newest that is not it. At release
  // time those are the same thing, since this tag has no release yet, so the difference only shows
  // when the script is pointed at a tag already published: it then compares against something
  // newer, the range comes back empty, and the notes say a release changed nothing. Which is how
  // this was found. A generator that is only correct when run at exactly one moment is one nobody
  // can check afterwards, and checking it afterwards is the whole point of deriving it from diffs.
  const releases = await gh<{ tag_name: string }[]>(`repos/${repository}/releases?per_page=30`);
  const previous = releases
    .map((release) => release.tag_name)
    .filter((name) => isNewer(version(tag), version(name)))
    .sort((left, right) => (isNewer(version(left), version(right)) ? -1 : 1))
    .at(0);
  if (previous === undefined) {
    throw new Error(`No release older than ${tag} to compare against.`);
  }

  const compared = await gh<{ commits: { commit: { message: string } }[] }>(
    `repos/${repository}/compare/${previous}...${tag}`,
  );
  const numbers = pullRequestNumbers(compared.commits.map((entry) => entry.commit.message));

  const entries: Entry[] = [];
  for (const number of numbers) {
    const pull = await gh<{
      title: string;
      user: { login: string };
      labels: { name: string }[];
    }>(`repos/${repository}/pulls/${number}`);
    if (pull.labels.some((label) => label.name === IS_THE_RELEASE_ITSELF)) {
      continue;
    }
    const files = await gh<{ filename: string }[]>(`repos/${repository}/pulls/${number}/files?per_page=100`);
    entries.push({
      number,
      title: pull.title,
      author: pull.user.login,
      ships: shipsToUsers(files.map((file) => file.filename)),
    });
  }

  process.stdout.write(renderNotes(entries, repository, previous, tag));
}

if (import.meta.main) {
  await main();
}
