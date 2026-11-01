/**
 * What the CLI does to a project: puts the shipped addons in it, turns the editor ones on,
 * turns the runtime autoload on or off, and reads back whether all of that holds.
 *
 * Every write that lands in project.godot goes through the engine's own operations, so the
 * file is written the way the editor writes it. The addon copy is a plain copy, whole and
 * fresh each time, so an upgrade never leaves a file of the old version behind.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedClasses, staleAgainst } from './class-cache.js';
import { type HeadlessEngine, type HeadlessOutcome, runOperation } from './headless.js';
import { VERSION_MARKER } from './project-scan.js';
import { parseProjectGodot } from './resources.js';
import { SERVER_VERSION } from './server-version.js';
import { spawnSyncHidden } from './spawn.js';
import { readString } from './tool-args.js';

/** The addons the package ships, by directory name under addons/. */
export const ADDONS = ['gdharness_editor', 'gdharness_runtime', 'auto_reload', 'gdharness_tests'] as const;

/** The addons that are editor plugins and are enabled by setup. */
export const EDITOR_PLUGINS = ['gdharness_editor', 'auto_reload'] as const;

/** The runtime addon's own script, which is an autoload and nothing else, never a plugin. */
export const RUNTIME_SCRIPT = 'addons/gdharness_runtime/runtime_autoload.gd';

/**
 * The runtime's autoload entry, which names the loader gdharness ships rather than the addon.
 *
 * `addons/` is often not committed and exports leave it out, so an entry naming the addon's script
 * boots a fresh clone and every exported build with a missing script. Every project that met this
 * wrote a loader of its own, and the copies drifted apart. The loader is written outside `addons/`
 * so it is committed with the entry naming it, and it brings the runtime up only in a debug build
 * that has the addon.
 */
export const RUNTIME_AUTOLOAD = {
  name: 'GdharnessRuntime',
  path: 'gdharness/loader.gd',
} as const;

/**
 * The setting that makes the runtime serve a `godot -s` script run, which it does not by default.
 *
 * Named here because the skill has to say it. The skill said a script run does not answer, full
 * stop, which is the default rather than the rule, and a downstream project had copied it into its
 * own documentation as unconditional: it is the half a consumer builds a guard on. Held against the
 * addon's own constant by a case, so a rename there cannot leave this sentence naming a setting
 * nothing reads.
 */
export const SCRIPT_RUNS_SETTING = 'gdharness/runtime/serve_script_runs';

/**
 * The setting listing the `res://` folders of scenes that are not the game, such as a bench, whose
 * runs the runtime does not serve. Named here for the skill, and held against the addon's constant
 * as the one above is.
 */
export const QUIET_SCENES_SETTING = 'gdharness/runtime/quiet_scenes_under';

/**
 * Where the runtime listens, which is the one setting with a security answer.
 *
 * The command set is unauthenticated, and Godot's `listen()` defaults to every interface rather
 * than to loopback, so the addon names this rather than leaving it. It was read by the addon and
 * written down nowhere a caller looks, which is the same gap as the script-run sentence one step
 * further along: a caller who never learns a setting exists cannot get it wrong, until they do.
 */
export const BIND_ADDRESS_SETTING = 'gdharness/runtime/bind_address';

/** The port the runtime binds, 0 meaning the operating system picks and the game announces it. */
export const PORT_SETTING = 'gdharness/runtime/port';

/**
 * Written beside the version marker in the editor addon, a digest of the code an editor loads, and
 * in the runtime addon, a digest of the code a game loads.
 *
 * The version changes on every release and the addons' code mostly does not, so a version
 * comparison called an editor stale after every upgrade and sent it to a restart that changed
 * nothing. The digest is taken from the shipped copy at install time rather than from the project,
 * because the editor writes `.uid` and import files into the addons and those are not the code.
 */
const DIGEST_MARKER = '.gdharness-digest';

const RUNTIME_ADDON = 'gdharness_runtime';

/** The script of the tests addon that a bench under `gdharness spread` asks for its outcomes. */
export const SHARE_SCRIPT = 'addons/gdharness_tests/share.gd';

