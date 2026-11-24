import { retireHelper } from '../../src/desktop.js';
import { beginWindow } from './open-handles.js';
import { serversSaidAtADeadline, stopServersOf } from './server.js';
import { slotsSaid, withTheSuitesOwnSlotVariables } from './slots.js';
import { endEnginesLeft, leftBehindBy, lookUnder, runAsFixture, sweepingFor } from './sweep.js';

/** One test of the list, as the runner takes it. */
export type RegressionCase = () => void | Promise<void>;

/** What the runner keeps while it goes down the list. */
export interface RegressionRun {
  failed: string[];
  ranPast: string[];
  deadlineMs: number;
  budgetMs: number;
  runEnds: number;
}

/**
 * How long the runner waits for the desktop helper to end after a test that ended in time. Its
 * engines have ended by then, so it goes within a second. One that holds an engine longer must not
 * hold the run with it.
 */
const HELPER_RETIRE_MS = 10_000;

/** Whether [param promise] settles within [param ms]. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((settle) => {
        timer = setTimeout(() => {
          settle(false);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fails each fixture that left an engine running, passed or not: it takes a core from every fixture
 * after it, and a frame rate case run beside one read the machine rather than the code. Looked for
 * at once after a failure or a directory left behind, since those are how it shows, and once more
 * over the whole run, since on Linux and macOS a held directory is removed all the same.
 */
export function recordEnginesLeftRunning(
  engines: { pid: number; under: string; during: string | null }[],
  failed: string[],
): void {
  for (const { pid, under, during } of engines) {
    const name = during ?? 'a fixture';
    console.error(`${name} left engine ${pid} running under ${under}; it has been ended`);
    if (!failed.includes(name)) {
      failed.push(name);
    }
  }
}

/** What a rejection reads as in the log. */
function saidOfAFailure(error: unknown): string | undefined {
  // A thrown event is not an Error and prints as "[object ErrorEvent]", so its message is added.
  return error instanceof Error
    ? error.stack
    : typeof error === 'object' && error !== null && 'message' in error
      ? `${Object.prototype.toString.call(error)}: ${String(error.message)}`
      : String(error);
}

/** Runs one test against its deadline, then sweeps the engines and servers it left. */
export async function runOneRegression(test: RegressionCase, run: RegressionRun): Promise<void> {
  const { failed, ranPast, deadlineMs, budgetMs, runEnds } = run;
  withTheSuitesOwnSlotVariables();
  sweepingFor(test.name);
  // Said before the test runs, since a job that never ends keeps no log and the live page is all
  // that names the test it was in.
  console.log(`start ${test.name}`);
  const endWindow = beginWindow(test.name);
  let passed = true;
  const began = Date.now();
  const allowedMs = Math.min(deadlineMs, runEnds - began);
  let deadline: NodeJS.Timeout | undefined;
  const running = Promise.resolve().then(() => runAsFixture(test.name, test));
  // A test that settles after its deadline has nobody waiting on it any more.
  running.catch(() => undefined);
  try {
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          ranPast.push(test.name);
          const took = `${(allowedMs / 1000).toFixed(1)}s after it started`;
          reject(
            new Error(
              allowedMs < deadlineMs
                ? `${test.name} was still running when the run's ${budgetMs / 1000}s ran out, ${took}`
                : `${test.name} was still running ${took}`,
            ),
          );
        }, allowedMs);
      }),
    ]);
  } catch (error) {
    passed = false;
    failed.push(test.name);
    console.error(`\n${test.name} failed\n${saidOfAFailure(error)}\n`);
  } finally {
    clearTimeout(deadline);
    endWindow();
  }
  // Said for the slow ones, so a leg creeping towards its limit shows which tests are growing,
  // and so the weights the parts are split by (test/support/shards.ts) can be read off a run.
  const took = Date.now() - began;
  if (took >= 5_000) {
    console.log(`${test.name} took ${(took / 1000).toFixed(1)}s`);
  }
  await sweepAfter(test.name, run, passed);
}

/** Ends what [param name] left: its servers when it ran past its deadline, its engines, and the helper. */
async function sweepAfter(name: string, run: RegressionRun, passed: boolean): Promise<void> {
  const ranPast = run.ranPast.includes(name);
  if (ranPast) {
    // Said before its servers are ended, so the log tells a slow test from a stuck call.
    console.error(`What ${name} was doing at its deadline:`);
    for (const line of serversSaidAtADeadline(name)) {
      console.error(line);
    }
    console.error(slotsSaid());
    // Still running, it never reached its own stops and sweeps.
    lookUnder(name, await stopServersOf(name));
  }
  if (!passed || leftBehindBy(name)) {
    recordEnginesLeftRunning(await endEnginesLeft(name), run.failed);
  }
  // The runner's own process shares one desktop helper across engine runs, and each test leaves it
  // to end once its engines have. A test past its deadline may still be using it, so the run goes
  // on without waiting, and the helper ends when that test's engines do.
  const retired = retireHelper();
  if (!ranPast && !(await settledWithin(retired, HELPER_RETIRE_MS))) {
    console.error(
      `the desktop helper still served an engine ${String(HELPER_RETIRE_MS / 1000)}s after ${name} ended, so the run goes on without it`,
    );
  }
}
