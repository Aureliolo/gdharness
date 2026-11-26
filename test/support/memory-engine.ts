/**
 * A stand-in engine that holds memory. It prints a Godot version for `--version`, answers an
 * operation by writing `{}` to the answer file named last, and otherwise runs like a game: it
 * holds GDH_HOLD_MB of touched memory, reached GDH_GROW_MB every 150 ms, starts one child that
 * holds GDH_CHILD_MB, and stays up for GDH_STAY_MS. With GDH_OPERATION_HOLD_MB set, an operation
 * holds that much the same way and answers only once it has stayed up. With GDH_ENGINE_LOG set, it
 * appends `start` and `end` lines to that file, each with its pid, the time, what it ran (`import`,
 * `op:<name>` or `run`) and the slot it was handed in GODOT_ENGINE_HELD, or `-`. GDH_IMPORT_STATUS
 * is what get_import_status answers in place of `{}`.
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
const scriptAt = args.indexOf('--script');
const kind = args.includes('--import') ? 'import' : operation ? `op:${args[scriptAt + 2] ?? ''}` : 'run';
const logged = (what: string): void => {
  const log = process.env['GDH_ENGINE_LOG'];
  if (log !== undefined && log !== '') {
    const held = process.env['GODOT_ENGINE_HELD'] ?? '';
    appendFileSync(
      log,
      `${what} ${String(process.pid)} ${String(Date.now())} ${kind} ${held === '' ? '-' : held}\n`,
    );
  }
};
logged('start');
process.on('exit', () => {
  logged('end');
});
const operationHolds = Number(process.env['GDH_OPERATION_HOLD_MB'] ?? 0);
const answer =
  kind === 'op:get_import_status' && (process.env['GDH_IMPORT_STATUS'] ?? '') !== ''
    ? (process.env['GDH_IMPORT_STATUS'] ?? '{}')
    : '{}';
if (operation && operationHolds <= 0) {
  writeFileSync(last, answer);
  process.exit(0);
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
      writeFileSync(last, answer);
    }
    process.exit(0);
  },
  Number(process.env['GDH_STAY_MS'] ?? 20_000),
);
