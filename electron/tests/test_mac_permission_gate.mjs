import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAC_ACCESSIBILITY_SETTINGS_URL,
  createMacPermissionGate,
} from '../mac-permission-gate.js';

function harness({ platform = 'darwin', trusted = false } = {}) {
  const calls = { prompts: [], spawn: 0, errors: [], statuses: [], tray: [], urls: [] };
  let intervalCallback = null;
  const gate = createMacPermissionGate({
    platform,
    checkAccessibility: (prompt) => { calls.prompts.push(prompt); return trusted; },
    spawnBackend: () => { calls.spawn += 1; },
    sendAppError: (payload) => calls.errors.push(payload),
    sendStatus: (payload) => calls.statuses.push(payload),
    updateTrayStatus: (state, text) => calls.tray.push({ state, text }),
    openExternal: (url) => { calls.urls.push(url); return true; },
    setIntervalFn: (callback) => { intervalCallback = callback; return 42; },
    clearIntervalFn: () => { intervalCallback = null; },
  });
  return {
    gate,
    calls,
    setTrusted: (value) => { trusted = value; },
    poll: () => intervalCallback && intervalCallback(),
  };
}

test('non-Mac starts the backend immediately without a permission check', () => {
  const { gate, calls } = harness({ platform: 'win32' });
  assert.equal(gate.ensureBackendStarted(), true);
  assert.equal(calls.spawn, 1);
  assert.deepEqual(calls.prompts, []);
});

test('trusted Mac starts exactly one backend', () => {
  const { gate, calls } = harness({ trusted: true });
  assert.equal(gate.ensureBackendStarted(), true);
  assert.equal(gate.ensureBackendStarted(), true);
  assert.equal(calls.spawn, 1);
  assert.deepEqual(calls.prompts, [true]);
  assert.equal(calls.errors.at(-1).severity, 'clear');
});

test('untrusted Mac stays alive, presents actionable permission UI, then starts after grant', () => {
  const { gate, calls, setTrusted, poll } = harness({ trusted: false });
  assert.equal(gate.ensureBackendStarted(), false);
  assert.equal(calls.spawn, 0);
  assert.equal(calls.prompts[0], true, 'first check must ask macOS to present its permission prompt');
  assert.equal(calls.errors.at(-1).code, 'MAC_ACCESSIBILITY_REQUIRED');
  assert.equal(calls.errors.at(-1).severity, 'permission');
  assert.match(calls.errors.at(-1).detail, /System Settings/);
  assert.equal(gate.getState().polling, true);

  setTrusted(true);
  poll();
  assert.equal(calls.spawn, 1);
  assert.equal(calls.errors.at(-1).severity, 'clear');
  assert.deepEqual(gate.getState(), { backendStarted: true, waiting: false, polling: false });
});

test('permission settings action opens the macOS Accessibility pane', async () => {
  const { gate, calls } = harness();
  await gate.openAccessibilitySettings();
  assert.deepEqual(calls.urls, [MAC_ACCESSIBILITY_SETTINGS_URL]);
});
