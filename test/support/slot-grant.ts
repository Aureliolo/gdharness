/**
 * A stand-in for the command `GODOT_ENGINE_SLOT_COMMAND` names. It appends what it saw to the file
 * `GRANT_LOG` names, one JSON object a line: `start` with its arguments, then `eof` once its
 * standard input has ended, which is when a real command gives its slot back. Run it with Bun.
 *
 * It answers as the test asks, through the environment: `GRANT_SAY` is the first line it prints
 * (`held <lock>` where unset, nothing where empty), after `GRANT_DELAY_MS`, and `GRANT_EXIT` is
 * the code it exits with straight after printing, for a command that does not wait for its input.
 * `GRANT_DEAF` makes it stay up past the end of its input. A line `hand <pid> <start>` is logged as
 * `hand`, answered `handed` and ended with code 0 (`GRANT_HAND=refuse` answers `cannot` and code 2
 * instead), and `GRANT_EXIT_AFTER_MS` makes it exit with code 3 that long after it started.
 * `GRANT_LATE_MS` delays every start but the first by that long.
 */
import { appendFileSync, closeSync, openSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const log = process.env['GRANT_LOG'];
const note = (entry: object): void => {
  if (log !== undefined) {
    appendFileSync(log, `${JSON.stringify(entry)}\n`);
  }
};

note({ event: 'start', argv: process.argv.slice(2), pid: process.pid });
const exitWith = process.env['GRANT_EXIT'];
// `GRANT_LATE_MS` delays every start but the first, as a busy machine does a later grant, and a
// lock named for the process keeps the locks of concurrent starts apart.
const claimedFirst = (): boolean => {
  try {
    closeSync(openSync(`${log ?? ''}.first`, 'wx'));
    return true;
  } catch {
    return false;
  }
};
const perStart = process.env['GRANT_LATE_MS'] !== undefined;
const first = !perStart || claimedFirst();
const said =
  process.env['GRANT_SAY'] ??
  `held ${process.env['GRANT_LOCK'] ?? ''}${perStart ? `.${String(process.pid)}` : ''}`;
const wait =
  Number(process.env['GRANT_DELAY_MS'] ?? '0') + (first ? 0 : Number(process.env['GRANT_LATE_MS']));

process.stdin.on('end', () => {
  note({ event: 'eof' });
  // A deaf command reads the end of its input and carries on, which only being ended stops.
  if (process.env['GRANT_DEAF'] === undefined) {
    process.exit(0);
  }
  setInterval(() => undefined, 1000);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  const hand = /^hand (\d+) (\d+)$/m.exec(chunk);
  if (hand === null) {
    return;
  }
  note({ event: 'hand', handedTo: Number(hand[1]), started: Number(hand[2]) });
  // `GRANT_HAND` set to `refuse` answers as a command that cannot hand the slot on.
  if (process.env['GRANT_HAND'] === 'refuse') {
    process.stdout.write('cannot\n', () => {
      process.exit(2);
    });
    return;
  }
  process.stdout.write('handed\n', () => {
    process.exit(0);
  });
});
process.stdin.resume();
const exitAfter = process.env['GRANT_EXIT_AFTER_MS'];
if (exitAfter !== undefined) {
  setTimeout(() => {
    process.exit(3);
  }, Number(exitAfter));
}

if (wait > 0) {
  await delay(wait);
}
if (said !== '') {
  await new Promise<void>((written) => {
    process.stdout.write(`${said}\n`, () => {
      written();
    });
  });
}
if (exitWith !== undefined) {
  process.exit(Number(exitWith));
}
