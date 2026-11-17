import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi';
import { runHidden } from '../../src/spawn.js';

const user32 = dlopen('user32.dll', {
  EnumWindows: { args: [FFIType.function, FFIType.u64], returns: FFIType.bool },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.bool },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  GetClassNameW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

/** A visible top-level window, by the process that owns it. */
export interface VisibleWindow {
  readonly handle: bigint;
  readonly pid: number;
  readonly className: string;
}

/** Every visible top-level window on the desktop this process runs on. */
export function visibleWindows(): VisibleWindow[] {
  const found: VisibleWindow[] = [];
  const callback = new JSCallback(
    (handle: bigint) => {
      if (user32.symbols.IsWindowVisible(handle)) {
        const owner = new Uint32Array(1);
        user32.symbols.GetWindowThreadProcessId(handle, ptr(owner));
        const name = new Uint16Array(256);
        const length = user32.symbols.GetClassNameW(handle, ptr(name), name.length);
        found.push({
          handle,
          pid: owner[0] ?? 0,
          className: String.fromCharCode(...name.subarray(0, length)),
        });
      }
      return true;
    },
    { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
  );
  try {
    user32.symbols.EnumWindows(callback, 0n);
  } finally {
    callback.close();
  }
  return found;
}

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

/** [param pid] and every process below it, by parent id. */
export async function processTreeOf(pid: number): Promise<Set<number>> {
  const { stdout } = await runHidden(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { timeout: 60_000 },
  );
  const parents = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [child, parent] = line.trim().split(' ').map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child)) {
      parents.set(parent, [...(parents.get(parent) ?? []), child]);
    }
  }
  const tree = new Set<number>([pid]);
  for (const member of tree) {
    for (const child of parents.get(member) ?? []) {
      tree.add(child);
    }
  }
  return tree;
}
