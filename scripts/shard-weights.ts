/**
 * Raises the regression weights in test/support/shards.ts to what a CI run's engine legs took.
 *
 * Usage: `bun scripts/shard-weights.ts <run id>`. It reads every "regressions n/m" job of the run
 * through `gh`, takes each regression's "took" line, and keeps the larger of that and the table's
 * figure. A regression under five seconds stays out of the table, as the table's comment says.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSyncHidden } from '../src/spawn.js';

type Platform = 'linux' | 'win32' | 'darwin';

const TABLE = join(import.meta.dirname, '..', 'test', 'support', 'shards.ts');
const PLATFORMS: Readonly<Record<string, Platform>> = { linux: 'linux', windows: 'win32', macos: 'darwin' };
const SMALLEST = 5;

function gh(args: readonly string[]): string {
  const ran = spawnSyncHidden('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (ran.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${ran.stderr.trim()}`);
  }
  return ran.stdout;
}

/** The longest each regression took on each platform in the run's engine legs. */
function tookIn(
  logs: ReadonlyArray<{ readonly platform: Platform; readonly log: string }>,
): Record<Platform, Map<string, number>> {
  const took: Record<Platform, Map<string, number>> = {
    linux: new Map(),
    win32: new Map(),
    darwin: new Map(),
  };
  for (const { platform, log } of logs) {
    for (const [, name = '', seconds = '0'] of log.matchAll(/\s(test\w+) took ([\d.]+)s/gu)) {
      took[platform].set(name, Math.max(took[platform].get(name) ?? 0, Number(seconds)));
    }
  }
  return took;
}

/** [param source] with each platform's block raised to [param took], heaviest first. */
function raised(source: string, took: Readonly<Record<Platform, ReadonlyMap<string, number>>>): string {
  let text = source;
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    const block = new RegExp(`\\n  ${platform}: \\{\\n([\\s\\S]*?)\\n  \\},`, 'u').exec(text);
    if (block?.[1] === undefined) {
      throw new Error(`${TABLE} has no ${platform} block.`);
    }
    const weights = new Map<string, number>();
    for (const [, name = '', seconds = '0'] of block[1].matchAll(/(\w+): (\d+),/gu)) {
      weights.set(name, Number(seconds));
    }
    for (const [name, seconds] of took[platform]) {
      const rounded = Math.round(seconds);
      if (rounded >= SMALLEST && rounded > (weights.get(name) ?? 0)) {
        weights.set(name, rounded);
      }
    }
    const lines = [...weights]
      .toSorted((a, b) => b[1] - a[1])
      .map(([name, seconds]) => `    ${name}: ${String(seconds)},`);
    text = text.replace(block[0], `\n  ${platform}: {\n${lines.join('\n')}\n  },`);
  }
  return text;
}

if (import.meta.main) {
  const run = process.argv[2];
  if (run === undefined || !/^\d+$/u.test(run)) {
    console.error('Give the CI run id: bun scripts/shard-weights.ts <run id>');
    process.exit(2);
  }
  const jobs = gh([
    'api',
    `repos/Aureliolo/gdharness/actions/runs/${run}/jobs?per_page=100`,
    '--paginate',
    '--jq',
    '.jobs[] | select(.status == "completed" and (.name | test("regressions [0-9]+/"))) | "\\(.id) \\(.name)"',
  ])
    .split('\n')
    .filter((line) => line !== '');
  const logs = jobs.map((line) => {
    const [id = '', ...name] = line.split(' ');
    const leg = /engine (\w+)/u.exec(name.join(' '))?.[1] ?? '';
    const platform = PLATFORMS[leg];
    if (platform === undefined) {
      throw new Error(`Job ${line} names no platform this table holds.`);
    }
    return {
      platform,
      log: gh(['api', '--allow-escape-sequences', `repos/Aureliolo/gdharness/actions/jobs/${id}/logs`]),
    };
  });
  const before = readFileSync(TABLE, 'utf8');
  const after = raised(before, tookIn(logs));
  writeFileSync(TABLE, after);
  console.log(
    after === before ? 'No weight changed.' : `Raised the weights from ${String(logs.length)} jobs.`,
  );
}
