/**
 * The engine slots every suite's engines take, kept off the machine's own.
 *
 * Every engine gdharness starts waits for a slot in one directory the whole machine shares, so a
 * suite left on the default would hold slots a game's gate is waiting on, and wait on them in turn.
 * Set here, on import, before any server or command is spawned: each inherits the variables. A run
 * that names its own keeps them.
 */
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { MOST_ENGINES } from '../../src/engine-launch.js';
import { SLOT_COUNT_VARIABLE, SLOTS_VARIABLE } from '../../src/engine-slots.js';

process.env[SLOTS_VARIABLE] ??= join(tmpdir(), 'gdharness-test-slots');
process.env[SLOT_COUNT_VARIABLE] ??= String(Math.min(MOST_ENGINES, availableParallelism()));
