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

/**
 * What an editor serving no version at all is called, since every addon before 0.4.0 is one.
 *
 * A whole noun phrase rather than a version-shaped fragment, because the sentence it goes into
 * supplied the noun itself and the two met as "the addon from before versions were reported addon".
 * The versioned case now brings its own noun for the same reason.
 */
const UNVERSIONED = 'an addon from before versions were reported';

/**
 * Whether the editor is running addon code other than what this server ships.
 *
 * By digest when both sides have one, because the version moves on every release and the editor
 * addon mostly does not: compared by version, an upgrade that left the addon alone called every
 * editor stale and sent it to a restart that loaded the same code. An addon from before digests
 * reports none, and the version is all there is to go on.
 */
export function editorIsStale(
  addonVersion: string | undefined,
  serverVersion: string,
  addonDigest?: string,
  shippedDigest?: string,
): boolean {
  if (addonDigest !== undefined && addonDigest !== '' && shippedDigest !== undefined) {
    return addonDigest !== shippedDigest;
  }
  return addonVersion !== serverVersion;
}

/**
 * What to do about an editor and a server shipping different addons, or undefined when they agree.
 *
 * Which half is behind decides the answer, and getting it wrong sends the reader the wrong way.
 * An upgrade writes the new addon under a running editor, so the editor is the old half and a
 * restart picks the new one up. But an upgrade also leaves the harness spawning the server it
 * already started, so a project upgraded mid-session has the *newer* addon on disk and restarting
 * the editor widens the gap: what that one wants is the MCP server reconnected.
 */
export function addonMismatch(
  addonVersion: string | undefined,
  serverVersion: string,
  addonDigest?: string,
  shippedDigest?: string,
): string | undefined {
  if (!editorIsStale(addonVersion, serverVersion, addonDigest, shippedDigest)) {
    return undefined;
  }
  const reported = addonVersion ?? '';
  if (reported === serverVersion) {
    return `The editor is running a different build of the ${reported} addon from the one this server ships. Restart it with editor_launch restart to pick this one up.`;
  }
  const editor = reported === '' ? UNVERSIONED : `the ${reported} addon`;
  const both = `The editor is running ${editor} while this server ships ${serverVersion}.`;
  if (reported !== '' && isNewer(reported, serverVersion)) {
    return `${both} This server is the older half: reconnect it in your harness so it spawns ${reported}.`;
  }
  return `${both} Restart it with editor_launch restart to pick the new one up.`;
}

/**
 * An answer from the editor, marked when the addon that produced it is not this server's.
 *
 * `editor_status` has reported `addonIsStale` all along and every other answer out of the editor
 * said nothing, so a caller who never asks about versions is served by whatever code the editor
 * loaded at startup, confidently and with no sign of it. A downstream project has a recorded
 * incident of exactly that: four errors from a stale addon that were not errors, and vanished on
 * restart. The same project reported an editor three releases behind its server today.
 *
 * Only when the two differ, so a project whose halves agree sees nothing added, and only onto an
 * object, because an answer that is a list or a number is not one to grow a key on.
 */
export function markIfStale(
  answer: unknown,
  addonVersion: string | undefined,
  serverVersion: string,
  addonDigest?: string,
  shippedDigest?: string,
): unknown {
  const staleNote = addonMismatch(addonVersion, serverVersion, addonDigest, shippedDigest);
  if (staleNote === undefined || typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return answer;
  }
  return { ...(answer as Record<string, unknown>), addonIsStale: true, staleNote };
}