/** The file that says an addon of the package is all there: an editor plugin's plugin.cfg, else its script. */
function addonMarking(name: string): string {
  if (name === RUNTIME_ADDON) {
    return 'runtime_autoload.gd';
  }
  return name === 'gdharness_tests' ? 'share.gd' : 'plugin.cfg';
}

/** The digest of the editor plugins in `from`, which is what an open editor has loaded of ours. */
function editorAddonDigest(from: string = shippedAddonsDirectory()): string {
  return addonsDigest(EDITOR_PLUGINS, from);
}

/** The digest of the runtime addon in `from`, which is what a game has loaded of ours. */
function runtimeAddonDigest(from: string = shippedAddonsDirectory()): string {
  return addonsDigest([RUNTIME_ADDON], from);
}

function addonsDigest(names: readonly string[], from: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).toSorted()) {
      if (name === VERSION_MARKER || name === DIGEST_MARKER) {
        continue;
      }
      const path = join(directory, name);
      const inside = `${relative}/${name}`;
      if (statSync(path).isDirectory()) {
        walk(path, inside);
      } else {
        hash.update(`${inside}\n`);
        hash.update(readFileSync(path));
        hash.update('\n');
      }
    }
  };
  for (const name of names) {
    walk(join(from, name), name);
  }
  return hash.digest('hex');
}

let shippedDigest: string | undefined;
let shippedRuntime: string | undefined;

/**
 * The digest of the editor plugins this package ships, taken once. A package whose addons cannot
 * be read is a broken install, and the error says so where it is met.
 */
export function shippedEditorDigest(): string {
  shippedDigest ??= editorAddonDigest();
  return shippedDigest;
}

/** The same for the runtime addon. */
export function shippedRuntimeDigest(): string {
  shippedRuntime ??= runtimeAddonDigest();
  return shippedRuntime;
}

/**
 * The digest the installed editor addon was written with, or null for a copy gdharness did not
 * install, which carries no marker.
 */
export function installedEditorDigest(projectPath: string): string | null {
  return digestMarker(projectPath, ADDONS[0]);
}

/**
 * What an upgrade tells the user to do about the editor: [param sameCode] when the editor addons
 * came out as the code they were, and [param editors] the pids of the project's running editors,
 * or null when the process table could not be read.
 */
export function editorUpgradeNote(sameCode: boolean, editors: readonly number[] | null): string {
  if (sameCode) {
    return (
      '  1. Nothing for the editor: this upgrade left the editor addons the same code as before,\n' +
      '     so it gives an open editor nothing to restart for. editor_status says addonIsStale\n' +
      '     if the editor is running other code.'
    );
  }
  if (editors === null) {
    return (
      '  1. An editor of this project that is open is still running the addons it loaded at\n' +
      '     startup. Restart it with the editor_launch restart tool, which closes and reopens\n' +
      '     the window.'
    );
  }
  if (editors.length === 0) {
    return '  1. Nothing for the editor: none of this project is running, and the next one opened loads\n     these addons.';
  }
  const which =
    editors.length === 1
      ? `The open editor (pid ${editors[0]}) is`
      : `The open editors (pids ${editors.join(', ')}) are`;
  return (
    `  1. ${which} still running the addons loaded at startup. Restart with the\n` +
    '     editor_launch restart tool, which closes and reopens the window.'
  );
}

/** The digest the installed runtime addon was written with, or null for a copy without one. */
export function installedRuntimeDigest(projectPath: string): string | null {
  return digestMarker(projectPath, RUNTIME_ADDON);
}

function digestMarker(projectPath: string, addon: string): string | null {
  const marker = join(projectPath, 'addons', addon, DIGEST_MARKER);
  if (!existsSync(marker)) {
    return null;
  }
  const said = readFileSync(marker, 'utf8').trim();
  return said === '' ? null : said;
}

/** Where the shipped addons are, beside this module in the build and in the source tree alike. */
export function shippedAddonsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'addons');
}

/** The operations script, laid out the same way. */
export function shippedOperationsScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'operations', 'godot_operations.gd');
}

