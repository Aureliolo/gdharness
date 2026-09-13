#!/usr/bin/env bun
/**
 * The gdharness command line: the MCP server by default, and the commands that own the
 * Godot side of a project, which an agent's tool call is the wrong shape for because they are
 * run once by a person or a setup script.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Refusal } from './errors.js';
import { GodotLocator } from './godot-path.js';
import {
  type Candidate,
  candidates,
  connect,
  disconnect,
  displayPath,
  type Group,
  groupByFile,
  HARNESSES,
  type Harness,
  harnessById,
  type Launch,
  launchFor,
  registered,
} from './harnesses.js';
import { type HeadlessEngine, type HeadlessOutcome, runOperation } from './headless.js';
import { defectReport } from './issues.js';
import { Ask, interactive } from './prompt.js';
import { GODOT_DEBUG_MODE_DEFAULT } from './server-version.js';
import {
  disablePlugins,
  EDITOR_PLUGINS,
  enablePlugins,
  inspectProject,
  installAddons,
  RUNTIME_AUTOLOAD,
  removeAddons,
  setRuntime,
  shippedOperationsScript,
} from './setup.js';
import { everySkillDirectory, removeSkill, skillDirectories, writeSkill } from './skill.js';
import { getLocalVersion } from './version.js';

const args = process.argv.slice(2);
const command = args[0];

/** A {@link Refusal} about how the command was called rather than about what it found. */
class UsageError extends Refusal {}

/**
 * The project a command works on: the directory named, or the one you are standing in.
 *
 * Defaulting to the working directory rather than demanding a `.` for it, because every other
 * command line does, and because a required argument whose value is nearly always one character
 * is carrying no information. It still has to hold a `project.godot`, so the default cannot act
 * on somewhere that is not a Godot project.
 */
function projectArgument(at: number): string {
  // The first thing that is not a flag. With the directory optional, `setup --cursor` is the
  // natural thing to type and reads as a flag where the path used to be; taking the argument
  // positionally made it resolve `--cursor` as a directory and refuse the command the install
  // guide tells people to run.
  const named = args.slice(at).find((value) => !value.startsWith('--'));
  const projectPath = resolve(named ?? '.');
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
    // The engine's own refusal, which is about the project it was pointed at: a scene that will
    // not open is the project's, not this program's.
    throw new Refusal(`${what}: ${outcome.message}`);
  }
  for (const entry of outcome.messages) {
    console.error(`  engine ${entry.severity}: ${entry.text}`);
  }
}

/** setup's own flags, so anything else beginning with -- is read as naming a harness. */
const SETUP_FLAGS = new Set(['--runtime', '--no-runtime', '--no-connect', '--no-skill', '--json', '--yes']);

/**
 * The harnesses named on the command line, which is how an agent drives this.
 *
 * An unknown flag is refused rather than ignored, because a silently dropped `--curser` leaves
 * somebody believing a harness is configured when nothing was written.
 */
function namedHarnesses(): readonly Harness[] {
  const flags = args.filter((arg) => arg.startsWith('--') && !SETUP_FLAGS.has(arg));
  return flags.map((flag) => {
    const harness = harnessById(flag.slice(2));
    if (harness === undefined) {
      throw new UsageError(`Unknown option ${flag}. Run gdharness harnesses for every flag it takes.`);
    }
    return harness;
  });
}

/** What a candidate's prompt says, and what happens when nobody answers. */
function offer(candidate: Candidate): { question: string; fallback: boolean } {
  const { harness, reason } = candidate;
  if (reason === 'machine-wide') {
    return {
      question: `${harness.name} is on this machine and has no project-level config. Write ${displayPath(harness)}? That affects every project you open with it.`,
      fallback: false,
    };
  }
  if (reason === 'installed') {
    return { question: `${harness.name} is installed. Set it up for this project?`, fallback: true };
  }
  return { question: `${harness.name} is set up here. Add gdharness to it?`, fallback: true };
}

/**
 * The harnesses to write into.
 *
 * Flags win outright. Otherwise every harness worth offering is asked about one at a time, and
 * when there is nobody to ask, the ones already configured in this project are written and the
 * rest are named with the flag that would write them. Nothing outside the project is ever written
 * without a flag or a typed yes.
 */
