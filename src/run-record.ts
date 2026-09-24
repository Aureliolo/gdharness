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
 * Three things fix that. The game is started by a keeper outside the server's process tree (see
 * `outside.ts`), so nothing that ends the server takes it down. Its output goes to a file it holds
 * open rather than to a pipe, so it never blocks on a reader that has gone and the bytes survive
 * the reader anyway. And this record says which process and which file, so the next server can
 * pick the run back up instead of denying it. One record per project, because the directory is
 * shared by every server on the machine, and one record for all of them was overwritten by
 * whichever project started a run last.
 *
 * One transcript per run, named for when it started, because the alternative is what the engine
 * does to its own log: a second run rotates the file out from under the first, and the rows the
 * first had already printed stop being anywhere.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isSameDirectory } from './paths.js';
import { type CommandLineRead, POWERSHELL_UTF8, readCommandLine } from './process-children.js';
import { runtimeDirectories, runtimeDirectory, STARTED_AFTER_ANNOUNCING_MS } from './runtime-client.js';

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
   * What it exited with, written by the keeper that holds the game the moment it ends.
   *
   * Absent while the run is going, and for a run whose keeper was ended before the game was.
   */
  readonly exitCode?: number;
  /** The signal that ended it instead, under the same conditions; a signalled run has no code. */
  readonly exitSignal?: string;
}

/** Where a run's note and its transcript are kept, beside the runtime's own announcements. */
function runsDirectory(): string {
  return join(runtimeDirectory(), 'runs');
}

/**
 * The part of a note's name that says whose project it is.
 *
 * One note per project, because the runs directory is every project's on the machine: with one
 * note for all of them, a bench one project started overwrote the note of a run another project's
 * server had started, and that server's successor after a reconnect found no run of its own and
 * refused to end the game as somebody else's. Normalised the way `isSameDirectory` compares, so
 * the spelling a server was given and the one its editor reports name the same note.
 */
/**
 * [param path] with the links in whatever part of it exists resolved, and the rest as written.
 *
 * Resolved only when it exists, the key changed when the directory appeared: a server writes into
 * its project's `.godot` as it starts, which creates the directory, so a note written for the
 * project before that and one read after it named two files wherever the path runs through a link,
 * as a macOS temporary directory does through `/var`.
 */
function realAsFarAsItExists(path: string): string {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing);
    } catch {
      const parent = dirname(at);
      if (parent === at) {
        return path;
      }
      missing.unshift(basename(at));
      at = parent;
    }
  }
}

function projectKey(projectPath: string): string {
  const real = realAsFarAsItExists(resolve(projectPath)).replace(/[\\/]+$/, '');
  const folded = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
  return createHash('sha256').update(folded.replaceAll('\\', '/')).digest('hex').slice(0, 16);
}

/** Where [param projectPath]'s run note is, in [param directory]'s runs. */
export function runRecordPath(projectPath: string, directory = runtimeDirectory()): string {
  return join(directory, 'runs', `note-${projectKey(projectPath)}.json`);
}

/**
 * The one note every project shared before notes were per project, read so a run a server of that
 * version started is still picked up and ended after the upgrade.
 */
const SHARED_NOTE = 'run.json';

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
  writeFileSync(runRecordPath(record.projectPath), JSON.stringify(record, null, 2), 'utf8');
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

/** Per project, for the same reason the run note is. */
function editorNotePath(projectPath: string, directory = runtimeDirectory()): string {
  return join(directory, 'runs', `editor-${projectKey(projectPath)}.json`);
}

export function writeEditorRunNote(note: EditorRunNote): void {
  mkdirSync(runsDirectory(), { recursive: true });
  writeFileSync(editorNotePath(note.projectPath), JSON.stringify(note, null, 2), 'utf8');
}

