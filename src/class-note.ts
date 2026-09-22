import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asParams, readArray, readNumber } from './tool-args.js';

/**
 * What a server learned about a project's class cache and the editor writing it, kept in the
 * project so the next server on it starts knowing.
 *
 * Two facts, both about an editor that outlives the server. What the last rebuild left in the
 * cache is what tells a class the files gained from one the editor wrote out, and the editor
 * whose scan or save wrote a shorter list than the file is the one a rescan cannot teach; the
 * server that measured either is replaced at every reconnect, which is exactly when a stale
 * editor has been up for hours. Held in memory alone, every replacement offered that editor the
 * rescan again until it saw the loss for itself.
 */
export interface ClassNote {
  /** The classes the cache held after the last rebuild a server ran. */
  readonly rebuiltWith: readonly string[];
  /**
   * The editor whose last scan or save wrote the cache shorter than the file, by pid, or null
   * for one that never said its pid. Absent when no loss has been seen on this project.
   */
  readonly shortListEditorPid?: number | null;
}

/** Beside the other notes, in the project's own `.godot`. */
export function classNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-classes.json');
}

/** The note as written, or null for a file that is missing, unreadable or not this shape. */
export function readClassNote(projectPath: string): ClassNote | null {
  try {
    const fields = asParams(JSON.parse(readFileSync(classNotePath(projectPath), 'utf8')));
    const rebuiltWith = readArray(fields, 'rebuiltWith');
    if (rebuiltWith === undefined || !rebuiltWith.every((name) => typeof name === 'string')) {
      return null;
    }
    const pid = readNumber(fields, 'shortListEditorPid');
    return {
      rebuiltWith: rebuiltWith.map(String),
      ...(Object.hasOwn(fields, 'shortListEditorPid') ? { shortListEditorPid: pid ?? null } : {}),
    };
  } catch {
    return null;
  }
}

/** Writes [param note] for [param projectPath]. A project that cannot be written into is forgotten again. */
export function writeClassNote(projectPath: string, note: ClassNote): void {
  try {
    const path = classNotePath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`, 'utf8');
  } catch {
    // The next server learns it afresh, which is what it did before there was a note.
  }
}
