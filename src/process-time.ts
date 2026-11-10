import process from 'node:process';
import { askProcessTable } from './process-table.js';
import { runHidden as run } from './spawn.js';

/**
 * Long enough for the operating system to answer about one process on a machine that is busy,
 * short enough not to hold a call that asked for the reading on purpose. A loaded machine, a bench
 * with thirty workers grinding or a shared runner, held a PowerShell start past two seconds: the
 * reading was being given up on exactly when it was wanted, since a machine under load is the one
 * whose run somebody is watching for a stall.
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
    return process.platform === 'win32' ? await secondsOnWindows(pid) : await askPosix(pid);
  } catch {
    return undefined;
  }
}

async function secondsOnWindows(pid: number): Promise<number | undefined> {
  const said = (await askProcessTable(`ProcessorSeconds(${pid})`, ASK_TIMEOUT_MS)).trim();
  const seconds = Number(said);
  return said !== '' && Number.isFinite(seconds) ? seconds : undefined;
}

async function askPosix(pid: number): Promise<number | undefined> {
  // In the C locale, since a comma-decimal one prints the fraction of a second after a comma.
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)], {
    timeout: ASK_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return secondsFromClock(stdout.trim());
}

/**
 * `ps` prints processor time as `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS` depending on how long it has
 * been going, with fractions of a second on some systems, after a comma in some locales. Anything
 * else is no clock, so a bare dash or colon is not read as zero processor time.
 */
const CLOCK = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/;

export function secondsFromClock(printed: string): number | undefined {
  const parts = CLOCK.exec(printed.trim());
  if (parts === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = parts;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds?.replace(',', '.'))
  );
}
