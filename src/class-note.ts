import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asParams, readArray, readNumber } from './tool-args.js';
import { changeWholeAsync } from './whole-file.js';

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
interface ClassNote {
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
    return classNoteIn(readFileSync(classNotePath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

/** The note [param text] holds, or null for no text or one that is not this shape. */
function classNoteIn(text: string | null): ClassNote | null {
  try {
    const fields = asParams(JSON.parse(text ?? ''));
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
 * Replaces the note of [param projectPath] with what [param change] makes of the note as it is when
 * the update's turn comes, or leaves it when that is null. Updates of one project run one after the
 * other: each reads the note after the one before it has written, since a write that waits on a
 * reader leaves the next to read the note as it was and write over the change.
 *
 * Written whole, since the next server reads it while this one may be writing. A project that
 * cannot be written into is forgotten again, and a note that cannot be read leaves the call as it
 * is, without a throw.
 */
export async function updateClassNote(
  projectPath: string,
  change: (note: ClassNote | null) => ClassNote | null,
): Promise<void> {
  const path = classNotePath(projectPath);
  // The next server learns it afresh when the write does not land, which is what it did before
  // there was a note.
  try {
    await changeWholeAsync(path, (text) => {
      const changed = change(classNoteIn(text));
      if (changed === null) {
        return null;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        return null;
      }
      return `${JSON.stringify(changed, null, 2)}\n`;
    });
  } catch {
    // A note that cannot be read for good, such as a folder at its path, cannot be replaced either.
    // Callers have already done what the note records, so they carry on without it.
  }
}
