import process from 'node:process';
import type { ChildProcess } from './spawn.js';

/**
 * How [param child] ended, including an end that came before this was asked. Node tells an exit once,
 * to the listeners there at the time, so one added after it is never called: a keeper whose game
 * quit while its start was still reading the pid held the ended run for as long as the machine
 * stayed up.
 */
export function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
}

/**
 * Whether a process is still running under [param pid].
 *
 * Undefined reads as gone, because a caller that has no process to name has nothing to wait for.
 */
export function alive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null) {
    return false;
  }
  try {
    // Signal 0 asks whether it could be signalled rather than signalling it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process that is there and is somebody else's, which is still there. Only ESRCH
    // says there is nothing under that number, and reading the two the same way reports a run
    // started by another user as one that has ended.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
