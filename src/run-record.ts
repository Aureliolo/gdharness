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
  /**
   * What it exited with, when its server was still there to see it go.
   *
   * Absent for a run that outlived the server which started it, which is the case this whole
   * record exists for. Present is the other one: the run ended, the server saw it, and then the
   * harness replaced that server before anybody asked.
   */
  readonly exitCode?: number;
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

/**
 * Where an editor-played run's console is being written, for whichever server asks next.
 *
 * Its own note rather than a field on the one above, because the two carry different authority. A
 * `RunRecord` names a process: it is what says a run is still going and what a stop is aimed at,
 * and a wrong one ends a stranger's bench. This names a file and nothing else. The run it belongs
 * to is held by the editor, which is on the bridge and answers whether it is still playing, so
 * there is no pid here to be believed and none to act on.
 *
 * Overwritten by each play and left behind afterwards, the way a transcript is. A note for a run
 * that is over is read by nobody: the editor has to say it is playing before this is opened at all.
 */
export interface EditorRunNote {
  readonly projectPath: string;
  readonly transcript: string;
  readonly startedAt: number;
}

function editorNotePath(): string {
  return join(runsDirectory(), 'editor-run.json');
}

export function writeEditorRunNote(note: EditorRunNote): void {
  mkdirSync(runsDirectory(), { recursive: true });
  writeFileSync(editorNotePath(), JSON.stringify(note, null, 2), 'utf8');
}

/** The editor-played run another server left a file for, or null when there is none to read. */
export function readEditorRunNote(): EditorRunNote | null {
  for (const directory of runtimeDirectories()) {
    const note = editorNoteAt(join(directory, 'runs', 'editor-run.json'));
    if (note !== null) {
      return note;
    }
  }
  return null;
}

function editorNoteAt(path: string): EditorRunNote | null {
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
  const projectPath = fields['projectPath'];
  const transcript = fields['transcript'];
  const startedAt = fields['startedAt'];
  if (typeof projectPath !== 'string' || typeof transcript !== 'string' || typeof startedAt !== 'number') {
    return null;
  }
  return { projectPath, transcript, startedAt };
}

/**
 * The exit code kept in the note, for a run that ended while its server was still there.
 *
 * A run outlives its server on purpose and the next one reads this note rather than the process,
 * so without this a bench that had finished cleanly under a server since replaced came back as one
 * whose exit code "was never collected". That is true of the reading and false of the run: it was
 * collected, by the process that started it, and then thrown away when the harness reconnected.
 *
 * Only when the note is still this run's. These directories are shared by every server on the
 * machine, and writing an exit code over somebody else's note would end their run on paper.
 */
export function recordRunEnded(pid: number, exitCode: number): void {
  const path = recordPath();
  const record = recordAt(path);
  if (record === null || record.pid !== pid) {
    return;
  }
  try {
    writeFileSync(path, JSON.stringify({ ...record, exitCode }, null, 2), 'utf8');
  } catch {
    // Gone or unwritable, which is a state every reader of this note already handles.
  }
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
    ...(typeof fields['exitCode'] === 'number' ? { exitCode: fields['exitCode'] } : {}),
  };
}

/**
 * What the operating system says is running under [param pid], and how much of it it would say.
 *
 * `image` is the executable's name alone, `commandLine` is the whole line it was started with.
 * Null is the operating system declining to answer, which is not the same as nothing running
 * there and must never be read as one.
 */
export function runningAs(pid: number): RunningAs | null {
  if (process.platform === 'win32') {
    const answer = windowsCommandLine(pid);
    if (answer !== null) {
      // The creation time is the first line and the command line is the rest, because the query
      // that reads one reads the other for free and this runs before every signal.
      const [, ...rest] = answer.split('\n');
      const line = rest.join('\n').trim();
      const began = startedAt(pid, answer);
      if (line !== '') {
        return { kind: 'commandLine', text: line, ...(began === null ? {} : { startedAt: began }) };
      }
    }
    // An empty answer from the query above is not "nothing is there": a process owned by another
    // user, or one this server cannot open, keeps its command line and hands back nothing at all.
    // tasklist still names the executable, and that is the difference between a weaker check and
    // no check, so it is asked before this gives up.
    const image = windowsImage(pid);
    return image === null ? null : { kind: 'image', text: image };
  }
  try {
    const began = startedAt(pid, null);
    const when = began === null ? {} : { startedAt: began };
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      return raw === '' ? null : { kind: 'commandLine', text: raw, ...when };
    }
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return args === '' ? null : { kind: 'commandLine', text: args, ...when };
  } catch {
    return null;
  }
}

/**
 * The process listening on [param port] of the loopback address, or null when the platform will
 * not say.
 *
 * Here because identity is what this file is about. Godot's debug adapter has one default port and
 * every editor on a machine takes it, and the addon reports the port its editor's *settings* name
 * rather than the one it managed to bind: two editors opened by hand both answer 6006, one of them
 * holds it, and nothing in the answer distinguishes them. A server that connects on that number is
 * talking to whichever editor got there first, and the console it reads back belongs to that
 * project. Measured here, not imagined: a fixture in this repository connected to a real editor
 * belonging to another project on this machine and read its game's output.
 *
 * Null is "the operating system would not say", which is not the same as "it is not this editor's"
 * and must not be treated as one. Every caller here already has that distinction: not knowing is
 * never grounds to refuse.
 */
