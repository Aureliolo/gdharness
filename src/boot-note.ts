import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ANNOUNCE_BUDGET_MS } from './runtime-client.js';
import { asParams } from './tool-args.js';

/**
 * How long the last games of a project took to announce, noted where the bridge file is: in the
 * project's own `.godot`, which the editor keeps and nothing of ours replaces wholesale.
 *
 * A start waits for the game to announce, and the wait has a budget. The usual one covers a
 * project that boots promptly and not one that does not, and a project's boot is a property of the
 * project: one downstream announces at eight seconds on its machine every time, so every start
 * with the usual budget answered `listening: false` about a game that was fine, and the way
 * through was to pass `runtimeWaitMs` on every call. The slowest of the last boots is what the next
 * wait is sized to, so the second start of a slow project waits long enough without being told.
 *
 * Kept per scene, keyed by the scene a start named or by MAIN_SCENE for none, because a boot is the
 * scene's as much as the project's: a harness scene that announces as it quits, a hundred seconds
 * in, would otherwise size the next start of the menu to itself.
 */
export function bootNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-boot.json');
}

/** The key a start naming no scene notes its boot under: the project's main scene, whichever it is. */
export const MAIN_SCENE = '';

function readScenes(projectPath: string): Record<string, unknown> {
  try {
    return asParams(asParams(JSON.parse(readFileSync(bootNotePath(projectPath), 'utf8')))['scenes']);
  } catch {
    return {};
  }
}

/**
 * How many of a scene's boots are kept. A boot moves with what else the machine is doing: one
 * downstream menu announced at 11.6 s on a quiet machine and at 20.1 s beside its own balance
 * sweeps, and a wait sized to the quiet one missed the busy one. Sized to the slowest of the last
 * few, a quiet boot does not undo the busy ones before it.
 */
const BOOTS_KEPT = 5;

function bootsOf(projectPath: string, scene: string): number[] {
  const kept = asParams(readScenes(projectPath)[scene])['boots'];
  return Array.isArray(kept)
    ? kept.filter((one): one is number => typeof one === 'number' && Number.isFinite(one) && one > 0)
    : [];
}

/**
 * The slowest of the last [constant BOOTS_KEPT] games of [param scene] to announce, after their
 * start, or null when none has.
 */
export function readBootNote(projectPath: string, scene: string): number | null {
  const boots = bootsOf(projectPath, scene);
  return boots.length === 0 ? null : Math.max(...boots);
}

/** Notes that a game of [param scene] announced [param announcedAfterMs] after it started. */
export function writeBootNote(projectPath: string, scene: string, announcedAfterMs: number): void {
  try {
    const path = bootNotePath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    const scenes = {
      ...readScenes(projectPath),
      [scene]: {
        boots: [...bootsOf(projectPath, scene), Math.round(announcedAfterMs)].slice(-BOOTS_KEPT),
        at: new Date().toISOString(),
      },
    };
    writeFileSync(path, JSON.stringify({ scenes }, null, 2), 'utf8');
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
 * The wait a boot of [param lastBootMs] earns before the ceiling: half as long again rather than
 * the boot itself, because a boot varies from one start to the next and a budget that the last
 * boot exactly fills is one the next boot overruns half the time.
 */
export function halfAsLongAgain(lastBootMs: number): number {
  return Math.round(lastBootMs * 1.5);
}

/**
 * The wait a start gives when the caller names none: the usual budget, or half as long again as
 * the last boot took when that is more, up to the ceiling. Never less than the usual, so a
 * project whose last game announced in a second is not given a second.
 */
export function waitSizedTo(lastBootMs: number | null, usual: number = ANNOUNCE_BUDGET_MS): number {
  if (lastBootMs === null) {
    return usual;
  }
  return Math.min(LONGEST_SIZED_WAIT_MS, Math.max(usual, halfAsLongAgain(lastBootMs)));
}
