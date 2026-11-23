/**
 * Two regressions through the runner's own step, with a deadline of three seconds. The first starts
 * a server that answers its opening and never a tool call, then an engine that runs for twenty
 * seconds, so it is still running at its deadline. The second prints how long after the first
 * began it started. The engine is waited for before the process ends, so it leaves nothing running.
 * Usage: deadline-run.ts
 */
import { join } from 'node:path';
import process from 'node:process';
import { runEngine } from '../../src/engine-run.js';
import { type RegressionRun, runOneRegression, settledWithin } from './regression-run.js';
import { ServerProcess } from './server.js';

const ENGINE_MS = 20_000;
let began = 0;
let engine: Promise<unknown> = Promise.resolve();

async function holdsAnEnginePastItsDeadline(): Promise<void> {
  began = Date.now();
  const server = new ServerProcess({ entry: join(import.meta.dirname, 'unanswering-server.ts') });
  await server.initialize('deadline-run');
  server
    .request('tools/call', { name: 'resource_edit', arguments: { op: 'set_theme_color' } }, 60_000)
    .catch(() => undefined);
  engine = runEngine(process.execPath, ['-e', `setTimeout(() => {}, ${String(ENGINE_MS)})`]);
  await engine;
}

function saysWhenItStarts(): void {
  console.log(`the next test started ${String(Date.now() - began)} ms after the first began`);
}

const run: RegressionRun = {
  failed: [],
  ranPast: [],
  deadlineMs: 3_000,
  budgetMs: Number.POSITIVE_INFINITY,
  runEnds: Number.POSITIVE_INFINITY,
};
for (const test of [holdsAnEnginePastItsDeadline, saysWhenItStarts]) {
  await runOneRegression(test, run);
}
console.log(`failed: ${run.failed.join(', ')}`);
await settledWithin(engine, ENGINE_MS + 10_000);
process.exit(0);
