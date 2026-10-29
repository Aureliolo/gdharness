import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isSameDirectory } from './paths.js';
import { runHidden as run } from './spawn.js';
import { askWindows, WindowsAskFailure } from './windows-ask.js';

/**
 * When each of [param pids] started, as milliseconds, for the ones the platform will say.
 *
 * One question for all of them, because a bench that fans out announces a game per worker, and on
 * Windows each question is a query of its own. A pid left out of the answer is one the platform
 * would not say about, which is not the same as one that has gone and is never read as it.
 */
export async function startTimesOf(pids: readonly number[]): Promise<Map<number, number>> {
  const began = new Map<number, number>();
  if (pids.length === 0) {
    return began;
  }
  try {
    if (process.platform === 'win32') {
      const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
      const said = await askWindows(
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`,
        ASK_TIMEOUT_MS,
      );
      for (const line of said.split('\n')) {
        const found = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (found?.[1] !== undefined && found[2] !== undefined) {
          began.set(Number(found[1]), Number(found[2]));
        }
      }
      return began;
    }
    if (process.platform === 'linux') {
      return await linuxStartTimes(pids);
    }
    // Read whatever ps printed rather than its exit status: a pid among these that has gone makes
    // ps exit non-zero after printing the rest, and the rest is the answer. In the C locale, since
    // lstart is a date in words and the words are the ones Date.parse reads.
    const said = await printedBy('ps', ['-p', pids.join(','), '-o', 'pid=,lstart='], {
      ...process.env,
      LC_ALL: 'C',
    });
    for (const line of said.split('\n')) {
      const found = /^\s*(\d+)\s+(.+)$/.exec(line);
      const at = Date.parse(found?.[2]?.trim() ?? '');
      if (found?.[1] !== undefined && !Number.isNaN(at)) {
        began.set(Number(found[1]), at);
      }
    }
  } catch {
    // The platform would not say, which the empty map is.
  }
  return began;
}

/**
 * When each of [param pids] started, on Linux, as milliseconds, for the ones whose entry under /proc
 * can be read: the boot time the kernel gives in whole seconds, plus the start in ticks after it, as
 * psutil's create_time() reads it.
 *
 * Never late, and early by up to a second for the boot time's cut and a tick for the start's, as
 * [method linuxStartEarliest] answers; a CI runner dated one 1008 ms early. The same number in every
 * process that asks, since the boot time is the kernel's. `ps -o lstart` adds the same two and then
 * cuts the sum to the second,
 * up to two seconds early: on a CI runner the process a game restarted itself into was dated before
 * the run that made it had begun, past the second a comparison allows, and refused as older than the
 * run. A boot instant worked out as now less the uptime is finer, but each process works out its own
 * a few milliseconds apart, and a start one server noted and another compares has to be one number.
 */
export async function linuxStartTimes(pids: readonly number[]): Promise<Map<number, number>> {
  const began = new Map<number, number>();
  const hertz = await ticksPerSecond();
  let booted: number;
  try {
    booted = Number(/^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1] ?? Number.NaN) * 1000;
  } catch {
    return began;
  }
  if (hertz === null || Number.isNaN(booted)) {
    return began;
  }
  for (const pid of pids) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    } catch {
      continue;
    }
    // After the name, which is in brackets and can hold spaces and brackets of its own; the start is
    // the twenty-second field, and the state after the name the third.
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    if (Number.isInteger(ticks) && ticks >= 0) {
      began.set(pid, booted + Math.round((ticks * 1000) / hertz));
    }
  }
  return began;
}

/**
 * The most [method linuxStartTimes] can date a start early, in milliseconds: just under a second
 * for the boot time, cut to the second, and just under a tick for the start, cut to the tick.
 */
export async function linuxStartEarliest(): Promise<number> {
  return 1000 + Math.ceil(1000 / ((await ticksPerSecond()) ?? 100));
}

let ticksAnswered: number | undefined;

/** The ticks a second /proc counts starts in, asked once it has been answered. */
async function ticksPerSecond(): Promise<number | null> {
  if (ticksAnswered !== undefined) {
    return ticksAnswered;
  }
  try {
    const hertz = Number((await run('getconf', ['CLK_TCK'], { timeout: ASK_TIMEOUT_MS })).stdout.trim());
    if (Number.isInteger(hertz) && hertz > 0) {
      ticksAnswered = hertz;
      return hertz;
    }
  } catch {
    // Not answered, which is asked again next time.
  }
  return null;
}

/** What [param command] printed to stdout, whatever it exited with. */
function printedBy(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return run(command, args, { timeout: ASK_TIMEOUT_MS, env }).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      const printed = (error as { stdout?: unknown }).stdout;
      return typeof printed === 'string' ? printed : '';
    },
  );
}

/**
 * Long enough for the operating system to list every process on a machine that is busy. A stop
 * that asked for the children waits on this once, before the run is ended.
 */
const ASK_TIMEOUT_MS = 15_000;

/** One process as the operating system lists it: whose child it is, and what it was started as. */
interface ListedProcess {
  readonly parent: number;
  /** The whole command line, or empty where the platform will not show it. */
  readonly command: string;
  /** When it started, as milliseconds, where the platform lists that with the rest. */
  readonly startedAt?: number;
}

/** Every process the operating system lists right now, by pid. */
export type ProcessTree = ReadonlyMap<number, ListedProcess>;

/**
 * The whole process table, taken in one ask: parent links and command lines.
 *
 * Asked of the operating system rather than of the announcements, because being a game of the
 * project is what a stranger's bench also is, and being under this run's process is the property a
 * stranger's bench cannot have. One ask rather than one per process, because a bench with thirty
 * workers is thirty children and on Windows every ask is a query of its own. Undefined when the
 * platform will not say, which the caller reports rather than reads as an empty machine.
 */
export async function processTree(): Promise<ProcessTree | undefined> {
  try {
    const tree =
      process.platform === 'win32'
        ? parseProcessTable(await listWindows(), true)
        : parseProcessTable(await askPosix());
    lastListingFailure = undefined;
    return tree;
  } catch (error) {
    lastListingFailure = listingFailure(error);
    return undefined;
  }
}

let lastListingFailure: string | undefined;

/**
 * What stopped a listing, as one clause naming what was asked and how it failed: not answered in
 * time, the helper gone, refused, killed at the budget, ended by a signal, or exited with a code and
 * a line on stderr. The error's own message was "Command failed:" and the command, which a timeout
 * and a query the system refused both produce, so a failure on a busy machine could not be put down
 * to either.
 */
export function listingFailure(error: unknown): string {
  if (error instanceof WindowsAskFailure) {
    return error.message;
  }
  if (!(error instanceof Error)) {
    return String(error);
  }
  const failed = error as Error & {
    cmd?: string;
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    stderr?: unknown;
  };
  const how =
    failed.killed === true
      ? `was killed after the ${ASK_TIMEOUT_MS}ms budget${failed.signal ? ` (${failed.signal})` : ''}`
      : failed.signal
        ? `was ended by ${failed.signal}`
        : failed.code !== undefined && failed.code !== null
          ? `exited with ${failed.code}`
          : 'failed';
  const said = typeof failed.stderr === 'string' ? failed.stderr.trim() : '';
  const asked = basename((failed.cmd ?? '').split(' ')[0] ?? '') || 'the listing';
  return `${asked} ${how}${said === '' ? ', with nothing on stderr' : `; stderr: ${said.slice(0, 400)}`}`;
}

/**
 * Why the last [method processTree] came back empty, or undefined when it did not. Kept because an
 * answer of "the platform would not list its processes" with nothing behind it left a failure on a
 * loaded runner with no way to tell a timeout from a refusal.
 */
export function whyTheProcessTreeFailed(): string | undefined {
  return lastListingFailure;
}

/**
 * [param printed] as `pid ppid command...` per line, into a tree, or as `pid ppid started
 * command...` when [param started] says the third column is when each process began. Lines that
 * are not that are skipped.
 */
export function parseProcessTable(printed: string, started = false): ProcessTree {
  const tree = new Map<number, ListedProcess>();
  for (const line of printed.split(/\r?\n/)) {
    const fields = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (fields === null) {
      continue;
    }
    const pid = Number(fields[1]);
    const parent = Number(fields[2]);
    const rest = (fields[3] ?? '').trim();
    if (pid <= 0) {
      continue;
    }
    if (!started) {
      tree.set(pid, { parent, command: rest });
      continue;
    }
    const timed = /^(\d+)(?:\s+(.*))?$/.exec(rest);
    if (timed === null) {
      continue;
    }
    // Zero is a process the system would not date, which is judged as if no time were listed.
    const began = Number(timed[1]);
    tree.set(pid, { parent, command: (timed[2] ?? '').trim(), ...(began > 0 ? { startedAt: began } : {}) });
  }
  return tree;
}

/**
 * Whether [param child]'s link to [param parent] in [param tree] is to the process that started
 * it, rather than to a number that process left behind.
 *
 * Windows keeps a dead parent's number on its orphans, and hands the number out again: a bench
 * started on a runner that had just run a suite was listed with four children it never opened,
 * left there by whatever had held its number before, and a stop asked to end its workers named
 * them as processes it could not account for. A child cannot have started before its parent, so a
 * link to a parent that began later is to the number and not to the process. Only judged where
 * the listing says when each began; POSIX hands an orphan to init the moment its parent goes, so
 * its links are never stale and its listing carries no times.
 *
 * A parent that has gone is not listed, so its start is [param since] when the caller knows it: a
 * run's game is asked about after it ended, and without a start to hold them against, the orphans
 * of an earlier holder of its number were listed as the run's, which they had been refused as
 * while it lived.
 */
function linked(tree: ProcessTree, child: number, parent: number, since?: number): boolean {
  const from = tree.get(child);
  const began = tree.get(parent)?.startedAt ?? since;
  if (from === undefined || from.parent !== parent) {
    return false;
  }
  if (from.startedAt === undefined || began === undefined) {
    return true;
  }
  return from.startedAt >= began;
}

/**
 * Whether [param listed] is the console host Windows starts for a console program given a console
 * with no window, which is how every process here is started. It is listed as that program's child,
 * but it is the program's console rather than anything the program started, and it ends with the
 * last process using it: a stop that named one as a child left running, or ended it, would be wrong
 * about what the run had started. Known by its path in the system directory rather than its name,
 * since anything can be called conhost.exe.
 */
function isConsoleHost(listed: ListedProcess): boolean {
  const executable = commandWords(listed.command)[0];
  if (executable === undefined) {
    return false;
  }
  const host = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\conhost.exe`;
  return (
    executable
      .replace(/^\\\?\?\\/, '')
      .replaceAll('/', '\\')
      .toLowerCase() === host.toLowerCase()
  );
}

/**
 * The processes whose parent is [param pid], as [param tree] has them, console hosts aside, with
 * [param since] as [method linked] takes it.
 */
function childrenIn(tree: ProcessTree, pid: number, since?: number): number[] {
  const children: number[] = [];
  for (const [child, listed] of tree) {
    if (linked(tree, child, pid, since) && !isConsoleHost(listed)) {
      children.push(child);
    }
  }
  return children;
}

/**
 * Every process under [param pid], to any depth, nearest first.
 *
 * A game that fans out with OS.create_process is its workers' parent, and only for as long as it
 * lives: ending it reparents them, to init on POSIX, so the tree has to be read while the parent
 * is still there. To any depth because the process a run holds is not always the game: a console
 * wrapper on Windows starts the engine as its child, and the engine's workers are the wrapper's
 * grandchildren. [param since] is when [param pid] began, for when it may have gone; every process
 * below it was found listed, with its own start.
 */
export function descendantsIn(tree: ProcessTree, pid: number, since?: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    for (const child of childrenIn(tree, next, next === pid ? since : undefined)) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/**
 * The processes between [param pid] and [param root] in [param tree], nearest first, [param root]
 * itself included when it is reached and neither end otherwise. A chain that leaves the tree or
 * loops ends where it does.
 */
export function ancestorsIn(tree: ProcessTree, pid: number, root: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let child = pid;
  let parent = tree.get(pid)?.parent;
  while (parent !== undefined && !seen.has(parent) && linked(tree, child, parent)) {
    chain.push(parent);
    if (parent === root) {
      break;
    }
    seen.add(parent);
    child = parent;
    parent = tree.get(parent)?.parent;
  }
  return chain;
}

/**
 * The processes whose parent is [param pid] right now, or undefined when the platform will not say,
 * with [param since] as [method descendantsIn] takes it.
 */
export async function childrenOf(pid: number, since?: number): Promise<number[] | undefined> {
  const tree = await processTree();
  return tree === undefined ? undefined : childrenIn(tree, pid, since);
}

/** What a command line says a process is: the executable it runs and the project it was pointed at. */
export interface CommandLineRead {
  /** The executable's own name, without its directory. Empty when the line is. */
  readonly executable: string;
  /** What followed `--path`, or null when nothing did. */
  readonly projectPath: string | null;
  /** Whether the line asks for the editor, which a game is never given. */
  readonly editor: boolean;
  /**
   * The option that makes this run one job that quits, such as `--import`, or null when it has
   * none. Such a run loads the editor and its plugins, plays nothing and is nobody's editor.
   */
  readonly oneShot: string | null;
}

/**
 * The engine's options that make a run do one job and quit: import, export, write documentation,
 * run a script, convert, dump or validate an API, or load and quit. An editor plugin is handed none
 * of them (OS.get_cmdline_args() answered ["--editor"] under --import and under --quit-after alike,
 * measured on 4.7.2), so whether a run that connects is an editor is read here from its command line.
 */
const ONE_SHOT_OPTIONS: readonly string[] = [
  '--import',
  '--quit',
  '--quit-after',
  '--export-release',
  '--export-debug',
  '--export-pack',
  '--export-patch',
  '--doctool',
  '--gdscript-docs',
  '--script',
  '-s',
  '--check-only',
  '--build-solutions',
  '--dump-gdextension-interface',
  '--dump-extension-api',
  '--dump-extension-api-with-docs',
  '--validate-extension-api',
  '--convert-3to4',
  '--validate-conversion-3to4',
];

/**
 * Godot's Windows console build, by name: `X_console.exe` is a wrapper that starts `X.exe` beside
 * it as its child and forwards the console to it, so the wrapper is never the game.
 */
export const CONSOLE_WRAPPER = /_console(\.exe)?$/i;

/**
 * The editors of [param projectPath] in [param tree], read off their command lines: a Godot
 * executable given `--path` on the project and the editor flag, without an option that makes it
 * one job that quits, and not the console wrapper, which forwards to an editor listed beside it.
 *
 * Read from the process table because an editor that has not reached the bridge yet is known to
 * nothing else. A restart interrupted by a reconnect launched one and its server was ended before
 * it connected; the next server, seeing nothing connected and no restart owed, opened a second on
 * the same project and the same language server port.
 */
export function editorsOfProjectIn(tree: ProcessTree, projectPath: string): number[] {
  const found: number[] = [];
  for (const [pid, listed] of tree) {
    const read = readCommandLine(listed.command);
    if (
      read.editor &&
      read.oneShot === null &&
      read.projectPath !== null &&
      /godot/i.test(read.executable) &&
      !CONSOLE_WRAPPER.test(read.executable) &&
      isSameDirectory(read.projectPath, projectPath)
    ) {
      found.push(pid);
    }
  }
  return found.sort((a, b) => a - b);
}

/**
 * [param command] read the way the engine reads its own: the executable first, then `--path` and
 * the directory after it. Quoted where the platform quotes, which Windows does and `ps` does not,
 * so a directory with spaces in it is taken up to the next argument-shaped word rather than the
 * next space, and a quoted one as far as its closing quote.
 *
 * Only as far as the first `--` or `++`, because the engine passes everything after either to the
 * game and reads none of it: a game given `-e` there is not an editor, and one given `--path` is
 * not pointed anywhere. And with `%20` read as a space, which is how the editor writes a project path with
 * spaces in it onto the game it plays, and how the engine reads it back.
 */
export function readCommandLine(command: string): CommandLineRead {
  const all = commandWords(command);
  const separator = all.findIndex((word) => word === '--' || word === '++');
  const words = separator === -1 ? all : all.slice(0, separator);
  const executable = words[0] === undefined ? '' : basename(words[0].replaceAll('\\', '/'));
  const at = words.indexOf('--path');
  let projectPath: string | null = null;
  if (at !== -1 && at + 1 < words.length) {
    const taken: string[] = [];
    for (const word of words.slice(at + 1)) {
      if (taken.length > 0 && (word.startsWith('-') || /^[a-z]+:\/\//.test(word))) {
        break;
      }
      taken.push(word);
    }
    projectPath = taken.join(' ').replaceAll('%20', ' ');
  }
  return {
    executable,
    projectPath,
    editor: words.some((word) => word === '-e' || word === '--editor'),
    oneShot: words.find((word) => ONE_SHOT_OPTIONS.includes(word)) ?? null,
  };
}

/**
 * The option that makes process [param pid] one job that quits, null when its command line has
 * none, or undefined when the platform would not say or no such process is listed. Read when an
 * editor connects without a server's mark, to tell a gate's import from somebody's editor.
 */
export async function oneShotOptionOf(pid: number): Promise<string | null | undefined> {
  const tree = await processTree();
  const listed = tree?.get(pid);
  if (listed === undefined || listed.command === '') {
    return undefined;
  }
  return readCommandLine(listed.command).oneShot;
}

/** [param command] split into its words, with double quotes grouping and removed. */
function commandWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (started) {
    words.push(word);
  }
  return words;
}

function listWindows(): Promise<string> {
  return askWindows(
    // The start beside the parent link, because the link alone is not to be believed on Windows:
    // see `linked`. Zero for the few processes the system will not date. Only the four properties
    // read below: the whole object takes the query about twice as long.
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object { $began = 0; if ($_.CreationDate) { $began = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "$($_.ProcessId) $($_.ParentProcessId) $began $($_.CommandLine)" }',
    ASK_TIMEOUT_MS,
  );
}

async function askPosix(): Promise<string> {
  const { stdout } = await run('ps', ['-e', '-o', 'pid=,ppid=,args='], {
    timeout: ASK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
