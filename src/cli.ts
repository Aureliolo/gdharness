#!/usr/bin/env bun
/**
 * The gdharness command line: the MCP server by default, and the commands that own the
 * Godot side of a project, which an agent's tool call is the wrong shape for because they are
 * run once by a person or a setup script.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GodotLocator } from './godot-path.js';
import {
  connect,
  detect,
  detectGlobal,
  HARNESSES,
  type Harness,
  harnessById,
  launchFor,
  type Written,
} from './harnesses.js';
import { type HeadlessEngine, type HeadlessOutcome, runOperation } from './headless.js';
import { GODOT_DEBUG_MODE_DEFAULT } from './server-version.js';
import {
  EDITOR_PLUGINS,
  enablePlugins,
  inspectProject,
  installAddons,
  RUNTIME_AUTOLOAD,
  setRuntime,
  shippedOperationsScript,
} from './setup.js';
import { getLocalVersion } from './version.js';

const args = process.argv.slice(2);
const command = args[0];

class UsageError extends Error {}

/** The project a command was given, checked to be one. */
function projectArgument(at: number): string {
  const given = args[at];
  if (given === undefined) {
    throw new UsageError('A project directory is required.');
  }
  const projectPath = resolve(given);
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new UsageError(`Not a Godot project: ${projectPath} holds no project.godot.`);
  }
  return projectPath;
}

async function engine(): Promise<HeadlessEngine> {
  const godotPath = await new GodotLocator().find();
  if (godotPath === null) {
    throw new UsageError(`No Godot executable found. ${GodotLocator.ADVICE.join('. ')}.`);
  }
  return { godotPath, script: shippedOperationsScript(), debug: GODOT_DEBUG_MODE_DEFAULT };
}

/** The outcome as a line for a person, and a throw when the engine refused. */
function said(outcome: HeadlessOutcome, what: string): void {
  if (!outcome.ok) {
    throw new Error(`${what}: ${outcome.message}`);
  }
  for (const entry of outcome.messages) {
    console.error(`  engine ${entry.severity}: ${entry.text}`);
  }
}

/** setup's own flags, so anything else beginning with -- is read as naming a harness. */
const SETUP_FLAGS = new Set(['--runtime', '--no-connect', '--json']);

/**
 * The harnesses to write into: the ones named, else the ones this machine appears to run.
 *
 * An unknown flag is refused rather than ignored, because a silently dropped `--curser` leaves
 * somebody believing a harness is configured when nothing was written.
 */
function chosenHarnesses(projectPath: string): { harnesses: readonly Harness[]; named: boolean } {
  const flags = args.filter((arg) => arg.startsWith('--') && !SETUP_FLAGS.has(arg));
  const picked: Harness[] = [];
  for (const flag of flags) {
    const harness = harnessById(flag.slice(2));
    if (harness === undefined) {
      throw new UsageError(
        `Unknown option ${flag}. Harnesses: ${HARNESSES.map((known) => `--${known.id}`).join(', ')}.`,
      );
    }
    picked.push(harness);
  }
  return picked.length > 0
    ? { harnesses: picked, named: true }
    : { harnesses: detect(projectPath), named: false };
}

function reportConnection(written: Written): void {
  if (written.action === 'command') {
    console.log(`${written.harness.name}: run  ${(written.command ?? []).join(' ')}`);
    return;
  }
  if (written.action === 'snippet') {
    console.log(`${written.harness.name}: put this in ${written.path}`);
    for (const line of (written.snippet ?? '').split('\n')) {
      console.log(`  ${line}`);
    }
    return;
  }
  console.log(`${written.harness.name}: ${written.action} ${written.path}`);
}

