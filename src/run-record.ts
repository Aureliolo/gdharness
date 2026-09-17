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

import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runtimeDirectories, runtimeDirectory } from './runtime-client.js';

/** What a run leaves behind so another server can find it. */
export interface RunRecord {
  /** The game's own process, which is what says whether the run is still going. */
  readonly pid: number;
  /** The file both its streams are written to, in the order the lines landed. */
  readonly transcript: string;
  readonly startedAt: number;
  readonly projectPath: string;
  readonly arguments: readonly string[];
  /**
   * The engine this run was started with, so the pid can be shown to still mean this run.
   *
   * Absent from a record written before this was kept, and a pid on its own is not an identity:
   * see `stillTheRecordedRun`, which is what decides whether anything may be signalled.
   */
  readonly command?: string;
}

/** Where a run's note and its transcript are kept, beside the runtime's own announcements. */
function runsDirectory(): string {
  return join(runtimeDirectory(), 'runs');
}

function recordPath(): string {
  return join(runsDirectory(), 'run.json');
}

/**
 * Every place a note could have been left, newest first.
 *
 * Written to one directory and looked for in several, because the two servers either side of a
 * reconnect do not have to agree about where the temporary directory is. They usually do, being
 * started the same way by the same harness, but "usually" is how this project already lost a
 * session once: a game announced itself in `C:\Windows\Temp\gdharness` while the server watched
 * the user's own, and answered that nothing was running while something was. The same fallbacks
 * are read here, so that mismatch costs a lookup rather than the run.
 */
function recordPaths(): string[] {
  return runtimeDirectories().map((directory) => join(directory, 'runs', 'run.json'));
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
  for (const path of recordPaths()) {
    const record = recordAt(path);
    if (record !== null) {
      return record;
    }
  }
  return null;
}

function recordAt(path: string): RunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
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
    ...(typeof fields['command'] === 'string' ? { command: fields['command'] } : {}),
  };
}

/**
 * What the operating system says is running under [param pid], and how much of it it would say.
 *
 * `image` is the executable's name alone, `commandLine` is the whole line it was started with.
 * Null is the operating system declining to answer, which is not the same as nothing running
 * there and must never be read as one.
 */
function runningAs(pid: number): { kind: 'image' | 'commandLine'; text: string } | null {
  if (process.platform === 'win32') {
    const line = windowsCommandLine(pid);
    if (line !== null) {
      return { kind: 'commandLine', text: line };
    }
    // An empty answer from the query above is not "nothing is there": a process owned by another
    // user, or one this server cannot open, keeps its command line and hands back nothing at all.
    // tasklist still names the executable, and that is the difference between a weaker check and
    // no check, so it is asked before this gives up.
    const image = windowsImage(pid);
    return image === null ? null : { kind: 'image', text: image };
  }
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      return raw === '' ? null : { kind: 'commandLine', text: raw };
    }
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return args === '' ? null : { kind: 'commandLine', text: args };
  } catch {
    return null;
  }
}

/**
 * The whole command line of a Windows process, or null when Windows will not give it.
 *
 * Windows keeps a command line out of reach of anything but a query, so this is the one platform
 * that starts an interpreter to answer. Half a second, on a path that runs once when a run is
 * picked up and once before one is ended.
 */
function windowsCommandLine(pid: number): string | null {
  try {
    const answer = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    ).trim();
    return answer === '' ? null : answer;
  } catch {
    return null;
  }
}

/** The executable's name alone, from the one tool every Windows has. */
function windowsImage(pid: number): string | null {
  try {
    const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    return /^"([^"]+)"/.exec(csv.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the process under the record's pid is still the run the record describes.
 *
 * A pid is a number the operating system hands out again the moment it is free, so a record that
 * outlived its run names whatever came next. Signalling on the strength of that number alone is
 * killing a stranger's process, and this is the one thing here that does something irreversible
 * to a process nobody asked about.
 *
 * What it compares is what the run was started with: the engine's own path and, where the whole
 * command line can be read, the project it was pointed at. Two engines of the same build on two
 * projects are not the same run, which matters because these records are shared by every server
 * using this runtime directory.
 *
 * False when the operating system will not say. Not knowing is not the same as knowing it is
 * ours, and the caller that acts on this is the one that kills.
 */
export function stillTheRecordedRun(record: RunRecord): boolean {
  const running = runningAs(record.pid);
  if (running === null) {
    return false;
  }
  const engine = record.command === undefined ? null : basename(record.command);
  const said = process.platform === 'win32' ? running.text.toLowerCase() : running.text;
  const wanted = engine === null || process.platform !== 'win32' ? engine : engine.toLowerCase();
  if (wanted !== null && !said.includes(wanted)) {
    return false;
  }
  if (running.kind === 'image' || record.projectPath === '') {
    // An older record names no engine and an image name carries no project, so the most that can
    // be said is that something is there. A record written by this version answers both.
    return wanted !== null;
  }
  const project = process.platform === 'win32' ? record.projectPath.toLowerCase() : record.projectPath;
  return said.includes(project);
}

/**
 * Take the note away for a run that has ended, wherever it was left.
 *
 * Every candidate directory is looked in, for the same reason they are read, and each note is read
 * before it is removed: two servers share these directories, and the one whose run this is not
 * must not be the one that deletes it. [param ours] is how the caller says which are its own.
 */
export function clearRunRecord(ours: (record: RunRecord) => boolean = () => true): void {
  for (const path of recordPaths()) {
    const record = recordAt(path);
    if (record === null || !ours(record)) {
      continue;
    }
    try {
      rmSync(path);
    } catch {
      // Already gone, which is the state this asks for.
    }
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