async function chosenHarnesses(
  projectPath: string,
  ask: Ask,
): Promise<{ harnesses: readonly Harness[]; skipped: readonly Candidate[] }> {
  const named = namedHarnesses();
  if (named.length > 0) {
    return { harnesses: named, skipped: [] };
  }

  const offered = candidates(projectPath);
  if (!interactive() || args.includes('--yes')) {
    return {
      harnesses: offered.filter((one) => one.reason === 'configured').map((one) => one.harness),
      skipped: offered.filter((one) => one.reason !== 'configured'),
    };
  }

  const picked: Harness[] = [];
  for (const candidate of offered) {
    const { question, fallback } = offer(candidate);
    if (await ask.confirm(question, fallback)) {
      picked.push(candidate.harness);
    }
  }
  return { harnesses: picked, skipped: [] };
}

/** What was found and left alone, and the flag that would take it further. */
function reportSkipped(candidate: Candidate): void {
  const { harness, reason } = candidate;
  console.log(
    reason === 'machine-wide'
      ? `${harness.name}: found, not touched. Its config is machine-wide; pass --${harness.id} to write it.`
      : `${harness.name}: installed, not touched. Pass --${harness.id} to set it up here.`,
  );
}

function reportConnection(group: Group, launch: Launch, projectPath: string): void {
  const who = group.harnesses.map((harness) => harness.name).join(', ');
  const written = connect(group.writer, projectPath, launch);
  if (written.action === 'command') {
    console.log(`${who}: run  ${(written.command ?? []).join(' ')}`);
    return;
  }
  if (written.action === 'snippet') {
    console.log(`${who}: put this in ${written.path}`);
    for (const line of (written.snippet ?? '').split('\n')) {
      console.log(`  ${line}`);
    }
    return;
  }
  console.log(`${who}: ${written.action} ${written.path}`);
  // A harness that will not take the config's word for it: a trust prompt or an approval nobody
  // mentions is an install that reports success and then answers nothing.
  for (const harness of group.harnesses) {
    if (harness.manual !== undefined) {
      console.log(`  ${harness.name}: ${harness.manual}`);
    }
  }
}

/**
 * What setup cannot do for you, which is everything that happens in a process it does not own.
 *
 * Both of these are easy to miss, because the old version keeps answering until they are done:
 * the harness holds the server it spawned, and the editor holds the addon it loaded at startup.
 */
function nextSteps(projectPath: string, runtime: boolean): void {
  console.log('\nTwo things this cannot do for you:');
  console.log('  1. Reconnect the MCP server in your harness, so it spawns this version.');
  console.log('  2. Restart an open editor, or open the project. Then editor_status should answer.');
  if (runtime) {
    // The path only when it is not the one you are standing in. Spelling out a temp directory the
    // reader is already inside turns a command they can copy into a line that wraps twice.
    const where = projectPath === process.cwd() ? '' : ` ${projectPath}`;
    console.log(
      `\nThe runtime autoload is registered, which is what the runtime_* tools talk to. It reaches an\nexport, so turn it off before you ship: gdharness runtime off${where}`,
    );
  }
}

async function setup(): Promise<void> {
  const projectPath = projectArgument(1);
  // The runtime addon is per-project like everything else setup installs, so it is not something
  // to opt into: without it a third of the tools have nothing to talk to.
  const runtime = !args.includes('--no-runtime');
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
    const ask = new Ask();
    let chosen: { harnesses: readonly Harness[]; skipped: readonly Candidate[] };
    try {
      chosen = await chosenHarnesses(projectPath, ask);
    } finally {
      ask.close();
    }
    for (const group of groupByFile(chosen.harnesses, projectPath)) {
      reportConnection(group, launch, projectPath);
    }
    for (const candidate of chosen.skipped) {
      reportSkipped(candidate);
    }
    if (chosen.harnesses.length === 0) {
      console.log('no harness configured; name one yourself, and gdharness harnesses lists them all');
    }

    if (!args.includes('--no-skill')) {
      const directories = skillDirectories(chosen.harnesses, projectPath, existsSync);
      for (const written of writeSkill(directories, getLocalVersion())) {
        console.log(`skill: ${written.replaced ? 'replaced' : 'written'} ${written.path}`);
      }
    }
  }

  doctorReport(projectPath);
  if (!args.includes('--json')) {
    nextSteps(projectPath, runtime);
  }
}

