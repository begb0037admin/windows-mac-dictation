#!/usr/bin/env node
'use strict';

// Wraps a single square source PNG into a valid Windows .ico or macOS .icns
// container using the "embedded PNG" image form both formats natively
// support (ICO: any Vista+ reader; ICNS: OS X 10.7+ via ic07/ic08/ic09/ic10).
//
// Turn 6 (implementation review) BLOCKED partly because the previous
// icon step ran `electron-builder --dir --publish=never` with no --config
// and no explicit --win as a side-effecting way to trigger icon conversion -
// that is a full, unscoped packaging invocation, not a narrow icon-only
// step. This script has no side effects beyond its own --output file and no
// dependency on electron-builder or electron-icon-builder (the latter was
// dropped earlier in this run after npm audit found 33 vulnerabilities in
// its dependency tree - see i1_claude.md).

const fs = require('fs');
const path = require('path');
const { readPngDimensions } = require('./lib/png-tool');

function fatal(code, message) {
  process.stderr.write(`generate-icon: FATAL(${code}): ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) fatal(2, `unexpected argument ${tok}`);
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fatal(2, `--${key} requires a value`);
    args[key] = next;
    i++;
  }
  return args;
}

function buildIco(pngBuf, dims) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(dims.width >= 256 ? 0 : dims.width, 0);
  entry.writeUInt8(dims.height >= 256 ? 0 : dims.height, 1);
  entry.writeUInt8(0, 2); // color count: not palette-indexed
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // size of image data
  entry.writeUInt32LE(header.length + entry.length, 12); // offset of image data

  return Buffer.concat([header, entry, pngBuf]);
}

// Largest-first; pick the first ICNS type code whose minimum square size
// the source image meets or exceeds.
const ICNS_TYPES_BY_MIN_SIZE = [
  { size: 1024, type: 'ic10' },
  { size: 512, type: 'ic09' },
  { size: 256, type: 'ic08' },
  { size: 128, type: 'ic07' },
];

function buildIcns(pngBuf, dims) {
  const square = Math.min(dims.width, dims.height);
  const match = ICNS_TYPES_BY_MIN_SIZE.find((c) => square >= c.size);
  if (!match) {
    fatal(4, `source image ${dims.width}x${dims.height} is smaller than the 128x128 minimum required for any ICNS icon type`);
  }
  const typeCode = Buffer.from(match.type, 'ascii');
  const entryLength = 8 + pngBuf.length; // type(4) + length(4) + data
  const entryLengthBuf = Buffer.alloc(4);
  entryLengthBuf.writeUInt32BE(entryLength, 0);
  const entry = Buffer.concat([typeCode, entryLengthBuf, pngBuf]);

  const totalLength = 8 + entry.length; // "icns"(4) + length(4) + entry
  const totalLengthBuf = Buffer.alloc(4);
  totalLengthBuf.writeUInt32BE(totalLength, 0);
  return Buffer.concat([Buffer.from('icns', 'ascii'), totalLengthBuf, entry]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const name of ['source', 'output', 'format']) {
    if (!args[name]) fatal(2, `missing required --${name}`);
  }
  if (!['ico', 'icns'].includes(args.format)) fatal(2, `--format must be ico|icns, got ${args.format}`);
  if (!path.isAbsolute(args.source)) fatal(2, '--source must be an absolute path');
  if (!path.isAbsolute(args.output)) fatal(2, '--output must be an absolute path');
  if (!fs.existsSync(args.source)) fatal(3, `source PNG does not exist: ${args.source}`);

  const pngBuf = fs.readFileSync(args.source);
  const dims = readPngDimensions(pngBuf);
  if (!dims) fatal(4, `${args.source} is not a valid PNG (bad signature or IHDR)`);
  if (dims.width !== dims.height) fatal(4, `source PNG must be square, got ${dims.width}x${dims.height}`);

  const outBuf = args.format === 'ico' ? buildIco(pngBuf, dims) : buildIcns(pngBuf, dims);

  const outDir = path.dirname(args.output);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpPath = `${args.output}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, outBuf);
  const reread = fs.readFileSync(tmpPath);
  if (reread.length !== outBuf.length) {
    fs.unlinkSync(tmpPath);
    fatal(11, 're-read of temporary icon output did not match what was written');
  }
  fs.renameSync(tmpPath, args.output);
  process.stdout.write(`generate-icon: wrote ${args.output} (${outBuf.length} bytes, format=${args.format})\n`);
}

main();
