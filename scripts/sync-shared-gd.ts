/**
 * The GDScript helpers that live beside the operations and again inside each addon, copied from
 * the one that is the original.
 *
 * An addon is installed into a project as a directory and can only preload what is inside it, so
 * a helper both the operations and an addon use has to exist in each of them. Kept by hand, the
 * copies drift, and the call that finds out is the one that went to the copy nobody edited: the
 * same value came back three ways depending on which tool was asked.
 *
 * So the original is the one beside the operations and the build and every suite that reads the
 * source addons write the rest, byte for byte. Git ignores the copies. Only the original is
 * tracked.
 *
 * A copy that differs from its original and holds no text the sync wrote was edited by hand.
 * The sync stops there and names the original, because overwriting it would lose the edit and
 * leaving it would test the wrong text. Each text it wrote is kept as an empty file named by its
 * hash in `written-helpers` in gdharness's cache folder, which no tree holds and no package carries.
 * Every tree on the machine shares it, so a `godot` folder copied from another tree is judged by
 * what any sync here wrote. A file there is created once and never changed, so syncs running together
 * cannot undo each other. The folder gains one empty file per edit of an original and is not pruned,
 * since removing a hash a copy still holds would refuse that copy. Deleting the whole folder is safe.
 * File times judge nothing, since a copy that keeps its source's time or two syncs at once make
 * them lie. Without the folder, as on a machine no sync ran on, a differing copy is taken for stale.
 * Each file is written to a temporary name and renamed, so a suite starting beside another reads
 * a whole copy.
 *
 * A `.uid` is never written here. Godot writes one beside every script and reads it back so a
 * reference survives a rename, so an identity is permanent once it exists and every game holding
 * an addon keeps the value it shipped with. Each copy's `.uid` is a tracked file.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheHome } from '../src/cache-home.js';

const GODOT = join('src', 'godot');

/** Which helpers are shared, and which addons hold a copy of each. */
export const SHARED_GDSCRIPT: Readonly<Record<string, readonly string[]>> = {
  'animation_reads.gd': ['gdharness_editor'],
  'declared_values.gd': ['gdharness_editor', 'gdharness_runtime'],
  'file_reads.gd': ['gdharness_editor'],
  'file_walk.gd': ['gdharness_editor'],
  'picture_saves.gd': ['gdharness_editor', 'gdharness_runtime'],
  'property_paths.gd': ['gdharness_editor'],
  'property_values.gd': ['gdharness_editor'],
  'reading.gd': ['gdharness_editor', 'gdharness_runtime'],
  'same_values.gd': ['gdharness_editor'],
  'serialisation.gd': ['gdharness_editor', 'gdharness_runtime'],
  'setting_reads.gd': ['gdharness_editor'],
  'value_shapes.gd': ['gdharness_editor', 'gdharness_runtime'],
};

/** Every copy of the shared helpers under a `godot` folder, as [original, copy] pairs. */
export function sharedCopies(godot: string = GODOT): { original: string; copy: string }[] {
  return Object.entries(SHARED_GDSCRIPT).flatMap(([file, addons]) =>
    addons.map((addon) => ({
      original: join(godot, 'operations', file),
      copy: join(godot, 'addons', addon, file),
    })),
  );
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The folder of what any sync on this machine wrote, in the cache so it never ships or enters a digest. */
export function syncRecordPath(): string {
  return join(cacheHome(), 'written-helpers');
}

/** Replaces a file in one step, so a process reading it sees the old text or the new and never half. */
function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, text);
  // Windows refuses a rename onto a file another process has open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      if (attempt >= 50) {
        rmSync(temporary, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Notes that the sync wrote or found this text. A file already there is the same note, so it is kept. */
export function noteWritten(folder: string, text: string): void {
  try {
    writeFileSync(join(folder, sha256(text)), '', { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

/**
 * Writes each missing or outdated copy and answers the copies it wrote.
 *
 * A copy that differs from its original is stale when the sync wrote its text, and edited by hand
 * otherwise, which stops the sync before anything is written. With no folder of what was written, a
 * copy that differs is taken for stale. A text is noted before any copy holds it and a note is never
 * rewritten or removed, so no process can undo another's.
 */
export function syncSharedGdscript(godot: string = GODOT): string[] {
  const folder = syncRecordPath();
  const recorded = existsSync(folder);
  const due: { copy: string; wanted: string }[] = [];
  const equal: string[] = [];
  for (const { original, copy } of sharedCopies(godot)) {
    const wanted = readFileSync(original, 'utf8');
    const held = existsSync(copy) ? readFileSync(copy, 'utf8') : null;
    if (held === wanted) {
      equal.push(held);
      continue;
    }
    if (held !== null && recorded && !existsSync(join(folder, sha256(held)))) {
      throw new Error(
        `${copy} was changed after it was written. It is a copy of ${original}: make the change there, then delete the copy.`,
      );
    }
    due.push({ copy, wanted });
  }
  mkdirSync(folder, { recursive: true });
  for (const text of equal) noteWritten(folder, text);
  for (const { copy, wanted } of due) {
    noteWritten(folder, wanted);
    writeWhole(copy, wanted);
  }
  return due.map(({ copy }) => copy);
}
