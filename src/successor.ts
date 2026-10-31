import { readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { linuxStartEarliest, linuxStartTimes, readCommandLine } from './process-children.js';
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
 * near the end of its teardown, once the scene tree is gone: measured on 4.7.2 at 51ms before the exit
 * reached the game's parent. The rest is room for a loaded machine. A worker the game started for
 * itself is older than this, unless the game started it in its last moments, and then it is one of
 * two candidates and neither is taken.
 */
export const RESTARTED_WITHIN_MS = 2000;

/** Long enough for the operating system to list a process's children on a machine that is busy. */
const LIST_WITHIN_MS = 15_000;

/** How often the end of a successor is looked for where nothing can wait on it. */
const POLL_MS = 250;

/** A process listed as a candidate for the one a game restarted itself into. */
export interface ListedSuccessor {
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
      fold(readCommandLine(one.command).executable) === wanted &&
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
): Promise<Followed | null> {
  if (process.platform === 'win32') {
    return await followOnWindows(exitedPid, engine, notBefore, exitedAt);
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
  let printed: string;
  try {
    // In the C locale, since lstart is a date in words and the words are the ones Date.parse reads.
    ({ stdout: printed } = await runHidden('ps', ['-e', '-o', linux ? 'pid=,args=' : 'pid=,lstart=,args='], {
      timeout: LIST_WITHIN_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch {
    return null;
  }
  const listed: ListedSuccessor[] = [];
  if (linux) {
    const commands = new Map<number, string>();
    for (const line of printed.split('\n')) {
      const fields = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (fields?.[1] !== undefined) {
        commands.set(Number(fields[1]), (fields[2] ?? '').trim());
      }
    }
    for (const [pid, startedAt] of await linuxStartTimes([...commands.keys()])) {
      listed.push({ pid, startedAt, command: commands.get(pid) ?? '' });
    }
  } else {
    for (const line of printed.split('\n')) {
      const fields = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
      const startedAt = Date.parse(fields?.[2] ?? '');
      if (fields?.[1] !== undefined && !Number.isNaN(startedAt)) {
        listed.push({ pid: Number(fields[1]), startedAt, command: (fields[3] ?? '').trim() });
      }
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
