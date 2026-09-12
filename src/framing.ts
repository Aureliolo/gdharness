/**
 * The Content-Length framing both the language server and the debug adapter speak.
 *
 * Bytes, never strings: Content-Length counts bytes, and every string index in JavaScript
 * counts UTF-16 code units. A stream held as text walks off its own message boundaries the
 * first time a body carries an accent, and never recovers.
 */

const HEADER_TERMINATOR = '\r\n\r\n';

/**
 * A ceiling on a message body, and on the bytes held while waiting for a header block to end.
 *
 * Without one, a peer that announces an absurd Content-Length, or never finishes a header,
 * grows this process until it dies, and says nothing on the way. The largest real traffic on either
 * socket is a completion list over the whole global scope or the diagnostics for a very long
 * script, both of which Godot answers in hundreds of kilobytes; 32 MiB is two orders of
 * magnitude above that, so reaching it means the stream is broken rather than busy.
 */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export type Frame =
  | { readonly kind: 'message'; readonly value: unknown; readonly byteLength: number }
  | { readonly kind: 'malformed'; readonly byteLength: number; readonly reason: string };

export class OversizedStreamError extends Error {
  constructor(detail: string) {
    super(`stream exceeded the ${MAX_MESSAGE_BYTES} byte ceiling: ${detail}`);
    this.name = 'OversizedStreamError';
  }
}

/** One message as the peer expects it on the wire. */
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_TERMINATOR}`, 'ascii'), body]);
}

/**
 * The Content-Length a header block announces, or null when it announces none.
 *
 * Headers are ASCII by specification, so latin1 decodes them one byte to one character and
 * nothing here can shift a byte offset. A header block with no usable Content-Length is
 * skipped rather than failed: the only way to find the next message is to move on.
 */
function announcedLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(value)) continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/** Accumulates bytes as they arrive and yields every complete message they hold. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  get buffered(): number {
    return this.buffer.length;
  }

  /**
   * Adds a chunk and returns the frames it completed, in order. Throws OversizedStreamError
   * when the peer announces or accumulates more than the ceiling; the reader is unusable
   * after that and the caller drops the connection.
   */
  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) {
        // The only unbounded wait: a body's size is announced and checked below, but a peer
        // that never ends its header block could stream bytes forever.
        if (this.buffer.length > MAX_MESSAGE_BYTES) {
          throw new OversizedStreamError(`${this.buffer.length} bytes buffered without a complete header`);
        }
        break;
      }

      const contentLength = announcedLength(this.buffer.toString('latin1', 0, headerEnd));
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length);
        continue;
      }
      if (contentLength > MAX_MESSAGE_BYTES) {
        throw new OversizedStreamError(`a peer announced a ${contentLength} byte message`);
      }

      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.toString('utf8', bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        frames.push({ kind: 'message', value: JSON.parse(body) as unknown, byteLength: contentLength });
      } catch (error) {
        // A body that will not parse is the only symptom a framing fault has, so it is
        // reported rather than skipped in silence.
        frames.push({
          kind: 'malformed',
          byteLength: contentLength,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return frames;
  }
}