/** The editor-played run of [param projectPath] another server left a file for, or null. */
export function readEditorRunNote(projectPath: string): EditorRunNote | null {
  for (const directory of runtimeDirectories()) {
    const note =
      editorNoteAt(editorNotePath(projectPath, directory)) ??
      editorNoteAt(join(directory, 'runs', 'editor-run.json'));
    if (note !== null && isSameDirectory(note.projectPath, projectPath)) {
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
 * The exit code kept in the note, written by the run's keeper as the game ends.
 *
 * A run outlives its server on purpose and every server reads this note rather than the process,
 * so without this a bench that had finished cleanly came back as one whose exit code "was never
 * collected". The keeper is the one process that can wait on the game, so it is the one that says.
 *
 * Only when the note is still this run's: a later run of the same project replaces it, and writing
 * an exit code over that note would end the later run on paper.
 */
export function recordRunEnded(
  projectPath: string,
  pid: number,
  ending: { readonly exitCode: number | null; readonly exitSignal: string | null },
): void {
  const path = runRecordPath(projectPath);
  const record = recordAt(path);
  if (record === null || record.pid !== pid) {
    return;
  }
  const written = {
    ...record,
    ...(ending.exitCode === null ? {} : { exitCode: ending.exitCode }),
    ...(ending.exitSignal === null ? {} : { exitSignal: ending.exitSignal }),
  };
  try {
    writeFileSync(path, JSON.stringify(written, null, 2), 'utf8');
  } catch {
    // Gone or unwritable, which is a state every reader of this note already handles.
  }
}

/**
 * The run of [param projectPath] a server left a note for, or null when there is none.
 *
 * Looked for in every runtime directory, because the two servers either side of a reconnect do not
 * have to agree about where the temporary directory is. They usually do, being started the same way
 * by the same harness, but "usually" is how this project already lost a session once: a game
 * announced itself in the system temporary directory while the server watched the user's own, and
 * answered that nothing was running while something was.
 */
export function readRunRecord(projectPath: string): RunRecord | null {
  for (const directory of runtimeDirectories()) {
    const own = recordAt(runRecordPath(projectPath, directory));
    if (own !== null) {
      return own;
    }
    const shared = recordAt(join(directory, 'runs', SHARED_NOTE));
    if (shared !== null && shared.projectPath !== '' && isSameDirectory(shared.projectPath, projectPath)) {
      return shared;
    }
  }
  return null;
}

/** Every run note on the machine, whichever project it is for, newest first. */
export function everyRunRecord(): RunRecord[] {
  const found: RunRecord[] = [];
  for (const directory of runtimeDirectories()) {
    let entries: string[];
    try {
      entries = readdirSync(join(directory, 'runs'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === SHARED_NOTE || (entry.startsWith('note-') && entry.endsWith('.json'))) {
        const record = recordAt(join(directory, 'runs', entry));
        if (record !== null) {
          found.push(record);
        }
      }
    }
  }
  return found.sort((one, other) => other.startedAt - one.startedAt);
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
    ...(typeof fields['exitSignal'] === 'string' ? { exitSignal: fields['exitSignal'] } : {}),
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
 *
 * Asked of `netstat` on Windows rather than of PowerShell's Get-NetTCPConnection, which loads a
 * module before it answers: a second on this machine and nine on a loaded runner, all of it
 * spent inside a synchronous call that holds every other request while it runs. A start through
 * the editor asks this once, before the play, and a fixture read that second as the announce wait
 * sitting out its budget. netstat answers in tens of milliseconds and is on every Windows.
 */
export function listeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      return listeningPidInNetstat(
        execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15_000 }),
        port,
      );
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
 * The pid holding [param port] open for listening in [param printed], as `netstat -ano` prints
 * the table: protocol, local address, foreign address, state, pid, on IPv4 and on IPv6 alike,
 * with the port after the last colon of the address. Null when no line says so.
 */
export function listeningPidInNetstat(printed: string, port: number): number | null {
  for (const line of printed.split(/\r?\n/)) {
    const fields = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (fields === null) {
      continue;
    }
    const local = fields[1] ?? '';
    if (Number(local.slice(local.lastIndexOf(':') + 1)) === port) {
      return Number(fields[2]);
    }
  }
  return null;
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
        `${POWERSHELL_UTF8}$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o"); $p.CommandLine }`,
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
 * The record is written from the same call that spawned the engine, so the two differ by the spawn
 * itself. What this has to absorb is that latency on a loaded machine and the second-resolution the
 * platforms answer a start time with, and nothing else.
 *
 * Wide is the dangerous direction, which is not obvious: a recycled number has to wait for the first
 * process to exit, so the gap it leaves is the run's whole length, and a wide window is blind to
 * every run shorter than it. A gate elsewhere runs sixteen engines at once, and a five-second run
 * whose number is taken ten seconds later would have passed a window measured in minutes. The case
 * this is for is short runs on a busy machine, which is the one it would have missed.
 */
const SAME_RUN_WINDOW_MS = 10_000;

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
  // Asked of both callers, unlike everything below. The weaker question is weaker because an image
  // name is not enough to tell two engines apart, not because picking a run back up deserves less
  // care: this is not a guess that leans one way, it is a process that cannot be the one recorded.
  // Left out of it, a worker holding a recycled number is adopted and reported as the run still
  // going, which is the answer this project is asked to trust above every other.
  //
  // The cost is a clock stepped backwards by more than the window between the note being written
  // and the process being asked about, which would read a live run as finished. Remote against an
  // adjustment of that size, and the alternative is a stale yes on every fan-out.
  if (running.startedAt !== undefined && running.startedAt - record.startedAt > SAME_RUN_WINDOW_MS) {
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
  // too weak to kill on. Read as the engine reads them, so a game given `-e` as one of its own
  // arguments is not taken for an editor and left running by every stop.
  if (running.kind === 'commandLine' && readCommandLine(running.text).editor) {
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

/** Whether [param pid] is still the game that announced itself for [param projectPath]: see `judgeAnnouncedGame`. */
export function stillTheAnnouncedGame(
  pid: number,
  projectPath: string,
  announcedAt: number,
): CommandLineRead | null {
  return judgeAnnouncedGame(runningAs(pid), projectPath, announcedAt);
}

/**
 * The comparison for a game no note names, which a stop is asked to end by its number: what the
 * operating system says about the process, the project the game announced itself for, and when it
 * did. The reading of its command line when it is that game, null when it is not or cannot be told.
 *
 * Stricter than `judgeRun`, because there is no record of how the game was started to hold it to.
 * The whole command line has to be readable and be this project's engine run: `--path` on the
 * project and no editor flag, read as the engine reads them. The process has to have started
 * before its announcement was written, since a game announces from its first frames and a number
 * taken after that is somebody else's; and a platform that will not say when it started is not
 * taken as having said yes.
 */
export function judgeAnnouncedGame(
  running: RunningAs | null,
  projectPath: string,
  announcedAt: number,
): CommandLineRead | null {
  if (running?.kind !== 'commandLine' || running.startedAt === undefined) {
    return null;
  }
  if (running.startedAt - announcedAt > STARTED_AFTER_ANNOUNCING_MS) {
    return null;
  }
  const read = readCommandLine(running.text);
  if (read.editor || read.projectPath === null || !isSameDirectory(read.projectPath, projectPath)) {
    return null;
  }
  return read;
}

/**
 * Take [param projectPath]'s note away for a run that has ended, wherever it was left.
 *
 * Every candidate directory is looked in, for the same reason they are read. The note every project
 * shared before notes were per project is taken away only when it names this project, since another
 * project's run may be the one it describes.
 */
export function clearRunRecord(projectPath: string): void {
  for (const directory of runtimeDirectories()) {
    const shared = join(directory, 'runs', SHARED_NOTE);
    const sharedRecord = recordAt(shared);
    const ours =
      sharedRecord !== null &&
      sharedRecord.projectPath !== '' &&
      isSameDirectory(sharedRecord.projectPath, projectPath);
    for (const path of [runRecordPath(projectPath, directory), ...(ours ? [shared] : [])]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Held open for a moment, which leaves it for the next clear.
      }
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
 * A file per run in a directory nothing ever empties is a leak, and a run that is still going
 * cannot be the one deleted, so the keep-alive is the notes rather than a guess: whatever any
 * project's note names is left alone whatever its age.
 */
export function sweepTranscripts(keepMs = 24 * 60 * 60 * 1000, now = Date.now()): void {
  const directory = runsDirectory();
  const kept = new Set(everyRunRecord().map((record) => record.transcript));
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
    if (kept.has(path) || ageMs(path, now) < keepMs) {
      continue;
    }
    try {
      rmSync(path);
    } catch {
      // A transcript still held open somewhere, which the next sweep will get.
    }
  }
}
