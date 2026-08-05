import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import backendSupervisor from '../backend-supervisor.js';
import { createQuitEntryWiring, createFatalCoordinator } from '../lifecycle-wiring.js';
import { FatalGate } from '../fatal-gate.js';

// Turn-5 binding checklist ("i5_codex.md") deterministic acceptance tests
// for items 2, 3, 5, and 6: the single idempotent shutdown coordinator, all
// primary-process quit entries routing through it, current-child-identity
// gating on a child's 'error' event, and import-safe/dependency-injected
// lifecycle wiring exercising the *actual* registered callback objects
// (not merely terminateAllKnownChildren()/requestAppQuit() directly).

const {
  supervisorState,
  resetSupervisorStateForTests,
  initSupervisor,
  spawnBackend,
  requestBackendRecovery,
  requestAppQuit,
} = backendSupervisor;

/** Same minimal fake child_process.ChildProcess shape as
 * test_recovery_orchestration.mjs, extended with a 'noop-then-exit' kill
 * behavior: the first kill() call never fires 'exit' (simulating a
 * genuinely unconfirmed termination), but every subsequent kill() call
 * (a later retry, e.g. via terminateAllKnownChildren()) does - fast,
 * without waiting on the real bounded termination timers. */
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
    } else if (killBehavior === 'noop-then-exit' && child.killCalls > 1) {
      setImmediate(() => child.emit('exit', 0));
    }
    // 'no-op' (default when neither branch matches): records the call,
    // never fires exit.
  };
  return child;
}

function freshHooks(overrides = {}) {
  const calls = { setQuitting: [], quitApp: [], fatalNative: [], appendLog: [] };
  const hooks = {
    setQuitting: () => calls.setQuitting.push(true),
    quitApp: () => calls.quitApp.push(true),
    fatalNative: (code, message, detail) => calls.fatalNative.push({ code, message, detail }),
    appendLog: (prefix, text) => calls.appendLog.push({ prefix, text }),
    forceKillProcess: () => {}, // never itself confirms - only a deliberate retry kill() does, in these tests
    ...overrides,
  };
  return { hooks, calls };
}

test.beforeEach(() => {
  resetSupervisorStateForTests();
});

// ---------- item 2: one idempotent asynchronous shutdown coordinator ----------

test('requestAppQuit: concurrent and later calls share one in-flight/settled promise; exactly one final quit', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);
  const child = makeFakeChild({ killBehavior: 'async-exit' });
  spawnBackend({}, { spawnFn: () => child });

  const p1 = requestAppQuit();
  const p2 = requestAppQuit();
  assert.equal(p1, p2, 'concurrent calls must return the exact same in-flight promise');
  await Promise.all([p1, p2]);

  assert.equal(calls.setQuitting.length, 1, 'setQuitting must run exactly once');
  assert.equal(calls.quitApp.length, 1, 'the final app.quit() must run exactly once');

  // A later call, after the coordinator has already settled, is still
  // idempotent - same promise, no re-run.
  const p3 = requestAppQuit();
  assert.equal(p3, p1);
  await p3;
  assert.equal(calls.setQuitting.length, 1);
  assert.equal(calls.quitApp.length, 1);
});

// ---------- item 3: every quit entry routes through the coordinator ----------

test('quitEntryWiring.trayExit: retries a deferred unconfirmed child; app.quit() runs only once termination settles', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  const child = makeFakeChild({ killBehavior: 'noop-then-exit' });
  spawnBackend({}, { spawnFn: () => child });
  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child);
  assert.equal(supervisorState.pythonProcess, null);
  assert.equal(supervisorState.unconfirmedTerminationChild, child, 'must start from a deferred unconfirmed child');
  const killCallsBefore = child.killCalls;

  const quitEntryWiring = createQuitEntryWiring({
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    platform: 'darwin',
  });

  const quitPromise = quitEntryWiring.trayExit();
  assert.equal(calls.quitApp.length, 0, 'app.quit() must remain uncalled while termination is pending');
  await quitPromise;

  assert.ok(child.killCalls > killCallsBefore, 'the deferred unconfirmed child must be retried');
  assert.equal(calls.quitApp.length, 1, 'app.quit() must be called exactly once, after termination settled');
});

test('quitEntryWiring.beforeQuit: prevents default while cleanup is incomplete, then lets the coordinator\'s own final quit through without recursion', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  const child = makeFakeChild({ killBehavior: 'noop-then-exit' });
  spawnBackend({}, { spawnFn: () => child });
  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child);
  assert.equal(supervisorState.unconfirmedTerminationChild, child);

  const quitEntryWiring = createQuitEntryWiring({
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    platform: 'darwin',
  });
  // Real production main.js's quitApp hook calls
  // quitEntryWiring.markCleanupComplete() before app.quit() - simulate that
  // exact contract here, plus the real Electron effect: app.quit() re-fires
  // 'before-quit' synchronously-ish.
  const secondBeforeQuitEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  initSupervisor({}, {
    ...hooks,
    quitApp: () => {
      calls.quitApp.push(true);
      quitEntryWiring.markCleanupComplete();
      quitEntryWiring.beforeQuit(secondBeforeQuitEvent); // the coordinator's own final app.quit() recursing into before-quit
    },
  });

  const firstEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  const p = quitEntryWiring.beforeQuit(firstEvent);
  assert.equal(firstEvent.prevented, true, 'the first before-quit, while cleanup is incomplete, must be prevented');
  await p;

  assert.equal(calls.quitApp.length, 1, 'exactly one final quit');
  assert.equal(
    secondBeforeQuitEvent.prevented, false,
    'the coordinator\'s own final before-quit (post-cleanup) must not be prevented - no recursion back into requestAppQuit()',
  );
});