/** The loader the runtime's autoload entry names, laid out the same way. */
export function shippedLoader(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'loader', 'loader.gd');
}

/**
 * Whether the project's copy of the loader is the one this gdharness ships. Line endings are left
 * out of the comparison, because git on Windows checks a file out with CRLF and that copy is still
 * the same script.
 */
export function loaderState(projectPath: string): 'current' | 'differs' | 'missing' {
  const copy = join(projectPath, ...RUNTIME_AUTOLOAD.path.split('/'));
  if (!existsSync(copy)) {
    return 'missing';
  }
  const lines = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  return lines(copy) === lines(shippedLoader()) ? 'current' : 'differs';
}

/** The shipped loader written into [param projectPath]. Answers whether anything changed. */
export function writeLoader(projectPath: string): boolean {
  if (loaderState(projectPath) === 'current') {
    return false;
  }
  const copy = join(projectPath, ...RUNTIME_AUTOLOAD.path.split('/'));
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, readFileSync(shippedLoader()));
  return true;
}

/** The project's copy of the loader taken out, and its folder with it when nothing else is there. */
export function removeLoader(projectPath: string): boolean {
  const copy = join(projectPath, ...RUNTIME_AUTOLOAD.path.split('/'));
  if (!existsSync(copy)) {
    return false;
  }
  rmSync(copy);
  rmSync(`${copy}.uid`, { force: true });
  const folder = dirname(copy);
  if (readdirSync(folder).length === 0) {
    rmdirSync(folder);
  }
  return true;
}

/** The gdUnit4 runner over a file of suites, laid out the same way, which project_test and `test` start. */
export function shippedListedRunner(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'tests', 'listed.gd');
}

/** The gdUnit4 class the shipped runner extends, which gdUnit4 has had since 6.0. */
const GDUNIT4_CI_RUNNER = 'addons/gdUnit4/src/core/runners/GdUnitTestCIRunner.gd';

/** Why the gdUnit4 in [param projectPath] cannot run the shipped runner, or null when it can. */
export function gdUnit4Unusable(projectPath: string): { missing: boolean; reason: string } | null {
  const marker = 'addons/gdUnit4/plugin.cfg';
  if (!existsSync(join(projectPath, ...marker.split('/')))) {
    return { missing: true, reason: `gdUnit4 is not installed in this project: no ${marker}` };
  }
  if (!existsSync(join(projectPath, ...GDUNIT4_CI_RUNNER.split('/')))) {
    return {
      missing: false,
      reason: `gdUnit4 in this project is older than 6.0, which the shipped runner needs: no ${GDUNIT4_CI_RUNNER}`,
    };
  }
  return null;
}

export interface InstalledAddon {
  readonly name: string;
  readonly path: string;
  readonly replaced: boolean;
}

/** Each addon copied whole into the project's addons/, over whatever was there. */
export function installAddons(
  projectPath: string,
  from: string = shippedAddonsDirectory(),
): InstalledAddon[] {
  const installed: InstalledAddon[] = [];
  for (const name of ADDONS) {
    const source = join(from, name);
    if (!existsSync(join(source, addonMarking(name)))) {
      throw new Error(`The package holds no ${name} addon at ${source}.`);
    }
    const target = join(projectPath, 'addons', name);
    const replaced = existsSync(target);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    writeFileSync(join(target, VERSION_MARKER), `${SERVER_VERSION}\n`);
    installed.push({ name, path: target, replaced });
  }
  writeFileSync(join(projectPath, 'addons', ADDONS[0], DIGEST_MARKER), `${editorAddonDigest(from)}\n`);
  writeFileSync(join(projectPath, 'addons', RUNTIME_ADDON, DIGEST_MARKER), `${runtimeAddonDigest(from)}\n`);
  return installed;
}

/**
 * What the addons installed in this project say they are, or null when none of them say.
 *
 * The third version in play, and the one nothing was reading. `addonIsStale` compares what an
 * editor loaded at startup against this server, which catches an editor nobody has restarted. It
 * cannot catch the other way round: somebody runs `upgrade` while this server is running, the
 * project moves on, and the server goes on answering as the version it was started as with
 * nothing anywhere saying so.
 */
