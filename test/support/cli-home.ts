import { join } from 'node:path';

/**
 * [param env] with every place the command line looks for a home pointed at [param home].
 *
 * The command line reads and writes machine-wide harness configs under the home directory and, on
 * Windows, under APPDATA: Claude Desktop, Codex, Windsurf, Cline and the rest. Run with the real
 * ones, an `upgrade` or `uninstall` in a fixture rewrote or removed the developer's own entries.
 */
export function withHome(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
  };
}
