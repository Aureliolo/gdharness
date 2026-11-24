/**
 * A stand-in engine that holds memory. It prints a Godot version for `--version`, answers an
 * operation by writing `{}` to the answer file named last, and otherwise runs like a game: it
 * holds GDH_HOLD_MB of touched memory, reached GDH_GROW_MB every 150 ms, starts one child that
 * holds GDH_CHILD_MB, and stays up for GDH_STAY_MS. With GDH_OPERATION_HOLD_MB set, an operation
 * holds that much the same way and answers only once it has stayed up. A test run (one given
 * `--suites-in`) appends its own pid and its parent's to the file GDH_PID_FILE names.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const MIB = 1024 * 1024;
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('4.7.2.stable.custom_build\n');
  process.exit(0);
}
const last = args.at(-1) ?? '';
const operation = args.includes('--script') && last.endsWith('.json');
const operationHolds = Number(process.env['GDH_OPERATION_HOLD_MB'] ?? 0);
if (operation && operationHolds <= 0) {
  writeFileSync(last, '{}');
  process.exit(0);
}

const pidFile = process.env['GDH_PID_FILE'];
if (pidFile !== undefined && args.includes('--suites-in')) {
  appendFileSync(pidFile, `${String(process.pid)} ${String(process.ppid)}\n`);
}

const holds = operation ? operationHolds : Number(process.env['GDH_HOLD_MB'] ?? 0);
const step = Math.max(1, Number(process.env['GDH_GROW_MB'] ?? holds));
const childMb = operation ? 0 : Number(process.env['GDH_CHILD_MB'] ?? 0);
const held: Buffer[] = [];
const grow = setInterval(() => {
  if (held.length * step >= holds) {
    clearInterval(grow);
    return;
  }
  held.push(Buffer.alloc(step * MIB, 1));
}, 150);
if (childMb > 0) {
  Bun.spawn([process.execPath, ...args], {
    env: { ...process.env, GDH_HOLD_MB: String(childMb), GDH_CHILD_MB: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
}
setTimeout(
  () => {
    if (operation) {
      writeFileSync(last, '{}');
    }
    process.exit(0);
  },
  Number(process.env['GDH_STAY_MS'] ?? 20_000),
);