async function setup(): Promise<void> {
  const projectPath = projectArgument(1);
  const runtime = args.includes('--runtime');
  const godot = await engine();

  for (const addon of installAddons(projectPath)) {
    console.log(`${addon.replaced ? 'replaced' : 'installed'} ${addon.path}`);
  }
  const enabled = await enablePlugins(godot, projectPath, EDITOR_PLUGINS);
  for (const [index, outcome] of enabled.entries()) {
    const name = EDITOR_PLUGINS[index] ?? '';
    said(outcome, `enabling ${name}`);
    console.log(`${name}: ${outcome.ok ? String(outcome.payload['action']) : 'failed'}`);
  }
  if (runtime) {
    said(await setRuntime(godot, projectPath, true), 'registering the runtime autoload');
    console.log(`${RUNTIME_AUTOLOAD.name} autoload registered`);
  }
  const classes = await runOperation(godot, 'refresh_class_cache', {}, projectPath);
  said(classes, 'rebuilding the class list');
  if (classes.ok) {
    console.log(`class list rebuilt: ${String(classes.payload['classes'])} classes`);
  }

  if (!args.includes('--no-connect')) {
    // The version is the running one, so the config pins the server that installed these addons.
    const launch = launchFor(getLocalVersion(), godot.godotPath);
    const { harnesses, named } = chosenHarnesses(projectPath);
    if (harnesses.length === 0) {
      console.log(`no harness set up in this project; name one with --${HARNESSES[0]?.id ?? 'claude-code'}`);
    }
    for (const harness of harnesses) {
      reportConnection(connect(harness, projectPath, launch));
    }

    // Named on the command line and nowhere else: a machine-wide config is the reader's to change,
    // so the most this does unasked is say which one it found and what would write it.
    if (!named) {
      for (const harness of detectGlobal(projectPath)) {
        console.log(
          `${harness.name}: found, not touched. Its config is machine-wide; pass --${harness.id} to write it.`,
        );
      }
    }
  }

  doctorReport(projectPath);
}

function doctorReport(projectPath: string): void {
  const report = inspectProject(projectPath);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const addon of report.addons) {
      console.log(
        `addons/${addon.name}: ${addon.installed ? `installed, ${addon.version ?? 'unknown version'}${addon.current ? '' : ' (not this version)'}` : 'missing'}`,
      );
    }
    console.log(`editor plugins enabled: ${report.pluginsEnabled.join(', ') || 'none'}`);
    console.log(`runtime autoload: ${report.runtimeAutoload ? 'registered' : 'not registered'}`);
    console.log(
      report.classCacheExists
        ? `class cache: ${report.staleClasses.length === 0 ? 'current' : `stale for ${report.staleClasses.join(', ')}`}`
        : 'class cache: missing',
    );
    for (const problem of report.problems) {
      console.log(`problem: ${problem}`);
    }
  }
  if (report.problems.length > 0) {
    process.exitCode = 1;
  }
}

async function runtime(): Promise<void> {
  const state = args[1];
  if (state !== 'on' && state !== 'off') {
    throw new UsageError('gdharness runtime takes on or off, then the project directory.');
  }
  const projectPath = projectArgument(2);
  const godot = await engine();
  said(await setRuntime(godot, projectPath, state === 'on'), `turning the runtime ${state}`);
  console.log(`${RUNTIME_AUTOLOAD.name} autoload ${state === 'on' ? 'registered' : 'removed'}`);
}

async function classes(): Promise<void> {
  const projectPath = projectArgument(1);
  const godot = await engine();
  const outcome = await runOperation(godot, 'refresh_class_cache', {}, projectPath);
  said(outcome, 'rebuilding the class list');
  if (outcome.ok) {
    console.log(JSON.stringify(outcome.payload, null, 2));
  }
}

function printHelp(): void {
  console.log(
    `
gdharness v${getLocalVersion()}, a harness for driving a Godot 4 project from an agent

Usage:
  gdharness                          Start the MCP server (default)
  gdharness setup <project> [--runtime] [--no-connect] [--<harness>]
                                     Install the addons into the project, enable the editor
                                     ones, register the runtime autoload with --runtime, and
                                     rebuild the class list. Then register the server with the
                                     harnesses already set up in this project, writing only files
                                     inside it. A harness whose config is machine-wide is named
                                     and left alone unless you ask for it by flag:
                                     ${HARNESSES.map((harness) => `--${harness.id}`).join(', ')}
  gdharness doctor <project> [--json]
                                     Say what holds and what does not; exit 1 on a problem
  gdharness runtime on|off <project> Register or remove the runtime autoload, which reaches
                                     an export if it is left on
  gdharness classes <project>        Rebuild .godot/global_script_class_cache.cfg from disk
  gdharness version                  Show the installed version
  gdharness help                     Show this help

Godot is found through GODOT_PATH, else in the usual places.
More info: https://github.com/Aureliolo/gdharness
`.trim(),
  );
}

async function main(): Promise<void> {
  switch (command) {
    case undefined: {
      // Dynamic import so a CLI-only command never loads the MCP SDK.
      const { runGodotServer } = await import('./server.js');
      await runGodotServer();
      return;
    }
    case 'setup':
      await setup();
      return;
    case 'doctor':
      doctorReport(projectArgument(1));
      return;
    case 'runtime':
      await runtime();
      return;
    case 'classes':
      await classes();
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(`gdharness v${getLocalVersion()}`);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new UsageError(`Unknown command: ${command}. Run gdharness help.`);
  }
}

await main().catch((error: unknown) => {
  console.error('gdharness:', error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
});