export function installedAddonVersion(projectPath: string): string | null {
  const marker = join(projectPath, 'addons', ADDONS[0], VERSION_MARKER);
  if (!existsSync(marker)) {
    return null;
  }
  const said = readFileSync(marker, 'utf8').trim();
  return said === '' ? null : said;
}

/**
 * Each addon taken back out, naming the ones that were there to remove, and `addons/` with them
 * when that leaves it empty: setup makes the directory in a project that had none, and an uninstall
 * that left it behind left the project a directory it did not have before.
 */
export function removeAddons(projectPath: string): readonly string[] {
  const removed: string[] = [];
  for (const name of ADDONS) {
    const target = join(projectPath, 'addons', name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  const addons = join(projectPath, 'addons');
  if (removed.length > 0 && existsSync(addons) && readdirSync(addons).length === 0) {
    rmdirSync(addons);
    removed.push(addons);
  }
  return removed;
}

/** The plugins turned off in project.godot, through the engine, the way they were turned on. */
export async function disablePlugins(
  engine: HeadlessEngine,
  projectPath: string,
  names: readonly string[],
): Promise<HeadlessOutcome[]> {
  const outcomes: HeadlessOutcome[] = [];
  for (const name of names) {
    outcomes.push(await runOperation(engine, 'disable_plugin', { pluginName: name }, projectPath));
  }
  return outcomes;
}

/** The plugins turned on in project.godot, through the engine. */
export async function enablePlugins(
  engine: HeadlessEngine,
  projectPath: string,
  names: readonly string[],
): Promise<HeadlessOutcome[]> {
  const outcomes: HeadlessOutcome[] = [];
  for (const name of names) {
    outcomes.push(await runOperation(engine, 'enable_plugin', { pluginName: name }, projectPath));
  }
  return outcomes;
}

/**
 * Whether an autoload entry is one gdharness wrote, and so one it may rewrite: none, the shipped
 * loader, or the addon's own script, which an earlier gdharness wrote and which boots a build
 * without `addons/` with a missing script.
 *
 * An entry naming a script of the project's own is left alone. Repointing it once took away a
 * loader the project wrote, and nothing failed: the loader was still on disk and still correct,
 * every gate went on passing because they exercise the script rather than ask what `project.godot`
 * registers, and the change was visible only in a diff, found in `git status` after twelve green
 * gates.
 */
export function autoloadIsOurs(named: string | null): boolean {
  return named === null || named === `res://${RUNTIME_AUTOLOAD.path}` || named === `res://${RUNTIME_SCRIPT}`;
}

/**
 * The runtime autoload registered, with the shipped loader written for it to name, or removed with
 * the loader, through the engine. Not a global name: nothing reaches the loader by name, and the
 * runtime it brings up is its child.
 */
export async function setRuntime(
  engine: HeadlessEngine,
  projectPath: string,
  on: boolean,
): Promise<HeadlessOutcome> {
  if (!on) {
    const removed = await runOperation(
      engine,
      'remove_autoload',
      { name: RUNTIME_AUTOLOAD.name },
      projectPath,
    );
    if (removed.ok) {
      removeLoader(projectPath);
    }
    return removed;
  }
  writeLoader(projectPath);
  return await runOperation(
    engine,
    'add_autoload',
    { name: RUNTIME_AUTOLOAD.name, path: `res://${RUNTIME_AUTOLOAD.path}`, global: false },
    projectPath,
  );
}

interface AddonState {
  readonly name: string;
  readonly installed: boolean;
  /** The version the copy came from, or null when no marker was written with it. */
  readonly version: string | null;
  readonly current: boolean;
}

export interface ProjectReport {
  readonly projectPath: string;
  readonly addons: readonly AddonState[];
  readonly pluginsEnabled: readonly string[];
  readonly runtimeAutoload: boolean;
  /**
   * What the runtime autoload entry names, or null when nothing registers it.
   *
   * The path and not just the fact, because a project is free to register the runtime through a
   * script of its own and the difference is invisible from a boolean.
   */
  readonly runtimeAutoloadPath: string | null;
  /**
   * An autoload that looks like this project bringing the runtime up itself, under a name of its
   * own, or null when there is none.
   *
   * `runtimeAutoloadPath` only sees an entry called `GdharnessRuntime`. A project is free to call
   * it anything, and one calls it `GdharnessLoader`, so on its project every check for "is the
   * runtime registered" answered no and registering would have added a second entry beside the
   * first: the addon's own script, coming up unguarded, next to the guard. Recognised by the path
   * rather than the name, because the name is the part a project chooses freely.
   */
  readonly runtimeLoaderAutoload: {
    readonly name: string;
    readonly path: string;
    /**
     * Whether the file the entry names is on disk. A loader recognised by its filename can be
     * recognised without the file, and a project whose loader has gone boots with a missing script
     * while `project.godot` still says the runtime comes up through it.
     */
    readonly exists: boolean;
  } | null;
  /** class_name declarations on disk that the class cache does not list, or lists elsewhere. */
  readonly staleClasses: readonly string[];
  readonly classCacheExists: boolean;
  /**
   * Autoloads naming a file that is here and that git ignores, so a clone has it only once the
   * project's own install step has run. Said rather than counted a problem: the rule is the project
   * deciding that, where a file nobody added is one somebody forgot.
   */
  readonly ignoredAutoloads: readonly { readonly name: string; readonly path: string }[];
  readonly problems: readonly string[];
}

/**
 * The autoload a project uses to bring the runtime up itself, or null when there is none.
 *
 * Read out of the script rather than guessed from its name. The first version of this matched a
 * path with gdharness in it, which is a guess about what people call their files: it happened to
 * catch `scripts/gdharness_loader.gd` and would have missed `boot/harness.gd` entirely. What
 * actually identifies a loader is that it names the addon's own script, so that is what is looked
 * for, in the file the entry points at.
 *
 * The name in the entry proves nothing either way, since a project chooses it freely, and the
 * filename is kept only as a second chance for a loader whose reference is built from pieces
 * rather than written out. A miss here is not silent: the runtime either answers or it does not,
 * and doctor now reports which entry brings it up rather than whether ours exists.
 */
function loaderAmong(
  projectPath: string,
  named: ReadonlyMap<string, string>,
): { name: string; path: string; exists: boolean } | null {
  let byName: { name: string; path: string; exists: boolean } | null = null;
  for (const [entry, path] of named) {
    if (entry === RUNTIME_AUTOLOAD.name || path === RUNTIME_AUTOLOAD.path || path === RUNTIME_SCRIPT) {
      continue;
    }
    let source: string | null = null;
    try {
      source = readFileSync(join(projectPath, path), 'utf8');
    } catch {
      // A script the entry names and the project does not have. Only the filename can identify it
      // from here, and the answer carries that the file is gone so that doctor can say so.
    }
    if (source?.includes(RUNTIME_SCRIPT)) {
      return { name: entry, path, exists: true };
    }
    byName ??= path.toLowerCase().includes('gdharness')
      ? { name: entry, path, exists: source !== null }
      : null;
  }
  return byName;
}

/** Every autoload in project.godot, as the project-relative path each one names. */
export function autoloadPaths(settings: Record<string, Record<string, unknown>>): Map<string, string> {
  const named = new Map<string, string>();
  for (const [name, value] of Object.entries(settings['autoload'] ?? {})) {
    // A leading star is the enabled marker the editor writes, not part of the path.
    const said = typeof value === 'string' ? value.replace(/^\*/, '') : '';
    if (said.startsWith('res://')) {
      named.set(name, said.slice('res://'.length));
    }
  }
  return named;
}

/**
 * Which of [param wanted] are in git's index, or null where git could not say.
 *
 * The index is the question, because the question is whether a clone gets the file. Whether a rule
 * ignores it answers neither half: a path nobody ever added is as absent from a clone as one
 * .gitignore matches, and a path a rule matches that somebody added with -f is there. That first
 * half is the window every project sits in between the addon being installed and somebody
 * committing it, which is the window worth catching.
 *
 * Null rather than an empty set where there is no git on the machine and where this is no
 * repository, so that a missing answer reads as a missing answer rather than as every autoload
 * being lost. Run from the project root, which is the answer a worktree and a submodule both want.
 */
function trackedByGit(projectPath: string, wanted: readonly string[]): Set<string> | null {
  if (wanted.length === 0) {
    return new Set();
  }
  // -z, because git quotes a path with a space or a non-ASCII character in it otherwise and the
  // quoted spelling matches nothing we asked about.
  const asked = spawnSyncHidden('git', ['ls-files', '-z', '--', ...wanted], {
    cwd: projectPath,
    encoding: 'utf8',
  });
  if (asked.status !== 0) {
    return null;
  }
  return new Set(asked.stdout.split('\0').filter(Boolean));
}

/**
 * Which of [param wanted] git ignores and does not track, none where git could not say.
 *
 * Kept apart from a file nobody added: a rule ignoring it is somebody deciding the repository does
 * not carry it, as a project does for an addon its own install step puts in place before setup
 * runs. Failing setup on that failed every fresh clone of such a project.
 */
function ignoredByGit(projectPath: string, wanted: readonly string[]): Set<string> {
  if (wanted.length === 0) {
    return new Set();
  }
  // Read whatever the exit: 1 is "none of them", and a failure prints none.
  const asked = spawnSyncHidden('git', ['check-ignore', '-z', '--stdin'], {
    cwd: projectPath,
    encoding: 'utf8',
    input: wanted.map((path) => `${path}\0`).join(''),
  });
  if (asked.error !== undefined) {
    return new Set();
  }
  return new Set(asked.stdout.split('\0').filter(Boolean));
}

/** The enabled editor plugins, read out of project.godot's PackedStringArray of plugin.cfg paths. */
function enabledPlugins(settings: Record<string, Record<string, unknown>>): string[] {
  const raw = settings['editor_plugins']?.['enabled'];
  if (typeof raw !== 'string') {
    return [];
  }
  return [...raw.matchAll(/res:\/\/addons\/([^/"]+)\/plugin\.cfg/g)]
    .map((match) => match[1] ?? '')
    .filter(Boolean);
}

/** What holds and what does not, read from the project directory alone. */
export function inspectProject(projectPath: string): ProjectReport {
  const problems: string[] = [];
  const addons = ADDONS.map((name): AddonState => {
    const directory = join(projectPath, 'addons', name);
    const marker = join(directory, VERSION_MARKER);
    const installed = existsSync(directory);
    const version = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
    const current = version === SERVER_VERSION;
    if (installed && !current) {
      problems.push(
        `addons/${name} is ${version ?? 'of an unknown version'}, this gdharness is ${SERVER_VERSION}. Run gdharness setup`,
      );
    }
    return { name, installed, version, current };
  });
  // One line for every addon missing, because a project without gdharness lacks all four at once
  // and four lines with one remedy read as four faults.
  const missing = addons.filter((addon) => !addon.installed).map((addon) => addon.name);
  if (missing.length === 1) {
    problems.unshift(`addons/${missing.join('')} is not installed. Run gdharness setup`);
  } else if (missing.length > 1) {
    problems.unshift(
      `${missing.length} addons are not installed (${missing.join(', ')}). Run gdharness setup`,
    );
  }

  const settings = parseProjectGodot(readFileSync(join(projectPath, 'project.godot'), 'utf8'));
  const pluginsEnabled = enabledPlugins(settings);
  const disabled = EDITOR_PLUGINS.filter((name) => !pluginsEnabled.includes(name));
  if (disabled.length === 1) {
    problems.push(`the ${disabled.join('')} plugin is not enabled in project.godot. Run gdharness setup`);
  } else if (disabled.length > 1) {
    problems.push(
      `the ${disabled.join(' and ')} plugins are not enabled in project.godot. Run gdharness setup`,
    );
  }
  const autoload = settings['autoload'];
  const registered = autoload === undefined ? undefined : readString(autoload, RUNTIME_AUTOLOAD.name);
  // The star is the enabled marker the editor writes, not part of the path.
  const runtimeAutoloadPath = typeof registered === 'string' ? registered.replace(/^\*/, '') : null;
  if (runtimeAutoloadPath === `res://${RUNTIME_SCRIPT}`) {
    problems.push(
      `the ${RUNTIME_AUTOLOAD.name} autoload names the addon's own script, which a clone or an export without addons/ boots as a missing script. Run gdharness setup to point it at res://${RUNTIME_AUTOLOAD.path}, the loader it writes`,
    );
  } else if (
    runtimeAutoloadPath === `res://${RUNTIME_AUTOLOAD.path}` &&
    loaderState(projectPath) === 'differs'
  ) {
    problems.push(
      `res://${RUNTIME_AUTOLOAD.path} is not the loader this gdharness ships. Run gdharness setup to write it again`,
    );
  }

  // project.godot is committed and what it names may not be. A project that installs a file an
  // autoload names rather than committing it, the way it treats gdUnit4, carries a line pointing at
  // a file the next clone will not have: the game boots with a missing script and nothing in the
  // repository says why. Found on two projects, and nothing said so at the moment it was created. A
  // file git ignores is said and not failed: a project ignoring it has an install step that puts it
  // there, and setup runs in fresh clones.
  const named = autoloadPaths(settings);
  const runtimeLoaderAutoload = loaderAmong(projectPath, named);
  // Whether the runtime is brought up at all, which is the question the name asks. It used to mean
  // "is there an entry called GdharnessRuntime", so a project bringing it up through a loader was
  // told its runtime was not registered while the runtime was answering queries. A false answer of
  // exactly the shape this project keeps finding: well formed, confident, and about something
  // other than what the reader takes it for.
  const runtimeAutoload = runtimeAutoloadPath !== null || runtimeLoaderAutoload !== null;
  const tracked = trackedByGit(projectPath, [...named.values()]);
  const untracked = [...named.values()].filter((path) => tracked !== null && !tracked.has(path));
  const ignored = ignoredByGit(projectPath, untracked);
  const ignoredAutoloads: { name: string; path: string }[] = [];
  const addonMissing = (path: string): boolean =>
    addons.some((addon) => !addon.installed && path.startsWith(`addons/${addon.name}/`));
  for (const [name, path] of named) {
    // A file that is not here at all is the fault this whole section is about, already happened
    // rather than waiting for a clone. Said for every entry, because a loader the project wrote is
    // as absent from a fresh checkout as our addon is, and the entry naming it is the one line
    // nothing else here reads. Our own addon's is the exception, since the line above has already
    // said the addon is not installed and a second sentence about the same absence is noise.
    if (!existsSync(join(projectPath, path))) {
      if (!addonMissing(path)) {
        problems.push(
          `the ${name} autoload names res://${path}, which is not in this project, so it boots with a missing script. Restore that file, or point the autoload at one that is here`,
        );
      }
      continue;
    }
    if (ignored.has(path)) {
      ignoredAutoloads.push({ name, path });
    } else if (tracked !== null && !tracked.has(path)) {
      problems.push(
        `the ${name} autoload names res://${path}, which git does not carry, so a clone boots with a missing script. Commit that file, or point the autoload at one the project tracks`,
      );
    }
  }

  const cached = cachedClasses(projectPath);
  const staleClasses = cached === null ? [] : staleAgainst(cached, projectPath);
  if (cached === null) {
    problems.push(
      'no class cache (.godot/global_script_class_cache.cfg), so the engine knows no class_name. Run gdharness classes, or open the editor',
    );
  } else if (staleClasses.length > 0) {
    problems.push(
      `the class cache does not list ${staleClasses.join(', ')}. Run project_import refresh_classes or gdharness classes`,
    );
  }

  return {
    projectPath,
    addons,
    pluginsEnabled,
    runtimeAutoload,
    runtimeAutoloadPath,
    runtimeLoaderAutoload,
    staleClasses,
    classCacheExists: cached !== null,
    ignoredAutoloads,
    problems,
  };
}
