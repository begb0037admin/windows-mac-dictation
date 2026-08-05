'use strict';

// Pure functions for the SS15 diagnostics sanitization boundary - no
// Electron API dependency, so this is directly unit-testable (electron/
// tests/test_diagnostics.mjs) without a full Electron test harness.

const { createHash } = require('crypto');

const DIAG_ALLOWED_KEYS = new Set([
  'code', 'url', 'error_class', 'char_count', 'duration_ms', 'deadline', 'exit_code',
  'requested', 'actual', 'rms_milli', 'peak_milli', 'active_percent',
  // Added for the CoreAudio stream-teardown recovery design (STREAM_TEARDOWN_TIMEOUT/
  // STREAM_CLOSE_ERROR/STREAM_STOP_ERROR diagnostics) - see FINAL_BRIEF.md.
  'operation', 'timeout_ms',
]);

function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (e) {
    return '[unparseable-url]';
  }
}

function shortHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Sanitizes one raw stderr line per SS15: structured `P2T_DIAG <json>`
 * lines pass through an explicit key allowlist; everything else is reduced
 * to a fixed, content-free shape. Never returns the original free-form text. */
function sanitizeStderrLine(line) {
  const trimmed = String(line).trim();
  if (trimmed.startsWith('P2T_DIAG ')) {
    let obj;
    try {
      obj = JSON.parse(trimmed.slice('P2T_DIAG '.length));
    } catch (e) {
      return `UNSTRUCTURED class=none len=${trimmed.length} h=${shortHash(trimmed)}`;
    }
    const clean = {};
    for (const key of Object.keys(obj || {})) {
      if (!DIAG_ALLOWED_KEYS.has(key)) continue;
      clean[key] = key === 'url' ? sanitizeUrl(obj[key]) : obj[key];
    }
    return `P2T_DIAG ${JSON.stringify(clean)}`;
  }
  const classMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))\b/);
  const errorClass = classMatch ? classMatch[1] : 'none';
  return `UNSTRUCTURED class=${errorClass} len=${trimmed.length} h=${shortHash(trimmed)}`;
}

module.exports = { sanitizeStderrLine, sanitizeUrl, shortHash, DIAG_ALLOWED_KEYS };
