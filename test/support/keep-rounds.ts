/**
 * Keeps a pipeline cache in rounds from a process of its own, each round holding more files than
 * the one before and every file saying which round wrote it, so a copy taken meanwhile can be told
 * whole from partial.
 *
 * Arguments: the scratch folder, the project, the engine executable, the cache home, the rounds.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepPipelineCache } from '../../src/pipeline-cache.js';

const [scratch, project, godot, home, rounds] = process.argv.slice(2);
if (
  scratch === undefined ||
  project === undefined ||
  godot === undefined ||
  home === undefined ||
  rounds === undefined
) {
  throw new Error('keep-rounds needs a scratch folder, project, engine, cache home and round count');
}
const FILE_BYTES = 40_000;
for (let round = 0; round < Number(rounds); round++) {
  const user = join(scratch, `round-${String(round)}`);
  const cache = join(user, 'Godot', 'app_userdata', 'Game', 'shader_cache');
  mkdirSync(cache, { recursive: true });
  for (let file = 0; file < 100 + round; file++) {
    writeFileSync(join(cache, `${String(file)}.bin`), `${String(round)}:`.padEnd(FILE_BYTES, 'x'));
  }
  const vulkan = join(user, 'Godot', 'app_userdata', 'Game', 'vulkan');
  mkdirSync(vulkan, { recursive: true });
  writeFileSync(join(vulkan, 'pipelines.forward.gpu.cache'), `${String(round)}:`.padEnd(FILE_BYTES, 'y'));
  await keepPipelineCache(user, project, godot, home);
}
