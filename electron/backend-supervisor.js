'use strict';

// Owns all backend child-process recovery state and orchestration logic:
// spawning, teardown-deadline arming, expected-vs-unexpected exit
// suppression, the bounded (3-per-60s) auto-recovery budget, and the
// terminal "unavailable" state. Extracted out of electron/main.js so it can
// be require()'d import-safely by a test (main.js calls app.whenReady() at
// module scope, so it can never be safely required by a test) and so its
// state genuinely reflects the current value at all times (a single shared
// mutable object, never bare module-level `let`s that would be stale
// CommonJS snapshots if ever exported).
//
// Zero top-level Electron/app-lifecycle side effects of its own - every
// UI-facing action goes through the injected `hooks` object instead of a
// direct Electron import, matching this codebase's existing pattern of
// separating pure/stateful logic from the Electron bootstrap
// (electron/diagnostics.js, electron/tray-icon-path.js,
// electron/backend-recovery.js itself).
//
// See FINAL_BRIEF.md's "windows-mac-dictation: CoreAudio Stream-Teardown
// Hang & macOS Tray Icon Fix" for the full design and every handoff-review
// gap this module closes.

const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const {
  RecoveryWindow,
  isExpectedRecoveryExit,
  shouldProcessChildEvent,
  parseAndGateBackendLine,
} = require('./backend-recovery');

const NORMAL_TERMINATION_TIMEOUT_MS = 5000;
const FORCE_KILL_EXIT_CONFIRMATION_MS = 1000;
const BACKEND_TEARDOWN_DEADLINE_MS = 4000;

// Every callback this module actually calls internally, including
// clearDeadlines (pre-existing readiness-timeout bookkeeping that stays in
// electron/main.js, since it also manages the unrelated
// startup-progress-deadline feature) and resolveBackendLaunch (the
// packaged-vs-dev command/env/windowsHide resolution, which genuinely needs
// the real Electron `app` module - kept out of this file entirely rather
// than half-imported).
const DEFAULT_HOOKS = {
  updateTrayStatus() {},
  sendToRenderer() {},
  appendLog() {},
  fatalNative() {},
  onBackendExit() {},
  clearDeadlines() {},
  // Turn-3 correction (Codex turn-2 finding): enterBackendUnavailable() must
  // present its own persistent, retry-capable UI rather than routing through
  // fatalNative()'s quit-only dialog lifecycle - see enterBackendUnavailable()
  // and requestAppQuit() below. showAndFocusWindow/sendAppError present the
  // state; setQuitting/quitApp are the only way out of it, and always go
  // through requestAppQuit() so terminateAllKnownChildren() is awaited first.
  showAndFocusWindow() {},
  sendAppError() {},
  setQuitting() {},
  quitApp() {},
  // Not part of this brief's own recovery design (the pre-existing
  // startup-progress-deadline feature, unrelated to teardown recovery) -
  // added as a hook so a replacement backend spawned by
  // requestBackendRecovery()'s own direct spawnBackend() call still gets a
  // real readiness watchdog, exactly like every other spawn. Implementer
  // decision, not itself a named FINAL_BRIEF.md gap - see i1_claude.md.
  armDeadlines() {},
  resolveBackendLaunch() {
    return { command: null, args: [], cwd: undefined, env: {}, windowsHide: false };
  },
  forceKillProcess(proc) {
    if (process.platform === 'win32' && proc.pid) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f']);
    } else if (proc.pid) {
      proc.kill('SIGKILL');
    }
  },
};

const supervisorState = {
  pythonProcess: null,
  backendReady: false,
  backendAcceptingCommands: false, // matches backendReady's existing false-until-ready convention
  expectedRecoveryExitChild: null,
  unconfirmedTerminationChild: null, // separate from expectedRecoveryExitChild's exit-suppression purpose
  recoveryAwaitingReady: false,
  teardownDeadlineTimer: null,
  recoveryInFlight: false, // serializes requestBackendRecovery()
  spawnFn: spawn, // real spawn in production; a test overrides this once and every later respawn reuses it automatically
  recoveryWindow: new RecoveryWindow(),
  mainWindow: null, // set once via initSupervisor()
  hooks: { ...DEFAULT_HOOKS }, // set once via initSupervisor(); a test supplying only some hooks does not lose the rest
};

function initSupervisor(win, hooks) {
  supervisorState.mainWindow = win;
  supervisorState.hooks = { ...DEFAULT_HOOKS, ...hooks }; // merge, never replace
}

