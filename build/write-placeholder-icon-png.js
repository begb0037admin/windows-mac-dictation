#!/usr/bin/env node
'use strict';

// One-time tool: writes a solid-color 1024x1024 PLACEHOLDER source PNG at
// electron/build/icon.png so the packaging pipeline has something real to
// convert into icon.ico/icon.icns (build-app.ps1 previously failed at its
// first gate with no source PNG present at all - flagged since Turn 1).
//
// This is deliberately NOT the app's real branded icon - ui/logo.svg was
// never rasterized (no SVG rasterizer is available in this environment).
// Uses the app's own --accent-blue (ui/styles.css) as a placeholder fill so
// the generated .ico/.icns are at least visually related to the app, not
// arbitrary. Kevin should replace electron/build/icon.png with real
// branded artwork and re-run this pipeline before shipping to anyone else.
//
// Idempotent: does nothing if the target already exists, unless --force.

const fs = require('fs');
const path = require('path');
const { encodeSolidRgbaPng } = require('./lib/png-tool');

const OUTPUT = path.join(__dirname, '..', 'electron', 'build', 'icon.png');
const ACCENT_BLUE_RGBA = [0x2f, 0x63, 0xd8, 0xff]; // ui/styles.css --accent-blue

function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(OUTPUT) && !force) {
    process.stdout.write(`write-placeholder-icon-png: ${OUTPUT} already exists, leaving it alone (use --force to overwrite)\n`);
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const png = encodeSolidRgbaPng(1024, ACCENT_BLUE_RGBA);
  fs.writeFileSync(OUTPUT, png);
  process.stdout.write(`write-placeholder-icon-png: wrote PLACEHOLDER ${OUTPUT} (${png.length} bytes) - replace with real branded artwork before shipping\n`);
}

main();
