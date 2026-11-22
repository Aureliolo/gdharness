import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

/**
 * The most of an engine's log that is read, and how much an engine may print before it is ended.
 * A gdUnit4 run prints about a kilobyte a case, so ten thousand cases are a tenth of this. A layout
 * loop in a change under test made an engine print 2 GB, and the server reading it whole ran out of
 * memory and left the engine running.
 */
export const LOG_LIMIT_BYTES = 128 * 1024 * 1024;

/** The limit in force, which GDHARNESS_LOG_LIMIT_BYTES lowers for a test of an engine printing past it. */
export function logLimitBytes(): number {
  const set = Number(process.env['GDHARNESS_LOG_LIMIT_BYTES']);
  return Number.isInteger(set) && set > 0 && set < LOG_LIMIT_BYTES ? set : LOG_LIMIT_BYTES;
}

/**
 * Why an engine that printed more than [param limit] bytes was ended, in the words every run answers
 * with, naming [param suite] when one was running.
 */
export function pastTheLogLimit(suite: string | null, limit = logLimitBytes()): string {
  const mib = limit / 1024 / 1024;
  const size = Number.isInteger(mib) ? `${String(mib)} MiB` : `${String(limit)} bytes`;
  const running = suite === null ? '' : ` It was running ${suite}.`;
  return `the engine printed more than the ${size} a log may hold, so it was ended.${running}`;
}

/**
 * The lines of the log at [param path] as the text read whole would split them, with colour codes
 * taken out and CRLF read as one line end. It is read [param chunkBytes] at a time, and each line is
 * given as it ends, so nothing holds more of the log than a chunk and a line.
 */
export function* eachLogLine(path: string, chunkBytes = 1024 * 1024): Generator<string, void, undefined> {
  // Cut in bytes and decoded a line at a time, so a line kept holds no more than itself. No byte of
  // a character UTF-8 spells in several is a line feed, so no character is cut.
  let carry: Buffer[] = [];
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(chunkBytes);
    for (let got = readSync(fd, chunk, 0, chunkBytes, null); got > 0; got = readSync(fd, chunk, 0, chunkBytes, null)) {
      const bytes = chunk.subarray(0, got);
      let from = 0;
      for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, from)) {
        const text =
          carry.length === 0
            ? bytes.toString('utf8', from, end)
            : Buffer.concat([...carry, bytes.subarray(from, end)]).toString('utf8');
        carry = [];
        const line = stripVTControlCharacters(text);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        from = end + 1;
      }
      if (from < got) {
        carry.push(Buffer.from(bytes.subarray(from)));
      }
    }
  } finally {
    closeSync(fd);
  }
  yield stripVTControlCharacters(Buffer.concat(carry).toString('utf8'));
}

/**
 * [param text] in a string of its own. A line cut from a larger text holds that text in memory for
 * as long as it is kept, so what outlives a read is copied.
 */
export function owned(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

/** Of a log read in part, how much comes from its start. The rest is its end, where a run stops. */
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
    return `${kept.toString('utf8')}[gdharness: ${String(skipped)} bytes of this ${String(size)}-byte log were not read, since at most ${String(limit)} are]\n${ending.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

/** Puts [param text] before what [param path] holds. The rest is copied a piece at a time. */
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

/** Up to [param length] bytes of the open file [param fd] from [param position], fewer at its end. */
export function bytesAt(fd: number, position: number, length: number): Buffer {
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
