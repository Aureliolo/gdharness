/**
 * Keeps a pipeline cache from a process of its own, once a start file appears, so several runs
 * can be made to finish at the same moment.
 *
 * Arguments: the user folder, the project, the engine executable, the cache home, the start file.
 */

import { existsSync } from 'node:fs';
import { keepPipelineCache } from '../../src/pipeline-cache.js';

const [user, project, godot, home, start] = process.argv.slice(2);
if (
  user === undefined ||
  project === undefined ||
  godot === undefined ||
  home === undefined ||
  start === undefined
) {
  throw new Error('keep-cache needs a user folder, project, engine, home and start file');
}
while (!existsSync(start)) {
  // Spins until the parent says go, so every child leaves its start at the same moment.
}
await keepPipelineCache(user, project, godot, home);
