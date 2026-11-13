import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { HeldBreakpoint } from './dap_client.js';
import { errorMessage } from './errors.js';
import { realAsFarAsItExists, relativeWithin } from './paths.js';
import { isRecord } from './records.js';
import { writeWhole } from './whole-file.js';

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
  // Spelt as debug_breakpoint spells it, the project resolved and the path below it as written:
  // on macOS every /var/folders project is really under /private/var/folders, and a file compared
  // against the unresolved root reads as outside it. A path elsewhere is resolved to be compared.
  const root = realAsFarAsItExists(projectPath);
  const inside = held
    .map((one) => ({
      scriptPath:
        relativeWithin(root, one.scriptPath) === null ? realAsFarAsItExists(one.scriptPath) : one.scriptPath,
      lines: one.lines,
    }))
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
    if (!writeWhole(path, `${JSON.stringify(note, null, 2)}\n`)) {
      console.error(`[SERVER] Could not record the breakpoints at ${path}.`);
    }
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
    const breakpoints: unknown = isRecord(parsed) ? parsed['breakpoints'] : undefined;
    if (!Array.isArray(breakpoints)) {
      return [];
    }
    const held: HeldBreakpoint[] = [];
    for (const entry of breakpoints as unknown[]) {
      if (!isRecord(entry)) {
        continue;
      }
      const { script: written, lines: listed } = entry;
      if (typeof written !== 'string') {
        continue;
      }
      // A project path never holds a backslash in a name, since the engine's paths use slashes, so
      // a note spelt with backslashes reads the same on every system.
      const script = written.replaceAll('\\', '/');
      if (isAbsolute(script) || !withinProject(projectPath, join(projectPath, script))) {
        continue;
      }
      const lines = Array.isArray(listed)
        ? listed.filter((line): line is number => Number.isInteger(line) && line > 0)
        : [];
      if (lines.length > 0) {
        // Spelt as debug_breakpoint spells it, the project resolved and the path below it as
        // written, since the adapter refuses a path that is not under the project it holds.
        held.push({ scriptPath: join(realAsFarAsItExists(projectPath), script), lines });
      }
    }
    return held;
  } catch {
    return [];
  }
}

function withinProject(projectPath: string, scriptPath: string): boolean {
  const rel = relativeWithin(projectPath, scriptPath);
  return rel !== null && rel !== '';
}
