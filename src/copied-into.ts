/**
 * Carrying what an engine writes to its pipes into a file. On Windows an engine flushes a file to
 * disk after every write, which costs 1.5 to 4 ms a line, and a pipe costs 0.04 ms. So the engine
 * is given pipes and the process that started it writes the file.
 */

import { writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * How long the streams of an engine that has exited are drained for: a process it started and
 * handed them to holds them open, and the run would otherwise wait on that process.
 */
const DRAIN_MS = 5000;

/**
 * Writes everything [param streams] carry into [param output] as it arrives, and settles once all
 * have ended, or [param DRAIN_MS] after [param exited] settles for those still held open. A write
 * that fails stops the writing, not the reading, so the engine is never left blocked on a full pipe.
 */
export function copiedInto(
  output: number,
  streams: readonly Readable[],
  exited: Promise<unknown>,
): Promise<void> {
  let writing = true;
  const ended = streams.map(
    (stream) =>
      new Promise<void>((settle) => {
        stream.on('data', (chunk: Buffer) => {
          if (!writing) {
            return;
          }
          try {
            writeSync(output, chunk);
          } catch {
            // The log then ends short, and the run is judged on what it holds.
            writing = false;
          }
        });
        stream.once('close', settle);
      }),
  );
  const all = Promise.all(ended).then(() => undefined);
  const drained = exited.then(() => delay(DRAIN_MS, undefined, { ref: false }));
  return Promise.race([all, drained]).then(() => {
    writing = false;
    for (const stream of streams) {
      stream.destroy();
    }
  });
}
