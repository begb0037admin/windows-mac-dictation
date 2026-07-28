import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAutostartToggle, reconcileLoginItemOnStartup } from '../login-item-logic.js';

function fakeCtx(overrides = {}) {
  const calls = { writeToBackend: [], sendToRenderer: [], sendAppError: [], appendLog: [] };
  return {
    calls,
    getLoginItemSettings: overrides.getLoginItemSettings || (() => ({ openAtLogin: false })),
    setLoginItemSettings: overrides.setLoginItemSettings || (() => {}),
    writeToBackend: (c) => calls.writeToBackend.push(c),
    sendToRenderer: (e) => calls.sendToRenderer.push(e),
    sendAppError: (p) => calls.sendAppError.push(p),
    appendLog: (prefix, text) => calls.appendLog.push([prefix, text]),
  };
}

test('toggle: setter and read-back agree - no warning, forwards actual', () => {
  const ctx = fakeCtx({ getLoginItemSettings: () => ({ openAtLogin: true }) });
  const actual = applyAutostartToggle(ctx, true, false);
  assert.equal(actual, true);
  assert.deepEqual(ctx.calls.writeToBackend, [{ cmd: 'save_config', data: { autostart: true } }]);
  assert.deepEqual(ctx.calls.sendToRenderer, [{ type: 'config', autostart: true }]);
  assert.equal(ctx.calls.sendAppError.length, 0);
});

// V9's required seam: the setter returns without applying the request.
test('toggle: setter silently no-ops (V9 seam) - immediate read-back, UI correction, LOGIN_ITEM_FAILED', () => {
  const ctx = fakeCtx({
    setLoginItemSettings: () => { /* silently does nothing - openAtLogin stays false */ },
    getLoginItemSettings: () => ({ openAtLogin: false }),
  });
  const actual = applyAutostartToggle(ctx, true, false);
  assert.equal(actual, false, 'must report the OS state, never the unverified request');
  assert.deepEqual(ctx.calls.writeToBackend, [{ cmd: 'save_config', data: { autostart: false } }]);
  assert.deepEqual(ctx.calls.sendToRenderer, [{ type: 'config', autostart: false }]);
  assert.equal(ctx.calls.sendAppError.length, 1);
  assert.equal(ctx.calls.sendAppError[0].code, 'LOGIN_ITEM_FAILED');
  assert.deepEqual(ctx.calls.sendAppError[0].detail, { requested: true, actual: false });
});

test('toggle: setter throws - read-back state is still used and forwarded', () => {
  const ctx = fakeCtx({
    setLoginItemSettings: () => { throw new Error('boom'); },
    getLoginItemSettings: () => ({ openAtLogin: false }),
  });
  const actual = applyAutostartToggle(ctx, true, false);
  assert.equal(actual, false);
  assert.equal(ctx.calls.sendAppError[0].code, 'LOGIN_ITEM_FAILED');
});

test('toggle: both APIs throw - last known actual state is authoritative, no crash', () => {
  const ctx = fakeCtx({
    setLoginItemSettings: () => { throw new Error('boom'); },
    getLoginItemSettings: () => { throw new Error('boom2'); },
  });
  const actual = applyAutostartToggle(ctx, true, true /* lastKnownAutostart */);
  assert.equal(actual, true);
});

// Codex turn-2 finding: this case previously warned nothing at all, because
// actual (true, from lastKnownAutostart) happened to equal wanted (true) -
// but nothing was actually verified, since both APIs threw.
test('toggle: both APIs throw and retained state coincidentally equals request - still warns', () => {
  const ctx = fakeCtx({
    setLoginItemSettings: () => { throw new Error('boom'); },
    getLoginItemSettings: () => { throw new Error('boom2'); },
  });
  applyAutostartToggle(ctx, true, true /* lastKnownAutostart */);
  assert.equal(ctx.calls.sendAppError.length, 1, 'an exception must always warn, even when the coincidental value matches');
  assert.equal(ctx.calls.sendAppError[0].code, 'LOGIN_ITEM_FAILED');
});

// Codex turn-2 finding: this previously returned silently with no warning.
test('startup reconcile: OS read throws - warns, does not crash, forwards stored value unchanged', () => {
  const ctx = fakeCtx({
    getLoginItemSettings: () => { throw new Error('boom'); },
  });
  const { configEvent, lastKnownAutostart } = reconcileLoginItemOnStartup(ctx, { autostart: true }, false);
  assert.equal(configEvent.autostart, true, 'stored value forwarded unchanged since OS state could not be read');
  assert.equal(lastKnownAutostart, false, 'lastKnownAutostart is untouched, not silently overwritten');
  assert.equal(ctx.calls.sendAppError.length, 1);
  assert.equal(ctx.calls.sendAppError[0].code, 'LOGIN_ITEM_FAILED');
});

test('startup reconcile: stored matches actual - no-op, no warning', () => {
  const ctx = fakeCtx({ getLoginItemSettings: () => ({ openAtLogin: true }) });
  const { configEvent } = reconcileLoginItemOnStartup(ctx, { autostart: true }, false);
  assert.equal(configEvent.autostart, true);
  assert.equal(ctx.calls.sendAppError.length, 0);
  assert.equal(ctx.calls.writeToBackend.length, 0);
});

test('startup reconcile: stored != actual - applies stored, re-reads, mutates payload to final read-back', () => {
  let current = false;
  const ctx = fakeCtx({
    setLoginItemSettings: (opts) => { current = opts.openAtLogin; },
    getLoginItemSettings: () => ({ openAtLogin: current }),
  });
  const { configEvent } = reconcileLoginItemOnStartup(ctx, { autostart: true }, false);
  assert.equal(configEvent.autostart, true);
  assert.equal(ctx.calls.sendAppError.length, 0, 'apply succeeded - no divergence warning');
});

test('startup reconcile: apply silently fails - warns and persists the real read-back, not stored', () => {
  const ctx = fakeCtx({
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  });
  const { configEvent } = reconcileLoginItemOnStartup(ctx, { autostart: true }, false);
  assert.equal(configEvent.autostart, false);
  assert.equal(ctx.calls.sendAppError[0].code, 'LOGIN_ITEM_FAILED');
  assert.deepEqual(ctx.calls.writeToBackend, [{ cmd: 'save_config', data: { autostart: false } }]);
});
