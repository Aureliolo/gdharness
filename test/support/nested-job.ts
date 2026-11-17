/**
 * Runs as a process that puts itself in a job of its own that ends its members when it closes and
 * allows no breakaway, as a CI runner or a gate's queue may run its children, and then starts an
 * engine stand-in and a kept stand-in the way the server does. Prints one line of JSON.
 * Argument: the scratch folder.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { engineJobName, ensureHelperCompiled, helperPid, spawnOnDesktop } from '../../src/desktop.js';
import { runEngine } from '../../src/engine-run.js';
import { openJob } from './job-objects.js';

const [root] = process.argv.slice(2);
if (root === undefined) {
  throw new Error('the scratch folder is the argument');
}
const kernel32 = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  SetInformationJobObject: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.bool,
  },
  AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
  GetCurrentProcess: { args: [], returns: FFIType.u64 },
});
const parent = kernel32.symbols.CreateJobObjectW(null, null);
const limits = new BigUint64Array(18);
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags sits after two 8-byte time limits. Only
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is set, so there is no breakaway.
new DataView(limits.buffer).setUint32(16, 0x2000, true);
const limited = kernel32.symbols.SetInformationJobObject(parent, 9, ptr(limits), 144);
const joined = kernel32.symbols.AssignProcessToJobObject(parent, kernel32.symbols.GetCurrentProcess());

const pids = join(root, 'pids');
const release = join(root, 'release');
const script = [
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(pids)}, String(process.pid));`,
  `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); } }, 50);`,
].join('\n');
const running = runEngine(process.execPath, ['-e', script]);
let engine: number | undefined;
for (let waited = 0; engine === undefined && waited < 60_000; waited += 50) {
  await delay(50);
  engine = existsSync(pids) ? Number(readFileSync(pids, 'utf8')) : undefined;
}
const job = engine === undefined ? null : openJob(engineJobName(engine));
const named = job !== null;
const holds = engine !== undefined && (job?.holds(engine) ?? false);
job?.close();
writeFileSync(release, '');
const ran = await running;

const compiled = await ensureHelperCompiled();
const kept = spawnOnDesktop(
  { directory: root, outlivesStarter: true, scratch: join(root, 'kept') },
  process.execPath,
  ['-e', 'setTimeout(() => undefined, 2000)'],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
let keptPid: number | undefined;
for (let waited = 0; keptPid === undefined && waited < 30_000; waited += 50) {
  await delay(50);
  keptPid = helperPid(kept.files.pid);
}
const keptJob = keptPid === undefined ? null : openJob(engineJobName(keptPid));
const keptNamed = keptJob !== null;
keptJob?.close();
process.stdout.write(
  `${JSON.stringify({ limited, joined, compiled, named, holds, exitCode: ran.exitCode, failure: ran.failure, keptPid: keptPid ?? null, keptNamed, keptError: keptPid === undefined ? readFileSync(kept.files.error, 'utf8') : null })}\n`,
);
process.exit(0);
