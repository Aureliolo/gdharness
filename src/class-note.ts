import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asParams, readArray, readNumber } from './tool-args.js';
import { writeWhole } from './whole-file.js';

/**
 * What a server learned about a project's class cache and the editor writing it, kept in the
 * project so the next server on it starts knowing.
 *
 * Facts about an editor that outlives the server. What the last rebuild left in the cache is what
 * tells a class the files gained from one the editor wrote out, and the editor whose scan or save
 * wrote a shorter list than the file is the one a rescan cannot teach. The server that measured
 * either is replaced at every reconnect, which is exactly when a stale editor has been up for
 * hours. Held in memory alone, every replacement offered that editor the rescan again until it saw
 * the loss for itself.
 */
export interface ClassNote {
  /** The classes the cache held after the last rebuild a server ran. */
  readonly rebuiltWith: readonly string[];
  /**
   * The editor whose last scan or save wrote the cache shorter than the file, by pid, or null
   * for one that never said its pid. Absent when no loss has been seen on this project.
   */
  readonly shortListEditorPid?: number | null;
  /**
   * The classes an editor could not see before a scan whose end no server saw, by that editor's
   * pid. The scan may have brought them in after the rescan stopped waiting, and the scripts naming
   * them stay compiled as the editor compiled them without them until each is reloaded. The next
   * rescan of the same editor does that, which it otherwise would not, since by then the editor
   * sees the classes and nothing marks them as new.
   */
  readonly unseenBeforeAnUnfinishedScan?: UnfinishedScan;
}

/** The editor, by pid or null for one that never said it, and what it could not see. */
interface UnfinishedScan {
  readonly editorPid: number | null;
  readonly classes: readonly string[];
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
    const unfinished = unfinishedScanIn(fields['unseenBeforeAnUnfinishedScan']);
    return {
      rebuiltWith: rebuiltWith.map(String),
      ...(Object.hasOwn(fields, 'shortListEditorPid') ? { shortListEditorPid: pid ?? null } : {}),
      ...(unfinished === null ? {} : { unseenBeforeAnUnfinishedScan: unfinished }),
    };
  } catch {
    return null;
  }
}

function unfinishedScanIn(value: unknown): UnfinishedScan | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const fields = asParams(value);
  const classes = readArray(fields, 'classes');
  if (classes === undefined || !classes.every((name) => typeof name === 'string')) {
    return null;
  }
  return { editorPid: readNumber(fields, 'editorPid') ?? null, classes: classes.map(String) };
}

/**
 * Writes [param note] for [param projectPath], whole, since the next server reads it while this
 * one may be writing. A project that cannot be written into is forgotten again.
 */
export function writeClassNote(projectPath: string, note: ClassNote): void {
  const path = classNotePath(projectPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return;
  }
  // The next server learns it afresh when the write does not land, which is what it did before
  // there was a note.
  writeWhole(path, `${JSON.stringify(note, null, 2)}\n`);
}
