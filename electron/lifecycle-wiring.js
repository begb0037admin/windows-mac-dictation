'use strict';

// Turn-5 binding checklist item 6: the primary-process quit-entry callback
// bodies (tray Exit, both fatalNative() branches, non-mac
// window-all-closed, and before-quit), extracted with zero
// require('electron') of its own so a test can require() this module
// directly (main.js itself calls app.whenReady() at module scope and can
// never be safely required by a test) and invoke the exact same callback
// functions electron/main.js registers in production - not merely
// backend-supervisor's terminateAllKnownChildren()/requestAppQuit()
// directly, which only proves the coordinator itself works, not that every
// quit entry actually reaches it.
//
// Every quit entry funnels into one injected `requestAppQuit` - normally
// backend-supervisor.js's own idempotent shutdown coordinator - so this
// module never becomes a second, independently-guarded quit coordinator of
// its own; it only decides *whether* and *when* to call the one it was
// given.

/** Builds the tray Exit / window-all-closed / before-quit callbacks that
 * electron/main.js registers verbatim against real Electron objects
 * (Tray menu template, app.on('window-all-closed'), app.on('before-quit')).
 *
 * `markCleanupComplete()`/`isCleanupComplete()` track whether the
 * coordinator's own final quitApp() has already run, so `beforeQuit` can
 * both (a) prevent quitting while cleanup is still in flight and (b) let
 * the coordinator's own subsequent app.quit() call - which re-fires
 * 'before-quit' - proceed without recursing back into requestAppQuit(). */
function createQuitEntryWiring({ requestAppQuit, platform }) {
  let cleanupComplete = false;

  function markCleanupComplete() {
    cleanupComplete = true;
  }

  function isCleanupComplete() {
    return cleanupComplete;
  }

  /** Tray "Exit" menu item click handler. */
  async function trayExit() {
    await requestAppQuit();
  }

  /** app.on('window-all-closed') handler. Preserves existing macOS
   * behavior: on darwin, all windows closing alone never quits the app
   * (item 4) - only non-mac platforms route through the coordinator here. */
  function windowAllClosed() {
    if (platform === 'darwin') return undefined;
    return requestAppQuit();
  }

  /** app.on('before-quit') handler - covers Dock, application-menu, OS
   * quit requests, and any external/direct app.quit() call. While cleanup
   * is not yet complete, prevents the default quit and instead funnels
   * through the same coordinator as every other entry (a no-op re-entry if
   * a quit is already in flight, since requestAppQuit() is itself
   * idempotent). Once cleanup has completed, the event is left alone so
   * the coordinator's own final app.quit() call - which re-fires this same
   * 'before-quit' handler - is allowed to proceed without recursing. */
  function beforeQuit(event) {
    if (cleanupComplete) return undefined;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    return requestAppQuit();
  }

  return {
    trayExit,
    windowAllClosed,
    beforeQuit,
    markCleanupComplete,
    isCleanupComplete,
  };
}

/** Builds fatalNative()'s coordinator-routing shell: the idempotency gate
 * (via the injected FatalGate-shaped `gate`), the injected `presentDialog`
 * (main.js supplies the real renderer-error-panel + native
 * dialog.showMessageBox sequence - genuinely Electron-only, so it stays
 * injected rather than reimplemented here), and - the part this checklist
 * item cares about - routing both the completion and rejection branches
 * through the single shutdown coordinator instead of each inlining its own
 * appQuitting/terminateBackend/app.quit() sequence. */
function createFatalCoordinator({ gate, requestAppQuit, presentDialog, appendLog }) {
  function fatalNative(code, message, detail) {
    return gate.claim(async () => {
      try {
        await presentDialog(code, message, detail);
      } catch (e) {
        appendLog('exit', `showMessageBox rejected: ${e && e.message}`);
        await requestAppQuit();
        return;
      }
      await requestAppQuit();
    });
  }

  return { fatalNative };
}

module.exports = { createQuitEntryWiring, createFatalCoordinator };
