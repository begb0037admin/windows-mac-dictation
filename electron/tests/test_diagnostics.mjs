import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStderrLine } from '../diagnostics.js';

test('structured P2T_DIAG: allowlisted keys pass through', () => {
  const out = sanitizeStderrLine('P2T_DIAG {"code":"CLEANUP_FAILED","error_class":"RuntimeError","exit_code":1}');
  assert.equal(out, 'P2T_DIAG {"code":"CLEANUP_FAILED","error_class":"RuntimeError","exit_code":1}');
});

test('audio diagnostics retain levels but never content', () => {
  const out = sanitizeStderrLine(
    'P2T_DIAG {"code":"AUDIO_SIGNAL","rms_milli":12.3,"peak_milli":45.6,"active_percent":72.1,"transcript":"private words"}'
  );
  assert.equal(
    out,
    'P2T_DIAG {"code":"AUDIO_SIGNAL","rms_milli":12.3,"peak_milli":45.6,"active_percent":72.1}'
  );
});

test('structured P2T_DIAG: non-allowlisted keys are dropped, never leaked', () => {
  const out = sanitizeStderrLine('P2T_DIAG {"code":"X","transcript":"secret spoken words","message":"raw exception text"}');
  assert.ok(!out.includes('secret spoken words'));
  assert.ok(!out.includes('raw exception text'));
  assert.equal(out, 'P2T_DIAG {"code":"X"}');
});

test('structured P2T_DIAG: url is stripped of query/fragment', () => {
  const out = sanitizeStderrLine('P2T_DIAG {"url":"http://localhost:11434/api/generate?token=secret#frag"}');
  assert.equal(out, 'P2T_DIAG {"url":"http://localhost:11434/api/generate"}');
});

test('malformed P2T_DIAG JSON falls back to UNSTRUCTURED, not a crash', () => {
  const out = sanitizeStderrLine('P2T_DIAG {not valid json');
  assert.match(out, /^UNSTRUCTURED class=none len=\d+ h=[0-9a-f]{12}$/);
});

test('unstructured line: never contains the original text', () => {
  const secret = 'Traceback: RuntimeError: the user said something private here';
  const out = sanitizeStderrLine(secret);
  assert.ok(!out.includes('private'));
  assert.ok(!out.includes('said'));
  assert.match(out, /^UNSTRUCTURED class=RuntimeError len=\d+ h=[0-9a-f]{12}$/);
});

test('unstructured line: unknown class falls back to none', () => {
  const out = sanitizeStderrLine('[main] windows-dictation starting on Windows');
  assert.match(out, /^UNSTRUCTURED class=none len=\d+ h=[0-9a-f]{12}$/);
});

test('sanitization is deterministic (same input -> same hash)', () => {
  const a = sanitizeStderrLine('SomeError: identical message');
  const b = sanitizeStderrLine('SomeError: identical message');
  assert.equal(a, b);
});

test('stream-teardown diagnostics: operation and timeout_ms pass through the allowlist', () => {
  const out = sanitizeStderrLine('P2T_DIAG {"code":"STREAM_TEARDOWN_TIMEOUT","operation":"stop_recording","timeout_ms":3000}');
  assert.equal(out, 'P2T_DIAG {"code":"STREAM_TEARDOWN_TIMEOUT","operation":"stop_recording","timeout_ms":3000}');
});
