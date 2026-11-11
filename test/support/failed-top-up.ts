/**
 * Draws spare ports while every top-up fails, and prints what happened as one JSON line.
 *
 * Run as a script under Bun, it has a pool of its own, so the suite's pool stays full. A top-up
 * nobody awaits must end no run, and an empty pool must say why it could not refill.
 */

import { fileURLToPath } from 'node:url';

import { reservePort, sparePort, unheldPort } from './server.js';

/** The path a case runs under Bun. */
export const FAILED_TOP_UP = fileURLToPath(import.meta.url);

async function run(): Promise<void> {
  let unhandled = 0;
  process.on('unhandledRejection', () => {
    unhandled += 1;
  });

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  const dead = (): Promise<number> =>
    unheldPort(
      () => 1120,
      () => Promise.resolve(null),
      () => Promise.resolve(null),
    );
  const live = (): Promise<number> =>
    unheldPort(
      () => 1121,
      () => Promise.resolve(null),
      () => Promise.resolve(false),
    );

  const taken: number[] = [];
  let said = 'no call failed';
  for (let call = 0; call < 25; call += 1) {
    try {
      taken.push(sparePort(dead));
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    await sleep(5);
  }
  const next = await reservePort(live);
  await sleep(50);

  console.log(JSON.stringify({ unhandled, taken, said, next }));
  process.exit(0);
}

if (process.argv[1] === FAILED_TOP_UP) {
  await run();
}
