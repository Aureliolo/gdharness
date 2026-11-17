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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheHome } from './cache-home.js';
import { ownStart } from './engine-slots.js';
import { realAsFarAsItExists } from './paths.js';
import { isRecord } from './records.js';
import { parseProjectGodot } from './resources.js';
import { tryTake } from './write-turns.js';

/**
 * A test run's engine gets a user:// of its own, and Godot keeps its shader cache there, in
 * user://shader_cache. A drawing engine started cold compiled every shader again: one game's windowed
 * suite spent five to seven seconds of a case building the pipelines of one screen. So the cache a
 * run leaves is kept per project, and handed to the next run on the same engine build before it
 * starts. Copied in and out rather than shared, since runs go side by side.
 */
const NAME = 'shader_cache';

/**
 * The Vulkan driver keeps its own pipeline cache beside the shader cache, in
 * user://vulkan/pipelines.<rendering method>.<device>.cache. Building them cold costs a first draw
 * two to nine seconds per run, so these files travel with the shader cache. The
 * editor's file, which ends in `.editor.cache`, is not a game's. The engine judges a file's
 * validity itself, against the device and driver, and builds cold when it refuses one.
 */
const PIPELINES = 'vulkan';

const PIPELINE_FILE = /^pipelines\..+\.cache$/;

const EDITOR_PIPELINE_SUFFIX = '.editor.cache';

/** The pipeline cache files in [param folder], as their names. */
function pipelineFilesIn(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && PIPELINE_FILE.test(e.name) && !e.name.endsWith(EDITOR_PIPELINE_SUFFIX))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

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
  /** The settings that name the run's user folder, as the project had them when this was kept. */
  readonly layout: string;
}

/**
 * The project's settings that decide which folder under the user data its engine reads, as the
 * project file spells them. A cache kept under another name is in a folder the engine no longer reads.
 */
function layoutOf(projectPath: string): string {
  try {
    const application =
      parseProjectGodot(readFileSync(join(projectPath, 'project.godot'), 'utf8'))['application'] ?? {};
    return JSON.stringify([
      application['config/name'],
      application['config/use_custom_user_dir'],
      application['config/custom_user_dir_name'],
    ]);
  } catch {
    return '';
  }
}

function keptRecord(kept: string): Kept | null {
  try {
    const record: unknown = JSON.parse(readFileSync(join(kept, RECORD), 'utf8'));
    if (!isRecord(record)) {
      return null;
    }
    const { project, engine, where, bytes, layout } = record;
    if (
      typeof project !== 'string' ||
      typeof engine !== 'string' ||
      typeof where !== 'string' ||
      typeof bytes !== 'number'
    ) {
      return null;
    }
    return { project, engine, where, bytes, layout: typeof layout === 'string' ? layout : '' };
  } catch {
    return null;
  }
}

/**
 * Puts the pipeline cache kept for [param projectPath] into [param user], the user folder a run is
 * about to start with, where the last run's engine kept it, when the same engine build made it.
 * The copy holds the lock a keep's swap holds, so it takes the old cache whole or the new one whole,
 * never what is left of the old one while it is removed. A run is never held up by the cache: any
 * failure, or a lock not had in time, leaves it to build its pipelines as it would have.
 */
export async function seedPipelineCache(
  user: string,
  projectPath: string,
  godotPath: string,
  home: string = cacheHome(),
  copy: CopyFile = cpSync,
): Promise<void> {
  const kept = keptFor(projectPath, home);
  const lock = `${kept}.lock`;
  // A swap removes the kept folder for a moment, under the lock, so a lock file also means a cache.
  if (!existsSync(kept) && !existsSync(lock)) {
    return;
  }
  try {
    await underLock(lock, () => {
      const record = keptRecord(kept);
      if (
        record === null ||
        record.engine !== engineBuild(godotPath) ||
        record.layout !== layoutOf(projectPath) ||
        !existsSync(join(kept, NAME))
      ) {
        return;
      }
      const shaders = join(user, record.where);
      cpSync(join(kept, NAME), shaders, { recursive: true });
      const into = join(dirname(shaders), PIPELINES);
      const seeded: Record<string, Stamp> = {};
      for (const file of pipelineFilesIn(join(kept, PIPELINES))) {
        // Renamed into place, so the engine never reads a file that is half copied.
        mkdirSync(into, { recursive: true });
        const partial = join(into, `${file}.seeding`);
        try {
          copy(join(kept, PIPELINES, file), partial);
          renameSync(partial, join(into, file));
        } finally {
          rmSync(partial, { force: true });
        }
        const stamp = stampOf(join(into, file));
        if (stamp !== null) {
          seeded[file] = stamp;
        }
      }
      mkdirSync(dirname(seededNote(user)), { recursive: true });
      writeFileSync(seededNote(user), JSON.stringify(seeded));
    });
  } catch {
    // A partial copy is a cache with fewer pipelines in it, which the engine fills in.
  }
}

