/**
 * One process taking an engine slot, for a test of takers that ask at once. It tells the test it is
 * ready, spins until the test's `go` file appears, takes a slot as a windowed engine would, holds
 * it, and prints when its hold began and ended, and the budget in GiB. Run it with Bun.
 *
 * Arguments: slot folder, slot count, project, sync folder, taker number, hold milliseconds.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { EngineSlots, ownStart } from '../../src/engine-slots.js';

const GIB = 1024 ** 3;
const [folder = '', count = '', project = '', sync = '', number = '', hold = ''] = process.argv.slice(2);
const slots = new EngineSlots(
  folder,
  Number(count),
  { pid: process.pid, started: await ownStart() },
  undefined,
  () => 'other',
  project,
  { memory: 20 * GIB, tool: 'test_lane' },
);
writeFileSync(join(sync, `ready-${number}`), '');
const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(join(sync, 'go'))) {
  Atomics.wait(pause, 0, 0, 1);
}
const lock = await slots.take(
  undefined,
  undefined,
  undefined,
  false,
  undefined,
  undefined,
  'test_windowed_lane',
);
const began = Date.now();
await new Promise((done) => setTimeout(done, Number(hold)));
const ended = Date.now();
slots.release(lock);
console.log(JSON.stringify({ began, ended, budget: slots.memoryBudget / GIB }));
process.exit(0);
