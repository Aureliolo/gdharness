/**
 * Runs a command and ends it, with everything it started, once it has had its minutes. Exits 124 on
 * the limit, as `timeout` does, and with the command's own code otherwise.
 *
 * A step the runner ends at its own limit keeps no log on Windows, so CI ends the run a little
 * before, from outside the run's event loop. This is a program of the repository rather than a
 * shell's `timeout`, so the step keeps the shell the rest of the job uses: a Git Bash step starts
 * its programs from the msys runtime, where the tests of unreadable and held files failed.
 */
import { spawnHidden, spawnSyncHidden } from '../src/spawn.js';

const [minutes, command, ...args] = process.argv.slice(2);
const limitMs = Number(minutes) * 60_000;
if (!(limitMs > 0) || command === undefined) {
  console.error('Usage: bun scripts/run-limited.ts <minutes> <command> [args...]');
  process.exit(2);
}

const KILL_AFTER_MS = 30_000;
const child = spawnHidden(command, args, {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});
let limited = false;

/** Ends [param child] and everything below it. */
function endTree(): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSyncHidden('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

const limit = setTimeout(() => {
  limited = true;
  console.error(`run-limited: ${command} still running after ${minutes} minutes, ending it`);
  if (process.platform === 'win32') {
    endTree();
  } else {
    try {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
    } catch {
      // Already gone.
    }
    setTimeout(endTree, KILL_AFTER_MS);
  }
}, limitMs);

child.on('error', (error) => {
  clearTimeout(limit);
  console.error(`run-limited: ${command} did not start: ${error.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  clearTimeout(limit);
  process.exit(limited ? 124 : (code ?? (signal === null ? 1 : 128)));
});
