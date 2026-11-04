/**
 * Reading a child's exit code whole.
 *
 * Bun on Windows hands a parent only the low byte of a child's exit code, so an engine that died
 * on an access violation, 0xC0000005, read as an exit of 5 and was named a quit(5) in the game's
 * code. Under Bun on Windows a handle to the child is opened as it starts, and its code is read
 * from that handle as it ends. The runtime holds its own handle until it has told the exit, so the
 * pid still names the child when this one is opened. Node tells the code whole, so there the code
 * told stands, as it does wherever the handle could not be opened.
 */

import type { Pointer } from 'bun:ffi';
import process from 'node:process';

/** The child's whole exit code, given the one the runtime told. Asked once, as the child ends. */
export type WholeExit = (told: number | null) => number | null;

const QUERY_LIMITED_INFORMATION = 0x1000;

interface Kernel {
  readonly open: (pid: number) => Pointer | null;
  readonly codeOf: (handle: Pointer) => number | null;
  readonly close: (handle: Pointer) => void;
}

let kernel: Kernel | null = null;

/** Loads what reads a code whole, where it is needed and can be: under Bun on Windows. */
export async function prepareWholeExits(): Promise<void> {
  if (kernel !== null || process.platform !== 'win32' || !('bun' in process.versions)) {
    return;
  }
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    });
    const { OpenProcess, GetExitCodeProcess, CloseHandle } = kernel32.symbols;
    kernel = {
      open: (pid) => {
        const handle = OpenProcess(QUERY_LIMITED_INFORMATION, false, pid);
        // Bun types a returned pointer as a bigint as well, which it is only when asked for one.
        return typeof handle === 'bigint' ? null : handle;
      },
      codeOf: (handle) => {
        const code = new Uint32Array(1);
        return GetExitCodeProcess(handle, ptr(code)) ? (code[0] ?? null) : null;
      },
      close: (handle) => {
        CloseHandle(handle);
      },
    };
  } catch {
    // Left unloaded, and every code is the one told.
  }
}

/**
 * How to read the exit code of the child [param pid] whole. Called in the same turn as the child
 * is started, before its exit can be told.
 */
export function holdExit(pid: number | undefined): WholeExit {
  const held = kernel;
  const handle = held === null || pid === undefined ? null : held.open(pid);
  if (held === null || handle === null) {
    return (told) => told;
  }
  let open = true;
  return (told) => {
    if (!open) {
      return told;
    }
    open = false;
    const whole = held.codeOf(handle);
    held.close(handle);
    // A code whose low byte is not the one told is not this exit's.
    return told === null || whole === null || (whole & 0xff) !== (told & 0xff) ? told : whole;
  };
}
