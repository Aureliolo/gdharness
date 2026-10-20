/**
 * Letting Windows Error Reporting see an engine crash.
 *
 * A process's error mode is inherited by every process it starts, and the one Claude Code runs its
 * tools under is 0x8003, which includes SEM_NOGPFAULTERRORBOX. With that bit set Windows Error
 * Reporting never runs for a crash, so an engine dying of an access violation left no dump although
 * the machine was set to write one, and no Application Error event either. So the bit is cleared
 * before any engine starts, and the other two are kept: SEM_FAILCRITICALERRORS and
 * SEM_NOOPENFILEERRORBOX keep a missing drive or file from opening a box nobody will answer.
 * CREATE_DEFAULT_ERROR_MODE on a start would drop those as well.
 *
 * Under Bun the bit is cleared in this process, which every start then inherits. Node has no way to
 * call kernel32, so there the engines a run starts go through the desktop helper, which clears it in
 * itself before it starts them; {@link crashesReported} says which of the two applies.
 */

import process from 'node:process';

/** The bit that keeps Windows Error Reporting from running when a process crashes. */
const NO_FAULT_ERROR_BOX = 0x2;

let cleared = process.platform !== 'win32';

/** Clears the bit in this process where it can, which is under Bun on Windows. */
export async function letWindowsReportCrashes(): Promise<void> {
  if (cleared || !('bun' in process.versions)) {
    return;
  }
  try {
    const { dlopen, FFIType } = await import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      GetErrorMode: { args: [], returns: FFIType.u32 },
      SetErrorMode: { args: [FFIType.u32], returns: FFIType.u32 },
    });
    try {
      const mode = kernel32.symbols.GetErrorMode();
      kernel32.symbols.SetErrorMode(mode & ~NO_FAULT_ERROR_BOX);
      cleared = true;
    } finally {
      kernel32.close();
    }
  } catch {
    // Left as it was, and the starts that matter go through the helper instead.
  }
}

/** Whether an engine this process starts directly gets an error mode that lets a crash be reported. */
export function crashesReported(): boolean {
  return cleared;
}
