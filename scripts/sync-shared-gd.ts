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
 * A copy that differs from its original and is newer than it was edited by hand. The sync stops
 * there and names the original, because overwriting it would lose the edit and leaving it would
 * test the wrong text. Git gives a file it checks out the time of the checkout, so an original that
 * a pull or a branch switch changed is the newer one and its copy is written again.
 *
 * A `.uid` is never written here. Godot writes one beside every script and reads it back so a
 * reference survives a rename, so an identity is permanent once it exists and every game holding
 * an addon keeps the value it shipped with. Each copy's `.uid` is a tracked file.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Writes each missing or outdated copy and answers the copies it wrote. */
export function syncSharedGdscript(godot: string = GODOT): string[] {
  const written: string[] = [];
  for (const { original, copy } of sharedCopies(godot)) {
    const wanted = readFileSync(original, 'utf8');
    if (existsSync(copy) && readFileSync(copy, 'utf8') === wanted) continue;
    if (existsSync(copy) && statSync(copy).mtimeMs > statSync(original).mtimeMs) {
      throw new Error(
        `${copy} was changed after it was written. It is a copy of ${original}: make the change there, then delete the copy.`,
      );
    }
    writeFileSync(copy, wanted);
    written.push(copy);
  }
  return written;
}
