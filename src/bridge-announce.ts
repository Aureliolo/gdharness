import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage } from './errors.js';

/**
 * Where this server says its editor bridge is, so an editor can find it without anybody having
 * agreed on a port beforehand.
 *
 * Inside the project rather than under a temporary directory, and that is the whole point. The
 * two sides do not share an environment: this server is started by the harness and the editor by
 * whoever opened it, so a path derived from TMP is a path the two of them spell differently.
 * That cost a session once already, on the runtime's own announcement, and the fallback list it
 * grew is not something to write twice in two languages. The project is the one fact both sides
 * hold, and `.godot` is the directory Godot already keeps its own cache in: gitignored
 * everywhere, and not somewhere an install of ours replaces wholesale.
 */
export function announcementPath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-bridge.json');
}

/** What the editor reads: enough to reach this bridge, and to tell a live one from a leftover. */
interface BridgeAnnouncement {
  readonly protocol: number;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
}

/** Raised with the file, so a reader that stops understanding it can say so rather than guess. */
export const BRIDGE_ANNOUNCE_PROTOCOL = 1;

/**
 * Writes where this bridge is, and answers the path, or null with a reason on standard error.
 *
 * A failure here is not fatal: without an announcement the editor falls back to the port it was
 * configured with, which is where it looked before any of this existed.
 */
export function announceBridge(
  projectPath: string,
  bridge: { host: string; port: number; version: string },
): string | null {
  const path = announcementPath(projectPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const announcement: BridgeAnnouncement = {
      protocol: BRIDGE_ANNOUNCE_PROTOCOL,
      host: bridge.host,
      port: bridge.port,
      pid: process.pid,
      version: bridge.version,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(announcement, null, 2)}\n`, 'utf8');
    return path;
  } catch (error) {
    console.error(`[SERVER] Could not announce the editor bridge at ${path}: ${errorMessage(error)}`);
    return null;
  }
}

/** Takes the announcement down. A file left behind names a process the editor will find gone. */
export function withdrawBridge(path: string | null): void {
  if (path === null) {
    return;
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`[SERVER] Could not withdraw the editor bridge announcement: ${errorMessage(error)}`);
  }
}
