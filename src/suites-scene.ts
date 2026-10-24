/**
 * gdUnit4 suites played as a scene, so the engine's script profiler sees them.
 *
 * `gdharness test` and project_test run suites as a `-s` script, which the profiler never attaches
 * to, so a game wanting to know what its suites cost by function kept a bench scene of its own
 * driving a runner of its own. `editor_run start` given `suites` plays the scene the tests addon
 * ships instead, handing it the runner `gdharness test` uses and a file of the suites to run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sweepRunDirectories } from './engine-launch.js';
import { shippedListedRunner } from './setup.js';

/** The scene the tests addon plays suites in, from the project root. */
export const SUITES_SCENE = 'addons/gdharness_tests/suites.tscn';

/** When this process began, naming the one directory its suite runs share. */
const STARTED_AT = Date.now();

/** Whether the project at [param projectPath] has the tests addon's suites scene. */
export function hasSuitesScene(projectPath: string): boolean {
  return existsSync(join(projectPath, SUITES_SCENE));
}

/**
 * The game arguments playing [param suites], `res://` suites and directories, in the suites scene
 * of the project at [param projectPath]. The file of suites and gdUnit4's reports are kept in one
 * directory a server, written over by each start, since a start ends the run before it.
 */
export function suitesSceneArgs(projectPath: string, suites: readonly string[]): string[] {
  const runs = join(projectPath, '.godot', 'gdharness', 'suite-scenes');
  sweepRunDirectories(runs);
  const directory = join(runs, `${String(STARTED_AT)}-${String(process.pid)}`);
  mkdirSync(directory, { recursive: true });
  const suitesFile = join(directory, 'suites.txt');
  writeFileSync(suitesFile, `${suites.join('\n')}\n`);
  return [
    '--gdh-runner',
    shippedListedRunner(),
    '--suites-in',
    suitesFile,
    '--html-report-off',
    '--junit-report-off',
    '--gdh-gdunit',
    '-c',
    // Harmless in a window, and a headless run is refused by gdUnit4 without it.
    '--ignoreHeadlessMode',
    // Named from res://, since gdUnit4 reads a path starting with a slash as one under res://.
    '-rd',
    `res://${relative(projectPath, join(directory, 'reports')).split(sep).join('/')}`,
    '-rc',
    '1',
  ];
}
