import { runHidden } from '../../src/spawn.js';

/** The pids of the processes whose command line holds [param fragment] and whose image starts with [param image]. */
export async function pidsWithCommandLine(image: string, fragment: string): Promise<number[]> {
  const { stdout } = await runHidden(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name like '${image}%'" | Where-Object { $_.CommandLine -like '*${fragment.replaceAll("'", "''")}*' } | ForEach-Object { $_.ProcessId }`,
    ],
    { timeout: 60_000 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
