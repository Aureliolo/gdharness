/**
 * The run that outlives the server which started it.
 *
 * An MCP server is restarted by the harness in front of it, on its own schedule and without
 * warning: a reconnect. Everything about a run used to live in that process, so a reconnect took
 * the run with it. The game was spawned as an ordinary child, which on every platform here means
 * it is torn down with its parent, and the log was an object in memory, so what the run had
 * already printed went with it too. `editor_output` afterwards answered "No game is running",
 * which is true about the process and says nothing about the forty minutes of bench output that
 * had just been thrown away. Reported twice in one session by a project running sweeps: a
 * six-setting sweep died after one row, a nine-cell sweep after five cells.
 *
 * Two things fix that, and both have to be on disk. The game is spawned detached, so the
 * operating system stops taking it down with whoever started it, and its output goes to a file
 * it holds open rather than to a pipe, so it never blocks on a reader that has gone and the
 * bytes survive the reader anyway. This record is the third piece: the note that says which
 * process and which file, so the next server can pick the run back up instead of denying it.
 *
 * One transcript per run, named for when it started, because the alternative is what the engine
 * does to its own log: a second run rotates the file out from under the first, and the rows the
 * first had already printed stop being anywhere.
 */

import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeDirectory } from './runtime-client.js';

/** What a run leaves behind so another server can find it. */
export interface RunRecord {
  /** The game's own process, which is what says whether the run is still going. */
  readonly pid: number;
  /** The file both its streams are written to, in the order the lines landed. */
  readonly transcript: string;
  readonly startedAt: number;
  readonly projectPath: string;
  readonly arguments: readonly string[];
}

/** Where a run's note and its transcript are kept, beside the runtime's own announcements. */
function runsDirectory(): string {
  return join(runtimeDirectory(), 'runs');
}

function recordPath(): string {
  return join(runsDirectory(), 'run.json');
}

/**
 * A transcript nothing else is writing to, opened for appending.
 *
 * The descriptor is handed to the child as both its streams and closed here straight afterwards:
 * the child keeps its own copy, and this process has no reason to hold one open for a file it
 * only ever reads by offset.
 */
export function openTranscript(startedAt: number): { path: string; fd: number } {
  mkdirSync(runsDirectory(), { recursive: true });
  const path = join(runsDirectory(), `run-${startedAt}.log`);
  return { path, fd: openSync(path, 'a') };
}

export function writeRunRecord(record: RunRecord): void {
  mkdirSync(runsDirectory(), { recursive: true });
  writeFileSync(recordPath(), JSON.stringify(record, null, 2), 'utf8');
}

/** The run another server left behind, or null when there is none to read. */
export function readRunRecord(): RunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  const pid = fields['pid'];
  const transcript = fields['transcript'];
  const startedAt = fields['startedAt'];
  if (typeof pid !== 'number' || typeof transcript !== 'string' || typeof startedAt !== 'number') {
    return null;
  }
  const args = fields['arguments'];
  return {
    pid,
    transcript,
    startedAt,
    projectPath: typeof fields['projectPath'] === 'string' ? fields['projectPath'] : '',
    arguments: Array.isArray(args) ? args.filter((value): value is string => typeof value === 'string') : [],
  };
}

export function clearRunRecord(): void {
  try {
    rmSync(recordPath());
  } catch {
    // Already gone, which is the state this asks for.
  }
}

/** How old a file is, for deciding whether a transcript is worth keeping. */
function ageMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Drop transcripts old enough that nobody is coming back for them.
 *
 * A file per run in a directory nothing ever empties is a leak, and the run that is still going
 * cannot be the one deleted, so the keep-alive is the record rather than a guess: whatever the
 * current record names is left alone whatever its age.
 */
export function sweepTranscripts(keepMs = 24 * 60 * 60 * 1000, now = Date.now()): void {
  const directory = runsDirectory();
  const keep = readRunRecord()?.transcript;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('run-') || !entry.endsWith('.log')) {
      continue;
    }
    const path = join(directory, entry);
    if (path === keep || ageMs(path, now) < keepMs) {
      continue;
    }
    try {
      rmSync(path);
    } catch {
      // A transcript still held open somewhere, which the next sweep will get.
    }
  }
}
