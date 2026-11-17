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

/**
 * The exit status the keeper noted for editor [param pid] of [param projectPath], or null. The note
 * names the pid it is of, so one left by an editor before is not read as this one's.
 */
export function readEditorExit(projectPath: string, pid: number): number | null {
  try {
    const [notedPid, notedCode, ...rest] = readFileSync(editorExitPath(projectPath), 'utf8')
      .trim()
      .split(/\s+/);
    const code = Number(notedCode);
    return rest.length === 0 && Number(notedPid) === pid && Number.isInteger(code) && code >= 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * What the editor printed, as a phrase: nothing, blank lines alone, its banner alone, or how much
 * and the last line. Read as {@link linesAsPrinted} reads output, so the words agree with the rule
 * that decides whether a start is made again.
 */
function whatTheEditorPrinted(projectPath: string): string {
  let lines: string[];
  try {
    lines = linesAsPrinted(readFileSync(editorLogPath(projectPath), 'utf8'));
  } catch {
    return 'wrote no console';
  }
  const [first] = lines;
  if (lines.length === 0) {
    return 'printed nothing';
  }
  if (lines.length === 1 && (first ?? '').trim() === '') {
    return 'printed only blank lines';
  }
  if (lines.length === 1 && ENGINE_BANNER.test(first ?? '')) {
    return 'printed only its banner';
  }
  const last = (lines.at(-1) ?? '').trim();
  const shown = last.length > LAST_LINE_CHARS ? `${last.slice(0, LAST_LINE_CHARS)}...` : last;
  return `printed ${String(lines.length)} lines, the last "${shown}"`;
}

/**
 * How editor [param pid] of [param projectPath] ended, as a phrase: its exit status, which a Windows
 * exception status gives in hex with its meaning, and what it printed.
 */
export function howTheEditorEnded(projectPath: string, pid: number): string {
  const code = readEditorExit(projectPath, pid);
  const status = code === null ? 'its exit status was not recorded' : exitCodeText(code);
  return `${status}, and it ${whatTheEditorPrinted(projectPath)}`;
}
