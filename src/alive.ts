import process from 'node:process';

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
