/**
 * Six regressions through the runner's own step, with a deadline of three seconds. The first starts
 * a server that answers its opening and never a tool call, then an engine that runs for twenty
 * seconds, so it is still running at its deadline. The third holds an engine that never ends past
 * its deadline, and the fifth ends after a second and leaves such an engine running. The tests
 * between print how long after the test before them began they started, then end the engine that
 * never ends, so only a runner that waited on it is held until this run ends it itself. The engines
 * are waited for before the process ends, so it leaves nothing running.
 * Usage: deadline-run.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { runEngine } from '../../src/engine-run.js';
import { type RegressionRun, runOneRegression, settledWithin } from './regression-run.js';
import { ServerProcess } from './server.js';

const ENGINE_MS = 20_000;
/**
 * How long this run lets an engine that never ends run before it ends it, so a runner that waits on
 * one reads as a wait this long rather than a run that never finishes.
 */
const NEVER_ENDS_MS = 30_000;
/** How long such an engine runs if this run is killed before it ends it. */
const NEVER_ENDS_ALONE_MS = 120_000;
const stops = mkdtempSync(join(tmpdir(), 'gdharness-deadline-run-'));
let began = 0;
const engines: Promise<unknown>[] = [];
let endTheEngineThatNeverEnds = (): void => undefined;

function engineOfTwentySeconds(): Promise<unknown> {
  const engine = runEngine(process.execPath, ['-e', `setTimeout(() => {}, ${String(ENGINE_MS)})`]);
  engines.push(engine);
  return engine;
}

/** An engine that runs until its stop file is written, named as its last argument. */
function engineThatNeverEnds(): Promise<unknown> {
  const stop = join(stops, `stop-${String(engines.length)}`);
  const engine = runEngine(process.execPath, [
    '-e',
    `const stop = process.argv.at(-1); setInterval(() => { if (require('node:fs').existsSync(stop)) process.exit(0); }, 100); setTimeout(() => process.exit(0), ${String(NEVER_ENDS_ALONE_MS)})`,
    stop,
  ]);
  const end = (): void => {
    if (!existsSync(stop)) {
      writeFileSync(stop, '');
    }
  };
  const timer = setTimeout(end, NEVER_ENDS_MS);
  endTheEngineThatNeverEnds = (): void => {
    clearTimeout(timer);
    end();
  };
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

async function holdsAnEngineThatNeverEndsPastItsDeadline(): Promise<void> {
  began = Date.now();
  await engineThatNeverEnds();
}

function saysWhenItStarts(): void {
  console.log(`the next test started ${String(Date.now() - began)} ms after the one before began`);
  endTheEngineThatNeverEnds();
}

async function leavesAnEngineThatNeverEndsRunning(): Promise<void> {
  began = Date.now();
  void engineThatNeverEnds();
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
  holdsAnEngineThatNeverEndsPastItsDeadline,
  saysWhenItStarts,
  leavesAnEngineThatNeverEndsRunning,
  saysWhenItStarts,
]) {
  await runOneRegression(test, run);
}
console.log(`failed: ${run.failed.join(', ')}`);
await settledWithin(Promise.all(engines), ENGINE_MS + 10_000);
rmSync(stops, { recursive: true, force: true });
process.exit(0);
