/**
 * Four regressions through the runner's own step, with a deadline of three seconds. The first starts
 * a server that answers its opening and never a tool call, then an engine that runs for twenty
 * seconds, so it is still running at its deadline. The third ends after a second and leaves such an
 * engine running. The second and the fourth print how long after the test before them began they
 * started. The engines are waited for before the process ends, so it leaves nothing running.
 * Usage: deadline-run.ts
 */
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { runEngine } from '../../src/engine-run.js';
import { type RegressionRun, runOneRegression, settledWithin } from './regression-run.js';
import { ServerProcess } from './server.js';

const ENGINE_MS = 20_000;
let began = 0;
const engines: Promise<unknown>[] = [];

function engineOfTwentySeconds(): Promise<unknown> {
  const engine = runEngine(process.execPath, ['-e', `setTimeout(() => {}, ${String(ENGINE_MS)})`]);
  engines.push(engine);
  return engine;
}

async function holdsAnEnginePastItsDeadline(): Promise<void> {
  began = Date.now();
  const server = new ServerProcess({ entry: join(import.meta.dirname, 'unanswering-server.ts') });
  await server.initialize('deadline-run');
  server
    .request('tools/call', { name: 'resource_edit', arguments: { op: 'set_theme_color' } }, 60_000)
    .catch(() => undefined);
  await engineOfTwentySeconds();
}

function saysWhenItStarts(): void {
  console.log(`the next test started ${String(Date.now() - began)} ms after the one before began`);
}

async function leavesAnEngineRunning(): Promise<void> {
  began = Date.now();
  void engineOfTwentySeconds();
  // Long enough for the engine to be with the helper when the test ends.
  await delay(1_000);
}

const run: RegressionRun = {
  failed: [],
  ranPast: [],
  deadlineMs: 3_000,
  budgetMs: Number.POSITIVE_INFINITY,
  runEnds: Number.POSITIVE_INFINITY,
};
for (const test of [
  holdsAnEnginePastItsDeadline,
  saysWhenItStarts,
  leavesAnEngineRunning,
  saysWhenItStarts,
]) {
  await runOneRegression(test, run);
}
console.log(`failed: ${run.failed.join(', ')}`);
await settledWithin(Promise.all(engines), ENGINE_MS + 10_000);
process.exit(0);
