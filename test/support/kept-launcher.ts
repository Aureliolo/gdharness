/**
 * A launcher as a keeper is: it starts a process meant to outlive it through the desktop helper,
 * prints the process's pid and exits. Arguments: the scratch folder, then the file the process waits
 * to see before it ends.
 */
import { existsSync } from 'node:fs';
import { helperPid, spawnOnDesktop } from '../../src/desktop.js';

const [scratch, release] = process.argv.slice(2);
if (scratch === undefined || release === undefined) {
  throw new Error('the scratch folder and the release file are the arguments');
}
const waits = `const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); } }, 50);`;
const started = spawnOnDesktop(
  { directory: scratch, outlivesStarter: true, scratch },
  process.execPath,
  ['-e', waits],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
started.child.unref();
let pid = helperPid(started.files.pid);
for (let waited = 0; pid === undefined && waited < 60_000; waited += 20) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  pid = helperPid(started.files.pid);
}
process.stdout.write(`pid ${String(pid)}\n`);
if (existsSync(release)) {
  process.stdout.write('released early\n');
}
process.exit(0);
