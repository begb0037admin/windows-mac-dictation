'use strict';

// Pure SS11 login-item decision logic, with every OS/IPC/process effect
// injected via `ctx` - directly unit-testable (electron/tests/
// test_login_item.mjs) including the V9 "setter returns without applying
// the request" seam, without needing a full Electron test harness or an
// installed copy of the app.
//
// ctx shape: {
//   getLoginItemSettings: () => { openAtLogin: boolean } (may throw),
//   setLoginItemSettings: (opts) => void (may throw),
//   writeToBackend: (cmdObject) => void,
//   sendToRenderer: (eventObject) => void,
//   sendAppError: (payload) => void,
//   appendLog: (prefix, text) => void,
// }

const { sanitizeStderrLine } = require('./diagnostics');

/** SS11.1: applies an autostart toggle request. Always reads back actual OS
 * state and forwards/displays only that - never the unverified request.
 * Returns the final actual value (also the new lastKnownAutostart). */
function applyAutostartToggle(ctx, requested, lastKnownAutostart) {
  const wanted = Boolean(requested);
  let errorClass;
  try {
    ctx.setLoginItemSettings({ openAtLogin: wanted });
  } catch (e) {
    errorClass = e && e.constructor ? e.constructor.name : 'Error';
  }
  let actual = lastKnownAutostart;
  try {
    actual = ctx.getLoginItemSettings().openAtLogin;
  } catch (e) {
    errorClass = errorClass || (e && e.constructor ? e.constructor.name : 'Error');
    // step 8: read failed - the last known actual state remains authoritative.
  }

  ctx.writeToBackend({ cmd: 'save_config', data: { autostart: actual } });
  ctx.sendToRenderer({ type: 'config', autostart: actual });

  if (actual !== wanted) {
    ctx.appendLog('diag', sanitizeStderrLine(`P2T_DIAG ${JSON.stringify({ code: 'LOGIN_ITEM_FAILED', requested: wanted, actual, error_class: errorClass })}`));
    ctx.sendAppError({
      severity: 'warning',
      code: 'LOGIN_ITEM_FAILED',
      message: 'Run on login could not be set',
      detail: { requested: wanted, actual },
    });
  }
  return actual;
}

/** SS11.2: on every backend `config` event, reconcile stored vs actual OS
 * login-item state before the config payload is forwarded. Mutates and
 * returns configEvent with autostart set to the final read-back value. */
function reconcileLoginItemOnStartup(ctx, configEvent, lastKnownAutostart) {
  const stored = Boolean(configEvent.autostart);
  let actual;
  try {
    actual = ctx.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return { configEvent, lastKnownAutostart }; // can't read OS state - forward stored value unchanged
  }

  if (stored === actual) {
    return { configEvent, lastKnownAutostart: actual };
  }

  try {
    ctx.setLoginItemSettings({ openAtLogin: stored });
  } catch (e) { /* fall through to re-read below regardless */ }
  let reread = actual;
  try {
    reread = ctx.getLoginItemSettings().openAtLogin;
  } catch (e) { /* keep prior actual */ }

  if (reread !== stored) {
    ctx.writeToBackend({ cmd: 'save_config', data: { autostart: reread } });
    ctx.appendLog('diag', sanitizeStderrLine(`P2T_DIAG ${JSON.stringify({ code: 'LOGIN_ITEM_FAILED', requested: stored, actual: reread })}`));
    ctx.sendAppError({
      severity: 'warning',
      code: 'LOGIN_ITEM_FAILED',
      message: 'Run on login could not be set',
      detail: { requested: stored, actual: reread },
    });
  }
  configEvent.autostart = reread;
  return { configEvent, lastKnownAutostart: reread };
}

module.exports = { applyAutostartToggle, reconcileLoginItemOnStartup };
