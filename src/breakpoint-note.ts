import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { HeldBreakpoint } from './dap_client.js';
import { errorMessage } from './errors.js';
import { realPathOr } from './paths.js';

/**
 * The breakpoints set through this server, written down in the project.
 *
 * The editor keeps a breakpoint set through its debug adapter for one play, so the server sends
 * every breakpoint it holds again before each play it starts. What it holds lives in the session,
 * and a session ends with the server: the reconnect a harness performs for an upgrade, which is
 * the ordinary way a server ends, left the successor holding nothing and the next play running
 * through every line the caller had asked it to stop on. So the set is kept here as well, beside
 * the restart note, and a successor takes it on before its first play.
 *
 * Paths are kept relative to the project, since the note is the project's: the adapter wants the
 * machine's spelling and the reader rebuilds that from where the project is now.
 */
interface BreakpointNote {
  readonly breakpoints: readonly { readonly script: string; readonly lines: readonly number[] }[];
}

export function breakpointNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-breakpoints.json');
}

/**
 * Writes what is held, or takes the note down when nothing is.
 *
 * A failure is logged and not fatal: the breakpoints are still set for this session, and only the
 * successor's copy of them is lost.
 */
export function writeBreakpointNote(projectPath: string, held: readonly HeldBreakpoint[]): void {
  const path = breakpointNotePath(projectPath);
  // The project as the adapter's paths spell it, which is with every symlink resolved: on macOS
  // every /var/folders project is really under /private/var/folders, and a file compared against
  // the unresolved root reads as outside it.
  const root = realPathOr(projectPath);
  const inside = held
    .map((one) => ({ scriptPath: realPathOr(one.scriptPath), lines: one.lines }))
    .filter((one) => one.lines.length > 0 && withinProject(root, one.scriptPath));
  try {
    if (inside.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const note: BreakpointNote = {
      breakpoints: inside.map((one) => ({
        script: relative(root, one.scriptPath).replaceAll('\\', '/'),
        lines: [...one.lines],
      })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`[SERVER] Could not record the breakpoints at ${path}: ${errorMessage(error)}`);
  }
}

/**
 * The breakpoints an earlier server left for this project, spelt for the adapter.
 *
 * Empty for a note that is missing, unreadable or not the shape this writes, because all three
 * mean the same thing to the caller: nothing here says a line is to be stopped on.
 */
export function readBreakpointNote(projectPath: string): HeldBreakpoint[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(breakpointNotePath(projectPath), 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as BreakpointNote).breakpoints)
    ) {
      return [];
    }
    const held: HeldBreakpoint[] = [];
    for (const entry of (parsed as { breakpoints: unknown[] }).breakpoints) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const { script, lines: listed } = entry as { script?: unknown; lines?: unknown };
      if (typeof script !== 'string' || isAbsolute(script) || script.split('/').includes('..')) {
        continue;
      }
      const lines = Array.isArray(listed)
        ? listed.filter((line): line is number => Number.isInteger(line) && line > 0)
        : [];
      if (lines.length > 0) {
        // Resolved the way debug_breakpoint resolves what it is given, since the adapter refuses
        // a spelling of the file that is not the one it holds the project under.
        held.push({ scriptPath: realPathOr(join(projectPath, script)), lines });
      }
    }
    return held;
  } catch {
    return [];
  }
}

function withinProject(projectPath: string, scriptPath: string): boolean {
  const rel = relative(projectPath, scriptPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
