import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Long enough for the operating system to list every process on a machine that is busy. A stop
 * that asked for the children waits on this once, before the run is ended.
 */
const ASK_TIMEOUT_MS = 15_000;

/** Every process the operating system lists right now, by its parent. */
export type ProcessTree = ReadonlyMap<number, number>;

/**
 * The whole process table as parent links, taken in one ask.
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
    const tree = new Map<number, number>();
    for (const line of printed.split(/\r?\n/)) {
      const [pid, parent] = line
        .trim()
        .split(/[\s,]+/)
        .map((field) => Number(field));
      if (
        pid !== undefined &&
        parent !== undefined &&
        Number.isInteger(pid) &&
        Number.isInteger(parent) &&
        pid > 0
      ) {
        tree.set(pid, parent);
      }
    }
    return tree;
  } catch {
    return undefined;
  }
}

/** The processes whose parent is [param pid], as [param tree] has them. */
function childrenIn(tree: ProcessTree, pid: number): number[] {
  const children: number[] = [];
  for (const [child, parent] of tree) {
    if (parent === pid) {
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

/** The processes whose parent is [param pid] right now, or undefined when the platform will not say. */
export async function childrenOf(pid: number): Promise<number[] | undefined> {
  const tree = await processTree();
  return tree === undefined ? undefined : childrenIn(tree, pid);
}

async function askWindows(): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { timeout: ASK_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

async function askPosix(): Promise<string> {
  const { stdout } = await run('ps', ['-e', '-o', 'pid=,ppid='], {
    timeout: ASK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