function resetSupervisorStateForTests() {
  Object.assign(supervisorState, {
    pythonProcess: null,
    backendReady: false,
    backendAcceptingCommands: false,
    expectedRecoveryExitChild: null,
    unconfirmedTerminationChild: null,
    recoveryAwaitingReady: false,
    teardownDeadlineTimer: null,
    recoveryInFlight: false,
    spawnFn: spawn,
    recoveryWindow: new RecoveryWindow(),
    mainWindow: null,
    hooks: { ...DEFAULT_HOOKS },
  });
}

// ---------- teardown deadline (Electron-side watchdog, independent of Python's own) ----------

function clearBackendTeardownDeadline() {
  if (supervisorState.teardownDeadlineTimer) {
    clearTimeout(supervisorState.teardownDeadlineTimer);
    supervisorState.teardownDeadlineTimer = null;
  }
}

/** Arms a 4-second timer independent of Python's own 3-second bounded
 * teardown helper - the deliberate outside-Python fallback for when a
 * native call prevents Python's own watchdog from ever running at all. If
 * Python's own STREAM_TEARDOWN_TIMEOUT/STREAM_CLOSE_ERROR recovery event
 * never arrives, this timer's own expiry still terminates the child. */
function armBackendTeardownDeadline(child) {
  clearBackendTeardownDeadline();
  supervisorState.teardownDeadlineTimer = setTimeout(() => {
    supervisorState.teardownDeadlineTimer = null;
    if (child !== supervisorState.pythonProcess) return; // stale timer, e.g. a race with an already-cleared/replaced child
    requestBackendRecovery('ELECTRON_TEARDOWN_DEADLINE_EXCEEDED', child).catch((err) => {
      supervisorState.hooks.appendLog('main', `requestBackendRecovery failed: ${err && err.message}`);
      enterBackendUnavailable('BACKEND_RECOVERY_INTERNAL_ERROR');
    });
  }, BACKEND_TEARDOWN_DEADLINE_MS);
}

// ---------- termination ----------

/** SS12.2-style bounded termination: normal termination first (5,000 ms),
 * then a targeted force-kill if that doesn't produce an `exit`, followed by
 * a further bounded 1,000 ms grace for that forced kill's own asynchronous
 * exit. Every resolution has one unambiguous shape: `{ confirmed: true }`
 * only when the target is absent or its `exit` event was actually observed;
 * `{ confirmed: false }` only after both windows expire. Worst-case total
 * wait is 6,000 ms. */
function terminateBackend(targetProcess = supervisorState.pythonProcess) {
  return new Promise((resolve) => {
    if (!targetProcess) return resolve({ confirmed: true });
    const proc = targetProcess;
    let settled = false;
    let normalTimer = null;
    let forceConfirmationTimer = null;

    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (normalTimer) clearTimeout(normalTimer);
      if (forceConfirmationTimer) clearTimeout(forceConfirmationTimer);
      proc.removeListener('exit', confirmExit);
      resolve({ confirmed });
    };
    const confirmExit = () => finish(true);

    proc.once('exit', confirmExit);
    try { proc.kill(); } catch (e) { /* already gone */ }
    if (settled) return;

    normalTimer = setTimeout(() => {
      if (settled) return;
      try { supervisorState.hooks.forceKillProcess(proc); } catch (e) { /* best effort */ }
      if (settled) return;
      forceConfirmationTimer = setTimeout(
        () => finish(false),
        FORCE_KILL_EXIT_CONFIRMATION_MS,
      );
    }, NORMAL_TERMINATION_TIMEOUT_MS);
  });
}

/** Called from the Exit menu action. Awaited before app.quit() actually
 * runs, so a genuinely-unconfirmed-terminated zombie (tracked only in
 * unconfirmedTerminationChild once enterBackendUnavailable() has nulled
 * pythonProcess) gets a real second termination attempt instead of
 * surviving Exit. Run in parallel, not sequentially, so total added Exit
 * latency is bounded by one 6-second terminateBackend() window, not two
 * stacked. */
async function terminateAllKnownChildren() {
  await Promise.all([
    terminateBackend(supervisorState.pythonProcess),
    supervisorState.unconfirmedTerminationChild
      ? terminateBackend(supervisorState.unconfirmedTerminationChild)
      : Promise.resolve(),
  ]);
}

/** The single, exclusive way this application ever actually quits (Turn-3
 * correction, Codex turn-2 finding). Every exit path - the tray's own Exit
 * item, and any native-dialog Quit button a caller retains elsewhere - must
 * route through this function rather than calling hooks.quitApp() directly,
 * so terminateAllKnownChildren() (including a retry against a still-tracked
 * unconfirmedTerminationChild left over from an earlier unconfirmed
 * termination) is always awaited first. Sets the quitting flag before
 * termination begins so any exit events observed during teardown are
 * correctly treated as expected. */
