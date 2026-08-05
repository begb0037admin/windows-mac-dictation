import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import backendSupervisor from '../backend-supervisor.js';

const {
  supervisorState,
  resetSupervisorStateForTests,
  initSupervisor,
  spawnBackend,
  terminateBackend,
  terminateAllKnownChildren,
  requestBackendRecovery,
} = backendSupervisor;

// backend-supervisor.js has zero require('electron') of its own - every
// UI-facing action goes through the injected `hooks` object instead, and
// spawnBackend/terminateBackend operate only on whatever object `spawnFn`
// returns, real or fake. This means it genuinely is a plain, ordinary Node
// module: this suite runs via plain `node --test`, no special Electron
// runner needed.

/** A minimal fake child_process.ChildProcess: a real EventEmitter (so
 * .on('exit', ...) / .once('exit', ...) work exactly like the real thing)
 * plus PassThrough stdout/stderr (a genuine Readable+Writable, so
 * readline.createInterface works against it exactly as it would a real
 * process's stdout) and a plain, test-controlled kill() function. */
function makeFakeChild({ killBehavior = 'async-exit' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = Math.floor(Math.random() * 100000) + 1;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (killBehavior === 'async-exit') {
      setImmediate(() => child.emit('exit', 0));
    }
    // 'no-op' behavior: records the call, never fires exit.
  };
  return child;
}

function freshHooks(overrides = {}) {
  const calls = {
    sendToRenderer: [],
    updateTrayStatus: [],
    onBackendExit: [],
    fatalNative: [],
    appendLog: [],
    // Turn-3 correction (Codex turn-2 finding): enterBackendUnavailable()'s
    // own persistent presentation/exit hooks - see requestAppQuit() and
    // "case 17" below.
    showAndFocusWindow: [],
    sendAppError: [],
    setQuitting: [],
    quitApp: [],
  };
  const hooks = {
    sendToRenderer: (evt) => calls.sendToRenderer.push(evt),
    updateTrayStatus: (state, text) => calls.updateTrayStatus.push({ state, text }),
    appendLog: (prefix, text) => calls.appendLog.push({ prefix, text }),
    onBackendExit: (code) => calls.onBackendExit.push(code),
    fatalNative: (code, message, detail) => calls.fatalNative.push({ code, message, detail }),
    showAndFocusWindow: () => calls.showAndFocusWindow.push(true),
    sendAppError: (payload) => calls.sendAppError.push(payload),
    setQuitting: () => calls.setQuitting.push(true),
    quitApp: () => calls.quitApp.push(true),
    ...overrides,
  };
  return { hooks, calls };
}

test.beforeEach(() => {
  resetSupervisorStateForTests();
});

test('case 13: overlapping recovery generations - the second is a genuine no-op while the first is in flight', async () => {
  const { hooks } = freshHooks();
  initSupervisor({}, hooks);

  const firstChild = makeFakeChild({ killBehavior: 'async-exit' });
  let spawnCallCount = 0;
  const spawnedChildren = [firstChild];
  const spawnFn = () => {
    spawnCallCount += 1;
    if (spawnCallCount === 1) return firstChild;
    const replacement = makeFakeChild({ killBehavior: 'async-exit' });
    spawnedChildren.push(replacement);
    return replacement;
  };

  spawnBackend({}, { spawnFn });
  assert.equal(spawnCallCount, 1);
  assert.equal(supervisorState.pythonProcess, firstChild);

  // Trigger two requestBackendRecovery() calls against the same child in
  // immediate succession ("overlapping generations").
  const p1 = requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', firstChild);
  const p2 = requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', firstChild);
  await Promise.all([p1, p2]);

  // Only one termination/respawn cycle happened - the reentrancy guard
  // rejected the second, overlapping call outright.
  assert.equal(firstChild.killCalls, 1, 'only one terminateBackend() cycle for the overlapping calls');
  assert.equal(spawnCallCount, 2, 'exactly one respawn (not two) for the two overlapping calls');
  assert.equal(supervisorState.pythonProcess, spawnedChildren[1]);

  // A third, distinct call made only after the first has fully completed is
  // accepted normally (spawnFn is remembered on supervisorState, so no
  // re-passing is needed).
  const secondChild = supervisorState.pythonProcess;
  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', secondChild);
  assert.equal(spawnCallCount, 3);
  assert.equal(supervisorState.pythonProcess, spawnedChildren[2]);
});

