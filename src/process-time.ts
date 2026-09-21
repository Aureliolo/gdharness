import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Long enough for the operating system to answer about one process on a machine that is busy,
 * short enough not to hold a call that asked for the reading on purpose. On Windows the answer
 * is a PowerShell start, which a loaded machine, a bench with thirty workers grinding or a
 * shared runner, holds past two seconds: the reading was being given up on exactly when it was
 * wanted, since a machine under load is the one whose run somebody is watching for a stall.
 */
const ASK_TIMEOUT_MS = 6_000;

/**
 * Processor seconds a process has used, or undefined when the platform will not say.
 *
 * A run that is merely slow and a run that is wedged look identical from outside: both are alive,
 * both have printed nothing lately. Processor time separates them, and it was the reason a project
 * kept a shell command in its own instructions to ask what gdharness already had the pid for.
 *
 * Best effort on purpose. Every way of asking is a different program on a different platform, any
 * of them can be missing, slow or refused, and none of the answer above depends on this one: a
 * missing number is left out rather than turned into a failure.
 */
export async function cpuSecondsOf(pid: number): Promise<number | undefined> {
  try {
    return process.platform === 'win32' ? await askWindows(pid) : await askPosix(pid);
  } catch {
    return undefined;
  }
}

async function askWindows(pid: number): Promise<number | undefined> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).CPU`],
    { timeout: ASK_TIMEOUT_MS, windowsHide: true },
  );
  const seconds = Number(stdout.trim().replace(',', '.'));
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function askPosix(pid: number): Promise<number | undefined> {
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)], { timeout: ASK_TIMEOUT_MS });
  return secondsFromClock(stdout.trim());
}

/**
 * `ps` prints processor time as `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS` depending on how long it has
 * been going, so the parts are read from the right rather than the left.
 */
export function secondsFromClock(printed: string): number | undefined {
  if (printed === '') {
    return undefined;
  }
  const dashed = printed.includes('-');
  const days = dashed ? printed.slice(0, printed.indexOf('-')) : null;
  const clock = dashed ? printed.slice(printed.indexOf('-') + 1) : printed;
  const parts = clock.split(':').map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  const extra = days === null ? 0 : Number(days) * 86_400;
  return Number.isFinite(extra) ? seconds + extra : undefined;
}
