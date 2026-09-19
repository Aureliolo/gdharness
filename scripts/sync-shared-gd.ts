#!/usr/bin/env bun
/**
 * The GDScript helpers that live beside the operations and again inside each addon, copied from
 * the one that is the original.
 *
 * An addon is installed into a project as a directory and can only preload what is inside it, so
 * a helper both the operations and an addon use has to exist in each of them. Kept by hand, the
 * copies drift, and the call that finds out is the one that went to the copy nobody edited: the
 * same value came back three ways depending on which tool was asked.
 *
 * So the original is the one beside the operations and this writes the rest, byte for byte.
 * `test/regressions.ts` compares them and names this script when they differ, which is what makes
 * an edit to a copy a failure rather than a surprise later.
 *
 * A `.uid` is written only when there is none. Godot writes one beside every script and reads it
 * back so a reference survives a rename, so an identity is permanent once it exists: rewriting one
 * would re-identify the file in every project that already holds it. New ones are derived from the
 * path rather than drawn at random, so two machines generate the same id for the same file.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OPERATIONS = join('src', 'godot', 'operations');
const ADDONS = join('src', 'godot', 'addons');

/** Which helpers are shared, and which addons hold a copy of each. */
export const SHARED_GDSCRIPT: Readonly<Record<string, readonly string[]>> = {
  'reading.gd': ['gdharness_editor', 'gdharness_runtime'],
  'serialisation.gd': ['gdharness_editor', 'gdharness_runtime'],
};

/** Every copy of the shared helpers, as [original, copy] pairs. */
export function sharedCopies(): { original: string; copy: string }[] {
  return Object.entries(SHARED_GDSCRIPT).flatMap(([file, addons]) =>
    addons.map((addon) => ({ original: join(OPERATIONS, file), copy: join(ADDONS, addon, file) })),
  );
}

/**
 * A uid for a file that has none, out of its path.
 *
 * Godot's own are base-36-ish text after `uid://`, and nothing but the format and uniqueness is
 * asked of them, so a hash of the path satisfies both and is the same answer every time.
 */
function identityFor(path: string): string {
  const digest = createHash('sha256').update(path.replaceAll('\\', '/')).digest('hex');
  return `uid://c${BigInt(`0x${digest.slice(0, 16)}`)
    .toString(36)
    .slice(0, 12)}`;
}

export function syncSharedGdscript(): string[] {
  const written: string[] = [];
  for (const { original, copy } of sharedCopies()) {
    const wanted = readFileSync(original, 'utf8');
    if (!existsSync(copy) || readFileSync(copy, 'utf8') !== wanted) {
      writeFileSync(copy, wanted);
      written.push(copy);
    }
    const beside = `${copy}.uid`;
    if (!existsSync(beside)) {
      writeFileSync(beside, `${identityFor(copy)}\n`);
      written.push(beside);
    }
  }
  return written;
}

if (import.meta.main) {
  const written = syncSharedGdscript();
  console.log(
    written.length === 0
      ? 'shared GDScript already matches'
      : `wrote ${written.length}: ${written.join(', ')}`,
  );
}
