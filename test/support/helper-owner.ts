/**
 * A process that starts an engine through the desktop helper and then stays running, so a test can
 * end it from outside. It prints the engine's pid and the helper's as one line of JSON. Argument:
 * the folder to work in.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHelperCompiled, helperPid, spawnOnDesktop } from '../../src/desktop.js';

const [root] = process.argv.slice(2);
if (root === undefined) {
  throw new Error('the folder to work in is needed');
}
const compiled = await ensureHelperCompiled();
if (compiled !== null) {
  throw new Error(compiled);
}
const scratch = join(root, 'ending');
mkdirSync(scratch, { recursive: true });
const ending = spawnOnDesktop(
  { directory: scratch, scratch, endsWithHelper: true },
  process.execPath,
  ['-e', 'setTimeout(() => undefined, 600000)'],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
let engine = helperPid(ending.files.pid);
for (let waited = 0; engine === undefined && waited < 60_000; waited += 20) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine = helperPid(ending.files.pid);
}
if (engine === undefined) {
  throw new Error('the engine never started');
}
process.stdout.write(`${JSON.stringify({ helper: ending.child.pid, engine })}\n`);
setInterval(() => undefined, 1000);
