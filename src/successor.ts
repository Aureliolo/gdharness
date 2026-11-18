import { readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { linuxStartEarliest, processTree, startTimesOf } from './process-children.js';
import { loadingTheTable } from './process-table.js';
import { runHidden, spawnHidden } from './spawn.js';

/**
 * The process a game restarts itself into with `OS.set_restart_on_exit`, found and followed by the
 * keeper holding the run once the game has exited, since nothing says beforehand that it will.
 *
 * The run is one run to whoever started it: a game switching its renderer at its next start is the
 * same game. Left untracked, the successor was reported as a run over with a clean exit, and no stop
 * could reach it.
 */

/**
 * How long before a game's exit the process it restarts itself into is started. The engine starts it
 * near the end of its teardown, once the scene tree is gone: measured on 4.7.2 at 25 to 50ms before the
 * kernel ended the game, where the keeper's sighting of that exit came up to two seconds later. The
 * rest is room for a loaded machine. A worker the game started for
 * itself is older than this, unless the game started it in its last moments, and then it is one of
 * two candidates and neither is taken.
 */
export const RESTARTED_WITHIN_MS = 2000;

/** Long enough for the operating system to list a process's children on a machine that is busy. */
const LIST_WITHIN_MS = 15_000;

/** How long after the keeper sees a game exit its kernel exit time is waited for. */
const EXIT_TIME_WITHIN_MS = 5000;

/** A game's own exit time, held open while it runs. */
export interface ExitWatch {
  /**
   * When the kernel ended the game, or [param seenAt] where that was not told in time or is not
   * before it. The keeper sees an exit when its own event loop gets to it, which a loaded machine
   * puts seconds after the successor started, so a window measured back from the sighting refused
   * it. Windows only: elsewhere the sighting is the only date there is.
   */
  endedBy(seenAt: number): Promise<number>;
}

/**
 * The kernel's exit time [param told] gives, when it comes within [param withinMs] and falls
 * between [param spawnedAt] and [param seenAt], and [param seenAt] otherwise. A date outside those
 * is another process's under a number handed on, or a sighting that came before the exit.
 */
export async function exitDateOf(
  told: Promise<number | null>,
  spawnedAt: number,
  seenAt: number,
  withinMs = EXIT_TIME_WITHIN_MS,
): Promise<number> {
  const at = await Promise.race([told, delay(withinMs, null, { ref: false })]);
  return at !== null && at >= spawnedAt && at <= seenAt ? at : seenAt;
}

/**
 * Starts holding [param pid], a game started at [param spawnedAt], to read when it ends. A game
 * that has ended before the holder is up is not told, and its sighting stands.
 */
export function watchExit(pid: number, spawnedAt: number): ExitWatch {
  if (process.platform !== 'win32') {
    return { endedBy: (seenAt) => Promise.resolve(seenAt) };
  }
  const told = (async (): Promise<number | null> => {
    let loading: string;
    try {
      loading = await loadingTheTable();
    } catch {
      return null;
    }
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      loading,
      `[Console]::Out.Write([GdhProcessTable]::ExitTimeOf(${String(pid)}, ${String(spawnedAt - 1000)}))`,
    ].join('\n');
    const started = spawnHidden(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let said = '';
    started.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => {
      started.once('close', () => {
        resolve();
      });
      started.once('error', () => {
        resolve();
      });
    });
    return /^\d+$/.test(said.trim()) ? Number(said.trim()) : null;
  })();
  return { endedBy: (seenAt) => exitDateOf(told, spawnedAt, seenAt) };
}

/** How often the end of a successor is looked for where nothing can wait on it. */
const POLL_MS = 250;

/** A process listed as a candidate for the one a game restarted itself into. */
interface ListedSuccessor {
  readonly pid: number;
  /** When it started, in milliseconds. Up to a second early on POSIX, which dates no finer. */
  readonly startedAt: number;
  readonly command: string;
}

/** A successor found, and how it ended: its exit code where the platform tells one, null otherwise. */
export interface Followed {
  readonly successor: ListedSuccessor;
  readonly ended: Promise<{ readonly code: number | null }>;
}

/**
 * The file name of the program [param command] runs. `ps` prints no quotes, so a folder with a space
 * in it, as Steam's `Godot Engine` is, runs on until the first option rather than to the first space.
 */
function executableOf(command: string): string {
  const quoted = /^"([^"]*)"/.exec(command);
  const program = quoted?.[1] ?? command.split(/\s+-/, 1)[0] ?? command;
  return basename(program.trim().replaceAll('\\', '/'));
}

/**
 * The one process in [param listed] that [param exitedPid] restarted itself into as it exited, or
 * null when there is not exactly one: the engine [param engine] run again, started after
 * [param notBefore] (before the exited process existed, a number its orphans kept is not a link to
 * it) and no earlier than [param RESTARTED_WITHIN_MS] before [param exitedAt]. [param early] is how
 * many milliseconds the listing can date a start before it happened: none for one read to the
 * instant, a second for one cut to the second, and a second and a tick for Linux's.
 */
