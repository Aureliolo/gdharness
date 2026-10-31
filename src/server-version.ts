import { readFileSync } from 'node:fs';
import { isRecord } from './records.js';
import { isNewer } from './update-check.js';

/** Debug lines on stderr, and headless engines run with `--debug-godot`. */
export const DEBUG_MODE: boolean = process.env['GDHARNESS_DEBUG'] === '1';

export const SERVER_VERSION = (() => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = isRecord(pkg) ? pkg['version'] : undefined;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Whether an addon is running code other than what this server ships.
 *
 * By digest, because the version moves on every release and the addons' code mostly does not:
 * compared by version, an upgrade that left the addon alone called every editor stale and sent it
 * to a restart that loaded the same code.
 */
export function staleAddon(addonDigest: string, shippedDigest: string): boolean {
  return addonDigest !== shippedDigest;
}

/**
 * Why an editor running this server's addon code reports another version, or undefined when the
 * versions match or the editor reports none. Asked only of an editor that is not stale.
 *
 * An upgrade that leaves the editor addons alone leaves an open editor reporting the version it
 * loaded at startup, which is right: it is running that code, and that code is this version's. The
 * answer then showed an older addonVersion beside addonIsStale false, and a session read the gap as
 * something to fix and restarted its editor for nothing.
 */
export function sameCodeNote(addonVersion: string, serverVersion: string): string | undefined {
  if (addonVersion === '' || addonVersion === serverVersion) {
    return undefined;
  }
  const same = `The editor loaded the ${addonVersion} addons, which are the same code this ${serverVersion} server ships, so nothing needs restarting`;
  // Which version moves next depends on which half is behind. An editor opened after a project's
  // pin moved and before the harness reconnected holds the newer addon, and keeps it across a
  // restart: it is this server that is behind.
  return isNewer(addonVersion, serverVersion)
    ? `${same}. This server is the older of the two, which a reconnect in your harness settles once the project pins ${addonVersion}.`
    : `${same}; addonVersion is the version the editor loaded when it started.`;
}

/**
 * Why the editor is not asked anything, and what to do about it, when it and this server run
 * different addon code; undefined when they agree.
 *
 * Which half is behind decides the answer, and getting it wrong sends the reader the wrong way.
 * An upgrade writes the new addon under a running editor, so the editor is the old half and a
 * restart picks the new one up. But an upgrade also leaves the harness spawning the server it
 * already started, so a project upgraded mid-session has the *newer* addon on disk and restarting
 * the editor widens the gap: what that one wants is the MCP server reconnected.
 */
export function addonMismatch(
  addonVersion: string,
  serverVersion: string,
  addonDigest: string,
  shippedDigest: string,
  onDisk?: string | null,
): string | undefined {
  if (!staleAddon(addonDigest, shippedDigest)) {
    return undefined;
  }
  const reported = addonVersion;
  // What a restart would load, which is the project's addons on disk, not this server's. A server
  // newer than the addons it finds, as a checkout gets when a teammate moves the pin in a committed
  // config and not the addons, was told to restart the editor, which loaded the same old code, and
  // the restart's own answer said to restart again.
  const restart =
    onDisk !== undefined && onDisk !== shippedDigest
      ? `The project's own addons are not this server's either, so a restart would load the same code again: run  ${gdharnessCommand(serverVersion, 'upgrade')}  in a shell in the project directory, which installs the ${serverVersion} addons, and editor_launch restart then picks them up.`
      : 'Restart it with editor_launch restart to pick this one up.';
  const asked = 'so this server asks it nothing but to quit:';
  if (reported === serverVersion) {
    return `The editor is running a different build of the ${reported} addon from the one this server ships, ${asked} ${restart}`;
  }
  const editor = reported === '' ? 'an addon with no version marker' : `the ${reported} addon`;
  const both = `The editor is running ${editor} while this server ships ${serverVersion}, ${asked}`;
  if (reported !== '' && isNewer(reported, serverVersion)) {
    return `${both} this server is the older half; reconnect it in your harness so it spawns ${reported}.`;
  }
  return `${both} ${restart}`;
}

/**
 * The gdharness command line running [param args] at [param version], as typed into a shell.
 *
 * No tool installs or upgrades the addons, so a remedy that needs one names the command in full: a
 * caller holding only the tools, told "gdharness setup", went looking for a tool of that name.
 */
export function gdharnessCommand(version: string, args: string): string {
  return `npx -y gdharness@${version} ${args}`;
}

/** A game that reports its runtime addon and could not read the markers that say what it is. */
export function runtimeAddonUnknown(addon: { readonly version: string; readonly digest: string }): boolean {
  return addon.version === '' && addon.digest === '';
}

/**
 * Why a game is not asked anything, and what to do about it, when it runs a runtime addon other
 * than this server's; undefined when it runs this server's or cannot say what it runs.
 *
 * The same question as `addonMismatch` asks of the editor, for the addon inside a game. A second
 * checkout of a project, a git worktree, carried a runtime addon three releases behind its server
 * and nothing said so: every runtime answer came from the old code, and the protocol, which is
 * all that was compared, had not moved. [param onDisk] is the digest the game's own project holds,
 * which is what the game loads the next time it starts.
 */
export function runtimeMismatch(
  pid: number,
  addon: { readonly version: string; readonly digest: string },
  serverVersion: string,
  shippedDigest: string,
  onDisk: string | null | undefined,
  projectPath: string,
): string | undefined {
  if (runtimeAddonUnknown(addon) || !staleAddon(addon.digest, shippedDigest)) {
    return undefined;
  }
  const game = `The game (pid ${pid})`;
  if (addon.version !== '' && isNewer(addon.version, serverVersion)) {
    return `${game} is running the ${addon.version} runtime addon while this server ships ${serverVersion}, so this server asks it nothing. This server is the older half: reconnect it in your harness so it spawns ${addon.version}.`;
  }
  let loaded: string;
  if (addon.version === serverVersion) {
    loaded = `a different build of the ${serverVersion} runtime addon from the one this server ships`;
  } else if (addon.version === '') {
    loaded = `a runtime addon with no version marker, while this server ships ${serverVersion}`;
  } else {
    loaded = `the ${addon.version} runtime addon, while this server ships ${serverVersion}`;
  }
  const remedy =
    onDisk !== undefined && onDisk !== shippedDigest
      ? `The project's own runtime addon is not this server's either, so starting the game again loads the same code: run  ${gdharnessCommand(serverVersion, `upgrade "${projectPath}"`)}  in a shell, which installs the ${serverVersion} addons, and the game picks them up when it next starts.`
      : `The project holds this server's runtime addon, so the game picks it up when it next starts.`;
  return `${game} is running ${loaded}, so this server asks it nothing: its answers would come from that code. ${remedy}`;
}
