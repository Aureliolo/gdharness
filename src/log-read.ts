import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * The most of an engine's log that is read, and how much an engine may print before it is ended.
 * A gdUnit4 run prints about a kilobyte a case, so ten thousand cases are a tenth of this. A layout
 * loop in a change under test made an engine print 2 GB, and the server reading it whole ran out of
 * memory and left the engine running.
 */
export const LOG_LIMIT_BYTES = 128 * 1024 * 1024;

/** Of a log read in part, how much comes from its start; the rest is its end, where a run stops. */
const HEAD_SHARE = 4;

/**
 * [param path] as text, whole when it holds at most [param limit] bytes, else its first quarter and
 * its last three quarters of that, cut at line ends, with a line between saying how much was not
 * read.
 */
export function readLog(path: string, limit = LOG_LIMIT_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= limit) {
      return bytesAt(fd, 0, size).toString('utf8');
    }
    const headBytes = Math.floor(limit / HEAD_SHARE);
    const tailBytes = limit - headBytes;
    const head = bytesAt(fd, 0, headBytes);
    const tail = bytesAt(fd, size - tailBytes, tailBytes);
    const headEnd = head.lastIndexOf(0x0a) + 1;
    const tailStart = tail.indexOf(0x0a) + 1;
    const kept = head.subarray(0, headEnd);
    const ending = tail.subarray(tailStart);
    const skipped = size - kept.length - ending.length;
    return `${kept.toString('utf8')}[gdharness: ${String(skipped)} bytes of this ${String(size)}-byte log were not read; at most ${String(limit)} are]\n${ending.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

/** Puts [param text] before what [param path] holds, copying the rest a piece at a time. */
export function prependTo(path: string, text: string): void {
  const whole = `${path}.whole`;
  renameSync(path, whole);
  const from = openSync(whole, 'r');
  const into = openSync(path, 'w');
  try {
    writeSync(into, text);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let got = readSync(from, chunk, 0, chunk.length, null); got > 0; ) {
      writeSync(into, chunk, 0, got);
      got = readSync(from, chunk, 0, chunk.length, null);
    }
  } finally {
    closeSync(into);
    closeSync(from);
    rmSync(whole, { force: true });
  }
}

function bytesAt(fd: number, position: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const got = readSync(fd, bytes, read, length - read, position + read);
    if (got === 0) {
      break;
    }
    read += got;
  }
  return bytes.subarray(0, read);
}
