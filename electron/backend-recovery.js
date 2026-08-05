'use strict';

// Pure functions for the backend-recovery design (CoreAudio stream-teardown
// hang fix) - no Electron API dependency, so this is directly unit-testable
// (electron/tests/test_backend_recovery.mjs) without a full Electron test
// harness. See FINAL_BRIEF.md's "windows-mac-dictation: CoreAudio
// Stream-Teardown Hang & macOS Tray Icon Fix" for the full design.

/** Tracks recovery attempts within a rolling window. Three permitted
 * recoveries in 60,000 ms by default; a fourth within the window is
 * refused. State is Electron-process-local and resets only when the app
 * itself restarts (a fresh RecoveryWindow instance). */
class RecoveryWindow {
  constructor({ maxRecoveries = 3, windowMs = 60000 } = {}) {
    this.maxRecoveries = maxRecoveries;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  /** Removes timestamps outside the window, records this request, and
   * returns true for requests one through maxRecoveries, false for any
   * request beyond that within the same rolling window. */
  record(now) {
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRecoveries) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

/** Strict object-identity comparison - true only when both are the same
 * non-null child-process reference. Used to suppress a real recovery-driven
 * child exit from being misclassified as an unrelated crash, and nowhere
 * else (an unrelated exit must still reach the normal fatal path). */
function isExpectedRecoveryExit(exitedChild, expectedExitChild) {
  return exitedChild != null && expectedExitChild != null && exitedChild === expectedExitChild;
}

/** True only when both arguments are the same non-null reference - i.e. the
 * event/line under consideration genuinely came from the currently-tracked
 * child process, not a stale one whose output arrived after a newer child
 * has already taken over. */
function shouldProcessChildEvent(child, currentPythonProcess) {
  return child != null && child === currentPythonProcess;
}

/** The entire parse-and-gate sequence for one raw stdout line from a given
 * child, extracted as a single exported function so a test exercising it
 * proves the *real* call site behaves correctly, not just that the
 * predicate alone is correct in isolation (see FINAL_BRIEF.md's seventh
 * handoff-review gap). Returns the parsed event object, or null for a
 * blank line, a stale child's line, or malformed JSON. */
function parseAndGateBackendLine(line, child, currentPythonProcess) {
  if (!line || !line.trim()) return null;
  if (!shouldProcessChildEvent(child, currentPythonProcess)) return null; // stale child
  try {
    return JSON.parse(line);
  } catch (e) {
    return null; // malformed JSON - caller logs this distinctly
  }
}

module.exports = {
  RecoveryWindow,
  isExpectedRecoveryExit,
  shouldProcessChildEvent,
  parseAndGateBackendLine,
};
