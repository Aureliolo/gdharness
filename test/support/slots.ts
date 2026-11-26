/**
 * The engine slots every suite's engines take, kept off the machine's own.
 *
 * Every engine gdharness starts waits for a slot in one directory the whole machine shares, so a
 * suite left on the default would hold slots a game's gate is waiting on, and wait on them in turn.
 * Set here, on import, before any server or command is spawned: each inherits the variables. A run
 * that names its own keeps them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { MOST_ENGINES } from '../../src/engine-launch.js';
import {
  ENDED_SUFFIX,
  PROJECTS_FOLDER,
  SLOT_COUNT_VARIABLE,
  SLOTS_VARIABLE,
  WAITING_FOLDER,
} from '../../src/engine-slots.js';

/**
 * The variables that tell a process how it takes engine slots, whichever program set them: the
 * queue's jobs and gates set them for what they start, so a run inside one inherits them.
 */
export const SLOT_VARIABLES = [
  'GODOT_ENGINE_HELD',
  'GODOT_ENGINE_SLOT_COMMAND',
  SLOTS_VARIABLE,
  SLOT_COUNT_VARIABLE,
  'GODOT_ENGINE_TIMED',
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

/**
 * What is left in the slot directory [param slots]: every lock, every wait mark as
 * `waiting/<name>` and every project lock as `projects/<name>`. The folders of marks and project
 * locks stay once made, and so does the note each ended wait leaves, which holds nothing. A run that
 * gave back everything leaves an empty list.
 */
export function leftInSlots(slots: string): string[] {
  const inside = (folder: string, kept: (name: string) => boolean): string[] => {
    const path = join(slots, folder);
    return existsSync(path)
      ? readdirSync(path)
          .filter(kept)
          .map((name) => `${folder}/${name}`)
      : [];
  };
  return [
    ...readdirSync(slots).filter(
      (name) => name !== WAITING_FOLDER && name !== PROJECTS_FOLDER,
    ),
    ...inside(WAITING_FOLDER, (name) => !name.endsWith(ENDED_SUFFIX)),
    ...inside(PROJECTS_FOLDER, () => true),
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

/** A taker waiting for a slot, as its mark in the waiting folder names it. */
export interface WaitingMark {
  readonly mark: string;
  readonly pid: number;
  /** When it began to wait, in milliseconds since the epoch. */
  readonly since: number;
  /** When it last looked, in milliseconds. */
  readonly seen: number;
}

/** The marks of the waiting folder of [param directory] that name a pid and a start, by mark name. */
export function slotWaiters(directory: string): WaitingMark[] {
  const marks = join(directory, WAITING_FOLDER);
  if (!existsSync(marks)) {
    return [];
  }
  return readdirSync(marks)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .flatMap((mark) => {
      try {
        const named: unknown = JSON.parse(readFileSync(join(marks, mark), 'utf8'));
        const { pid, since } = named as { pid?: unknown; since?: unknown };
        if (typeof pid !== 'number' || typeof since !== 'number') {
          return [];
        }
        const note = join(marks, mark.replace(/\.json$/u, '.seen'));
        const seen = existsSync(note) ? statSync(note).mtimeMs : statSync(join(marks, mark)).mtimeMs;
        return [{ mark, pid, since, seen: Math.floor(seen) }];
      } catch {
        return [];
      }
    });
}
