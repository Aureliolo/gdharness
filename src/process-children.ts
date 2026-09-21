import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
    const printed = process.platform === 'win32' ? await askWindows() : await askPosix();
    return parseProcessTable(printed);
  } catch {
    return undefined;
  }
}

/** [param printed] as `pid ppid command...` per line, into a tree. Lines that are not that are skipped. */
export function parseProcessTable(printed: string): ProcessTree {
  const tree = new Map<number, ListedProcess>();
  for (const line of printed.split(/\r?\n/)) {
    const fields = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (fields === null) {
      continue;
    }
    const pid = Number(fields[1]);
    const parent = Number(fields[2]);
    if (pid > 0) {
      tree.set(pid, { parent, command: (fields[3] ?? '').trim() });
    }
  }
  return tree;
}

/** The processes whose parent is [param pid], as [param tree] has them. */
function childrenIn(tree: ProcessTree, pid: number): number[] {
  const children: number[] = [];
  for (const [child, listed] of tree) {
    if (listed.parent === pid) {
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
  let parent = tree.get(pid)?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    chain.push(parent);
    if (parent === root) {
      break;
    }
    seen.add(parent);
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
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
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
