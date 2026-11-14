/**
 * The engine slots every suite's engines take, kept off the machine's own.
 *
 * Every engine gdharness starts waits for a slot in one directory the whole machine shares, so a
 * suite left on the default would hold slots a game's gate is waiting on, and wait on them in turn.
 * Set here, on import, before any server or command is spawned: each inherits the variables. A run
 * that names its own keeps them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { MOST_ENGINES } from '../../src/engine-launch.js';
import { ENDED_SUFFIX, SLOT_COUNT_VARIABLE, SLOTS_VARIABLE, WAITING_FOLDER } from '../../src/engine-slots.js';

/**
 * The variables that tell a process how it takes engine slots, whichever program set them: the
 * queue's jobs and gates set them for what they start, so a run inside one inherits them.
 */
export const SLOT_VARIABLES = [
  'GODOT_ENGINE_HELD',
  'GODOT_ENGINE_LANES',
  'GODOT_ENGINE_SHARE',
  'GODOT_ENGINE_SHARE_COUNT',
  SLOTS_VARIABLE,
  SLOT_COUNT_VARIABLE,
  'GODOT_ENGINE_STARVING',
  'GODOT_ENGINE_TIER',
  'GODOT_ENGINE_TIMED',
  // The marker of a job the machine's queue runs, which nothing here reads but a program started
  // inside the job would.
  ['GODOT', 'TOOLS', 'JOB'].join('_'),
];

/**
 * Leaves the process with the slot variables of a bare shell and the suite's own slot directory and
 * count, so a result does not depend on the shell that started it, a queue job or a gate included.
 * A fixture sets what it needs itself.
 */
export function withTheSuitesOwnSlotVariables(): void {
  for (const name of SLOT_VARIABLES) {
    delete process.env[name];
  }
  process.env[SLOTS_VARIABLE] = join(tmpdir(), 'gdharness-test-slots');
  process.env[SLOT_COUNT_VARIABLE] = String(Math.min(MOST_ENGINES, availableParallelism()));
}

withTheSuitesOwnSlotVariables();

/**
 * What is left in the slot directory [param slots]: every lock, and every wait mark as
 * `waiting/<name>`. The folder of marks stays once a wait has made it, and so does the note each
 * ended wait leaves, which holds nothing. A run that gave back everything leaves an empty list.
 */
export function leftInSlots(slots: string): string[] {
  const marks = join(slots, WAITING_FOLDER);
  return [
    ...readdirSync(slots).filter((name) => name !== WAITING_FOLDER),
    ...(existsSync(marks)
      ? readdirSync(marks)
          .filter((name) => !name.endsWith(ENDED_SUFFIX))
          .map((name) => `${WAITING_FOLDER}/${name}`)
      : []),
  ].toSorted();
}

/**
 * Every lock and mark in the suite's slot directory with what it holds and whether its process
 * lives, for a call that stalled: a take waiting on held slots answers nothing until they free.
 */
export function slotsSaid(): string {
  const slots = process.env[SLOTS_VARIABLE];
  if (slots === undefined || !existsSync(slots)) {
    return 'The slot directory holds nothing.';
  }
  const said = (path: string, name: string): string[] => {
    try {
      return readdirSync(path).flatMap((inner) => said(join(path, inner), `${name}/${inner}`));
    } catch {
      // Not a folder, so a lock or a mark.
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8').trim();
    } catch {
      return [`${name} went while it was read`];
    }
    const pid = /"pid":(\d+)/.exec(text)?.[1];
    return [`${name} (${pid === undefined ? 'no pid' : livesSaid(Number(pid))}): ${text}`];
  };
  const lines = readdirSync(slots)
    .toSorted()
    .flatMap((name) => said(join(slots, name), name))
    .filter((line) => !line.includes(ENDED_SUFFIX));
  return lines.length === 0
    ? `The slot directory ${slots} holds nothing.`
    : `The slot directory ${slots} holds:\n${lines.join('\n')}`;
}

function livesSaid(pid: number): string {
  try {
    process.kill(pid, 0);
    return `pid ${String(pid)} lives`;
  } catch (error) {
    // EPERM is a live process of another user's.
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? `pid ${String(pid)} has gone`
      : `pid ${String(pid)} lives`;
  }
}
