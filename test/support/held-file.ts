import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * A file held under an exclusive opportunistic lock, which makes any other process that opens it
 * wait until the lock is let go. A test uses it to stop a process at a known point for as long as it
 * needs, with no timing to guess.
 */
const kernel32 = dlopen('kernel32.dll', {
  CreateFileW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  DeviceIoControl: {
    args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
});

const GENERIC_READ = 0x8000_0000;
const SHARE_ALL = 0x7;
const OPEN_ALWAYS = 4;
const FILE_FLAG_OVERLAPPED = 0x4000_0000;
const FSCTL_REQUEST_OPLOCK_LEVEL_1 = 0x9_0000;
const STATUS_PENDING = 0x103n;
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;

/**
 * The system writes to a pending request's state when the lock breaks or the file is closed, which
 * can be after `let go` returns, so that memory is kept for the life of the process.
 */
const pendingStates: Buffer[] = [];

/** Holds [param file], made where it is missing, until the returned function lets it go. */
export function holdFile(file: string): () => void {
  const handle = kernel32.symbols.CreateFileW(
    ptr(Buffer.from(`${file}\0`, 'utf16le')),
    GENERIC_READ,
    SHARE_ALL,
    null,
    OPEN_ALWAYS,
    FILE_FLAG_OVERLAPPED,
    0n,
  );
  if (handle === INVALID_HANDLE || handle === 0n) {
    throw new Error(`CreateFileW could not open ${file}`);
  }
  const state = Buffer.alloc(32);
  const returned = Buffer.alloc(4);
  pendingStates.push(state, returned);
  const granted = kernel32.symbols.DeviceIoControl(
    handle,
    FSCTL_REQUEST_OPLOCK_LEVEL_1,
    null,
    0,
    null,
    0,
    ptr(returned),
    ptr(state),
  );
  // A lock granted is a request left pending until it breaks. Its state says so, which the last
  // error cannot be trusted to across calls from Bun.
  const status = state.readBigUInt64LE(0);
  if (granted || status !== STATUS_PENDING) {
    kernel32.symbols.CloseHandle(handle);
    throw new Error(`the lock on ${file} was not granted: status 0x${status.toString(16)}`);
  }
  let held = true;
  return () => {
    if (held) {
      held = false;
      kernel32.symbols.CloseHandle(handle);
    }
  };
}
