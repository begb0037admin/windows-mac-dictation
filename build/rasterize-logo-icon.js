#!/usr/bin/env node
'use strict';

// Rasterizes ui/logo.svg into electron/build/icon.png at its native
// 1024x1024. This is NOT a general SVG rasterizer - it hardcodes the exact
// shapes in ui/logo.svg (a rounded-square background, a ring, three
// vertical rounded-cap bars) as closed-form point-in-shape tests, with 4x4
// supersampling for anti-aliased edges. No SVG/rasterization library is
// added to the dependency tree (same reasoning as build/lib/png-tool.js -
// electron-icon-builder was dropped earlier this run for pulling 33
// vulnerabilities via a deprecated dependency chain).
//
// If ui/logo.svg's shapes ever change, this file's hardcoded geometry
// (SIZE/RADIUS/CENTER/RING/BARS below) must be updated to match - it is
// intentionally not a real SVG parser.

const fs = require('fs');
const path = require('path');
const { encodeRgbaPng } = require('./lib/png-tool');

const SIZE = 1024;
const BG_COLOR = [0x20, 0x56, 0xdf, 255]; // ui/logo.svg rect fill #2056DF
const WHITE = [255, 255, 255, 255];
const RECT_RADIUS = 241; // rect rx
const RING_CENTER = [512, 512];
const RING_RADIUS = 314;
const RING_STROKE = 74;
// Three vertical capsule bars: [x, yStart, yEnd], stroke-width 74 -> radius 37
const BARS = [
  [512, 383, 641],
  [627, 457, 568],
  [397, 457, 568],
];
const BAR_RADIUS = 37;
const SUPERSAMPLE = 4;

function insideRoundedRect(px, py, w, h, r) {
  const dx = Math.max(Math.abs(px - w / 2) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(py - h / 2) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function insideRing(px, py) {
  const dx = px - RING_CENTER[0];
  const dy = py - RING_CENTER[1];
  const d = Math.sqrt(dx * dx + dy * dy);
  const inner = RING_RADIUS - RING_STROKE / 2;
  const outer = RING_RADIUS + RING_STROKE / 2;
  return d >= inner && d <= outer;
}

function insideCapsule(px, py, x0, y0, y1) {
  const cy = Math.min(Math.max(py, y0), y1);
  const dx = px - x0;
  const dy = py - cy;
  return dx * dx + dy * dy <= BAR_RADIUS * BAR_RADIUS;
}

function insideWhiteShapes(px, py) {
  if (insideRing(px, py)) return true;
  for (const [x0, y0, y1] of BARS) {
    if (insideCapsule(px, py, x0, y0, y1)) return true;
  }
  return false;
}

function classify(px, py) {
  if (insideWhiteShapes(px, py)) return WHITE;
  if (insideRoundedRect(px, py, SIZE, SIZE, RECT_RADIUS)) return BG_COLOR;
  return [0, 0, 0, 0];
}

function pixelAt(x, y) {
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
  const step = 1 / SUPERSAMPLE;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const px = x + (sx + 0.5) * step;
      const py = y + (sy + 0.5) * step;
      const [r, g, b, a] = classify(px, py);
      const w = a / 255;
      sumR += r * w;
      sumG += g * w;
      sumB += b * w;
      sumA += a;
    }
  }
  const n = SUPERSAMPLE * SUPERSAMPLE;
  const avgA = sumA / n;
  if (avgA === 0) return [0, 0, 0, 0];
  const scale = 255 / avgA; // un-premultiply
  return [
    Math.round(Math.min(255, sumR * scale / n)),
    Math.round(Math.min(255, sumG * scale / n)),
    Math.round(Math.min(255, sumB * scale / n)),
    Math.round(avgA),
  ];
}

function main() {
  const output = path.join(__dirname, '..', 'electron', 'build', 'icon.png');
  const force = process.argv.includes('--force');
  if (fs.existsSync(output) && !force) {
    process.stdout.write(`rasterize-logo-icon: ${output} already exists, leaving it alone (use --force to overwrite)\n`);
    return;
  }
  const png = encodeRgbaPng(SIZE, SIZE, pixelAt);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, png);
  process.stdout.write(`rasterize-logo-icon: wrote ${output} (${png.length} bytes) from ui/logo.svg's exact shapes\n`);
}

main();
