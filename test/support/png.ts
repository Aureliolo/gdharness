import { deflateSync, inflateSync } from 'node:zlib';

/** A decoded 8-bit RGB or RGBA PNG, not interlaced, as Godot saves one. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  /** Red, green, blue and alpha at [param x], [param y], each 0 to 255. */
  pixel(x: number, y: number): [number, number, number, number];
}

/** [param png] decoded, refused unless it is 8-bit RGB or RGBA without interlacing. */
export function readPng(png: Buffer): Picture {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [depth, colourType, interlace] = [png[24], png[25], png[28]];
  if (depth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
    throw new Error(
      `readPng reads 8-bit RGB or RGBA without interlacing, not depth ${String(depth)} type ${String(colourType)}`,
    );
  }
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') {
      parts.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const corner = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const guess = left + up - corner;
      const nearest =
        Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner)
          ? left
          : Math.abs(guess - up) <= Math.abs(guess - corner)
            ? up
            : corner;
      const predicted = [0, left, up, (left + up) >> 1, nearest][filter] ?? 0;
      pixels[y * stride + x] = (byte + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = y * stride + x * channels;
      return [
        pixels[at] ?? 0,
        pixels[at + 1] ?? 0,
        pixels[at + 2] ?? 0,
        channels === 4 ? (pixels[at + 3] ?? 0) : 255,
      ];
    },
  };
}

/** A 4 by 4 PNG of one colour. */
export function solidPng(red: number, green: number, blue: number): Buffer {
  return encode(4, 4, 2, () => [red, green, blue]);
}

/** A PNG of [param width] by [param height] with alpha, each pixel as [param colour] gives it. */
export function pixelPng(
  width: number,
  height: number,
  colour: (x: number, y: number) => [number, number, number, number],
): Buffer {
  return encode(width, height, 6, colour);
}

/** [param colourType] is the PNG's: 2 for red, green and blue, 6 for those and alpha. */
function encode(
  width: number,
  height: number,
  colourType: 2 | 6,
  colour: (x: number, y: number) => number[],
): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const named = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(named));
    return Buffer.concat([length, named, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colourType, 9);
  // Every scanline opens with its filter byte, 0 for none.
  const scanline = (y: number): Buffer =>
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => colour(x, y)).flat()]);
  const rows = Array.from({ length: height }, (_, y) => scanline(y));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
