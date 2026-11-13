import { createHash } from 'node:crypto';
import {
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { cacheHome } from './cache-home.js';
import { realAsFarAsItExists } from './paths.js';
import { isRecord } from './records.js';

/**
 * A test run's engine gets a user:// of its own, and Godot keeps its pipeline cache there, in
 * user://shader_cache. A drawing engine started cold rebuilt every pipeline: one game's windowed
 * suite spent five to seven seconds of a case building the pipelines of one screen. So the cache a
 * run leaves is kept per project, and handed to the next run on the same engine build before it
 * starts. Copied in and out rather than shared, since runs go side by side.
 */
const NAME = 'shader_cache';

/** How deep under a run's user folder the cache is looked for: Godot/app_userdata/<name>/. */
const DEPTH = 4;

const RECORD = 'kept.json';

/** Where every project's kept cache is. */
function keptHome(home: string): string {
  return join(home, 'pipeline-caches');
}

/** The folder [param projectPath]'s cache is kept in: one per project, whichever engine built it. */
function keptFor(projectPath: string, home: string): string {
  // As the file system spells it, so a project given in another case or through a link is the same one.
  const key = createHash('sha256')
    .update(realAsFarAsItExists(resolve(projectPath)))
    .digest('hex')
    .slice(0, 16);
  return join(keptHome(home), key);
}

/** The engine build at [param godotPath], which a pipeline cache is good for alone. */
function engineBuild(godotPath: string): string | null {
  try {
    const engine = statSync(godotPath);
    return [resolve(godotPath), engine.size, engine.mtimeMs].join('|');
  } catch {
    return null;
  }
}

/** The pipeline cache under [param user], as its path from there, or null for none. */
function cacheUnder(user: string): string | null {
  return findCache(user, user, DEPTH);
}

function findCache(user: string, folder: string, depth: number): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === NAME) {
      return relative(user, join(folder, entry.name));
    }
  }
  if (depth === 0) {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findCache(user, join(folder, entry.name), depth - 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function bytesIn(folder: string): number {
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      total += statSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return total;
}

interface Kept {
  readonly project: string;
  readonly engine: string;
  readonly where: string;
  readonly bytes: number;
}

function keptRecord(kept: string): Kept | null {
  try {
    const record: unknown = JSON.parse(readFileSync(join(kept, RECORD), 'utf8'));
    if (!isRecord(record)) {
      return null;
    }
    const { project, engine, where, bytes } = record;
    if (
      typeof project !== 'string' ||
      typeof engine !== 'string' ||
      typeof where !== 'string' ||
      typeof bytes !== 'number'
    ) {
      return null;
    }
    return { project, engine, where, bytes };
  } catch {
    return null;
  }
}

/**
 * Puts the pipeline cache kept for [param projectPath] into [param user], the user folder a run is
 * about to start with, where the last run's engine kept it, when the same engine build made it.
 * A run is never held up by the cache: any failure leaves it to build its pipelines as it would
 * have.
 */
export function seedPipelineCache(
  user: string,
  projectPath: string,
  godotPath: string,
  home: string = cacheHome(),
): void {
  const kept = keptFor(projectPath, home);
  const record = keptRecord(kept);
  if (record === null || record.engine !== engineBuild(godotPath) || !existsSync(join(kept, NAME))) {
    return;
  }
  try {
    cpSync(join(kept, NAME), join(user, record.where), { recursive: true });
  } catch {
    // A partial copy is a cache with fewer pipelines in it, which the engine fills in.
  }
}

/**
 * Keeps the pipeline cache a run left in [param user] for the next run of [param projectPath]. It
 * replaces the kept one when another engine build made that, or when it holds more: a headless run
 * builds none, and a run of one suite fewer than a run of all of them. The caches of projects no
 * longer on disk go at the same time, as test projects do.
 */
export function keepPipelineCache(
  user: string,
  projectPath: string,
  godotPath: string,
  home: string = cacheHome(),
): void {
  const engine = engineBuild(godotPath);
  const where = cacheUnder(user);
  if (engine === null || where === null) {
    return;
  }
  const kept = keptFor(projectPath, home);
  const left = join(user, where);
  try {
    const bytes = bytesIn(left);
    if (bytes === 0 || keptHolds(kept, engine, bytes)) {
      return;
    }
    // Built beside the kept one and swapped in whole, so a run seeding from it meanwhile copies
    // the old cache or the new one and never half of each.
    const building = `${kept}.${process.pid}.${Date.now()}`;
    mkdirSync(building, { recursive: true });
    cpSync(left, join(building, NAME), { recursive: true });
    const made: Kept = { project: resolve(projectPath), engine, where: where.split(sep).join('/'), bytes };
    writeFileSync(join(building, RECORD), JSON.stringify(made));
    // The copy takes a while and runs go side by side, so the kept one is read again under the lock
    // the swap holds: a smaller cache that finished last would otherwise replace a larger one.
    const swapped = underLock(`${kept}.lock`, () => {
      if (keptHolds(kept, engine, bytes)) {
        return false;
      }
      rmSync(kept, { recursive: true, force: true });
      try {
        renameSync(building, kept);
      } catch {
        return false;
      }
      return true;
    });
    if (swapped !== true) {
      rmSync(building, { recursive: true, force: true });
    }
    forgetGoneProjects(home);
  } catch {
    // Not kept, so the next run builds its pipelines again.
  }
}

/** Whether the cache kept in [param kept] is from [param engine] and holds at least [param bytes]. */
function keptHolds(kept: string, engine: string, bytes: number): boolean {
  const record = keptRecord(kept);
  return record?.engine === engine && bytes <= record.bytes;
}

/** How long a keep waits for another's swap, which takes milliseconds, before leaving its copy unkept. */
const LOCK_WAIT_MS = 10_000;

/** A lock older than this was left by a keep that died inside its swap. */
const LOCK_ABANDONED_MS = 30_000;

/**
 * Runs [param swap] holding the lock file [param lock], and answers what it did, or null when the
 * lock could not be had in time. The wait blocks, since a keep runs after its engine has ended.
 */
function underLock<T>(lock: string, swap: () => T): T | null {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      if (Date.now() > deadline) {
        return null;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_ABANDONED_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // Given back since it was found, which the next try takes.
        continue;
      }
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try {
    return swap();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** A keep builds its copy in `<key>.<pid>.<time>`, which one that ended midway leaves behind. */
const BUILDING = /^[0-9a-f]{16}\.\d+\.\d+$/;

/** Long enough for any keep still copying, since a copy is a few files and takes seconds. */
const BUILDING_ABANDONED_MS = 60 * 60 * 1000;

/** Removes every kept cache whose project folder is gone, and every copy a keep left unfinished. */
function forgetGoneProjects(home: string): void {
  for (const entry of readdirSync(keptHome(home), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const folder = join(keptHome(home), entry.name);
    if (BUILDING.test(entry.name)) {
      if (Date.now() - statSync(folder).mtimeMs > BUILDING_ABANDONED_MS) {
        rmSync(folder, { recursive: true, force: true });
      }
      continue;
    }
    if (entry.name.includes('.')) {
      continue;
    }
    const record = keptRecord(folder);
    if (record !== null && !existsSync(record.project)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}
