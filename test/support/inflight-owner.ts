/**
 * A process that begins one engine start through the helper program named by its second argument,
 * says so, and stays running so a test can end it while the start is in flight. The engine's command
 * line ends in the third argument, which a test finds it by. Arguments: the folder to work in, the
 * helper program and the marker.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnOnDesktop } from '../../src/desktop.js';

const [root, assembly, marker] = process.argv.slice(2);
if (root === undefined || assembly === undefined || marker === undefined) {
  throw new Error('the folder, the helper program and a marker are needed');
}
const scratch = join(root, 'inflight');
mkdirSync(scratch, { recursive: true });
spawnOnDesktop(
  { directory: scratch, scratch, endsWithHelper: true },
  process.execPath,
  ['-e', 'setTimeout(() => undefined, 600000)', marker],
  { stdio: ['ignore', 'ignore', 'ignore'] },
  assembly,
);
process.stdout.write('begun\n');
setInterval(() => undefined, 1000);
