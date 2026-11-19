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
 * A copy that differs from its original and from the text the sync last wrote was edited by hand.
 * The sync stops there and names the original, because overwriting it would lose the edit and
 * leaving it would test the wrong text. What it last wrote is kept as one hash per copy in
 * `.shared-gd-hashes.json` beside the `godot` folder, which git ignores and no package carries.
 * File times judge nothing, since a copy that keeps its source's time or two syncs at once make
 * them lie. Without a record, as on a tree an older sync left, a differing copy is taken for stale.
 * Each file is written to a temporary name and renamed, so a suite starting beside another reads
 * a whole copy.
 *
 * A `.uid` is never written here. Godot writes one beside every script and reads it back so a
 * reference survives a rename, so an identity is permanent once it exists and every game holding
 * an addon keeps the value it shipped with. Each copy's `.uid` is a tracked file.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const GODOT = join('src', 'godot');
const RECORD = '.shared-gd-hashes.json';

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

/** The file of what the sync last wrote, beside the `godot` folder so it never ships or enters a digest. */
export function syncRecordPath(godot: string = GODOT): string {
  return join(godot, '..', RECORD);
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

function readRecord(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/**
 * Writes each missing or outdated copy and answers the copies it wrote.
 *
 * A copy that differs from its original is stale when it holds the text the sync last wrote, and
 * edited by hand otherwise, which stops the sync before anything is written. With no record of what
 * was written, a copy that differs is taken for stale. The record is read before any copy, so a
 * copy another process writes meanwhile is equal to the original or still what the record says.
 */
export function syncSharedGdscript(godot: string = GODOT): string[] {
  const recordPath = syncRecordPath(godot);
  const record = readRecord(recordPath);
  const known = { ...record };
  const due: { copy: string; wanted: string }[] = [];
  for (const { original, copy } of sharedCopies(godot)) {
    const wanted = readFileSync(original, 'utf8');
    const key = relative(godot, copy);
    const held = existsSync(copy) ? readFileSync(copy, 'utf8') : null;
    if (held === wanted) {
      known[key] = sha256(wanted);
      continue;
    }
    if (held !== null && key in record && sha256(held) !== record[key]) {
      throw new Error(
        `${copy} was changed after it was written. It is a copy of ${original}: make the change there, then delete the copy.`,
      );
    }
    known[key] = sha256(wanted);
    due.push({ copy, wanted });
  }
  for (const { copy, wanted } of due) writeWhole(copy, wanted);
  if (JSON.stringify(known) !== JSON.stringify(record)) {
    writeWhole(recordPath, `${JSON.stringify(known, null, 2)}\n`);
  }
  return due.map(({ copy }) => copy);
}
