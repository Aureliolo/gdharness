/**
 * Starts an engine through the helper, ends the helper while the engine runs with the helper
 * program made unrunnable, and prints how the start ended and the processor time this process used
 * meanwhile, as one line of JSON. Run with its own TEMP, since it changes the helper program.
 * Arguments: the folder to work in, and `move` or `acl` for how the program is made unrunnable.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

interface DesktopModule {
  readonly ensureHelperCompiled: () => Promise<string | null>;
  readonly helperAssembly: () => string;
  readonly helperPid: (file: string) => number | undefined;
  readonly spawnOnDesktop: (
    how: { directory: string; scratch: string; exit: string; endsWithHelper: boolean },
    command: string,
    args: readonly string[],
    options: { stdio: string[] },
  ) => {
    child: {
      pid?: number;
      stdout: Readable | null;
      stderr: Readable | null;
      on: (event: string, listener: () => void) => void;
      once: (event: string, listener: (code: number | null, signal: string | null) => void) => void;
    };
    files: { pid: string };
  };
}

function isDesktopModule(value: unknown): value is DesktopModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'spawnOnDesktop') === 'function' &&
    typeof Reflect.get(value, 'helperPid') === 'function'
  );
}

// The built module, which Node loads as well as Bun does.
const loaded: unknown = await import(pathToFileURL(resolvePath('build', 'desktop.js')).href);
if (!isDesktopModule(loaded)) {
  throw new Error('build/desktop.js has no spawnOnDesktop');
}
const { ensureHelperCompiled, helperAssembly, helperPid, spawnOnDesktop } = loaded;
const hidden: unknown = await import(pathToFileURL(resolvePath('build', 'spawn.js')).href);
const found: unknown =
  typeof hidden === 'object' && hidden !== null ? Reflect.get(hidden, 'spawnSyncHidden') : null;

function isRunner(
  value: unknown,
): value is (program: string, args: readonly string[], options: object) => unknown {
  return typeof value === 'function';
}

if (!isRunner(found)) {
  throw new Error('build/spawn.js has no spawnSyncHidden');
}
const hiddenSpawn = found;

/** Runs a program with no window. */
function spawnSync(program: string, args: readonly string[]): void {
  hiddenSpawn(program, args, { encoding: 'utf8' });
}
const [root, how] = process.argv.slice(2);
if (root === undefined || (how !== 'move' && how !== 'acl')) {
  throw new Error('the folder and `move` or `acl` are needed');
}
const compiled = await ensureHelperCompiled();
if (compiled !== null) {
  throw new Error(compiled);
}
const exe = helperAssembly();
const scratch = join(root, 'one');
mkdirSync(scratch, { recursive: true });
const start = spawnOnDesktop(
  { directory: root, scratch, exit: join(scratch, 'exit'), endsWithHelper: true },
  process.execPath,
  ['-e', 'setTimeout(() => process.exit(4), 4000)'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
start.child.on('error', () => undefined);
start.child.stdout?.resume();
start.child.stderr?.resume();
const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  start.child.once('exit', (code, signal) => {
    resolve({ code, signal });
  });
});
for (let waited = 0; helperPid(start.files.pid) === undefined && waited < 30_000; waited += 20) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const user = process.env['USERNAME'] ?? '';
const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
if (how === 'acl') {
  spawnSync(icacls, [exe, '/deny', `${user}:(X)`]);
} else {
  renameSync(exe, `${exe}.moved`);
}
const before = process.cpuUsage();
if (start.child.pid !== undefined) {
  process.kill(start.child.pid);
}
const end = await Promise.race([
  ended,
  new Promise<string>((resolve) =>
    setTimeout(() => {
      resolve('no end in 20 s');
    }, 20_000),
  ),
]);
const used = process.cpuUsage(before);
const engine = helperPid(start.files.pid);
if (how === 'acl') {
  spawnSync(icacls, [exe, '/remove:d', user]);
} else {
  renameSync(`${exe}.moved`, exe);
}
process.stdout.write(`${JSON.stringify({ end, cpuMs: (used.user + used.system) / 1000 })}\n`);
if (engine !== undefined) {
  try {
    process.kill(engine);
  } catch {
    // It has ended.
  }
}
process.exit(0);