async function requestAppQuit() {
  supervisorState.hooks.setQuitting();
  await terminateAllKnownChildren();
  supervisorState.hooks.quitApp();
}

// ---------- readiness ----------

/** Rejects stale-child readiness before changing any module state - a
 * replacement child's `ready` re-enables commands and clears recovery
 * state/tray text; a stale child's `ready` changes nothing. */
function markBackendReady(child) {
  if (supervisorState.pythonProcess !== child) return;

  supervisorState.backendReady = true;
  supervisorState.hooks.clearDeadlines();
  supervisorState.backendAcceptingCommands = true;

  if (supervisorState.recoveryAwaitingReady) {
    supervisorState.recoveryAwaitingReady = false;
    supervisorState.hooks.updateTrayStatus('idle', '');
  }
}

// ---------- terminal unavailable state ----------

/** Establishes the terminal-state invariants explicitly rather than relying
 * on caller history: clears the teardown deadline and sets
 * pythonProcess/backendReady/backendAcceptingCommands/recoveryAwaitingReady
 * to their closed-for-good values on entry, regardless of the exact caller
 * or code path that reached this state. Does not interfere with
 * expectedRecoveryExitChild-based exit suppression (a separate mechanism) -
 * a later real exit from a detached zombie is still correctly handled.
 *
 * Turn-3 correction (Codex turn-2 finding): this used to call
 * hooks.fatalNative(), whose real production implementation presents a
 * Quit-only native dialog and then unconditionally calls terminateBackend()
 * (not terminateAllKnownChildren()) and app.quit() - silently replacing the
 * intended persistent unavailable state (usable Show/Exit tray entries, an
 * unconfirmed child retried on the way out) with the ordinary quit-on-ack
 * fatal lifecycle, and never retrying unconfirmedChild before the app
 * disappears. This state must instead stay alive and interactive: show and
 * focus the main window, present the non-dismissible fatal renderer error
 * panel directly (never fatalNative's native dialog), and leave quitting to
 * requestAppQuit() alone - the only path that awaits
 * terminateAllKnownChildren() (including a retry against unconfirmedChild)
 * before the app actually exits. */
function enterBackendUnavailable(code, unconfirmedChild = null) {
  clearBackendTeardownDeadline();
  supervisorState.pythonProcess = null;
  supervisorState.backendReady = false;
  supervisorState.backendAcceptingCommands = false;
  supervisorState.recoveryAwaitingReady = false;
  if (unconfirmedChild) {
    supervisorState.unconfirmedTerminationChild = unconfirmedChild;
  }

  const message = 'Dictation unavailable — exit and restart the app';
  supervisorState.hooks.sendToRenderer({ type: 'status', state: 'unavailable', text: message });
  supervisorState.hooks.updateTrayStatus('unavailable', message);
  supervisorState.hooks.showAndFocusWindow();
  supervisorState.hooks.sendAppError({ severity: 'fatal', code, message, detail: { code } });
}

// ---------- recovery orchestration ----------

/** Strictly serialized: a second recovery can never begin until the first
 * child is confirmed dead (via the reentrancy guard below), at which point
 * expectedRecoveryExitChild has already been naturally cleared by the
 * child's own `exit` handler - there is structurally never more than one
 * outstanding expected exit to track. */
async function requestBackendRecovery(code, child) {
  if (supervisorState.recoveryInFlight) return;
  if (child !== supervisorState.pythonProcess) return; // stale call - rejects calls from any child other than the current one

  supervisorState.recoveryInFlight = true;
  try {
    clearBackendTeardownDeadline();
    supervisorState.backendAcceptingCommands = false;

    supervisorState.expectedRecoveryExitChild = child;
    supervisorState.hooks.sendToRenderer({ type: 'status', state: 'recovering', text: 'Recovering from an audio problem…' });
    supervisorState.hooks.updateTrayStatus('recovering', 'Recovering from an audio problem…');

    const terminationResult = await terminateBackend(child);

    if (!terminationResult.confirmed) {
      // Do not respawn, regardless of recoveryWindow state - leave
      // expectedRecoveryExitChild set deliberately so a later real exit
      // from the zombie is still suppressed rather than firing a confusing
      // fatal dialog on top of the already-shown unavailable state.
      enterBackendUnavailable('BACKEND_TERMINATION_UNCONFIRMED', child);
      return;
    }

    if (supervisorState.recoveryWindow.record(Date.now())) {
      supervisorState.recoveryAwaitingReady = true;
      spawnBackend(supervisorState.mainWindow);
    } else {
      // Fourth recovery within 60 seconds, with a confirmed exit - no
      // unconfirmed child to track, so the second argument is omitted.
      supervisorState.recoveryAwaitingReady = false;
      enterBackendUnavailable('BACKEND_RECOVERY_LIMIT');
    }
  } finally {
    supervisorState.recoveryInFlight = false;
  }
}

