import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pngTool = require(path.join(__dirname, '..', 'lib', 'png-tool.js'));
const fs = require('fs');
// rasterize-logo-icon.js runs main() at require-time and is idempotent
// (skips writing if the output already exists) - required here only for
// that side effect, so this test doesn't depend on run order relative to
// a manual `node build/rasterize-logo-icon.js` invocation.
require(path.join(__dirname, '..', 'rasterize-logo-icon.js'));
const OUTPUT = path.join(__dirname, '..', '..', 'electron', 'build', 'icon.png');

test('rasterized icon.png exists, is square, and matches the logo geometry', () => {
  assert.ok(fs.existsSync(OUTPUT), 'run `node build/rasterize-logo-icon.js` before this test');
  const buf = fs.readFileSync(OUTPUT);
  const dims = pngTool.readPngDimensions(buf);
  assert.deepEqual(dims, { width: 1024, height: 1024 });

  const decoded = pngTool.decodeSolidRgbaPng(buf);

  // Corner (0,0): outside the rounded rect entirely - transparent.
  assert.deepEqual(decoded.pixelAt(4, 4), [0, 0, 0, 0]);

  // Edge midpoint (512, 4): inside the rounded rect's straight edge,
  // outside the ring/bars - background blue (#2056DF).
  assert.deepEqual(decoded.pixelAt(512, 4), [0x20, 0x56, 0xdf, 255]);

  // Center (512, 512): on the middle bar - white.
  assert.deepEqual(decoded.pixelAt(512, 512), [255, 255, 255, 255]);

  // On the ring, directly above center: circle radius 314, so
  // (512, 512-314) = (512, 198) sits on the ring - white.
  assert.deepEqual(decoded.pixelAt(512, 198), [255, 255, 255, 255]);

  // Between the ring and the middle bar (e.g. (512, 300)): inside the
  // ring's disc but outside both the ring stroke and any bar - background
  // blue shows through the gap.
  assert.deepEqual(decoded.pixelAt(512, 300), [0x20, 0x56, 0xdf, 255]);
});
