/**
 * Raises the regression weights in test/support/shards.ts to what a CI run's engine legs took.
 *
 * Usage: `bun scripts/shard-weights.ts <run id>`. It reads every "regressions n/m" job of the run
 * through `gh`, takes each regression's "took" line, and keeps the larger of that and the table's
 * figure, whichever platform it came from. A regression under five seconds stays out of the table,
 * as the table's comment says.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSyncHidden } from '../src/spawn.js';

const TABLE = join(import.meta.dirname, '..', 'test', 'support', 'shards.ts');
const SMALLEST = 5;

function gh(args: readonly string[]): string {
  const ran = spawnSyncHidden('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (ran.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${ran.stderr.trim()}`);
  }
  return ran.stdout;
}

/** The longest each regression took in the run's engine legs. */
function tookIn(logs: readonly string[]): Map<string, number> {
  const took = new Map<string, number>();
  for (const log of logs) {
    for (const [, name = '', seconds = '0'] of log.matchAll(/\s(test\w+) took ([\d.]+)s/gu)) {
      took.set(name, Math.max(took.get(name) ?? 0, Number(seconds)));
    }
  }
  return took;
}

/** [param source] with the table raised to [param took], heaviest first. */
function raised(source: string, took: ReadonlyMap<string, number>): string {
  const block = /\nexport const REGRESSION_SECONDS[^{]*\{\n([\s\S]*?)\n\};/u.exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${TABLE} has no weights table.`);
  }
  const weights = new Map<string, number>();
  for (const [, name = '', seconds = '0'] of block[1].matchAll(/(\w+): (\d+),/gu)) {
    weights.set(name, Number(seconds));
  }
  for (const [name, seconds] of took) {
    const rounded = Math.round(seconds);
    if (rounded >= SMALLEST && rounded > (weights.get(name) ?? 0)) {
      weights.set(name, rounded);
    }
  }
  const lines = [...weights]
    .toSorted((a, b) => b[1] - a[1])
    .map(([name, seconds]) => `  ${name}: ${String(seconds)},`);
  return source.replace(
    block[0],
    () => `\nexport const REGRESSION_SECONDS: Readonly<Record<string, number>> = {\n${lines.join('\n')}\n};`,
  );
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
    '.jobs[] | select(.status == "completed" and (.name | test("regressions [0-9]+/"))) | .id',
  ])
    .split('\n')
    .filter((line) => line !== '');
  const logs = jobs.map((id) =>
    gh(['api', '--allow-escape-sequences', `repos/Aureliolo/gdharness/actions/jobs/${id}/logs`]),
  );
  const before = readFileSync(TABLE, 'utf8');
  const after = raised(before, tookIn(logs));
  writeFileSync(TABLE, after);
  console.log(
    after === before ? 'No weight changed.' : `Raised the weights from ${String(logs.length)} jobs.`,
  );
}
