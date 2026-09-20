import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage } from './errors.js';
import type { EditorPorts } from './launch.js';

/**
 * A restart of an editor this server opened is two acts with a gap between them: the editor is
 * asked to quit, waited out, and started again. The server can be ended in the gap, and the usual
 * way that happens is the reason the restart was called at all, since a caller restarts the editor
 * to take an upgrade and the user reconnects the harness for the same upgrade at the same moment.
 * The quit lands, the launch never happens, and the server that comes up next has no idea anything
 * was owed: it is young, nothing has connected, and it answers that an editor may yet connect.
 * Nothing is coming. Reported downstream with a process listing to prove it.
 *
 * So the restart writes down what it is about to do before it does it, in the project, which is the
 * one fact the next server shares with this one. A successor reads the note and can say what
 * happened rather than guessing from its own age.
 */
export interface RestartNote {
  readonly projectPath: string;
  /** The editor that was asked to quit. Informational: a number is not a process. */
  readonly editorPid: number | null;
  /** The ports it served, which the launch would have reused. */
  readonly ports: EditorPorts;
  readonly quitAt: string;
  /** The server that began the restart, so a successor can tell it was not itself. */
  readonly byPid: number;
}

/** Beside the bridge announcement, for the same reason it lives there. */
export function restartNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-restart.json');
}

/**
 * Records that a restart has begun and the launch half is still to come.
 *
 * A failure here is logged and not fatal: the restart goes ahead as it always did, and only the
 * successor's ability to explain an interruption is lost.
 */
export function noteRestartBegun(note: RestartNote): void {
  const path = restartNotePath(note.projectPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`[SERVER] Could not record the restart at ${path}: ${errorMessage(error)}`);
  }
}

/**
 * The restart somebody began on this project and did not finish, or null when there is none.
 *
 * Null for a file that is missing, unreadable or not the shape this writes, because all three mean
 * the same thing to the caller: nothing here says a launch is owed.
 */
export function restartOwed(projectPath: string): RestartNote | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(restartNotePath(projectPath), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const said = parsed as Partial<RestartNote>;
    if (typeof said.quitAt !== 'string' || typeof said.byPid !== 'number' || typeof said.ports !== 'object') {
      return null;
    }
    return said as RestartNote;
  } catch {
    return null;
  }
}

/**
 * Takes the note down: the launch happened, or an editor is connected, so nothing is owed.
 *
 * Whichever server does it. Unlike the bridge announcement this is not a live address that a
 * replacement might be holding; it is a debt, and an editor being there settles it whoever opened
 * the editor.
 */
export function restartSettled(projectPath: string): void {
  try {
    rmSync(restartNotePath(projectPath), { force: true });
  } catch (error) {
    console.error(`[SERVER] Could not clear the restart note: ${errorMessage(error)}`);
  }
}
