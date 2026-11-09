/**
 * A hidden editor that quit after going unused, and what opens it again.
 *
 * Every game kept a hidden editor open all day, six of them about 11 GB, until the machine paged.
 * The editor addon quits a hidden editor that has had no call for the minutes the project's setting
 * names, unless a scene holds unsaved changes or a game is playing. It writes this record first, so
 * the next server whose call needs an editor opens one again the same way, whichever server that is.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from './alive.js';
import type { EditorPorts } from './launch.js';
import { startTimesOf } from './process-children.js';
import { isRecord } from './records.js';

/**
 * The project setting holding the minutes a hidden editor waits with no call before it quits, 0
 * for never. Kept in step with `IDLE_SETTING` in the editor addon's plugin.gd.
 */
export const IDLE_CLOSE_SETTING = 'gdharness/editor/idle_close_minutes';

/** The minutes when the setting is absent. Kept in step with `IDLE_MINUTES` in plugin.gd. */
export const IDLE_CLOSE_MINUTES = 10;

/** Where the record lies in a project. Kept in step with `IDLE_RECORD` in plugin.gd. */
const IDLE_RECORD = join('.godot', 'gdharness-editor-idle.json');

/** What the editor wrote as it quit. */
export interface IdleClosed {
  readonly pid: number;
  readonly closedAt: string;
  readonly idleMinutes: number;
  /** Its command line, the engine's arguments, then `--` and its own. */
  readonly arguments: readonly string[];
  /** The scenes it had open, which it opens again from its layout as it starts. */
  readonly scenes: readonly string[];
}

/** The record of the hidden editor of [param projectPath] that quit unused, or null. */
export function idleClosed(projectPath: string): IdleClosed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(projectPath, IDLE_RECORD), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { pid, closedAt, idleMinutes, arguments: given, scenes } = parsed;
  if (
    typeof pid !== 'number' ||
    typeof closedAt !== 'string' ||
    typeof idleMinutes !== 'number' ||
    !Array.isArray(given) ||
    !Array.isArray(scenes)
  ) {
    return null;
  }
  return {
    pid,
    closedAt,
    idleMinutes,
    arguments: given.filter((word): word is string => typeof word === 'string'),
    scenes: scenes.filter((scene): scene is string => typeof scene === 'string'),
  };
}

/**
 * Whether the editor [param record] names is still running as it quits. Its pid is alive, and the
 * process holding it started before the record was written, to the second the addon writes. A
 * process the system gave the pid to later is not the editor, and one whose start the platform
 * would not say is taken as it.
 */
export async function stillQuitting(record: IdleClosed): Promise<boolean> {
  if (!alive(record.pid)) {
    return false;
  }
  const started = (await startTimesOf([record.pid])).get(record.pid);
  return started === undefined || started < Date.parse(record.closedAt) + 1000;
}

/** Removes the record, once an editor of the project has connected or been opened again. */
export function idleSettled(projectPath: string): void {
  rmSync(join(projectPath, IDLE_RECORD), { force: true });
}

/** The language server and debug adapter ports [param words] started an editor on, or null. */
export function portsIn(words: readonly string[]): EditorPorts | null {
  const after = (flag: string): number => Number(words[words.indexOf(flag) + 1]);
  const lsp = after('--lsp-port');
  const dap = after('--dap-port');
  return Number.isInteger(lsp) && lsp > 0 && Number.isInteger(dap) && dap > 0 ? { lsp, dap } : null;
}
