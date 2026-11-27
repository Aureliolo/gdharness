/**
 * The engine slots every suite's engines take, kept off the machine's own.
 *
 * Every engine gdharness starts waits for a slot in one directory the whole machine shares, so a
 * suite left on the default would hold slots a game's gate is waiting on, and wait on them in turn.
 * Set here, on import, before any server or command is spawned: each inherits the variables. A run
 * that names its own keeps them.
 */
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { MOST_ENGINES } from '../../src/engine-launch.js';
import { PROJECTS_FOLDER, SLOT_COUNT_VARIABLE, SLOTS_VARIABLE } from '../../src/engine-slots.js';
import { tryOsLock } from '../../src/os-lock.js';

/**
 * The variables that tell a process how it takes engine slots, whichever program set them: the
 * queue's jobs and gates set them for what they start, so a run inside one inherits them.
 */
export const SLOT_VARIABLES = [
  'GODOT_ENGINE_HELD',
  SLOTS_VARIABLE,
  SLOT_COUNT_VARIABLE,
  // The marker of a job the machine's queue runs, which nothing here reads but a program started
  // inside the job would.
  ['GODOT', 'TOOLS', 'JOB'].join('_'),
];

/**
 * How many engines the suite may run at once, set by whoever starts it. The machine's own slot count
 * is no cap, since it says how many engines the whole machine runs.
 */
export const TEST_ENGINES_VARIABLE = 'GDHARNESS_TEST_ENGINES';

/**
 * How many engines the suite may run at once: the most a run takes, and no more than the machine has
 * processors for. [param cap], the suite's own variable, caps it lower still. A value that is not a
 * whole number above 0 sets no cap.
 */
export function suiteSlotCount(cap: string | undefined, processors: number): number {
  const most = Math.min(MOST_ENGINES, processors);
  const allowed = Number(cap);
  return Number.isInteger(allowed) && allowed >= 1 ? Math.min(most, allowed) : most;
}

/**
 * Leaves the process with the slot variables of a bare shell and the suite's own slot directory and
 * count, so a result does not depend on the shell that started it, a queue job or a gate included.
 * A fixture that needs a set count sets it itself.
 */
export function withTheSuitesOwnSlotVariables(): void {
  for (const name of SLOT_VARIABLES) {
    delete process.env[name];
  }
  process.env[SLOTS_VARIABLE] = join(tmpdir(), 'gdharness-test-slots');
  process.env[SLOT_COUNT_VARIABLE] = String(
    suiteSlotCount(process.env[TEST_ENGINES_VARIABLE], availableParallelism()),
  );
}

withTheSuitesOwnSlotVariables();

/**
 * The slot count, as the variable spells it, at which a run can hold [param engines] engines at once:
 * [param suiteCount], the suite's own count, raised to [param engines] where a cap holds it lower.
 */
export function slotCountForEngines(engines: number, suiteCount = process.env[SLOT_COUNT_VARIABLE]): string {
  return String(Math.max(engines, Number(suiteCount) || 0));
}

/** Whether another holder has the lock at [param lock] now, which a try for it answers. */
function lockHeld(lock: string): boolean {
  const taken = tryOsLock(lock);
  taken?.release();
  return taken === null;
}

/** The lock files in [param folder] that are held now, named as `<folder>/<name>`. */
function heldIn(slots: string, folder: string): string[] {
  const path = folder === '' ? slots : join(slots, folder);
  return existsSync(path)
    ? readdirSync(path)
        .filter((name) => name.endsWith('.held') && lockHeld(join(path, name)))
        .map((name) => (folder === '' ? name : `${folder}/${name}`))
    : [];
}

/**
 * What is held in the slot directory [param slots]: every slot lock and every project lock as
 * `projects/<name>`. The files stay once made, so a lock counts only while something holds it. A run
 * that gave back everything leaves an empty list.
 */
export function leftInSlots(slots: string): string[] {
  return [...heldIn(slots, ''), ...heldIn(slots, PROJECTS_FOLDER)].toSorted();
}

/** Every held lock in the suite's slot directory, for a call that stalled: a take waiting on held slots answers nothing until they free. */
export function slotsSaid(): string {
  const slots = process.env[SLOTS_VARIABLE];
  if (slots === undefined || !existsSync(slots)) {
    return 'The slot directory holds nothing.';
  }
  const held = leftInSlots(slots);
  return held.length === 0
    ? `The slot directory ${slots} holds no held lock.`
    : `The slot directory ${slots} has held locks:\n${held.join('\n')}`;
}
