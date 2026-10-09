/**
 * Godot's binary Variant format, as its remote debugger puts it on the wire.
 *
 * Read from `core/io/marshalls.cpp` at 4.7.2: every value is a little-endian header word whose low
 * byte is the `Variant::Type` and whose bit 16 says an INT, a FLOAT or a math type is 64-bit, then
 * the value padded to four bytes. Decoded whole, every type, because a message is decoded before it
 * is known whether anything here wants it, and one type left out would leave every message carrying
 * it unreadable. Encoded only for what a command needs: nil, bool, int, float, string and array.
 */

/** A decoded value. Containers and the engine's own types keep enough shape to be told apart. */
export type GodotValue =
  | null
  | boolean
  | number
  | string
  | readonly GodotValue[]
  | GodotDictionary
  | GodotOther;

interface GodotDictionary {
  readonly kind: 'dictionary';
  readonly entries: readonly (readonly [GodotValue, GodotValue])[];
}

/** A math type, a node path, an id or a callable: named by its type, with its parts in order. */
interface GodotOther {
  readonly kind: string;
  readonly values: readonly (number | string)[];
}

const NIL = 0;
const BOOL = 1;
const INT = 2;
const FLOAT = 3;
const STRING = 4;
const ARRAY = 28;
const FLAG_64 = 1 << 16;

/** How many reals or 32-bit integers each fixed-size math type holds, and which they are. */
const MATH: Readonly<
  Record<number, { readonly name: string; readonly count: number; readonly ints?: true }>
> = {
  5: { name: 'Vector2', count: 2 },
  6: { name: 'Vector2i', count: 2, ints: true },
  7: { name: 'Rect2', count: 4 },
  8: { name: 'Rect2i', count: 4, ints: true },
  9: { name: 'Vector3', count: 3 },
  10: { name: 'Vector3i', count: 3, ints: true },
  11: { name: 'Transform2D', count: 6 },
  12: { name: 'Vector4', count: 4 },
  13: { name: 'Vector4i', count: 4, ints: true },
  14: { name: 'Plane', count: 4 },
  15: { name: 'Quaternion', count: 4 },
  16: { name: 'AABB', count: 6 },
  17: { name: 'Basis', count: 9 },
  18: { name: 'Transform3D', count: 12 },
  19: { name: 'Projection', count: 16 },
};