export function listeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const said = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      ).trim();
      return /^\d+$/.test(said) ? Number(said) : null;
    }
    // `lsof` is on macOS by default and usual on Linux; `ss` is the modern Linux answer and is not
    // on macOS. Both are asked rather than one picked by platform, because what decides is which is
    // installed. A process owned by another user hides its pid from both, which is the null case.
    for (const [command, args, pattern] of [
      ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], /^(\d+)/],
      ['ss', ['-ltnpH', `sport = :${port}`], /pid=(\d+)/],
    ] as const) {
      try {
        const said = execFileSync(command, [...args], { encoding: 'utf8', timeout: 15_000 }).trim();
        const found = pattern.exec(said);
        if (found?.[1] !== undefined) {
          return Number(found[1]);
        }
      } catch {
        // Not installed, or nothing listening. The next one is asked either way.
      }
    }
    return null;
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
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o"); $p.CommandLine }`,
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    ).trim();
    return answer === '' ? null : answer;
  } catch {
    return null;
  }
}

/**
 * When the process under [param pid] started, as milliseconds, or null where the platform will not
 * say.
 *
 * This is the one thing about a process that a recycled number cannot carry over. Everything else a
 * record holds is a property of the engine and the project, and a machine running a fan-out has
 * dozens of processes sharing all of them; what it does not have is a second process that started
 * when this run did.
 */
function startedAt(pid: number, windowsAnswer: string | null): number | null {
  if (process.platform === 'win32') {
    // The first line of the answer above, asked in the same call: a second interpreter launch costs
    // half a second on a path that runs before every signal.
    const when = Date.parse(windowsAnswer?.split('\n')[0]?.trim() ?? '');
    return Number.isNaN(when) ? null : when;
  }
  try {
    const said = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    const when = Date.parse(said);
    return said === '' || Number.isNaN(when) ? null : when;
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
  return judgeRun(record, runningAs(record.pid), 'confirmed');
}

/**
 * Whether the process under the record's pid could still be this run.
 *
 * The weaker question, and the honest one to ask when picking a run back up rather than ending it.
 * A Windows process whose command line this server cannot read is named by `tasklist` and no more,
 * so all that can be had there is the executable's name. That is enough to go on calling a bench
 * running; it is not enough to signal one, and reporting a live bench as finished because an
 * interpreter would not answer is its own wrong answer.
 */
export function couldStillBeTheRecordedRun(record: RunRecord): boolean {
  return judgeRun(record, runningAs(record.pid), 'possible');
}

/**
 * The editor, as its own command line says so. Godot takes both spellings and a game is given
 * neither.
 */
const AN_EDITOR = /(?:^|\s)(?:-e|--editor)(?:\s|$)/;

/** What the operating system will say about a process, and how much of it. */
export interface RunningAs {
  readonly kind: 'image' | 'commandLine';
  readonly text: string;
  /** Milliseconds, where the platform will give it. Absent is not zero and not now. */
  readonly startedAt?: number;
}

/**
 * How far after a record's own start a process may have begun and still be that run.
 *
 * Wide enough to absorb the gap between a server writing the note and the engine being there to be
 * asked about, and the second-resolution the platforms answer with. Narrow against the case it is
 * for: a number handed out again has to wait for the first process to exit, so the gap is the run's
 * whole length.
 */
const SAME_RUN_WINDOW_MS = 90_000;

/**
 * The comparison itself, apart from asking the operating system, so that every answer the
 * operating system can give is a case that can be written down rather than a platform to be on.
 *
 * `confirmed` is for the caller that kills: a record naming a project and an answer that carries
 * no project is not a confirmation, whatever the executable is called. Two engines of the same
 * build on two projects are the case, and it is not a rare one on a machine running benches.
 */
export function judgeRun(
  record: RunRecord,
  running: RunningAs | null,
  needed: 'confirmed' | 'possible',
): boolean {
  if (running === null) {
    return false;
  }
  // When the process started, which is the one thing a recycled number cannot carry over. Every
  // other property a record holds belongs to the engine and the project, and a machine running a
  // fan-out has dozens of processes sharing all of them: one report here describes a bench opening
  // 31 worker engines, same executable, same `--path`, no `-e`, any of which the checks below would
  // confirm. What none of them has is a start at the moment this run started.
  //
  // Only one direction. A process that began after the record did cannot be the run the record
  // describes, because the run was already going. One that reads as starting slightly earlier is a
  // clock or a resolution artefact rather than evidence, so it is left to the comparisons below.
  //
  // Asked of the caller that kills. Picking a run back up on a weaker answer costs a wrong reading;
  // signalling on one costs somebody else's process.
  if (
    needed === 'confirmed' &&
    running.startedAt !== undefined &&
    running.startedAt - record.startedAt > SAME_RUN_WINDOW_MS
  ) {
    return false;
  }
  const engine = record.command === undefined ? null : basename(record.command);
  const said = process.platform === 'win32' ? running.text.toLowerCase() : running.text;
  const wanted = engine === null || process.platform !== 'win32' ? engine : engine.toLowerCase();
  if (wanted !== null && !said.includes(wanted)) {
    return false;
  }
  // An editor is not a run, and nothing else here separates the two: the editor holding a project
  // and a game of that project are the same binary pointed at the same directory, which is all
  // that is compared below. The pid that came round again is routinely an editor's, because a
  // restart frees the game's number and opens an editor seconds later, and confirming it hands
  // `process.kill` the editor, which then goes with no crash log and nothing in its output.
  //
  // Only where the flags can be read. An image name cannot show them, and that answer is already
  // too weak to kill on.
  if (running.kind === 'commandLine' && AN_EDITOR.test(said)) {
    return false;
  }
  if (record.projectPath === '') {
    // An older record names no project to compare, so the executable is the whole of what there
    // is to go on either way. A record written by this version answers both.
    return wanted !== null;
  }
  if (running.kind === 'image') {
    return needed === 'possible' && wanted !== null;
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
