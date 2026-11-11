import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envValue } from './launch.js';

/**
 * Where this server announces and looks first. The addon derives the same path with the same
 * precedence, so the two only meet if this stays in step with `_announcement_directory` in the
 * runtime autoload: an explicit override, the per-user runtime directory where the platform has
 * one, and otherwise the temporary directory.
 */
export function runtimeDirectory(variables: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue('GDHARNESS_RUNTIME_DIR', variables);
  if (explicit) {
    return explicit;
  }
  const perUser = envValue('XDG_RUNTIME_DIR', variables);
  return join(perUser ?? tmpdir(), 'gdharness');
}

/**
 * Every directory a game on this machine could have announced itself in.
 *
 * Deriving the path the same way on both sides is not enough, because the two sides do not share
 * an environment. A game is started by the editor, the editor by whoever opened it, and this
 * server by the harness: an editor launched without TMP or TEMP set puts its games in the
 * Windows directory's Temp while this server, started with them set, watches the user's. Measured
 * on Windows, where it cost a session: the game announced in C:\Windows\Temp\gdharness and the
 * server created and swept an empty C:\Users\<name>\AppData\Local\Temp\gdharness beside it,
 * and answered that no game was running while one was.
 *
 * `editor_launch` now passes the first of these down, so an editor this server opened puts its
 * games where this server looks. The rest are for the editor it did not open, which is most of
 * them: a fallback list beats a silent empty answer, and a stale announcement is already handled
 * by the process check.
 */
export function runtimeDirectories(variables: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [runtimeDirectory(variables)];
  const fallbacks =
    process.platform === 'win32'
      ? [envValue('SystemRoot', variables) ?? envValue('windir', variables) ?? 'C:\\Windows']
      : ['/tmp', '/var/tmp'];
  for (const base of fallbacks) {
    candidates.push(join(base, process.platform === 'win32' ? 'Temp' : '', 'gdharness'));
  }
  return [...new Set(candidates.map((path) => resolve(path)))];
}
