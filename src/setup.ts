/**
 * What the CLI does to a project: puts the shipped addons in it, turns the editor ones on,
 * turns the runtime autoload on or off, and reads back whether all of that holds.
 *
 * Every write that lands in project.godot goes through the engine's own operations, so the
 * file is written the way the editor writes it; the addon copy is a plain copy, whole and
 * fresh each time, so an upgrade never leaves a file of the old version behind.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedClasses, staleAgainst } from './class-cache.js';
import { type HeadlessEngine, type HeadlessOutcome, runOperation } from './headless.js';
import { parseProjectGodot } from './resources.js';
import { SERVER_VERSION } from './server-version.js';
import { readString } from './tool-args.js';

/** The addons the package ships, by directory name under addons/. */
const ADDONS = ['gdharness_editor', 'gdharness_runtime', 'auto_reload'] as const;

/** The addons that are editor plugins and are enabled by setup. */
export const EDITOR_PLUGINS = ['gdharness_editor', 'auto_reload'] as const;

/** The runtime addon is an autoload and nothing else: registered by name, never by plugin.cfg. */
export const RUNTIME_AUTOLOAD = {
  name: 'GdharnessRuntime',
  path: 'addons/gdharness_runtime/runtime_autoload.gd',
} as const;

/** Written into each installed addon, so doctor can tell an old copy from the shipped one. */
const VERSION_MARKER = '.gdharness-version';

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
  return installed;
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
  /** class_name declarations on disk that the class cache does not list, or lists elsewhere. */
  readonly staleClasses: readonly string[];
  readonly classCacheExists: boolean;
  readonly problems: readonly string[];
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
  const runtimeAutoload =
    autoload !== undefined && typeof readString(autoload, RUNTIME_AUTOLOAD.name) === 'string';

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
    staleClasses,
    classCacheExists: cached !== null,
    problems,
  };
}
