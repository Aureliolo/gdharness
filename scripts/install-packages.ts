/**
 * Installs the locked packages, giving each attempt three minutes and three attempts in all.
 *
 * Bun sets no time limit on a registry request, so a fetch that never answers holds the install
 * until the job runs out of time, printing nothing. On a hosted runner a whole install takes under
 * half a minute; one that sat on a dead connection took fourteen and cost its job. An attempt
 * past the limit is killed, and the next starts on an empty node_modules, since a package that
 * was being unpacked may be only partly there.
 */

import { rmSync } from 'node:fs';
import { spawnSyncHidden } from '../src/spawn.js';

const ATTEMPTS = 3;
const LIMIT_MS = 180_000;

let status = 1;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  if (attempt > 1) {
    rmSync('node_modules', { recursive: true, force: true });
  }
  const run = spawnSyncHidden(process.execPath, ['install', '--frozen-lockfile'], {
    stdio: 'inherit',
    timeout: LIMIT_MS,
    killSignal: 'SIGKILL',
  });
  if (run.status === 0) {
    process.exit(0);
  }
  status = run.status ?? 1;
  const outcome =
    run.error && 'code' in run.error && run.error.code === 'ETIMEDOUT'
      ? `was still running after ${LIMIT_MS / 1000} seconds and was stopped`
      : `exited with ${run.status ?? run.signal}`;
  console.error(`bun install, attempt ${attempt} of ${ATTEMPTS}, ${outcome}.`);
}
process.exit(status);
