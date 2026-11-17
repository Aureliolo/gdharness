/**
 * A launcher as a keeper is: it starts a process meant to outlive it through the desktop helper and
 * prints the process's pid and the helper's. Arguments: the scratch folder, the program the process
 * is, its arguments as one JSON list, and whether this launcher then exits ("exit") or goes on
 * running ("stay"), which lets a test end it from outside.
 */
import { ensureHelperCompiled, helperPid, spawnOnDesktop } from '../../src/desktop.js';

const [scratch, program, argumentList, after] = process.argv.slice(2);
if (scratch === undefined || program === undefined || argumentList === undefined) {
  throw new Error('the scratch folder, the program and its arguments are needed');
}
function listOfText(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new Error('the arguments are a JSON list of text');
  }
  return parsed;
}

const compiled = await ensureHelperCompiled();
if (compiled !== null) {
  throw new Error(compiled);
}
const started = spawnOnDesktop(
  { directory: scratch, outlivesStarter: true, scratch },
  program,
  listOfText(argumentList),
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
started.child.unref();
let pid = helperPid(started.files.pid);
for (let waited = 0; pid === undefined && waited < 60_000; waited += 20) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  pid = helperPid(started.files.pid);
}
process.stdout.write(`pid ${String(pid)} helper ${String(started.child.pid)}\n`);
if (after === 'stay') {
  setInterval(() => undefined, 1000);
} else {
  process.exit(0);
}
