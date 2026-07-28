import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pngTool = require(path.join(__dirname, '..', 'lib', 'png-tool.js'));

test('crc32 matches the known "123456789" IEEE test vector', () => {
  assert.equal(pngTool.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('encodeSolidRgbaPng round-trips through decodeSolidRgbaPng', () => {
  const png = pngTool.encodeSolidRgbaPng(16, [0x2f, 0x63, 0xd8, 0xff]);
  assert.ok(png.subarray(0, 8).equals(pngTool.PNG_SIGNATURE));
  const decoded = pngTool.decodeSolidRgbaPng(png);
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 16);
  assert.deepEqual(decoded.pixelAt(0, 0), [0x2f, 0x63, 0xd8, 0xff]);
  assert.deepEqual(decoded.pixelAt(15, 15), [0x2f, 0x63, 0xd8, 0xff]);
});

test('readPngDimensions reads width/height without a full decode', () => {
  const png = pngTool.encodeSolidRgbaPng(64, [1, 2, 3, 255]);
  const dims = pngTool.readPngDimensions(png);
  assert.deepEqual(dims, { width: 64, height: 64 });
});

test('readPngDimensions returns null for non-PNG data', () => {
  assert.equal(pngTool.readPngDimensions(Buffer.from('not a png')), null);
});
