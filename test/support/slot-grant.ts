/**
 * A stand-in for the command `GODOT_ENGINE_SLOT_COMMAND` names. It appends what it saw to the file
 * `GRANT_LOG` names, one JSON object a line: `start` with its arguments, then `eof` once its
 * standard input has ended, which is when a real command gives its slot back. Run it with Bun.
 *
 * It answers as the test asks, through the environment: `GRANT_SAY` is the first line it prints
 * (`held <lock>` where unset, nothing where empty), after `GRANT_DELAY_MS`, and `GRANT_EXIT` is
 * the code it exits with straight after printing, for a command that does not wait for its input.
 * `GRANT_DEAF` makes it stay up past the end of its input.
 */
import { appendFileSync } from 'node:fs';
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
const said = process.env['GRANT_SAY'] ?? `held ${process.env['GRANT_LOCK'] ?? ''}`;
const wait = Number(process.env['GRANT_DELAY_MS'] ?? '0');

process.stdin.on('end', () => {
  note({ event: 'eof' });
  // A deaf command reads the end of its input and carries on, which only being ended stops.
  if (process.env['GRANT_DEAF'] === undefined) {
    process.exit(0);
  }
  setInterval(() => undefined, 1000);
});
process.stdin.resume();

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
