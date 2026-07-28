'use strict';

// SS13 step 1's idempotency in isolation: the single module-level
// fatal-handling promise that makes a duplicate fatalNative() call (e.g.
// the SS12.2 timeout path racing against a delayed SS12.1 backend-exit
// event) a no-op instead of a second dialog. Directly unit-testable
// (electron/tests/test_fatal_lifecycle.mjs) without Electron: create a
// gate, call claim() twice concurrently with different actions, and
// assert the second call's action never runs and both callers get the
// first call's result.

class FatalGate {
  constructor() {
    this._promise = null;
  }

  /** Runs `action` only on the first call; every call (including the
   * first) returns the same promise/result. */
  claim(action) {
    if (this._promise) return this._promise;
    this._promise = Promise.resolve().then(action);
    return this._promise;
  }

  get claimed() {
    return this._promise !== null;
  }
}

module.exports = { FatalGate };
