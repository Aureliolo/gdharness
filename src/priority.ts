import { constants, getPriority, setPriority } from 'node:os';
import { type ChildProcess, RelayedChild } from './spawn.js';

/**
 * Puts [param child], an engine this server started, below normal priority. On a machine running
 * every core, an engine at normal priority starved other work kept below normal, so a test there
 * timed out. What the engine starts, such as a game an editor plays, inherits the lower class.
 */
export function belowNormal(child: ChildProcess): void {
  // A start through the desktop helper is begun below normal by the helper, whose own pid this is.
  if (child.pid === undefined || child instanceof RelayedChild) {
    return;
  }
  try {
    setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The engine ended before it could be lowered.
  }
}

/** The names Windows gives the priority classes Node reports as these values. */
const WINDOWS_CLASSES = new Map<number, string>([
  [constants.priority.PRIORITY_LOW, 'idle'],
  [constants.priority.PRIORITY_BELOW_NORMAL, 'below normal'],
  [constants.priority.PRIORITY_NORMAL, 'normal'],
  [constants.priority.PRIORITY_ABOVE_NORMAL, 'above normal'],
  [constants.priority.PRIORITY_HIGH, 'high'],
  [constants.priority.PRIORITY_HIGHEST, 'realtime'],
]);

/**
 * [param value], a priority as Node reads it, named as the platform names it: a priority class on
 * Windows, such as `below normal`, and the nice value elsewhere, such as `nice 10`.
 */
export function priorityNamed(value: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? (WINDOWS_CLASSES.get(value) ?? `priority ${String(value)}`)
    : `nice ${String(value)}`;
}

/** The priority the process [param pid] has now, named by {@link priorityNamed}, or null once it is gone. */
export function priorityOf(pid: number): string | null {
  try {
    return priorityNamed(getPriority(pid));
  } catch {
    return null;
  }
}
