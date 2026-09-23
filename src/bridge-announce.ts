import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage } from './errors.js';
import { startTimesOf } from './process-children.js';

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
export interface BridgeAnnouncement {
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
 * What the announcement for [param projectPath] says, or null when there is not one to read.
 *
 * Null for a file that is missing, unreadable or not the shape this writes, because all three mean
 * the same thing to a caller: nothing here says where a bridge is.
 */
export function readAnnouncement(path: string): BridgeAnnouncement | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const said = parsed as Partial<BridgeAnnouncement>;
    if (typeof said.port !== 'number' || typeof said.pid !== 'number') {
      return null;
    }
    return said as BridgeAnnouncement;
  } catch {
    return null;
  }
}

/** A server announcing itself for a project: which version, and which process. */
export interface AnnouncedServer {
  readonly version: string;
  readonly pid: number;
}

/**
 * The server [param announcement] describes, when the process under its pid could have written it.
 *
 * [param startedAt] is when the process holding that pid started, or undefined when it is gone or
 * the platform will not say. A pid is handed out again once its holder has gone, so a live process
 * under it is not enough: the one that wrote the announcement started before writing it, which a
 * process that took the number afterwards cannot have done. A second of slack, since some
 * platforms give the start to the second and the announcement carries milliseconds.
 */
export function serverBehind(
  announcement: BridgeAnnouncement | null,
  startedAt: number | undefined,
): AnnouncedServer | null {
  if (announcement === null || typeof announcement.version !== 'string' || startedAt === undefined) {
    return null;
  }
  const announcedAt = Date.parse(announcement.startedAt);
  if (Number.isNaN(announcedAt) || startedAt > announcedAt + 1000) {
    return null;
  }
  return { version: announcement.version, pid: announcement.pid };
}

/**
 * The server serving [param projectPath] right now, as its own announcement says, or null when no
 * live server has announced itself there. What `upgrade` names as the one a harness is running,
 * rather than the version its config held before, which is only the running one if a reconnect
 * happened in between.
 */
export function serverServing(projectPath: string): AnnouncedServer | null {
  const announcement = readAnnouncement(announcementPath(projectPath));
  if (announcement === null) {
    return null;
  }
  return serverBehind(announcement, startTimesOf([announcement.pid]).get(announcement.pid));
}

/** Whether the announcement at [param path] is the one this process wrote. */
function announcementIsOurs(path: string): boolean {
  return readAnnouncement(path)?.pid === process.pid;
}

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

/**
 * Takes the announcement down. A file left behind names a process the editor will find gone.
 *
 * Only while it is still this process's own. A server that has been replaced still holds the path
 * it once announced at, and the file there now is the replacement's: removing it on the way out
 * would take the live bridge's address with it and leave the editor with nothing to find.
 */
export function withdrawBridge(path: string | null): void {
  if (path === null || !announcementIsOurs(path)) {
    return;
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`[SERVER] Could not withdraw the editor bridge announcement: ${errorMessage(error)}`);
  }
}