export function successorAmong(
  listed: readonly ListedSuccessor[],
  exitedPid: number,
  engine: string,
  notBefore: number,
  exitedAt: number,
  early: number,
): ListedSuccessor | null {
  const fold = (name: string): string => (process.platform === 'win32' ? name.toLowerCase() : name);
  const wanted = fold(basename(engine.replaceAll('\\', '/')));
  const found = listed.filter(
    (one) =>
      one.pid !== exitedPid &&
      fold(executableOf(one.command)) === wanted &&
      one.startedAt + early >= notBefore &&
      one.startedAt + early >= exitedAt - RESTARTED_WITHIN_MS,
  );
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * The process [param exitedPid], a game of [param engine] started no earlier than
 * [param notBefore], restarted itself into as it exited at [param exitedAt], followed until it ends,
 * or null when it restarted into none, or the platform would not list its processes.
 *
 * On Windows the successor still names the exited process as its parent, and Windows tells an exit
 * code to whoever holds a handle to the process. So one PowerShell lists the children and opens a
 * handle to each as it lists it, which also keeps their numbers from going to anything else, then
 * waits on the one chosen. Opened only once each process's start matches the one listed, since a
 * number can be handed on between the two. A successor that a separate process opened afterwards
 * had often gone by then, and its code with it.
 *
 * On POSIX it is handed to init as its parent goes, and the engine starts it in a session of its
 * own, so neither its parent nor its process group leads back to the game. What it keeps is the
 * output it inherited, which is [param transcript], a file opened for this run alone. Without one
 * nothing ties a process to this run, and an engine somebody else started in the same moment would
 * be taken for it. Only the parent is told an exit code there, and that is init by now, so it is
 * watched until it has gone.
 */
export async function followSuccessor(
  exitedPid: number,
  engine: string,
  notBefore: number,
  exitedAt: number,
  transcript: string | undefined,
  watch?: ExitWatch,
): Promise<Followed | null> {
  if (process.platform === 'win32') {
    return await followOnWindows(
      exitedPid,
      engine,
      notBefore,
      watch === undefined ? exitedAt : await watch.endedBy(exitedAt),
    );
  }
  return transcript === undefined
    ? null
    : await followOnPosix(exitedPid, engine, notBefore, exitedAt, transcript);
}

async function followOnWindows(
  exitedPid: number,
  engine: string,
  notBefore: number,
  exitedAt: number,
): Promise<Followed | null> {
  let loading: string;
  try {
    loading = await loadingTheTable();
  } catch {
    return null;
  }
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    loading,
    `[Console]::Out.Write([GdhProcessTable]::HoldChildren(${exitedPid}))`,
    "'listed'",
    '$chosen = [Console]::In.ReadLine()',
    'if ($chosen) { [GdhProcessTable]::WaitFor([int]$chosen) }',
  ].join('\n');
  const holder = spawnHidden(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let said = '';
  const closed = new Promise<void>((resolve) => {
    holder.once('close', () => {
      resolve();
    });
    holder.once('error', () => {
      resolve();
    });
  });
  const listed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, LIST_WITHIN_MS);
    holder.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8');
      if (/^listed\r?$/m.test(said)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    void closed.then(() => {
      clearTimeout(timer);
      resolve(/^listed\r?$/m.test(said));
    });
  });
  if (!listed) {
    holder.kill();
    return null;
  }
  const candidates: ListedSuccessor[] = [];
  for (const line of said.split(/\r?\n/)) {
    const fields = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (fields?.[1] !== undefined && fields[2] !== undefined && fields[3] !== undefined) {
      candidates.push({ pid: Number(fields[1]), startedAt: Number(fields[2]), command: fields[3].trim() });
    }
  }
  const successor = successorAmong(candidates, exitedPid, engine, notBefore, exitedAt, 0);
  holder.stdin.end(successor === null ? '\n' : `${String(successor.pid)}\n`);
  if (successor === null) {
    return null;
  }
  const ended = closed.then(() => {
    const told = /^exit (-?\d+)\r?$/m.exec(said);
    return { code: told?.[1] === undefined ? null : Number(told[1]) };
  });
  return { successor, ended };
}

async function followOnPosix(
  exitedPid: number,
  engine: string,
  notBefore: number,
  exitedAt: number,
  transcript: string,
): Promise<Followed | null> {
  // Linux dates a start from /proc, up to a second and a tick early, where its ps dates it up to two
  // seconds early. See linuxStartTimes. macOS's ps cuts it to the second.
  const linux = process.platform === 'linux';
  const early = linux ? await linuxStartEarliest() : 1000;
  const tree = await processTree();
  if (tree === undefined) {
    return null;
  }
  // Dated only for the engine's own processes, since each date is a look at another process.
  const wanted = basename(engine.replaceAll('\\', '/'));
  const runningEngine = [...tree].filter(([, one]) => executableOf(one.command) === wanted);
  const dated = await startTimesOf(runningEngine.map(([pid]) => pid));
  const listed: ListedSuccessor[] = [];
  for (const [pid, one] of runningEngine) {
    const startedAt = dated.get(pid);
    if (startedAt !== undefined) {
      listed.push({ pid, startedAt, command: one.command });
    }
  }
  // Asked of the engines that started in time only, since each answer is a look at another process.
  const timely = listed.filter(
    (one) => successorAmong([one], exitedPid, engine, notBefore, exitedAt, early) !== null,
  );
  const ours = canonical(transcript);
  const candidates: ListedSuccessor[] = [];
  for (const one of timely) {
    const writing = await outputOf(one.pid);
    if (writing !== null && canonical(writing) === ours) {
      candidates.push(one);
    }
  }
  const successor = successorAmong(candidates, exitedPid, engine, notBefore, exitedAt, early);
  if (successor === null) {
    return null;
  }
  const ended = (async () => {
    while (alive(successor.pid)) {
      await delay(POLL_MS);
    }
    return { code: null };
  })();
  return { successor, ended };
}

/** The file [param pid] writes its standard output to, or null where it cannot be read. */
async function outputOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${String(pid)}/fd/1`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await runHidden('lsof', ['-a', '-p', String(pid), '-d', '1', '-Fn'], {
      timeout: LIST_WITHIN_MS,
    });
    const named = stdout.split('\n').find((line) => line.startsWith('n'));
    return named === undefined ? null : named.slice(1);
  } catch {
    return null;
  }
}

/** [param path] with its links resolved, since macOS lists /var/folders as /private/var/folders. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
