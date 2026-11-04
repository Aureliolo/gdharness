import { constants, setPriority } from 'node:os';
import type { ChildProcess } from './spawn.js';

/**
 * Puts [param child], an engine this server started, below normal priority. On a machine running
 * every core, an engine at normal priority starved other work kept below normal, so a test there
 * timed out. What the engine starts, such as a game an editor plays, inherits the lower class.
 */
export function belowNormal(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The engine ended before it could be lowered.
  }
}
