import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RecoveryWindow,
  isExpectedRecoveryExit,
  shouldProcessChildEvent,
  parseAndGateBackendLine,
} from '../backend-recovery.js';

test('RecoveryWindow: three recoveries within 60s are allowed, the fourth is refused', () => {
  const w = new RecoveryWindow();
  let now = 1000;
  assert.equal(w.record(now), true);
  assert.equal(w.record(now += 1000), true);
  assert.equal(w.record(now += 1000), true);
  assert.equal(w.record(now += 1000), false);
});

test('RecoveryWindow: an expired timestamp no longer counts', () => {
  const w = new RecoveryWindow();
  let now = 0;
  assert.equal(w.record(now), true);
  assert.equal(w.record(now += 1000), true);
  assert.equal(w.record(now += 1000), true);
  // Fourth request 61s after the first - the first has expired out of the window.
  assert.equal(w.record(now += 59000), true);
});

test('isExpectedRecoveryExit: true only for exact object-identity match', () => {
  const a = { pid: 1 };
  const b = { pid: 2 };
  assert.equal(isExpectedRecoveryExit(a, a), true);
  assert.equal(isExpectedRecoveryExit(a, b), false);
  assert.equal(isExpectedRecoveryExit(a, null), false);
  assert.equal(isExpectedRecoveryExit(null, a), false);
});

test('shouldProcessChildEvent: true only when both are the same non-null reference', () => {
  const child = { pid: 1 };
  const oldChild = { pid: 2 };
  assert.equal(shouldProcessChildEvent(child, child), true);
  assert.equal(shouldProcessChildEvent(oldChild, child), false);
  assert.equal(shouldProcessChildEvent(null, child), false);
});

test('parseAndGateBackendLine: blank line returns null', () => {
  const child = { pid: 1 };
  assert.equal(parseAndGateBackendLine('', child, child), null);
  assert.equal(parseAndGateBackendLine('   \n', child, child), null);
});

test('parseAndGateBackendLine: malformed JSON from the current child returns null', () => {
  const child = { pid: 1 };
  assert.equal(parseAndGateBackendLine('{not valid json', child, child), null);
});

test('parseAndGateBackendLine: any well-formed event type from a stale child returns null', () => {
  const oldChild = { pid: 1 };
  const currentChild = { pid: 2 };
  assert.equal(
    parseAndGateBackendLine('{"type":"ready","hotkey_raw":"alt_l"}', oldChild, currentChild),
    null,
  );
});

test('parseAndGateBackendLine: well-formed event from the current child returns the parsed object', () => {
  const child = { pid: 1 };
  const result = parseAndGateBackendLine('{"type":"status","state":"idle","text":"Ready"}', child, child);
  assert.deepEqual(result, { type: 'status', state: 'idle', text: 'Ready' });
});