/**
 * Everything setup put in, taken back out.
 *
 * Only our own entry is removed from a harness config, and a machine-wide one is left alone unless
 * it is named, because that entry may be serving another project: the same reason writing it needs
 * a flag or an answer.
 */
async function uninstall(): Promise<void> {
  const projectPath = projectArgument(1);
  const godot = await engine();

  const named = namedHarnesses();
  const from = named.length > 0 ? named : HARNESSES;

  for (const harness of from) {
    const removal = disconnect(harness, projectPath);
    if (removal.action === 'absent') {
      continue;
    }
    if (harness.scope === 'home' && named.length === 0) {
      console.log(
        `${harness.name}: left alone. Its config is machine-wide and may serve another project; pass --${harness.id} to remove it.`,
      );
      continue;
    }
    if (removal.action === 'manual') {
      console.log(
        removal.command === undefined
          ? `${harness.name}: take gdharness out of ${removal.path} by hand.`
          : `${harness.name}: run  ${removal.command.join(' ')}`,
      );
      continue;
    }
    console.log(`${harness.name}: ${removal.action} ${removal.path}`);
  }

  for (const directory of removeSkill(everySkillDirectory(projectPath, HARNESSES), projectPath)) {
    console.log(`skill: removed ${directory}`);
  }

  const disabled = await disablePlugins(godot, projectPath, EDITOR_PLUGINS);
  for (const [index, outcome] of disabled.entries()) {
    const name = EDITOR_PLUGINS[index] ?? '';
    said(outcome, `disabling ${name}`);
    console.log(`${name}: ${outcome.ok ? String(outcome.payload['action']) : 'failed'}`);
  }
  said(await setRuntime(godot, projectPath, false), 'removing the runtime autoload');
  console.log(`${RUNTIME_AUTOLOAD.name} autoload removed`);

  for (const path of removeAddons(projectPath)) {
    console.log(`removed ${path}`);
  }

  console.log('\nReconnect your harness so it stops spawning a server that is no longer installed.');
}

/**
 * The same project, on this version of gdharness.
 *
 * Setup asks which harnesses to write; an upgrade asks nothing, because the answer is already in
 * the files: every config that has a gdharness entry gets it re-pinned, and one that has not is a
 * harness nobody asked us to write to. A machine-wide config is included when it holds our entry,
 * since a config we wrote pinning a version that is no longer installed is worse than a corrected
 * one.
 *
 * What this cannot do is either of the two restarts. The editor is holding addons that have just
 * been replaced underneath it, and the harness is running a server spawned from the version its
 * config used to name, so both are named at the end for the caller to carry out.
 */