// ---------- event handling ----------

function handleBackendEvent(child, evt) {
  if (evt.type === 'stream_teardown' && evt.phase === 'started') {
    armBackendTeardownDeadline(child);
  } else if (evt.type === 'stream_teardown' && evt.phase === 'completed') {
    if (child === supervisorState.pythonProcess) clearBackendTeardownDeadline();
  } else if (evt.type === 'backend_recovery_required') {
    requestBackendRecovery(evt.code, child).catch((err) => {
      supervisorState.hooks.appendLog('main', `requestBackendRecovery failed: ${err && err.message}`);
      enterBackendUnavailable('BACKEND_RECOVERY_INTERNAL_ERROR');
    });
  } else if (evt.type === 'status') {
    supervisorState.hooks.updateTrayStatus(evt.state, evt.text);
  } else if (evt.type === 'ready') {
    markBackendReady(child);
  }
  supervisorState.hooks.sendToRenderer(evt);
}

// ---------- spawn ----------

/** spawnBackend(win, { spawnFn } = {}): no longer takes `hooks` as its own
 * parameter - electron/main.js calls initSupervisor(win, hooks) exactly
 * once at real startup, before ever calling spawnBackend(), so every
 * function in this module reads supervisorState.mainWindow/hooks rather
 * than needing them re-passed on every call. If spawnFn is explicitly
 * passed, it's recorded on supervisorState before spawning (remembered for
 * this and every later call, including requestBackendRecovery()'s own
 * respawn); otherwise uses whatever supervisorState.spawnFn already is. */
function spawnBackend(win, { spawnFn } = {}) {
  if (win) supervisorState.mainWindow = win;
  if (spawnFn) supervisorState.spawnFn = spawnFn;

  const launch = supervisorState.hooks.resolveBackendLaunch();
  const { command, args, cwd, env, windowsHide } = launch;

  const spawnOptions = { cwd, env };
  if (windowsHide) spawnOptions.windowsHide = true;

  let child;
  try {
    child = supervisorState.spawnFn(command, args, spawnOptions);
  } catch (e) {
    supervisorState.hooks.fatalNative('BACKEND_MISSING', 'The dictation backend could not be started.', {
      error_class: e && e.constructor ? e.constructor.name : 'Error',
    });
    return null;
  }
  supervisorState.pythonProcess = child;
  supervisorState.backendReady = false;
  supervisorState.backendAcceptingCommands = false;
  supervisorState.hooks.armDeadlines();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const evt = parseAndGateBackendLine(line, child, supervisorState.pythonProcess);
    if (evt === null) {
      if (line && line.trim() && shouldProcessChildEvent(child, supervisorState.pythonProcess)) {
        // A non-stale line that specifically failed JSON parsing is worth a
        // log line; a blank line or a stale child's line is not (volume
        // would be noise).
        supervisorState.hooks.appendLog('main', `malformed JSON from backend, skipping (len=${line.length})`);
      }
      return;
    }
    handleBackendEvent(child, evt);
  });

  if (child.stderr) {
    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on('line', (line) => supervisorState.hooks.appendLog('diag', line));
  }

  if (typeof child.on === 'function') {
    child.on('error', (err) => {
      supervisorState.hooks.fatalNative('BACKEND_MISSING', 'The dictation backend could not be started.', {
        error_class: err && err.constructor ? err.constructor.name : 'Error',
      });
    });

    child.on('exit', (code) => {
      const expectedRecoveryExit = isExpectedRecoveryExit(child, supervisorState.expectedRecoveryExitChild);
      if (supervisorState.pythonProcess === child) supervisorState.pythonProcess = null;

      if (expectedRecoveryExit) {
        supervisorState.expectedRecoveryExitChild = null;
        if (supervisorState.unconfirmedTerminationChild === child) {
          supervisorState.unconfirmedTerminationChild = null; // a later-confirmed exit clears this too - nothing left for Exit to retry
        }
        return;
      }

      supervisorState.hooks.onBackendExit(code);
    });
  }

  return child;
}

module.exports = {
  supervisorState,
  resetSupervisorStateForTests,
  initSupervisor,
  spawnBackend,
  terminateBackend,
  terminateAllKnownChildren,
  requestAppQuit,
  requestBackendRecovery,
  handleBackendEvent,
  markBackendReady,
  armBackendTeardownDeadline,
  clearBackendTeardownDeadline,
  enterBackendUnavailable,
};