type CopyFile = (from: string, to: string) => void;

/** A file's size and modification time, which the engine changes whenever it writes the file. */
type Stamp = readonly [number, number];

function stampOf(path: string): Stamp | null {
  try {
    const { size, mtimeMs } = statSync(path);
    return [size, mtimeMs];
  } catch {
    return null;
  }
}

/**
 * Where a seed notes the pipeline files it put in [param user] and how they stood. It is a file
 * beside the folder, which the engine never reads, so a keep can tell a file the run's engine wrote
 * from the seeded copy it left alone.
 */
function seededNote(user: string): string {
  return `${resolve(user)}.pipeline-seeded.json`;
}

/** The files of [param note], read and removed, as their names and stamps. */
function takeSeededNote(user: string): Record<string, Stamp> {
  const path = seededNote(user);
  try {
    const note: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const stamps: Record<string, Stamp> = {};
    for (const [file, stamp] of Object.entries(isRecord(note) ? note : {})) {
      if (Array.isArray(stamp) && typeof stamp[0] === 'number' && typeof stamp[1] === 'number') {
        stamps[file] = [stamp[0], stamp[1]];
      }
    }
    return stamps;
  } catch {
    return {};
  } finally {
    rmSync(path, { force: true });
  }
}

/**
 * Keeps the pipeline cache a run left in [param user] for the next run of [param projectPath]. It
 * replaces the kept one when another engine build made that, and otherwise as [function settled]
 * says. The caches of projects no longer on disk go at the same time, as test projects do.
 */
