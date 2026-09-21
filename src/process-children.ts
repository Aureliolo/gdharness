import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Long enough for the operating system to list one process's children on a machine that is busy.
 * A stop that asked for the children waits on this once, before the run is ended.
 */
const ASK_TIMEOUT_MS = 15_000;

/**
 * The processes whose parent is [param pid], as the operating system lists them right now.
 *
 * A game that fans out to workers with OS.create_process is their parent for as long as it lives,
 * and only that long: ending it reparents them, to init on POSIX, so the list has to be taken
 * while the parent is still there. Asked of the operating system rather than of the announcements,
 * because being a game of the project is what a stranger's bench also is, and being this run's
 * child is the property a stranger's bench cannot have.
 *
 * Empty when the platform will not say, which the caller reports rather than reads as "none".
 */
export async function childrenOf(pid: number): Promise<number[] | undefined> {
  try {
    const printed = process.platform === 'win32' ? await askWindows(pid) : await askPosix(pid);
    return printed
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch (error) {
    // pgrep exits 1 for "no process matched", which is an answer rather than a refusal.
    if (process.platform !== 'win32' && (error as { code?: unknown }).code === 1) {
      return [];
    }
    return undefined;
  }
}

async function askWindows(pid: number): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`,
    ],
    { timeout: ASK_TIMEOUT_MS, windowsHide: true },
  );
  return stdout;
}

async function askPosix(pid: number): Promise<string> {
  const { stdout } = await run('pgrep', ['-P', String(pid)], { timeout: ASK_TIMEOUT_MS });
  return stdout;
}
