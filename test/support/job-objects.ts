import { dlopen, FFIType, ptr } from 'bun:ffi';

/** What a test needs of Windows' job objects, called through kernel32 from Bun. A handle is a 64-bit number. */
const kernel32 = dlopen('kernel32.dll', {
  OpenJobObjectW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.u64 },
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
});

const JOB_OBJECT_QUERY = 0x4;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf16le');
}

/** An open handle on a job, closed by [method JobHandle.close]. */
export class JobHandle {
  private readonly handle: bigint;

  constructor(handle: bigint) {
    this.handle = handle;
  }

  /** Whether the process [param pid] is in this job, nested ones included. */
  holds(pid: number): boolean {
    const process = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process === 0n) {
      return false;
    }
    try {
      const answer = new Int32Array(1);
      return kernel32.symbols.IsProcessInJob(process, this.handle, ptr(answer)) && answer[0] !== 0;
    } finally {
      kernel32.symbols.CloseHandle(process);
    }
  }

  close(): void {
    kernel32.symbols.CloseHandle(this.handle);
  }
}

/** The job called [param name], opened for query as a gate reading its processor time does, or null when there is none. */
export function openJob(name: string): JobHandle | null {
  const handle = kernel32.symbols.OpenJobObjectW(JOB_OBJECT_QUERY, false, ptr(wide(name)));
  return handle === 0n ? null : new JobHandle(handle);
}

/** A job of this name made here, which holds the name until it is closed. */
export function createJob(name: string): JobHandle {
  const handle = kernel32.symbols.CreateJobObjectW(null, ptr(wide(name)));
  if (handle === 0n) {
    throw new Error(`CreateJobObjectW could not make ${name}`);
  }
  return new JobHandle(handle);
}