export async function keepPipelineCache(
  user: string,
  projectPath: string,
  godotPath: string,
  home: string = cacheHome(),
  copy: CopyFile = cpSync,
): Promise<void> {
  const seeded = takeSeededNote(user);
  const engine = engineBuild(godotPath);
  const where = cacheUnder(user);
  if (engine === null || where === null) {
    return;
  }
  const kept = keptFor(projectPath, home);
  const left = join(user, where);
  try {
    const vulkan = join(dirname(left), PIPELINES);
    const all = pipelineFilesIn(vulkan);
    // A seeded file the engine left alone is the kept one, or an older one if the kept one has
    // moved on since: it says nothing about the pipelines this run built.
    const files = all.filter((file) => {
      const was = seeded[file];
      const now = stampOf(join(vulkan, file));
      return was === undefined || now === null || was[0] !== now[0] || was[1] !== now[1];
    });
    const bytes = bytesIn(left);
    if (bytes === 0 && all.length === 0) {
      return;
    }
    const made: Kept = {
      project: resolve(projectPath),
      engine,
      where: where.split(sep).join('/'),
      bytes,
      layout: layoutOf(projectPath),
    };
    // Decided before anything is copied or locked, since most runs are seeded and add nothing.
    const verdict = judge(kept, made, files, vulkan);
    if (!verdict.whole && !verdict.shaders && !verdict.changed) {
      return;
    }
    // Built beside the kept one and swapped in whole, so a run seeding from it meanwhile copies
    // the old cache or the new one and never half of each.
    const building = `${kept}.${process.pid}.${Date.now()}`;
    mkdirSync(building, { recursive: true });
    if (verdict.shaders) {
      cpSync(left, join(building, NAME), { recursive: true });
    }
    for (const file of files) {
      mkdirSync(join(building, PIPELINES), { recursive: true });
      copy(join(vulkan, file), join(building, PIPELINES, file));
    }
    // The copy takes a while and runs go side by side, so the kept one is judged again under the lock
    // the swap holds: a smaller shader cache that finished last would otherwise replace a larger one.
    const swapped = await underLock(`${kept}.lock`, () => {
      if (!settled(kept, building, made, { files, all, left, vulkan, copy })) {
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

function sameFile(a: string, b: string): boolean {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

interface Verdict {
  /** The kept set is another engine build's, or under another folder name, or gone: replace it. */
  readonly whole: boolean;
  /** The run's shader cache is larger than the kept one. */
  readonly shaders: boolean;
  /** A pipeline file the run's engine wrote differs from the kept one of its name. */
  readonly changed: boolean;
}

/**
 * What a run adds to the set kept in [param kept]. Of the same engine build's set, the shader cache
 * is the run's only when it is larger, since a run of one suite builds fewer than a run of all of
 * them. Each pipeline file the run's engine wrote is the run's when it differs from the kept one of
 * its name, whatever its size, since an engine that refuses a seeded file writes a smaller valid one.
 */
function judge(kept: string, made: Kept, files: readonly string[], vulkan: string): Verdict {
  const record = keptRecord(kept);
  if (
    record === null ||
    record.engine !== made.engine ||
    record.layout !== made.layout ||
    !existsSync(join(kept, NAME))
  ) {
    return { whole: true, shaders: true, changed: true };
  }
  return {
    whole: false,
    shaders: made.bytes > record.bytes,
    changed: files.some((file) => !sameFile(join(kept, PIPELINES, file), join(vulkan, file))),
  };
}

interface Run {
  /** The pipeline files the run's engine wrote, which the building folder holds copies of. */
  readonly files: readonly string[];
  /** Every pipeline file in the run's folder. */
  readonly all: readonly string[];
  readonly left: string;
  readonly vulkan: string;
  readonly copy: CopyFile;
}

/**
 * Judges again with the lock held and makes [param building] what replaces [param kept]. Answers
 * false when the kept set needs no change. A pipeline file the run's engine did not write stays as
 * kept. A set replaced whole takes the run's files, written or not.
 */
function settled(kept: string, building: string, made: Kept, run: Run): boolean {
  const verdict = judge(kept, made, run.files, run.vulkan);
  if (!verdict.whole && !verdict.shaders && !verdict.changed) {
    return false;
  }
  if (verdict.shaders && !existsSync(join(building, NAME))) {
    cpSync(run.left, join(building, NAME), { recursive: true });
  }
  if (verdict.whole) {
    for (const file of run.all.filter((name) => !run.files.includes(name))) {
      mkdirSync(join(building, PIPELINES), { recursive: true });
      run.copy(join(run.vulkan, file), join(building, PIPELINES, file));
    }
    writeFileSync(join(building, RECORD), JSON.stringify(made));
    return true;
  }
  if (!verdict.shaders) {
    rmSync(join(building, NAME), { recursive: true, force: true });
    renameSync(join(kept, NAME), join(building, NAME));
  }
  for (const file of pipelineFilesIn(join(kept, PIPELINES))) {
    if (!run.files.includes(file)) {
      mkdirSync(join(building, PIPELINES), { recursive: true });
      renameSync(join(kept, PIPELINES, file), join(building, PIPELINES, file));
    }
  }
  const record = keptRecord(kept);
  const { where, bytes } = verdict.shaders || record === null ? made : record;
  writeFileSync(join(building, RECORD), JSON.stringify({ ...made, where, bytes }));
  return true;
}

/** How long a keep waits for another's swap, which takes milliseconds, before leaving its copy unkept. */
const LOCK_WAIT_MS = 10_000;

let ownStarted: Promise<number> | undefined;

/** How often a keep waiting for the swap's lock looks at it again. */
const LOCK_LOOK_MS = 20;

/**
 * Runs [param swap] holding the lock file [param lock], and answers what it did, or null when the
 * lock could not be had in time. A lock whose holder has gone is taken over as a write turn's is.
 */
async function underLock<T>(lock: string, swap: () => T): Promise<T | null> {
  // Read once, since on Windows each read is a query of its own.
  ownStarted ??= ownStart();
  const holder = JSON.stringify({ pid: process.pid, started: await ownStarted });
  const starts = new Map<number, number | undefined>();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await tryTake(lock, holder, starts))) {
    if (Date.now() > deadline) {
      return null;
    }
    await delay(LOCK_LOOK_MS);
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
