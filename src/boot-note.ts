import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ANNOUNCE_BUDGET_MS } from './runtime-client.js';
import { asParams, readNumber } from './tool-args.js';

/**
 * How long the last game of a project took to announce, noted where the bridge file is: in the
 * project's own `.godot`, which the editor keeps and nothing of ours replaces wholesale.
 *
 * A start waits for the game to announce, and the wait has a budget. The usual one covers a
 * project that boots promptly and not one that does not, and a project's boot is a property of the
 * project: one downstream announces at eight seconds on its machine every time, so every start
 * with the usual budget answered `listening: false` about a game that was fine, and the way
 * through was to pass `runtimeWaitMs` on every call. The last boot is what the next wait is sized
 * to, so the second start of a slow project waits long enough without being told.
 */
export function bootNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-boot.json');
}

/** How long after its start the last game of the project announced, or null when none has. */
export function readBootNote(projectPath: string): number | null {
  try {
    const noted = readNumber(
      asParams(JSON.parse(readFileSync(bootNotePath(projectPath), 'utf8'))),
      'announcedAfterMs',
    );
    return noted !== undefined && Number.isFinite(noted) && noted > 0 ? noted : null;
  } catch {
    return null;
  }
}

/** Notes that a game of [param projectPath] announced [param announcedAfterMs] after it started. */
export function writeBootNote(projectPath: string, announcedAfterMs: number): void {
  try {
    const path = bootNotePath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { announcedAfterMs: Math.round(announcedAfterMs), at: new Date().toISOString() },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // A project that cannot be written into gets the usual budget next time, which is what it had.
  }
}

/**
 * The longest a start waits by default, however slow the last boot was. Past this a caller who
 * wants more has to ask, since a wait of minutes on every start is a cost worth saying yes to.
 */
export const LONGEST_SIZED_WAIT_MS = 60_000;

/**
 * The wait a start gives when the caller names none: the usual budget, or half as long again as
 * the last boot took when that is more, up to the ceiling.
 *
 * Half as long again rather than the last boot itself, because a boot varies from one start to
 * the next and a budget that the last boot exactly fills is one the next boot overruns half the
 * time. Never less than the usual, so a project whose last game announced in a second is not
 * given a second.
 */
export function waitSizedTo(lastBootMs: number | null, usual: number = ANNOUNCE_BUDGET_MS): number {
  if (lastBootMs === null) {
    return usual;
  }
  return Math.min(LONGEST_SIZED_WAIT_MS, Math.max(usual, Math.round(lastBootMs * 1.5)));
}