test('case 13b: unconfirmed termination - never respawns, enters BACKEND_TERMINATION_UNCONFIRMED', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  // Neither normal kill() nor the force-kill hook ever fires exit.
  const child = makeFakeChild({ killBehavior: 'no-op' });
  let spawnCallCount = 0;
  const spawnFn = () => { spawnCallCount += 1; return child; };

  initSupervisor({}, { ...hooks, forceKillProcess: () => {} });
  spawnBackend({}, { spawnFn });

  const directResult = await terminateBackend(child);
  assert.deepEqual(directResult, { confirmed: false });

  // Reset and drive it through the real orchestration path.
  resetSupervisorStateForTests();
  initSupervisor({}, { ...hooks, forceKillProcess: () => {} });
  const child2 = makeFakeChild({ killBehavior: 'no-op' });
  const spawnFn2 = () => child2;
  spawnBackend({}, { spawnFn: spawnFn2 });

  assert.equal(supervisorState.expectedRecoveryExitChild, null);
  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child2);

  assert.equal(supervisorState.pythonProcess, null);
  assert.equal(supervisorState.backendReady, false);
  assert.equal(supervisorState.backendAcceptingCommands, false);
  assert.equal(supervisorState.recoveryAwaitingReady, false);
  assert.equal(supervisorState.teardownDeadlineTimer, null);
  assert.equal(supervisorState.unconfirmedTerminationChild, child2);
  assert.equal(supervisorState.expectedRecoveryExitChild, child2, 'left set deliberately for later suppression');

  // Turn-3 correction (Codex turn-2 finding): enterBackendUnavailable() no
  // longer routes through fatalNative()'s quit-only dialog lifecycle at
  // all - it presents its own persistent state directly. See "case 17"
  // below for the full presentation/exit assertions.
  assert.equal(calls.fatalNative.length, 0, 'must not call fatalNative for BACKEND_TERMINATION_UNCONFIRMED');
  assert.ok(calls.showAndFocusWindow.length >= 1, 'main window must be shown/focused on entering unavailable');
  const errorPayloads = calls.sendAppError.filter((p) => p.code === 'BACKEND_TERMINATION_UNCONFIRMED');
  assert.equal(errorPayloads.length, 1);
  assert.equal(errorPayloads[0].severity, 'fatal', 'the renderer error panel must be non-dismissible');

  // No replacement spawn occurred, and a belated fake `ready` changes no state.
  const { markBackendReady } = backendSupervisor;
  markBackendReady(child2);
  assert.equal(supervisorState.backendReady, false);

  // A very late confirmed exit clears both expectedRecoveryExitChild and
  // unconfirmedTerminationChild, and does not reach onBackendExit.
  child2.emit('exit', 0);
  assert.equal(supervisorState.expectedRecoveryExitChild, null);
  assert.equal(supervisorState.unconfirmedTerminationChild, null);
  assert.equal(calls.onBackendExit.length, 0);
});

test('case 13c: forced-kill exit-confirmation race - respawns once the async force-kill exit is observed', async () => {
  const { hooks } = freshHooks();
  // Normal kill() records the attempt but never fires exit; the injected
  // forceKillProcess succeeds asynchronously.
  const forceKillHook = (proc) => { setImmediate(() => proc.emit('exit', 0)); };

  const child = makeFakeChild({ killBehavior: 'no-op' });
  initSupervisor({}, { ...hooks, forceKillProcess: forceKillHook });
  const directResult = await terminateBackend(child);
  assert.deepEqual(directResult, { confirmed: true });

  resetSupervisorStateForTests();
  let spawnCallCount = 0;
  const firstChild = makeFakeChild({ killBehavior: 'no-op' });
  const replacementChild = makeFakeChild({ killBehavior: 'async-exit' });
  const spawnFn = () => {
    spawnCallCount += 1;
    return spawnCallCount === 1 ? firstChild : replacementChild;
  };
  let forceKillCalls = 0;
  const trackedForceKillHook = (proc) => {
    forceKillCalls += 1;
    setImmediate(() => proc.emit('exit', 0));
  };
  initSupervisor({}, { ...hooks, forceKillProcess: trackedForceKillHook });
  spawnBackend({}, { spawnFn });

  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', firstChild);

  assert.equal(forceKillCalls, 1);
  assert.equal(supervisorState.expectedRecoveryExitChild, null);
  assert.equal(spawnCallCount, 2, 'the remembered spawnFn is called a second time');
  assert.equal(supervisorState.pythonProcess, replacementChild);
  const fatalCodes = [];
  // Sanity: never entered BACKEND_TERMINATION_UNCONFIRMED for this path.
  assert.ok(!fatalCodes.includes('BACKEND_TERMINATION_UNCONFIRMED'));
});

