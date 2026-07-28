'use strict';

// Minimal, dependency-free PNG chunk reader/writer. Exists so the build
// pipeline never needs a third-party image library (electron-icon-builder
// was dropped for pulling 33 vulnerabilities via a deprecated phantomjs
// dependency chain - see i1_claude.md) just to make a placeholder icon
// or wrap a source PNG into a platform icon container.
//
// Only supports what this repo's own icon assets need: 8-bit RGBA,
// colorType 6, filter-type-0 (None) scanlines, a single IDAT chunk. That
// is sufficient for both the solid-color placeholder we generate and for
// re-decoding it in tests - it is not a general-purpose PNG library.

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = null;
function crcTableFor() {
  if (crcTable) return crcTable;
  crcTable = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buf) {
  const table = crcTableFor();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeSolidRgbaPng(size, [r, g, b, a]) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`invalid PNG size: ${size}`);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // color type: RGBA
  ihdrData.writeUInt8(0, 10); // compression method
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(0, 12); // interlace method
  const ihdr = encodeChunk('IHDR', ihdrData);

  const rowLength = 1 + size * 4;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }
  const idat = encodeChunk('IDAT', zlib.deflateSync(raw));
  const iend = encodeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);
}

function readPngDimensions(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Decodes only what encodeSolidRgbaPng produces - filter-type-0 8-bit RGBA,
// a single logical IDAT stream. Used for round-trip self-tests, not general
// PNG decoding.
function decodeSolidRgbaPng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  let offset = 8;
  let width = null;
  let height = null;
  const idatParts = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data.readUInt8(8) !== 8 || data.readUInt8(9) !== 6) {
        throw new Error('decodeSolidRgbaPng only supports 8-bit RGBA (colorType 6)');
      }
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + length + 4; // length + type + data + crc
  }
  if (width === null) throw new Error('no IHDR chunk found');
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const rowLength = 1 + width * 4;
  const pixelAt = (x, y) => {
    const rowStart = y * rowLength;
    if (raw[rowStart] !== 0) throw new Error(`unsupported filter type ${raw[rowStart]} on row ${y}`);
    const px = rowStart + 1 + x * 4;
    return [raw[px], raw[px + 1], raw[px + 2], raw[px + 3]];
  };
  return { width, height, pixelAt };
}

module.exports = { crc32, encodeChunk, encodeSolidRgbaPng, readPngDimensions, decodeSolidRgbaPng, PNG_SIGNATURE };
