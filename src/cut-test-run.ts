/**
 * What a test run had finished when its client stopped waiting, kept in the project for the next
 * run there to hand back.
 *
 * A client ends a call it has waited on too long, and the engine goes with the call, since nobody
 * is left to read its answer. A tier of 110 suites cut off after thirty minutes lost every suite
 * it had run, and the only remedy was to run them all again. In the project rather than in this
 * process, because the client that cut the call may restart the server before it asks again.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A suite that finished with cases that did not pass, and which ones. */
export interface FailingSuite {
  readonly path: string;
  readonly errors: number;
  readonly failures: number;
  readonly failed: readonly string[];
}

export interface CutTestRun {
  readonly cutAt: string;
  /** The paths the run was given. */
  readonly paths: readonly string[];
  readonly suitesFinished?: readonly string[];
  readonly suitesFailing?: readonly FailingSuite[];
  readonly suiteRunning?: string;
}

function keptAt(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-reports', 'cut-run.json');
}

/** Keeps [param run] for the next test run in [param projectPath], over any kept before it. */
export function keepCutTestRun(projectPath: string, run: CutTestRun): void {
  const path = keptAt(projectPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  } catch {
    // A project that cannot be written to keeps nothing, and the call it was for has no reader.
  }
}

/** The run kept in [param projectPath], removed as it is read, or null when there is none. */
export function takeCutTestRun(projectPath: string): CutTestRun | null {
  const path = keptAt(projectPath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const run = JSON.parse(readFileSync(path, 'utf8')) as CutTestRun;
    rmSync(path, { force: true });
    return typeof run.cutAt === 'string' &&
      Array.isArray(run.paths) &&
      run.paths.every((path) => typeof path === 'string')
      ? run
      : null;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

/** The sentence an answer carries about [param run], which it holds under `previousRunCut`. */
export function cutTestRunNote(run: CutTestRun): string {
  const finished = run.suitesFinished?.length ?? 0;
  const failing = run.suitesFailing?.length ?? 0;
  const got =
    finished === 0
      ? 'before any suite had finished'
      : `after ${finished === 1 ? 'one suite' : `${finished} suites`} had finished${failing === 0 ? '' : finished === 1 ? ', with failures' : `, ${failing} of them with failures`}`;
  return `The test run before this one in this project, of ${run.paths.join(', ')}, was cut off by its client at ${run.cutAt} ${got}${run.suiteRunning === undefined ? '' : `, while ${run.suiteRunning} was running`}; what it finished is under previousRunCut.`;
}
