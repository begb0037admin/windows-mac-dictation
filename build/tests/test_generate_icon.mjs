import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '..');
const GENERATOR = path.join(BUILD_DIR, 'generate-icon.js');
const require = createRequire(import.meta.url);
const { encodeSolidRgbaPng } = require(path.join(BUILD_DIR, 'lib', 'png-tool.js'));

function run(args) {
  return spawnSync('node', [GENERATOR, ...args], { encoding: 'utf8' });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p2t-icon-'));
}

test('turn-6 finding 3 fix: produces a nonempty, well-formed .ico from a square source PNG', () => {
  const dir = tmpDir();
  const source = path.join(dir, 'icon.png');
  fs.writeFileSync(source, encodeSolidRgbaPng(256, [10, 20, 30, 255]));
  const output = path.join(dir, 'icon.ico');

  const res = run(['--source', source, '--output', output, '--format', 'ico']);
  assert.equal(res.status, 0, res.stderr);
  const buf = fs.readFileSync(output);
  assert.ok(buf.length > 0, 'icon.ico must be nonempty');
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type field must be 1 (icon)');
  assert.equal(buf.readUInt16LE(4), 1, 'ICO must contain exactly one image');
  // width/height byte 0 means "256" per the ICO spec.
  assert.equal(buf.readUInt8(6), 0);
  assert.equal(buf.readUInt8(7), 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('produces a nonempty, well-formed .icns from a square source PNG', () => {
  const dir = tmpDir();
  const source = path.join(dir, 'icon.png');
  fs.writeFileSync(source, encodeSolidRgbaPng(1024, [10, 20, 30, 255]));
  const output = path.join(dir, 'icon.icns');

  const res = run(['--source', source, '--output', output, '--format', 'icns']);
  assert.equal(res.status, 0, res.stderr);
  const buf = fs.readFileSync(output);
  assert.ok(buf.length > 0, 'icon.icns must be nonempty');
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(buf.readUInt32BE(4), buf.length, 'icns top-level length must equal the file length');
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'ic10', '1024x1024 source should map to the ic10 icon type');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a non-square source image', () => {
  const dir = tmpDir();
  const png = encodeSolidRgbaPng(64, [0, 0, 0, 255]);
  // Corrupt the IHDR height field to make it non-square without a second encoder path.
  png.writeUInt32BE(32, 20);
  const source = path.join(dir, 'icon.png');
  fs.writeFileSync(source, png);
  const output = path.join(dir, 'icon.ico');

  const res = run(['--source', source, '--output', output, '--format', 'ico']);
  assert.equal(res.status, 4);
  assert.ok(!fs.existsSync(output));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a missing source file', () => {
  const dir = tmpDir();
  const res = run(['--source', path.join(dir, 'nope.png'), '--output', path.join(dir, 'icon.ico'), '--format', 'ico']);
  assert.equal(res.status, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects an invalid --format', () => {
  const dir = tmpDir();
  const source = path.join(dir, 'icon.png');
  fs.writeFileSync(source, encodeSolidRgbaPng(64, [0, 0, 0, 255]));
  const res = run(['--source', source, '--output', path.join(dir, 'icon.bmp'), '--format', 'bmp']);
  assert.equal(res.status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
