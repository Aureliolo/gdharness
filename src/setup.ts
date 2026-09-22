/**
 * What the CLI does to a project: puts the shipped addons in it, turns the editor ones on,
 * turns the runtime autoload on or off, and reads back whether all of that holds.
 *
 * Every write that lands in project.godot goes through the engine's own operations, so the
 * file is written the way the editor writes it; the addon copy is a plain copy, whole and
 * fresh each time, so an upgrade never leaves a file of the old version behind.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedClasses, staleAgainst } from './class-cache.js';
import { type HeadlessEngine, type HeadlessOutcome, runOperation } from './headless.js';
import { parseProjectGodot } from './resources.js';
import { SERVER_VERSION } from './server-version.js';
import { readString } from './tool-args.js';

/** The addons the package ships, by directory name under addons/. */
export const ADDONS = ['gdharness_editor', 'gdharness_runtime', 'auto_reload'] as const;

/** The addons that are editor plugins and are enabled by setup. */
export const EDITOR_PLUGINS = ['gdharness_editor', 'auto_reload'] as const;

/** The runtime addon is an autoload and nothing else: registered by name, never by plugin.cfg. */
export const RUNTIME_AUTOLOAD = {
  name: 'GdharnessRuntime',
  path: 'addons/gdharness_runtime/runtime_autoload.gd',
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

/** Written into each installed addon, so doctor can tell an old copy from the shipped one. */
const VERSION_MARKER = '.gdharness-version';

/**
 * Written beside the version marker in the editor addon: a digest of the code an editor loads.
 *
 * The version changes on every release and the editor's code does not, so a version comparison
 * called an editor stale after every upgrade and sent it to a restart that changed nothing. The
 * digest is taken from the shipped copy at install time rather than from the project, because
 * the editor writes `.uid` and import files into its addons and those are not the code it loaded.
 */
const DIGEST_MARKER = '.gdharness-digest';

/** The digest of the editor plugins in `from`, which is what an open editor has loaded of ours. */
function editorAddonDigest(from: string = shippedAddonsDirectory()): string {
  const hash = createHash('sha256');
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
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
  for (const name of EDITOR_PLUGINS) {
    walk(join(from, name), name);
  }
  return hash.digest('hex');
}

let shippedDigest: string | null | undefined;

/**
 * The digest of the editor plugins this package ships, taken once, or undefined when they cannot
 * be read, which leaves staleness to the version as it was before digests.
 */
export function shippedEditorDigest(): string | undefined {
  if (shippedDigest === undefined) {
    try {
      shippedDigest = editorAddonDigest();
    } catch {
      shippedDigest = null;
    }
  }
  return shippedDigest ?? undefined;
}

/** The digest the installed editor addon was written with, or null for a copy from before digests. */
export function installedEditorDigest(projectPath: string): string | null {
  const marker = join(projectPath, 'addons', ADDONS[0], DIGEST_MARKER);
  if (!existsSync(marker)) {
    return null;
  }
  const said = readFileSync(marker, 'utf8').trim();
  return said === '' ? null : said;
}

/** Where the shipped addons are, beside this module in the build and in the source tree alike. */
function shippedAddonsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'addons');
}

