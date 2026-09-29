import { deflateSync } from 'node:zlib';

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
  const rows = Array.from({ length: height }, (_, y) =>
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => colour(x, y)).flat()]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
