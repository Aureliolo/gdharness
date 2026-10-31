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
import { SLOT_COUNT_VARIABLE, SLOTS_VARIABLE, WAITING_FOLDER } from '../../src/engine-slots.js';

process.env[SLOTS_VARIABLE] ??= join(tmpdir(), 'gdharness-test-slots');
process.env[SLOT_COUNT_VARIABLE] ??= String(Math.min(MOST_ENGINES, availableParallelism()));

/**
 * What is left in the slot directory [param slots]: every lock, and every wait mark as
 * `waiting/<name>`. The folder of marks stays once a wait has made it, so a run that gave back
 * everything leaves an empty list rather than an empty directory.
 */
export function leftInSlots(slots: string): string[] {
  const marks = join(slots, WAITING_FOLDER);
  return [
    ...readdirSync(slots).filter((name) => name !== WAITING_FOLDER),
    ...(existsSync(marks) ? readdirSync(marks).map((name) => `${WAITING_FOLDER}/${name}`) : []),
  ].toSorted();
}