/** The operations script, laid out the same way. */
export function shippedOperationsScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'godot', 'operations', 'godot_operations.gd');
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
    if (!existsSync(join(source, name === 'gdharness_runtime' ? 'runtime_autoload.gd' : 'plugin.cfg'))) {
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

/** Each addon taken back out, naming the ones that were there to remove. */
export function removeAddons(projectPath: string): readonly string[] {
  const removed: string[] = [];
  for (const name of ADDONS) {
    const target = join(projectPath, 'addons', name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
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
 * Whether an autoload entry is one gdharness wrote, and so one it may rewrite.
 *
 * A project is free to bring the runtime up through a script of its own, and the install guide
 * recommends exactly that: `project.godot` is committed and `addons/` often is not, so an entry
 * naming the addon directly boots a fresh clone, and every CI runner, with a missing script. A
 * wrapper is how a project says "only when it is there". Repointing the entry takes that away, and
 * takes it away from the one file the project wrote to keep it.
 *
 * Only that. The addon refuses to serve outside a debug build and refuses for a `-s` script run
 * unless the project asks, so a repointed entry does not put a socket into an export. The reporting
 * project believed it did and so did this comment, which is worth recording next to the fix.
 *
 * What makes it worth a check rather than a note is that nothing fails when it happens. The wrapper
 * is still on disk and still correct, every gate a project has goes on passing because they
 * exercise the script rather than ask what `project.godot` registers, and the state is only visible
 * in a diff. Found in `git status` after twelve green gates.
 */
export function autoloadIsOurs(named: string | null): boolean {
  return named === null || named === `res://${RUNTIME_AUTOLOAD.path}`;
}

/** The runtime autoload registered or removed, through the engine. */
export async function setRuntime(
  engine: HeadlessEngine,
  projectPath: string,
  on: boolean,
): Promise<HeadlessOutcome> {
  return on
    ? await runOperation(
        engine,
        'add_autoload',
        { name: RUNTIME_AUTOLOAD.name, path: `res://${RUNTIME_AUTOLOAD.path}`, enabled: true },
        projectPath,
      )
    : await runOperation(engine, 'remove_autoload', { name: RUNTIME_AUTOLOAD.name }, projectPath);
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
    if (entry === RUNTIME_AUTOLOAD.name || path === RUNTIME_AUTOLOAD.path) {
      continue;
    }
    let source: string | null = null;
    try {
      source = readFileSync(join(projectPath, path), 'utf8');
    } catch {
      // A script the entry names and the project does not have. Only the filename can identify it
      // from here, and the answer carries that the file is gone so that doctor can say so.
    }
    if (source?.includes(RUNTIME_AUTOLOAD.path)) {
      return { name: entry, path, exists: true };
    }
    byName ??= path.toLowerCase().includes('gdharness')
      ? { name: entry, path, exists: source !== null }
      : null;
  }
  return byName;
}

/** Every autoload in project.godot, as the project-relative path each one names. */
function autoloadPaths(settings: Record<string, Record<string, unknown>>): Map<string, string> {
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
  const asked = spawnSync('git', ['ls-files', '-z', '--', ...wanted], {
    cwd: projectPath,
    encoding: 'utf8',
  });
  if (asked.status !== 0) {
    return null;
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
    if (!installed) {
      problems.push(`addons/${name} is not installed; run gdharness setup`);
    } else if (!current) {
      problems.push(
        `addons/${name} is ${version ?? 'of an unknown version'}, this gdharness is ${SERVER_VERSION}; run gdharness setup`,
      );
    }
    return { name, installed, version, current };
  });

  const settings = parseProjectGodot(readFileSync(join(projectPath, 'project.godot'), 'utf8'));
  const pluginsEnabled = enabledPlugins(settings);
  for (const name of EDITOR_PLUGINS) {
    if (!pluginsEnabled.includes(name)) {
      problems.push(`the ${name} plugin is not enabled in project.godot; run gdharness setup`);
    }
  }
  const autoload = settings['autoload'];
  const registered = autoload === undefined ? undefined : readString(autoload, RUNTIME_AUTOLOAD.name);
  // The star is the enabled marker the editor writes, not part of the path.
  const runtimeAutoloadPath = typeof registered === 'string' ? registered.replace(/^\*/, '') : null;

  // project.godot is committed and what it names may not be. setup registers the runtime addon by
  // its path under addons/, and a project that installs its addons rather than committing them, the
  // way it treats gdUnit4, then carries a line pointing at a file the next clone will not have: the
  // game boots with a missing script and nothing in the repository says why. Found on two projects,
  // and nothing said so at the moment it was created.
  const named = autoloadPaths(settings);
  const runtimeLoaderAutoload = loaderAmong(projectPath, named);
  // Whether the runtime is brought up at all, which is the question the name asks. It used to mean
  // "is there an entry called GdharnessRuntime", so a project bringing it up through a loader was
  // told its runtime was not registered while the runtime was answering queries. A false answer of
  // exactly the shape this project keeps finding: well formed, confident, and about something
  // other than what the reader takes it for.
  const runtimeAutoload = runtimeAutoloadPath !== null || runtimeLoaderAutoload !== null;
  const tracked = trackedByGit(projectPath, [...named.values()]);
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
          `the ${name} autoload names res://${path}, which is not in this project, so it boots with a missing script; restore that file, or point the autoload at one that is here`,
        );
      }
      continue;
    }
    if (tracked !== null && !tracked.has(path)) {
      problems.push(
        `the ${name} autoload names res://${path}, which git does not carry, so a clone boots with a missing script; commit that file, or point the autoload at one the project tracks`,
      );
    }
  }

  const cached = cachedClasses(projectPath);
  const staleClasses = cached === null ? [] : staleAgainst(cached, projectPath);
  if (cached === null) {
    problems.push(
      'no .godot/global_script_class_cache.cfg: the engine knows no class_name; run project_import refresh_classes or open the editor',
    );
  } else if (staleClasses.length > 0) {
    problems.push(
      `the class cache does not list ${staleClasses.join(', ')}; run project_import refresh_classes or gdharness classes`,
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
    problems,
  };
}
