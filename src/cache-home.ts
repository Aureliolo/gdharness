import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { envValue } from './launch.js';

/**
 * gdharness's folder in the user's cache: `$XDG_CACHE_HOME`, then `%LOCALAPPDATA%` on Windows,
 * then `~/.cache`. The same order on every platform, so a machine that sets XDG_CACHE_HOME on
 * Windows too has one answer whichever tool works it out. An empty variable counts as unset, and so
 * does a relative one, since each process would otherwise keep a folder under its own working
 * directory.
 */
export function cacheHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const set = (name: string): string | undefined => {
    const value = envValue(name, env);
    return value !== undefined && isAbsolute(value) ? value : undefined;
  };
  const local = platform === 'win32' ? set('LOCALAPPDATA') : undefined;
  return join(set('XDG_CACHE_HOME') ?? local ?? join(home, '.cache'), 'gdharness');
}

/**
 * Where a pinned tool the scripts fetch is kept, in a folder named for it and its version. A
 * runner's own temporary folder on CI, which is thrown away with the runner. Anywhere else the
 * cache, since a temporary folder is swept: a pinned engine kept there vanished from under the
 * sessions pointing GODOT_PATH at it.
 */
export function toolHome(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const runner = env['RUNNER_TEMP'];
  return join(runner === undefined || runner === '' ? join(cacheHome(env), 'tools') : runner, name);
}
