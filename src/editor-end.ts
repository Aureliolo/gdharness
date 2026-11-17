/**
 * How an editor this server opened ended, read from the exit its keeper noted and the console it
 * wrote, for the refusals that say an editor went.
 */

import { readFileSync } from 'node:fs';
import { editorExitPath, editorLogPath } from './editor-log.js';
import { exitCodeText } from './engine-run.js';
import { ENGINE_BANNER, linesAsPrinted } from './start-race.js';

/** The longest last line a sentence quotes. */
const LAST_LINE_CHARS = 200;

/** The exit status the keeper noted for the editor of [param projectPath], or null. */
export function readEditorExit(projectPath: string): number | null {
  try {
    const said = Number(readFileSync(editorExitPath(projectPath), 'utf8').trim());
    return Number.isInteger(said) && said >= 0 ? said : null;
  } catch {
    return null;
  }
}

/** What the editor's console holds, as the lines it printed. None for a console never written. */
function printedBy(projectPath: string): string[] {
  try {
    return linesAsPrinted(readFileSync(editorLogPath(projectPath), 'utf8'));
  } catch {
    return [];
  }
}

/** What the editor printed, as a phrase: nothing, its banner alone, or how much and the last line. */
function whatTheEditorPrinted(projectPath: string): string {
  const lines = printedBy(projectPath);
  if (lines.length === 0 || (lines.length === 1 && (lines[0] ?? '').trim() === '')) {
    return 'printed nothing';
  }
  const [first] = lines;
  if (lines.length === 1 && ENGINE_BANNER.test(first ?? '')) {
    return 'printed only its banner';
  }
  const last = (lines.at(-1) ?? '').trim();
  const shown = last.length > LAST_LINE_CHARS ? `${last.slice(0, LAST_LINE_CHARS)}...` : last;
  return `printed ${String(lines.length)} lines, the last "${shown}"`;
}

/**
 * How the editor of [param projectPath] ended, as a phrase: its exit status, which a Windows
 * exception status gives in hex with its meaning, and what it printed.
 */
export function howTheEditorEnded(projectPath: string): string {
  const code = readEditorExit(projectPath);
  const status = code === null ? 'its exit status was not recorded' : exitCodeText(code);
  return `${status}, and it ${whatTheEditorPrinted(projectPath)}`;
}
