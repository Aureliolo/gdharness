/**
 * One process taking an engine slot, for a test of takers that ask at once. It tells the test it is
 * ready, spins until the test's `go` file appears, takes a slot as a windowed or a headless engine
 * would, holds it, and prints the live locks' count and memory in GiB as seen `check` milliseconds
 * into the hold. Run it with Bun.
 *
 * Arguments: slot folder, slot count, project, `windowed` or `headless`, sync folder, taker number,
 * hold milliseconds, check milliseconds.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { EngineSlots, holderOf, ownStart } from '../../src/engine-slots.js';

const GIB = 1024 ** 3;
const [folder = '', count = '', project = '', kind = '', sync = '', number = '', hold = '', check = ''] =
  process.argv.slice(2);
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
  kind === 'windowed' ? 'test_windowed_lane' : undefined,
);
await new Promise((done) => setTimeout(done, Number(check)));
const live = readdirSync(folder)
  .filter((name) => /^\d+\.lock$/.test(name))
  .map((name) => holderOf(readFileSync(join(folder, name), 'utf8')))
  .filter((holder) => holder !== null);
console.log(
  JSON.stringify({
    locks: live.length,
    gib: live.reduce((sum, holder) => sum + (holder.memory ?? 1.5 * GIB) / GIB, 0),
    budget: slots.memoryBudget / GIB,
  }),
);
await new Promise((done) => setTimeout(done, Number(hold) - Number(check)));
slots.release(lock);
process.exit(0);