test('quitEntryWiring.windowAllClosed: preserves macOS behavior (no-op, no quit) but routes non-mac through the coordinator', async () => {
  const { hooks: macHooks, calls: macCalls } = freshHooks();
  initSupervisor({}, macHooks);
  const macWiring = createQuitEntryWiring({
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    platform: 'darwin',
  });
  macWiring.windowAllClosed();
  assert.equal(macCalls.setQuitting.length, 0, 'darwin window-all-closed alone must never begin quitting');
  assert.equal(macCalls.quitApp.length, 0);

  resetSupervisorStateForTests();
  const { hooks: winHooks, calls: winCalls } = freshHooks();
  initSupervisor({}, winHooks);
  const child = makeFakeChild({ killBehavior: 'async-exit' });
  spawnBackend({}, { spawnFn: () => child });
  const winWiring = createQuitEntryWiring({
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    platform: 'win32',
  });
  await winWiring.windowAllClosed();
  assert.equal(winCalls.setQuitting.length, 1, 'non-mac window-all-closed must route through the coordinator');
  assert.equal(winCalls.quitApp.length, 1);
});

test('concurrent quit entries (tray Exit + before-quit) start only one cleanup operation, produce one final quit', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  const child = makeFakeChild({ killBehavior: 'noop-then-exit' });
  spawnBackend({}, { spawnFn: () => child });
  await requestBackendRecovery('STREAM_TEARDOWN_TIMEOUT', child);
  assert.equal(supervisorState.unconfirmedTerminationChild, child);
  const killCallsBefore = child.killCalls;

  const quitEntryWiring = createQuitEntryWiring({
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    platform: 'darwin',
  });

  const fakeEvent = { preventDefault() {} };
  const [r1, r2] = await Promise.all([
    quitEntryWiring.trayExit(),
    quitEntryWiring.beforeQuit(fakeEvent),
  ]);

  // Exactly one retry attempt against the deferred unconfirmed child - the
  // second, overlapping quit entry shared the same in-flight coordinator
  // call rather than starting a second cleanup operation.
  assert.equal(child.killCalls, killCallsBefore + 1, 'only one cleanup/retry attempt for two overlapping quit entries');
  assert.equal(calls.setQuitting.length, 1);
  assert.equal(calls.quitApp.length, 1, 'exactly one final quit for two overlapping quit entries');
});

// ---------- item 3: fatalNative's completion and rejection branches ----------

test('fatalCoordinator: a resolved dialog routes through requestAppQuit exactly once', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);
  const child = makeFakeChild({ killBehavior: 'async-exit' });
  spawnBackend({}, { spawnFn: () => child });

  const { fatalNative } = createFatalCoordinator({
    gate: new FatalGate(),
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    presentDialog: async () => {}, // resolves normally, like a real acknowledged native dialog
    appendLog: () => {},
  });

  await fatalNative('BACKEND_EXIT', 'boom', { exit_code: 1 });
  assert.equal(calls.setQuitting.length, 1);
  assert.equal(calls.quitApp.length, 1);
});

test('fatalCoordinator: a rejected dialog still routes through requestAppQuit exactly once', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);
  const child = makeFakeChild({ killBehavior: 'async-exit' });
  spawnBackend({}, { spawnFn: () => child });

  const { fatalNative } = createFatalCoordinator({
    gate: new FatalGate(),
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    presentDialog: async () => { throw new Error('showMessageBox rejected'); },
    appendLog: () => {},
  });

  await fatalNative('UI_LOAD_FAILED', 'boom', null);
  assert.equal(calls.setQuitting.length, 1);
  assert.equal(calls.quitApp.length, 1);
});

test('fatalCoordinator: the fatal gate absorbs a concurrent duplicate call - one dialog, one coordinator invocation', async () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);
  const child = makeFakeChild({ killBehavior: 'async-exit' });
  spawnBackend({}, { spawnFn: () => child });

  let presentCalls = 0;
  const { fatalNative } = createFatalCoordinator({
    gate: new FatalGate(),
    requestAppQuit: () => backendSupervisor.requestAppQuit(),
    presentDialog: async () => { presentCalls += 1; },
    appendLog: () => {},
  });

  await Promise.all([
    fatalNative('BACKEND_TIMEOUT', 'timeout', null),
    fatalNative('BACKEND_EXIT', 'exit', null),
  ]);
  assert.equal(presentCalls, 1, 'only the first fatal condition presents a dialog');
  assert.equal(calls.quitApp.length, 1, 'exactly one final quit despite two racing fatal conditions');
});

// ---------- item 5: child 'error' gated by current-child identity ----------

test('spawnBackend: a stale/detached child error is ignored; the current child error still reaches fatalNative', () => {
  const { hooks, calls } = freshHooks();
  initSupervisor({}, hooks);

  const staleChild = makeFakeChild();
  const currentChild = makeFakeChild();
  let spawnCallCount = 0;
  const spawnFn = () => {
    spawnCallCount += 1;
    return spawnCallCount === 1 ? staleChild : currentChild;
  };

  spawnBackend({}, { spawnFn });
  assert.equal(supervisorState.pythonProcess, staleChild);
  spawnBackend({}, { spawnFn }); // supersedes staleChild - now detached/stale
  assert.equal(supervisorState.pythonProcess, currentChild);

  staleChild.emit('error', new Error('late error from a detached child'));
  assert.equal(calls.fatalNative.length, 0, 'a stale child\'s error must be ignored, no fatal handling at all');

  currentChild.emit('error', new Error('real error from the current child'));
  assert.equal(calls.fatalNative.length, 1, 'the current child\'s error must still reach fatalNative');
  assert.equal(calls.fatalNative[0].code, 'BACKEND_MISSING');
});