/** The packed arrays of vectors, by how many reals each element holds. */
const PACKED_VECTORS: Readonly<Record<number, number>> = { 35: 2, 36: 3, 38: 4 };

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(view: DataView) {
    this.view = view;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  private need(bytes: number): void {
    if (bytes < 0 || bytes > this.remaining) {
      throw new RangeError(
        `a value runs past the end of its message (${bytes} bytes wanted, ${this.remaining} left)`,
      );
    }
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i64(): number {
    this.need(8);
    const value = Number(this.view.getBigInt64(this.offset, true));
    this.offset += 8;
    return value;
  }

  u64(): number {
    this.need(8);
    const value = Number(this.view.getBigUint64(this.offset, true));
    this.offset += 8;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  real(wide: boolean): number {
    return wide ? this.f64() : this.f32();
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, count);
    this.offset += count;
    return out;
  }

  /** A length-prefixed UTF-8 string padded to four bytes, as `_decode_string` reads one. */
  string(): string {
    const length = this.u32();
    const text = new TextDecoder().decode(this.bytes(length));
    this.bytes((4 - (length % 4)) % 4);
    return text;
  }
}

const MAX_DEPTH = 1024;

function containerType(reader: Reader, kind: number): void {
  if (kind === 1) {
    reader.u32();
  } else if (kind === 2 || kind === 3) {
    reader.string();
  }
}

function decodeValue(reader: Reader, depth: number): GodotValue {
  if (depth > MAX_DEPTH) {
    throw new RangeError('a value nests deeper than the engine allows');
  }
  const header = reader.u32();
  const type = header & 0xff;
  const wide = (header & FLAG_64) !== 0;
  const math = MATH[type];
  if (math !== undefined) {
    return {
      kind: math.name,
      values: Array.from({ length: math.count }, () =>
        math.ints === true ? reader.i32() : reader.real(wide),
      ),
    };
  }
  const vectorWidth = PACKED_VECTORS[type];
  if (vectorWidth !== undefined) {
    const count = reader.u32();
    return Array.from({ length: count }, () => ({
      kind: 'Vector',
      values: Array.from({ length: vectorWidth }, () => reader.real(wide)),
    }));
  }
  switch (type) {
    case NIL:
      return null;
    case BOOL:
      return reader.u32() !== 0;
    case INT:
      return wide ? reader.i64() : reader.i32();
    case FLOAT:
      return wide ? reader.f64() : reader.f32();
    case STRING:
    case 21:
      return reader.string();
    case 20:
      return { kind: 'Color', values: [reader.f32(), reader.f32(), reader.f32(), reader.f32()] };
    case 22: {
      const first = reader.u32();
      if ((first & 0x80000000) === 0) {
        throw new RangeError('a node path in the format before 3.0');
      }
      const names = first & 0x7fffffff;
      let subnames = reader.u32();
      const flags = reader.u32();
      if ((flags & 2) !== 0) {
        subnames += 1;
      }
      return { kind: 'NodePath', values: Array.from({ length: names + subnames }, () => reader.string()) };
    }
    case 23:
      return { kind: 'RID', values: [reader.u64()] };
    case 24:
      if ((header & FLAG_64) === 0) {
        // A full object, which the debugger never sends: it encodes objects as ids.
        throw new RangeError('a full object, which this reader does not take');
      }
      return { kind: 'Object', values: [reader.u64()] };
    case 25:
      return { kind: 'Callable', values: [] };
    case 26:
      return { kind: 'Signal', values: [reader.string(), reader.u64()] };
    case 27: {
      containerType(reader, (header >> 16) & 0b11);
      containerType(reader, (header >> 18) & 0b11);
      const count = reader.u32() & 0x7fffffff;
      const entries: [GodotValue, GodotValue][] = [];
      for (let index = 0; index < count; index += 1) {
        const key = decodeValue(reader, depth + 1);
        entries.push([key, decodeValue(reader, depth + 1)]);
      }
      return { kind: 'dictionary', entries };
    }
    case ARRAY: {
      containerType(reader, (header >> 16) & 0b11);
      const count = reader.u32() & 0x7fffffff;
      return Array.from({ length: count }, () => decodeValue(reader, depth + 1));
    }
    case 29: {
      const count = reader.u32();
      const bytes = [...reader.bytes(count)];
      reader.bytes((4 - (count % 4)) % 4);
      return bytes;
    }
    case 30:
      return Array.from({ length: reader.u32() }, () => reader.i32());
    case 31:
      return Array.from({ length: reader.u32() }, () => reader.i64());
    case 32:
      return Array.from({ length: reader.u32() }, () => reader.f32());
    case 33:
      return Array.from({ length: reader.u32() }, () => reader.f64());
    case 34:
      // Each element's length counts a trailing NUL, unlike a plain string's.
      return Array.from({ length: reader.u32() }, () => reader.string().replace(/\0$/, ''));
    case 37:
      return Array.from({ length: reader.u32() }, () => ({
        kind: 'Color',
        values: [reader.f32(), reader.f32(), reader.f32(), reader.f32()],
      }));
    default:
      throw new RangeError(`a value of type ${type}, which Godot 4.7 does not have`);
  }
}

/** The one value [param bytes] holds, which must be all of it. */
export function decodeVariant(bytes: Uint8Array): GodotValue {
  const reader = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const value = decodeValue(reader, 0);
  if (reader.remaining !== 0) {
    throw new RangeError(`${reader.remaining} bytes left over after the value`);
  }
  return value;
}

/** What a command can carry. A whole number is sent as an INT, any other as a 64-bit FLOAT. */
export type SentValue = null | boolean | number | string | readonly SentValue[];

function pushU32(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function encodeInto(out: number[], value: SentValue): void {
  if (value === null) {
    pushU32(out, NIL);
  } else if (typeof value === 'boolean') {
    pushU32(out, BOOL);
    pushU32(out, value ? 1 : 0);
  } else if (typeof value === 'number') {
    const view = new DataView(new ArrayBuffer(8));
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
      pushU32(out, INT);
      view.setInt32(0, value, true);
      out.push(...new Uint8Array(view.buffer, 0, 4));
    } else if (Number.isInteger(value)) {
      pushU32(out, INT | FLAG_64);
      view.setBigInt64(0, BigInt(value), true);
      out.push(...new Uint8Array(view.buffer));
    } else {
      pushU32(out, FLOAT | FLAG_64);
      view.setFloat64(0, value, true);
      out.push(...new Uint8Array(view.buffer));
    }
  } else if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    pushU32(out, STRING);
    pushU32(out, bytes.length);
    out.push(...bytes, ...Array.from({ length: (4 - (bytes.length % 4)) % 4 }, () => 0));
  } else {
    pushU32(out, ARRAY);
    pushU32(out, value.length);
    for (const element of value) {
      encodeInto(out, element);
    }
  }
}

function encodeVariant(value: SentValue): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
}

/** The thread every command is addressed to: the game drops one for a thread it does not know. */
const MAIN_THREAD = 1;

/** A command to the game as the debugger frames it: its length, then `[message, thread, data]`. */
export function framedCommand(message: string, data: readonly SentValue[]): Uint8Array {
  const body = encodeVariant([message, MAIN_THREAD, data]);
  const framed = new Uint8Array(body.length + 4);
  new DataView(framed.buffer).setUint32(0, body.length, true);
  framed.set(body, 4);
  return framed;
}

/** One message from the game, or why one could not be read. */
export type DebuggerMessage =
  | { readonly message: string; readonly data: readonly GodotValue[] }
  | { readonly unreadable: string };

/** The engine's own limit on one message, past which the stream cannot be in step. */
const MOST_MESSAGE_BYTES = (8 << 20) + 4;

/**
 * Splits what arrives from the game into its messages, however the reads cut it.
 *
 * Each message is decoded on its own, so one this reader cannot take is reported and skipped and
 * the next is read from where its length says it starts.
 */
export class DebuggerStream {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): DebuggerMessage[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending, 0);
    joined.set(chunk, this.pending.length);
    const out: DebuggerMessage[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0, true);
      if (length > MOST_MESSAGE_BYTES) {
        throw new RangeError(`a message of ${length} bytes, more than the engine sends`);
      }
      if (joined.length - at - 4 < length) {
        break;
      }
      out.push(readMessage(joined.subarray(at + 4, at + 4 + length)));
      at += 4 + length;
    }
    this.pending = joined.slice(at);
    return out;
  }
}

function readMessage(body: Uint8Array): DebuggerMessage {
  let value: GodotValue;
  try {
    value = decodeVariant(body);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(value) || value.length !== 3) {
    return { unreadable: 'a message that is not [message, thread, data]' };
  }
  const [message, , data] = value as readonly GodotValue[];
  if (typeof message !== 'string' || !Array.isArray(data)) {
    return { unreadable: 'a message whose name or data is the wrong type' };
  }
  return { message, data: data as readonly GodotValue[] };
}
