import { readFileSync } from 'node:fs';
import { isNewer } from './update-check.js';

export const DEBUG_MODE: boolean = process.env['DEBUG'] === 'true';
export const GODOT_DEBUG_MODE_DEFAULT: boolean = process.env['GODOT_DEBUG'] === 'true' || DEBUG_MODE;

export const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** What an editor serving no version at all is called, since every addon before 0.4.0 is one. */
const UNVERSIONED = 'addon from before versions were reported';

/**
 * What to do about an editor and a server shipping different addons, or undefined when they agree.
 *
 * Which half is behind decides the answer, and getting it wrong sends the reader the wrong way.
 * An upgrade writes the new addon under a running editor, so the editor is the old half and a
 * restart picks the new one up. But an upgrade also leaves the harness spawning the server it
 * already started, so a project upgraded mid-session has the *newer* addon on disk and restarting
 * the editor widens the gap: what that one wants is the MCP server reconnected.
 */
export function addonMismatch(addonVersion: string | undefined, serverVersion: string): string | undefined {
  if (addonVersion === serverVersion) {
    return undefined;
  }
  const reported = addonVersion ?? '';
  const editor = reported === '' ? UNVERSIONED : reported;
  const both = `The editor is running the ${editor} addon while this server ships ${serverVersion}.`;
  if (reported !== '' && isNewer(reported, serverVersion)) {
    return `${both} This server is the older half: reconnect it in your harness so it spawns ${reported}.`;
  }
  return `${both} Restart it with editor_launch restart to pick the new one up.`;
}
