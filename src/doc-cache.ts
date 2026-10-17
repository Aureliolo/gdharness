/**
 * The editor's class reference cache, and the crash a stale one causes as an import or an export
 * exits.
 *
 * Godot keeps the class reference in `editor_doc_cache-<major>.<minor>.res` in the editor's cache
 * directory, keyed on the exact build, so 4.7.1 and 4.7.2 share the file and each finds the other's
 * stale. An editor-mode run that finds it stale rebuilds it, and one that quits as soon as its work
 * is done, as an import or an export does, crashes on the way out: the thread that read the cache
 * hands the rebuild to the main thread as a deferred call, the editor frees the reference as it is
 * torn down, and the deferred call runs after that. Measured on 4.7.2: thirty imports of thirty
 * against a stale cache ended with an access violation, each having done its work and written a
 * fresh cache first, so the next run is clean. A missing cache is rebuilt at once and never crashes.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { type EngineRun, howItEnded } from './engine-run.js';

const CACHE_FILE = /^editor_doc_cache-\d+\.\d+\.res$/;

/**
 * Where the engine at [param godotPath] keeps its editor cache, as `EditorPaths` works it out: the
 * `editor_data/cache` folder beside an executable marked self-contained by a `_sc_` or `._sc_` file
 * (on macOS, beside the app bundle), and the platform's cache folder otherwise.
 */
export function editorCacheDirectory(
  godotPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const beside = dirname(godotPath);
  const bundle =
    platform === 'darwin' && basename(beside) === 'MacOS' && basename(dirname(beside)) === 'Contents'
      ? dirname(dirname(dirname(beside)))
      : null;
  for (const folder of bundle === null ? [beside] : [beside, bundle]) {
    if (existsSync(join(folder, '._sc_')) || existsSync(join(folder, '_sc_'))) {
      return join(folder, 'editor_data', 'cache');
    }
  }
  if (platform === 'win32') {
    // An empty variable counts as unset, as the engine counts it.
    const set = (name: string): string | undefined => (env[name] === '' ? undefined : env[name]);
    return join(set('LOCALAPPDATA') ?? set('TEMP') ?? join(home, 'AppData', 'Local'), 'Godot');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'Godot');
  }
  const xdg = env['XDG_CACHE_HOME'];
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'godot');
}

/** When each class reference cache in [param directory] was last written, by path. */
export function docCachesWritten(directory: string): ReadonlyMap<string, number> {
  const written = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return written;
  }
  for (const name of names.filter((one) => CACHE_FILE.test(one))) {
    try {
      written.set(join(directory, name), statSync(join(directory, name)).mtimeMs);
    } catch {
      // Gone between the listing and the read, which another engine replacing it can do.
    }
  }
  return written;
}

/**
 * What a caller is told when [param ran], an import or an export, did not exit cleanly, or exited 0
 * after its crash handler reported a crash, as one on macOS does, and a class reference cache was
 * written while it ran, going by [param before] and [param after] from
 * {@link docCachesWritten}; null for any other run. [param what] names the run, `import` or
 * `export`, and the caller runs it again when this is not null.
 */
export function docCacheCrash(
  ran: Pick<EngineRun, 'exitCode' | 'exitSignal' | 'failure' | 'log'>,
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  what: 'import' | 'export',
): string | null {
  const report = ran.log.crashReport();
  if ((ran.exitCode === 0 && ran.exitSignal === null && report === undefined) || ran.failure !== null) {
    return null;
  }
  const rewritten = [...after].find(([path, at]) => before.get(path) !== at)?.[0];
  if (rewritten === undefined) {
    return null;
  }
  const said = report === undefined ? '' : `, and its crash handler printed "${report.text}"`;
  return (
    `The first ${what} ended badly (${howItEnded(ran)}${said}) after rebuilding the editor's class reference ` +
    `cache, ${rewritten}. Godot crashes as an import or an export exits when it finds that cache ` +
    'stale, which it is whenever another build of the same minor version wrote it last, such as 4.7.1 ' +
    `beside 4.7.2, and the crashing run writes a fresh one. So the ${what} was run again, and this answer ` +
    'is from that second run.'
  );
}