async function upgrade(): Promise<void> {
  const projectPath = projectArgument(1);
  const version = getLocalVersion();
  const before = inspectProject(projectPath);
  const installed = before.addons.find((addon) => addon.installed)?.version ?? null;
  if (installed === null) {
    throw new UsageError(
      `gdharness is not installed in ${projectPath}. Run  gdharness setup ${projectPath}  instead.`,
    );
  }
  console.log(installed === version ? `already ${version}; reinstalling` : `${installed} -> ${version}`);

  const godot = await engine();
  for (const addon of installAddons(projectPath)) {
    console.log(`${addon.replaced ? 'replaced' : 'installed'} ${addon.path}`);
  }
  const enabled = await enablePlugins(godot, projectPath, EDITOR_PLUGINS);
  for (const [index, outcome] of enabled.entries()) {
    said(outcome, `enabling ${EDITOR_PLUGINS[index] ?? ''}`);
  }
  // Only when it was already on: an upgrade must not put back an autoload somebody turned off
  // deliberately, which is the one thing here that would reach a shipped build.
  if (before.runtimeAutoload) {
    said(await setRuntime(godot, projectPath, true), 'registering the runtime autoload');
  }
  said(await runOperation(godot, 'refresh_class_cache', {}, projectPath), 'rebuilding the class list');

  const launch = launchFor(version, godot.godotPath);
  const already = HARNESSES.filter((harness) => registered(harness, projectPath));
  for (const group of groupByFile(already, projectPath)) {
    reportConnection(group, launch, projectPath);
  }
  if (already.length === 0) {
    console.log('no harness config names gdharness, so none was re-pinned');
  }
  // The same rule setup uses, not the one uninstall uses. everySkillDirectory names every place a
  // copy could be, which is what you want when removing them and is how an upgrade came to create
  // two directories the install had deliberately not created.
  for (const written of writeSkill(skillDirectories(already, projectPath, existsSync), version)) {
    console.log(`skill: ${written.replaced ? 'replaced' : 'written'} ${written.path}`);
  }

  console.log(`\nOn ${version}. Two things this could not do for you:`);
  console.log(
    '  1. The open editor is still running the addons it loaded at startup. Restart it with the\n' +
      '     editor_launch restart tool, which closes and reopens the window.',
  );
  console.log(
    `  2. Your harness is still running gdharness ${installed}: its config named that version when\n` +
      '     the server was spawned. Reconnect the MCP server, or restart the harness.',
  );
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

/** Every harness, its flag and its file, because there are too many to list in the help. */
function printHarnesses(): void {
  const width = Math.max(...HARNESSES.map((harness) => harness.name.length));
  for (const scope of ['project', 'home'] as const) {
    console.log(
      scope === 'project'
        ? 'Configured inside the project. Written when set up here, or when named.'
        : '\nNo project-level config exists for these, so they are written only when named.',
    );
    for (const harness of HARNESSES.filter((known) => known.scope === scope)) {
      console.log(`  --${harness.id.padEnd(24)}${harness.name.padEnd(width + 2)}${displayPath(harness)}`);
    }
  }
}

function printHelp(): void {
  console.log(
    `
gdharness v${getLocalVersion()}, a harness for driving a Godot 4 project from an agent

Usage:
  gdharness                          Start the MCP server (default)
  gdharness setup [project] [--no-runtime] [--no-connect] [--no-skill] [--yes] [--<harness>]
                                     Install the addons into the project, enable the editor
                                     ones, register the runtime autoload unless --no-runtime,
                                     and rebuild the class list. Then register the server with your
                                     harnesses: the ones you name by flag, or, at a terminal,
                                     whichever are found here or on this machine, one question
                                     each. With no terminal and no flags it writes the ones this
                                     project already uses and names the rest. --yes skips the
                                     questions and does the same. Nothing outside the project is
                                     written without a flag or a typed yes. It also writes the
                                     gdharness skill into .agents/skills, unless --no-skill.
  gdharness upgrade [project]        Reinstall the addons at this version and re-pin every config
                                     that already names gdharness. Asks nothing: it touches only
                                     what is already ours. Afterwards the editor needs restarting
                                     so it loads the new addons, and the MCP server needs
                                     reconnecting so it is spawned at the new version.
  gdharness uninstall [project] [--<harness>]
                                     Take it all back out: the addons, the editor plugins, the
                                     runtime autoload, the skill, and our own entry in every
                                     config it can parse. Other servers in those files are
                                     untouched. A machine-wide config may serve another project,
                                     so it is named rather than edited unless you ask by flag.
  gdharness harnesses                Every harness, its flag and the file it reads
  gdharness doctor [project] [--json]
                                     Say what holds and what does not; exit 1 on a problem
  gdharness runtime on|off [project] Register or remove the runtime autoload, which reaches
                                     an export if it is left on
  gdharness classes [project]        Rebuild .godot/global_script_class_cache.cfg from disk
  gdharness version                  Show the installed version
  gdharness help                     Show this help

The project defaults to the directory you are in, and has to hold a project.godot either way.
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
    case 'upgrade':
      await upgrade();
      return;
    case 'uninstall':
      await uninstall();
      return;
    case 'harnesses':
      printHarnesses();
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
  if (error instanceof Refusal) {
    console.error('gdharness:', error.message);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
  // Nothing anticipated this, so the person in front of it is owed more than the exception's
  // message: what broke, that it is not theirs to fix, and what to do with it if they want to.
  console.error(defectReport(`gdharness ${command ?? 'server'}`, error));
  process.exit(1);
});
