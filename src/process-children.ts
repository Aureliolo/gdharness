import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What every PowerShell command that prints text begins with. Windows PowerShell writes a pipe
 * in the console's code page, so a command line with a character outside ASCII arrived here, read
 * as UTF-8, with that character replaced: `Müller` read as `M�ller`, and no comparison against
 * the project path or the engine path could match it. Measured on this machine, where a process
 * carries a 0x81 in its command line right now.
 */
export const POWERSHELL_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

/**
 * When each of [param pids] started, as milliseconds, for the ones the platform will say.
 *
 * One question for all of them, because the Windows answer is an interpreter start of half a
 * second and a bench that fans out announces a game per worker: asked one at a time, a sweep of
 * thirty announcements would sit for fifteen seconds before answering about any of them. A pid
 * left out of the answer is one the platform would not say about, which is not the same as one
 * that has gone and is never read as it. Synchronous, because the sweep that asks is.
 */
export function startTimesOf(pids: readonly number[]): Map<number, number> {
  const began = new Map<number, number>();
  if (pids.length === 0) {
    return began;
  }
  try {
    if (process.platform === 'win32') {
      const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
      const said = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`,
        ],
        { encoding: 'utf8', timeout: ASK_TIMEOUT_MS, windowsHide: true },
      );
      for (const line of said.split('\n')) {
        const found = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (found?.[1] !== undefined && found[2] !== undefined) {
          began.set(Number(found[1]), Number(found[2]));
        }
      }
      return began;
    }
    // Read whatever ps printed rather than its exit status: a pid among these that has gone makes
    // ps exit non-zero after printing the rest, and the rest is the answer. In the C locale, since
    // lstart is a date in words and the words are the ones Date.parse reads.
    const said = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart='], {
      encoding: 'utf8',
      timeout: ASK_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C' },
    }).stdout;
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
 * workers is thirty children and on Windows every ask is a PowerShell start. Undefined when the
 * platform will not say, which the caller reports rather than reads as an empty machine.
 */
export async function processTree(): Promise<ProcessTree | undefined> {
  try {
    if (process.platform === 'win32') {
      return parseProcessTable(await askWindows(), true);
    }
    return parseProcessTable(await askPosix());
  } catch {
    return undefined;
  }
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
 */
function linked(tree: ProcessTree, child: number, parent: number): boolean {
  const from = tree.get(child);
  const to = tree.get(parent);
  if (from === undefined || from.parent !== parent) {
    return false;
  }
  if (from.startedAt === undefined || to?.startedAt === undefined) {
    return true;
  }
  return from.startedAt >= to.startedAt;
}

/** The processes whose parent is [param pid], as [param tree] has them. */
function childrenIn(tree: ProcessTree, pid: number): number[] {
  const children: number[] = [];
  for (const child of tree.keys()) {
    if (linked(tree, child, pid)) {
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
 * grandchildren.
 */
export function descendantsIn(tree: ProcessTree, pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    for (const child of childrenIn(tree, next)) {
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

/** The processes whose parent is [param pid] right now, or undefined when the platform will not say. */
export async function childrenOf(pid: number): Promise<number[] | undefined> {
  const tree = await processTree();
  return tree === undefined ? undefined : childrenIn(tree, pid);
}

/** What a command line says a process is: the executable it runs and the project it was pointed at. */
export interface CommandLineRead {
  /** The executable's own name, without its directory. Empty when the line is. */
  readonly executable: string;
  /** What followed `--path`, or null when nothing did. */
  readonly projectPath: string | null;
  /** Whether the line asks for the editor, which a game is never given. */
  readonly editor: boolean;
}

/**
 * [param command] read the way the engine reads its own: the executable first, then `--path` and
 * the directory after it. Quoted where the platform quotes, which Windows does and `ps` does not,
 * so a directory with spaces in it is taken up to the next argument-shaped word rather than the
 * next space, and a quoted one as far as its closing quote.
 */
export function readCommandLine(command: string): CommandLineRead {
  const words = commandWords(command);
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
    projectPath = taken.join(' ');
  }
  return {
    executable,
    projectPath,
    editor: words.some((word) => word === '-e' || word === '--editor'),
  };
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

async function askWindows(): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // The start beside the parent link, because the link alone is not to be believed on
      // Windows: see `linked`. Zero for the few processes the system will not date.
      `${POWERSHELL_UTF8}Get-CimInstance Win32_Process | ForEach-Object { $began = 0; if ($_.CreationDate) { $began = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "$($_.ProcessId) $($_.ParentProcessId) $began $($_.CommandLine)" }`,
    ],
    { timeout: ASK_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

async function askPosix(): Promise<string> {
  const { stdout } = await run('ps', ['-e', '-o', 'pid=,ppid=,args='], {
    timeout: ASK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
