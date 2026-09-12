/**
 * Every pinned version in this repository, checked against what upstream has published.
 *
 * Dependabot watches two things: the dependencies in package.json and the `uses:` digests in the
 * workflows. It cannot see a version passed as an action input, an inline `pip install x==y`, a
 * version inside a URL, or a pin held in a script, and this repository has ten of those: the
 * engine itself, gdtoolkit, the Python version, actionlint, zizmor and the Biome schema URL.
 *
 * The important half is not the report. It is that PINS below is compared against every version
 * literal this script can find in the files it knows about, and an unrecognised one fails the
 * run. A pin that nothing watches is the failure mode this exists to prevent, so a new pin
 * cannot arrive quietly; it either joins the table or it fails the check.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** How to ask each upstream what its newest release is. */
const SOURCES = {
  async npm(name) {
    const body = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    return body['dist-tags']?.latest;
  },
  async pypi(name) {
    const body = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    return body.info?.version;
  },
  /** Newest non-prerelease tag, filtered by a pattern so Godot 3.x does not answer for 4.x. */
  async githubRelease(repo, pattern) {
    const body = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=30`);
    const match = body.find(
      (release) => !release.prerelease && !release.draft && pattern.test(release.tag_name),
    );
    return match?.tag_name;
  },
};

/**
 * Each entry says where the pin lives, how to read it out of that file, and where to ask about
 * it. `extract` returning null is itself a failure: it means the file moved on and the checker
 * is now reporting on a line that is not there.
 */
const PINS = [
  {
    name: 'godot',
    file: 'scripts/install-godot.mjs',
    extract: (text) => /const VERSION = '([^']+)'/.exec(text)?.[1],
    current: () => SOURCES.githubRelease('godotengine/godot', /^4\./),
    note: 'raising this means raising the three SHA-512 digests beside it',
  },
  {
    name: 'gdtoolkit',
    file: '.github/workflows/ci.yml',
    extract: (text) => /pip install gdtoolkit==([0-9][^\s]*)/.exec(text)?.[1],
    current: () => SOURCES.pypi('gdtoolkit'),
  },
  {
    name: 'python',
    file: '.github/workflows/ci.yml',
    extract: (text) => /python-version: '([^']+)'/.exec(text)?.[1],
    current: async () => {
      const body = await fetchJson('https://endoflife.date/api/python.json');
      return body[0]?.cycle;
    },
    compare: 'minor',
  },
  {
    name: 'actionlint',
    file: '.github/workflows/workflows.yml',
    extract: (text) => /bash download-actionlint\.bash ([0-9][^\s]*)/.exec(text)?.[1],
    current: () => SOURCES.githubRelease('rhysd/actionlint', /^v/).then((tag) => tag?.replace(/^v/, '')),
  },
  {
    name: 'zizmor',
    file: '.github/workflows/workflows.yml',
    extract: (text) => /version: ([0-9][^\s]*)/.exec(text)?.[1],
    current: () => SOURCES.pypi('zizmor'),
  },
  {
    name: 'biome schema url',
    file: 'biome.jsonc',
    extract: (text) => /biomejs\.dev\/schemas\/([^/]+)\//.exec(text)?.[1],
    current: () => SOURCES.npm('@biomejs/biome'),
    note: 'must match the @biomejs/biome devDependency, which Dependabot does bump',
  },
  {
    name: 'bun',
    file: 'package.json',
    extract: (text) => /"packageManager": "bun@([^"]+)"/.exec(text)?.[1],
    current: () => SOURCES.npm('bun'),
  },
];

/**
 * Files this script claims to cover, and the version literals in them it already knows about.
 * Anything else that looks like a version in one of these files is an unwatched pin.
 */
const COVERED_FILES = [
  'scripts/install-godot.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/workflows.yml',
];

/** Version-shaped strings that are not pins, with why each one is exempt. */
const NOT_A_PIN = [
  /[0-9a-f]{128}/, // a SHA-512 digest, which moves with the version above it
  /@[0-9a-f]{40}/, // an action pinned by commit, which Dependabot owns
  /such as 1\.0\.0/, // prose in a workflow input description
  /actionlint 1\.7\.12 rejects/, // prose in a comment, next to the real pin
];

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'gdharness-pin-check' } });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

/** True when the pinned version is the newest one, comparing only as far as the pin spells it. */
function isCurrent(pinned, latest, compare) {
  if (compare === 'minor') {
    return latest.startsWith(pinned);
  }
  return latest === pinned || latest === pinned.replace(/-stable$/, '');
}

/**
 * Every version-looking literal in the covered files that no entry in PINS accounts for. This is
 * the half that stops a new pin arriving unwatched.
 */
function unwatchedPins(pinnedValues) {
  const found = [];

  for (const file of COVERED_FILES) {
    const text = read(file);
    for (const [index, line] of text.split('\n').entries()) {
      const versions = line.match(/\b\d+\.\d+(\.\d+)?(-[a-z]+)?\b/g) ?? [];
      for (const version of versions) {
        if (pinnedValues.has(version)) continue;
        if (NOT_A_PIN.some((pattern) => pattern.test(line))) continue;
        found.push(`${file}:${index + 1}: ${version} in "${line.trim()}"`);
      }
    }
  }

  return found;
}

/**
 * Two modes, because they answer different questions and belong in different places.
 *
 * `--offline` asks only "is every pin in these files accounted for". It needs no network, gives
 * the same answer every time, and so can gate every pull request. Asking upstream cannot: a
 * release published this morning would turn somebody's unrelated change red.
 *
 * The full run also asks "is each pin the newest", which is a question for a schedule.
 */
async function main() {
  const offline = process.argv.includes('--offline');
  const rows = [];
  const problems = [];
  const behind = [];
  const pinnedValues = new Set();

  for (const pin of PINS) {
    const pinned = pin.extract(read(pin.file));
    if (!pinned) {
      problems.push(`${pin.name}: could not read a version out of ${pin.file}; the file moved on`);
      continue;
    }

    pinnedValues.add(pinned);
    pinnedValues.add(pinned.replace(/-stable$/, ''));

    if (offline) {
      rows.push(`  ${pin.name.padEnd(18)} pinned ${pinned}`);
      continue;
    }

    const latest = await pin.current();
    if (!latest) {
      problems.push(`${pin.name}: upstream did not say what its newest version is`);
      continue;
    }

    const current = isCurrent(pinned, latest, pin.compare);
    rows.push(`${current ? '  ' : '! '}${pin.name.padEnd(18)} pinned ${pinned.padEnd(16)} latest ${latest}`);
    if (!current) {
      behind.push(`${pin.name} ${pinned} -> ${latest}${pin.note ? ` (${pin.note})` : ''}`);
    }
  }

  const unwatched = unwatchedPins(pinnedValues);

  console.log(rows.join('\n'));

  if (unwatched.length > 0) {
    problems.push(
      ['version literals that no entry in PINS accounts for:', ...unwatched.map((line) => `  ${line}`)].join(
        '\n',
      ),
    );
  }
  if (behind.length > 0) {
    problems.push(['pins behind their upstream:', ...behind.map((line) => `  ${line}`)].join('\n'));
  }

  if (problems.length > 0) {
    console.error(`\n${problems.join('\n')}`);
    process.exit(1);
  }
}

await main();
