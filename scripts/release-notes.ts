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

import { isRecord } from '../src/records.js';
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

/**
 * The commit in `history` whose subject is `subject`, newest first, so a release's own commit can
 * be found again on a history that was rewritten under it.
 *
 * The history from the fork on was rewritten after 1.3.6, and GitHub never moves the tag of an
 * immutable release, so the tags up to that one point into a history no later tag descends from.
 * Comparing across the two lists every commit since the fork. The rewrite kept every subject.
 */
export function counterpart(
  subject: string,
  history: readonly { readonly sha: string; readonly message: string }[],
): string | undefined {
  return history.find((entry) => entry.message.split('\n')[0] === subject)?.sha;
}

async function gh(path: string): Promise<unknown> {
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
  const answered: unknown = await response.json();
  return answered;
}

function field(value: unknown, key: string, what: string): unknown {
  if (!isRecord(value)) {
    throw new Error(`GitHub answered ${what} with something other than an object.`);
  }
  return value[key];
}

function text(value: unknown, key: string, what: string): string {
  const found = field(value, key, what);
  if (typeof found !== 'string') {
    throw new Error(`GitHub answered ${what} without a string ${key}.`);
  }
  return found;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`GitHub answered ${what} with something other than a list.`);
  }
  return value;
}

/** The subject and body of each commit in [param listed], a list of commits as GitHub writes them. */
function messagesOf(listed: unknown, what: string): string[] {
  return list(listed, what).map((entry) => text(field(entry, 'commit', what), 'message', what));
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
  const releases = list(await gh(`repos/${repository}/releases?per_page=30`), 'the releases');
  const previous = releases
    .map((release) => text(release, 'tag_name', 'a release'))
    .filter((name) => isNewer(version(tag), version(name)))
    .toSorted((left, right) => (isNewer(version(left), version(right)) ? -1 : 1))
    .at(0);
  if (previous === undefined) {
    throw new Error(`No release older than ${tag} to compare against.`);
  }

  let from = previous;
  let compared = await gh(`repos/${repository}/compare/${previous}...${tag}`);
  if (text(compared, 'status', 'the comparison') === 'diverged') {
    const tagged = await gh(`repos/${repository}/commits/${previous}`);
    const subject =
      text(field(tagged, 'commit', 'the tagged commit'), 'message', 'the tagged commit').split('\n')[0] ?? '';
    const history = list(await gh(`repos/${repository}/commits?sha=${tag}&per_page=100`), 'the history');
    const found = counterpart(
      subject,
      history.map((entry) => ({
        sha: text(entry, 'sha', 'a commit'),
        message: text(field(entry, 'commit', 'a commit'), 'message', 'a commit'),
      })),
    );
    if (found === undefined) {
      throw new Error(
        `${tag} does not descend from ${previous}, and none of its last 100 commits is "${subject}".`,
      );
    }
    from = found;
    compared = await gh(`repos/${repository}/compare/${from}...${tag}`);
  }
  const numbers = pullRequestNumbers(
    messagesOf(field(compared, 'commits', 'the comparison'), 'a compared commit'),
  );

  const entries: Entry[] = [];
  for (const number of numbers) {
    const pull = await gh(`repos/${repository}/pulls/${number}`);
    const labels = list(field(pull, 'labels', 'a pull request'), 'the labels of a pull request');
    if (labels.some((label) => text(label, 'name', 'a label') === IS_THE_RELEASE_ITSELF)) {
      continue;
    }
    const files = list(
      await gh(`repos/${repository}/pulls/${number}/files?per_page=100`),
      'the files of a pull request',
    );
    entries.push({
      number,
      title: text(pull, 'title', 'a pull request'),
      author: text(field(pull, 'user', 'a pull request'), 'login', 'the author of a pull request'),
      ships: shipsToUsers(files.map((file) => text(file, 'filename', 'a changed file'))),
    });
  }

  process.stdout.write(renderNotes(entries, repository, from, tag));
}

if (import.meta.main) {
  await main();
}