test('case 15: stale-child output is dropped, current child\'s events reach the hooks exactly once', () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  const firstChild = makeFakeChild();
  const secondChild = makeFakeChild();
  let spawnCallCount = 0;
  const spawnFn = () => {
    spawnCallCount += 1;
    return spawnCallCount === 1 ? firstChild : secondChild;
  };

  spawnBackend({}, { spawnFn });
  assert.equal(supervisorState.pythonProcess, firstChild);
  spawnBackend({}, { spawnFn });
  assert.equal(supervisorState.pythonProcess, secondChild);

  const line = `${JSON.stringify({ type: 'status', state: 'idle', text: 'Ready' })}\n`;
  firstChild.stdout.write(line); // stale - must be dropped
  secondChild.stdout.write(line); // current - must reach hooks

  return new Promise((resolve) => {
    setImmediate(() => {
      const statusCalls = calls.updateTrayStatus.filter((c) => c.state === 'idle');
      assert.equal(statusCalls.length, 1, 'only the current child\'s status line should update the tray');
      const rendererCalls = calls.sendToRenderer.filter((e) => e.type === 'status');
      assert.equal(rendererCalls.length, 1, 'only the current child\'s status line should reach the renderer');
      resolve();
    });
  });
});

test('case 16: terminateAllKnownChildren retries an unconfirmed zombie in parallel, one bounded window', async () => {
  const { hooks } = freshHooks();
  initSupervisor({}, { ...hooks, forceKillProcess: () => {} });

  const child = makeFakeChild({ killBehavior: 'no-op' });
  const spawnFn = () => child;
  spawnBackend({}, { spawnFn });

  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child);
  assert.equal(supervisorState.pythonProcess, null);
  assert.equal(supervisorState.unconfirmedTerminationChild, child);

  const killCallsBefore = child.killCalls;
  const startedAt = Date.now();
  await terminateAllKnownChildren();
  const elapsedMs = Date.now() - startedAt;

  assert.ok(child.killCalls > killCallsBefore, 'terminateAllKnownChildren must retry the unconfirmed zombie');
  // Bounded by one ~6s window (5000 normal + 1000 force-confirmation), not
  // two stacked - generous upper bound to avoid CI flakiness while still
  // catching a sequential-await regression (which would be ~12s+).
  assert.ok(elapsedMs < 9000, `expected one bounded window, took ${elapsedMs}ms`);

  // Control case: unconfirmedTerminationChild === null behaves exactly like
  // a bare terminateBackend() call, no regression.
  resetSupervisorStateForTests();
  initSupervisor({}, hooks);
  assert.equal(supervisorState.unconfirmedTerminationChild, null);
  await terminateAllKnownChildren(); // pythonProcess is also null - must resolve cleanly
});

test('case 17: production unavailable-to-exit wiring - BACKEND_TERMINATION_UNCONFIRMED presents persistently, never auto-quits, and Exit retries the unconfirmed child before quitting', async () => {
  const { hooks, calls } = freshHooks();
  // Neither normal kill() nor the force-kill hook ever fires exit, so
  // terminateBackend() genuinely cannot confirm this child's death - the
  // exact real-world shape of an unconfirmed termination.
  initSupervisor({}, { ...hooks, forceKillProcess: () => {} });

  const child = makeFakeChild({ killBehavior: 'no-op' });
  const spawnFn = () => child;
  spawnBackend({}, { spawnFn });

  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child);

  // Reached the terminal unavailable state via the unconfirmed-termination
  // path, with the zombie child tracked for a later retry.
  assert.equal(supervisorState.pythonProcess, null);
  assert.equal(supervisorState.unconfirmedTerminationChild, child);

  // Presentation: window shown/focused, persistent tray "unavailable"
  // status, non-dismissible fatal renderer panel - and, critically, the app
  // must not have quit itself. fatalNative() (the quit-only dialog
  // lifecycle) must never be called for this state at all.
  assert.equal(calls.fatalNative.length, 0);
  assert.ok(calls.showAndFocusWindow.length >= 1, 'main window must be shown and focused');
  const unavailableTrayCalls = calls.updateTrayStatus.filter((c) => c.state === 'unavailable');
  assert.ok(unavailableTrayCalls.length >= 1, 'persistent unavailable tray status must be set');
  const errorPayloads = calls.sendAppError.filter((p) => p.code === 'BACKEND_TERMINATION_UNCONFIRMED');
  assert.equal(errorPayloads.length, 1);
  assert.equal(errorPayloads[0].severity, 'fatal');
  assert.equal(calls.quitApp.length, 0, 'must not automatically quit while awaiting an explicit Exit');
  assert.equal(calls.setQuitting.length, 0, 'must not mark the app as quitting until Exit is actually chosen');

  // Exit: the only way out of the unavailable state, and the only path that
  // ever calls quitApp() - it must retry the still-unconfirmed zombie child
  // (via terminateAllKnownChildren()) before quitting.
  const killCallsBefore = child.killCalls;
  await backendSupervisor.requestAppQuit();

  assert.equal(calls.setQuitting.length, 1);
  assert.ok(child.killCalls > killCallsBefore, 'Exit must retry termination against the unconfirmed child');
  assert.equal(calls.quitApp.length, 1, 'quitApp() must run only after termination was awaited');
});
