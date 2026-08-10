'use strict';

const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

const REQUIRED_MESSAGE =
  'Accessibility permission is required before PTT can listen for the hotkey or paste text.';
const REQUIRED_DETAIL =
  'Open System Settings, enable PTT under Privacy & Security > Accessibility, then return here. The app will start automatically when macOS confirms the permission.';

/**
 * Keeps the Electron app alive while macOS Accessibility permission is
 * missing. The outer app requests the permission before the Python child is
 * spawned, so TCC sees the visible application as the responsible process.
 * All side effects are injected to keep this state machine directly testable.
 */
function createMacPermissionGate({
  platform,
  checkAccessibility,
  spawnBackend,
  sendAppError,
  sendStatus,
  updateTrayStatus,
  openExternal,
  appendLog = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let backendStarted = false;
  let waiting = false;
  let pollTimer = null;

  function clearPoll() {
    if (!pollTimer) return;
    clearIntervalFn(pollTimer);
    pollTimer = null;
  }

  function isTrusted(prompt) {
    if (platform !== 'darwin') return true;
    try {
      return !!checkAccessibility(prompt);
    } catch (error) {
      appendLog('main', `Accessibility check failed: ${error && error.constructor ? error.constructor.name : 'Error'}`);
      return false;
    }
  }

  function startBackendOnce() {
    if (backendStarted) return false;
    backendStarted = true;
    waiting = false;
    clearPoll();
    sendAppError({ severity: 'clear', code: 'MAC_ACCESSIBILITY_GRANTED' });
    updateTrayStatus('idle', '');
    spawnBackend();
    return true;
  }

  function poll() {
    if (isTrusted(false)) startBackendOnce();
  }

  function enterWaitingState() {
    if (!waiting) {
      waiting = true;
      sendStatus({
        type: 'status',
        state: 'error',
        text: 'Waiting for Accessibility permission…',
      });
      updateTrayStatus('unavailable', 'Accessibility permission required');
      sendAppError({
        severity: 'permission',
        code: 'MAC_ACCESSIBILITY_REQUIRED',
        message: REQUIRED_MESSAGE,
        detail: REQUIRED_DETAIL,
      });
    }
    if (!pollTimer) pollTimer = setIntervalFn(poll, 1000);
  }

  function ensureBackendStarted() {
    if (backendStarted) return true;
    if (isTrusted(platform === 'darwin')) {
      startBackendOnce();
      return true;
    }
    enterWaitingState();
    return false;
  }

  function openAccessibilitySettings() {
    if (platform !== 'darwin') return Promise.resolve(false);
    return Promise.resolve(openExternal(MAC_ACCESSIBILITY_SETTINGS_URL));
  }

  function dispose() {
    clearPoll();
  }

  return {
    ensureBackendStarted,
    openAccessibilitySettings,
    dispose,
    getState: () => ({ backendStarted, waiting, polling: !!pollTimer }),
  };
}

module.exports = {
  MAC_ACCESSIBILITY_SETTINGS_URL,
  REQUIRED_MESSAGE,
  REQUIRED_DETAIL,
  createMacPermissionGate,
};
