'use strict';

// Electron shell for windows-mac-dictation. Owns the window (frameless,
// transparent, shaped via CSS) and spawns the Python backend (dev: `python
// main.py`; packaged: the frozen push2talk-backend executable) as a child
// process, speaking one JSON object per line over its stdio: the backend's
// stdout is events (state/transcript/config/...) forwarded to the renderer
// via 'backend-event'; the renderer's commands (send_text/dismiss/
// get_config/save_config) come back via 'backend-command' and are written
// to the backend's stdin. See main.py's module docstring for the Python
// side of this.
//
// This file also owns: the unified fatal lifecycle (FINAL_BRIEF.md SS12/13,
// push2talk-packaging run), the login-item toggle/reconciliation contract
// (SS11), and the runtime diagnostics sanitization boundary (SS15).

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { sanitizeStderrLine } = require('./diagnostics');
const { applyAutostartToggle, reconcileLoginItemOnStartup } = require('./login-item-logic');
const { FatalGate } = require('./fatal-gate');
const { installSingleInstanceGuard } = require('./single-instance-logic');
const { trayIconPath } = require('./tray-icon-path');
const backendSupervisor = require('./backend-supervisor');
const { createQuitEntryWiring, createFatalCoordinator } = require('./lifecycle-wiring');

const REPO_ROOT = path.join(__dirname, '..');

// ---------- SS15: runtime diagnostics sanitization boundary ----------
// Scope: backend.log / backend.log.1 / error UI / native dialog only.
// Build-time output is a different, unrestricted category - see FINAL_BRIEF.md.
// sanitizeStderrLine itself lives in diagnostics.js (no Electron dependency,
// directly unit-tested by electron/tests/test_diagnostics.mjs).

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_PATH = path.join(LOG_DIR, 'backend.log');
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size >= LOG_ROTATE_BYTES) {
      const rotated = `${LOG_PATH}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch (e) { /* fine if absent */ }
      fs.renameSync(LOG_PATH, rotated);
    }
  } catch (e) {
    // LOG_PATH doesn't exist yet - nothing to rotate.
  }
}

function appendLog(prefix, text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${prefix}] ${text}\n`, 'utf8');
  } catch (e) {
    console.error('[log] failed to write backend.log:', e.message);
  }
}

// ---------- build info (Kevin, 2026-07-31: too many installers built by
// hand to keep track of which one is actually running - the app should be
// able to say for itself) ----------

function resolveBuildInfo() {
  if (app.isPackaged) {
    const infoPath = path.join(process.resourcesPath, 'build-info.json');
    try {
      return JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch (e) {
      // Should never happen (generate-builder-config.js always ships this
      // file) - fail soft rather than block the app over a version label.
      return { version: app.getVersion(), gitSha: 'unknown', gitDirty: null, runId: 'unknown', builtAt: null };
    }
  }
  // Dev mode (`npm start`): no build-info.json exists (nothing ran
  // generate-builder-config.js), so ask git directly for the same info a
  // real build would have baked in.
  const sha = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    version: app.getVersion(),
    gitSha: sha.status === 0 ? sha.stdout.trim() || 'unknown' : 'unknown',
    gitDirty: dirty.status === 0 ? dirty.stdout.trim() !== '' : null,
    runId: 'dev',
    builtAt: null,
  };
}

// ---------- backend command resolution (dev vs packaged) ----------

function resolveBackendCommand() {
  if (app.isPackaged) {
    const backendDir = path.join(process.resourcesPath, 'backend');
    const exeName = process.platform === 'darwin' ? 'push2talk-backend' : 'push2talk-backend.exe';
    // cwd is the backend's own directory (corrected turn 3 - was
    // process.resourcesPath, the parent of it), matching where the frozen
    // --onedir build's _internal/ dependency tree actually lives.
    return { command: path.join(backendDir, exeName), args: [], cwd: backendDir };
  }
  const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
  return { command: pythonExe, args: ['main.py'], cwd: REPO_ROOT };
}

// ---------- fatal lifecycle (SS12/13) ----------

let mainWindow = null;
let tray = null;
let trayWindow = null;
// The current persistent tray status row (stopping/recovering/unavailable),
// or null when idle - rebuilt into the tray menu by buildTrayMenu()
// whenever updateTrayStatus() runs. `idle` always clears this.
let currentTrayStatus = null;
// The single module-level "fatal handling started" flag every section of
// SS12/13 refers to - owned exclusively by fatalNative() via this FatalGate
// (fatal-gate.js, unit-tested in isolation). No other function sets a flag
// of its own; both the exit and timeout paths call fatalNative() directly
// as their only entry into fatal handling.
const fatalGate = new FatalGate();
let appQuitting = false;
let progressTimer = null;
let absoluteTimer = null;
let stoppedSendingCommands = false;
let lastKnownAutostart = false;
const isPrimaryInstance = installSingleInstanceGuard(app, () => mainWindow);

// Turn-5 binding checklist: the primary-process quit-entry wiring (tray
// Exit, window-all-closed, before-quit) and the fatalNative() coordinator
// shell, built from the pure, import-safe lifecycle-wiring.js module so
// tests can invoke these exact same callback objects. Every entry funnels
// into backendSupervisor.requestAppQuit() - the one idempotent shutdown
// coordinator - so this file never independently guards its own second
// quit path.
const quitEntryWiring = createQuitEntryWiring({
  requestAppQuit: () => backendSupervisor.requestAppQuit(),
  platform: process.platform,
});

function sendToRenderer(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-event', event);
  }
}

function sendAppError(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-error', payload);
  }
}

function clearDeadlines() {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  if (absoluteTimer) { clearTimeout(absoluteTimer); absoluteTimer = null; }
}

function onBackendTimeout(which) {
  clearDeadlines();
  stoppedSendingCommands = true;
  fatalNative('BACKEND_TIMEOUT', 'The dictation backend did not become ready in time.', { deadline: which });
}

function armDeadlines() {
  clearDeadlines();
  stoppedSendingCommands = false;
  // backendReady itself now lives in backendSupervisor.supervisorState,
  // already reset to false by spawnBackend() before this hook runs.
  progressTimer = setTimeout(() => onBackendTimeout('progress'), 30 * 1000);
  absoluteTimer = setTimeout(() => onBackendTimeout('absolute'), 10 * 60 * 1000);
}

// Corrected turn 3 (Codex turn-2 finding): SS12.2 says the absolute deadline
// runs "from spawn until ready, never reset" - its entire purpose is
// bounding time-to-ready, not the whole session. Once a genuine `ready`
// event has fired once, both deadlines are cleared permanently, not just
// the progress one - otherwise a perfectly healthy session hits
// BACKEND_TIMEOUT 10 minutes after spawn regardless of activity, and a
// merely-idle-for-30s session (nothing to report - no dictation in
// progress) would spuriously hit the progress deadline too.
//
// backendReady/terminateBackend/spawnBackend/markBackendReady themselves
// now live in electron/backend-supervisor.js (see the sixteenth-eighteenth
// handoff-review gaps under FINAL_BRIEF.md's "Electron recovery
// integration") - this file wires real Electron-facing hooks to that
// module instead of owning this state directly. resetProgressDeadline()
// stays here since it's this pre-existing readiness-timeout feature's own
// bookkeeping, unrelated to teardown recovery.

function resetProgressDeadline() {
  if (stoppedSendingCommands || backendSupervisor.supervisorState.backendReady) return;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(() => onBackendTimeout('progress'), 30 * 1000);
}

/** SS13 / Turn-5 binding checklist item 3: presents the fatal renderer
 * panel + native dialog for one fatal condition, then always routes to the
 * single shutdown coordinator (backendSupervisor.requestAppQuit()) -
 * whether the dialog resolved normally or its promise rejected - instead of
 * inlining its own appQuitting/terminate/app.quit() sequence. The
 * fatalCoordinator (lifecycle-wiring.js) owns that routing and the
 * fatalGate idempotency; this function only supplies the genuinely
 * Electron-only presentation step (renderer error panel + native
 * dialog.showMessageBox). */
async function presentFatalDialog(code, message, detail) {
  appendLog('exit', `FATAL ${code}: ${message}${detail ? ` ${sanitizeStderrLine(`P2T_DIAG ${JSON.stringify({ code, ...detail })}`)}` : ''}`);

  const rendererLive = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isLoadingMainFrame();
  if (rendererLive) {
    try {
      sendAppError({ severity: 'fatal', code, message, detail: detail || null, logPath: LOG_PATH });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (e) { /* renderer gone - the native dialog below still shows */ }
  }

  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const boxOptions = {
    type: 'error',
    title: `Push 2 Talk — ${code}`,
    message,
    detail: `${detail ? `${JSON.stringify(detail)}\n\n` : ''}Log: ${LOG_PATH}`,
    buttons: ['Quit'],
    noLink: true,
  };
  if (owner) await dialog.showMessageBox(owner, boxOptions);
  else await dialog.showMessageBox(boxOptions);
}

const { fatalNative } = createFatalCoordinator({
  gate: fatalGate,
  requestAppQuit: () => backendSupervisor.requestAppQuit(),
  presentDialog: presentFatalDialog,
  appendLog: (prefix, text) => appendLog(prefix, sanitizeStderrLine(text)),
});

function onBackendExit(code) {
  if (appQuitting) return; // application itself is already quitting - suppress BACKEND_EXIT
  clearDeadlines();
  fatalNative('BACKEND_EXIT', 'The dictation backend stopped unexpectedly.', { exit_code: code });
}

// ---------- login-item contract (SS11) ----------
// Decision logic lives in login-item-logic.js (no Electron dependency,
// unit-tested by electron/tests/test_login_item.mjs including the V9
// "setter returns without applying the request" seam); this is just the
// real ctx wiring main.js provides to it.

function loginItemCtx() {
  return {
    getLoginItemSettings: () => app.getLoginItemSettings(),
    setLoginItemSettings: (opts) => app.setLoginItemSettings(opts),
    writeToBackend: (cmdObject) => {
      const proc = backendSupervisor.supervisorState.pythonProcess;
      if (proc && proc.stdin.writable) {
        proc.stdin.write(`${JSON.stringify(cmdObject)}\n`);
      }
    },
    sendToRenderer,
    sendAppError: (payload) => sendAppError({ ...payload, logPath: LOG_PATH }),
    appendLog,
  };
}

function handleAutostartToggle(requested) {
  lastKnownAutostart = applyAutostartToggle(loginItemCtx(), requested, lastKnownAutostart);
}

function reconcileConfigOnStartup(configEvent) {
  const result = reconcileLoginItemOnStartup(loginItemCtx(), configEvent, lastKnownAutostart);
  lastKnownAutostart = result.lastKnownAutostart;
  // alwaysOnTop needs no OS-level readback dance like autostart does -
  // setAlwaysOnTop() is a synchronous, reliable Electron window property,
  // not an OS API call that can silently fail. The window is constructed
  // with alwaysOnTop:true by default; apply the user's stored preference
  // (which may be false) once it's known.
  if (mainWindow && !mainWindow.isDestroyed() && typeof result.configEvent.alwaysOnTop === 'boolean') {
    mainWindow.setAlwaysOnTop(result.configEvent.alwaysOnTop, 'floating');
  }
  return result.configEvent;
}

// ---------- backend process ----------
//
// spawnBackend/terminateBackend/the recovery state machine itself now live
// in electron/backend-supervisor.js - this file wires real Electron-facing
// hooks to it via initSupervisor() (called once, in createWindow() below)
// and calls backendSupervisor.spawnBackend() to start it.

// The single point every backend stdout event passes through on its way to
// the renderer. Wraps the pre-existing config-reconciliation/
// resetProgressDeadline behavior (unrelated to this brief's recovery
// design) around the real sendToRenderer() call, so both keep working
// exactly as before despite living behind the new hooks boundary.
function sendToRendererHook(evt) {
  if (evt && (evt.type === 'status' || evt.type === 'config')) {
    resetProgressDeadline();
  }
  let outEvt = evt;
  if (evt && evt.type === 'config') {
    outEvt = reconcileConfigOnStartup(evt);
  }
  sendToRenderer(outEvt);
}

function resolveBackendLaunchHook() {
  const { command, args, cwd } = resolveBackendCommand();
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  if (app.isPackaged) {
    // Corrected turn 4 (Codex finding): FINAL_BRIEF.md SS5's exact contract
    // is P2T_CONFIG_DIR (a directory), not a full file path - turn 1
    // independently reinvented a differently-shaped variable instead of
    // using the one the brief already specified. Never inside
    // process.resourcesPath (typically not user-writable, would defeat
    // uninstall's "preserve userData" requirement) - see config.py's
    // resolve_config_path().
    env.P2T_CONFIG_DIR = app.getPath('userData');
  }
  // windowsHide: true (packaged only) is what actually hides the backend's
  // console window per FINAL_BRIEF.md - the exe itself stays a normal
  // console-subsystem build (push2talk-backend.win.spec: console=True,
  // corrected turn 3) so stdin/stdout redirection keeps working exactly as
  // observed in dev mode; only the visible window is suppressed, at spawn
  // time, not by changing the executable's own subsystem.
  return { command, args, cwd, env, windowsHide: !!app.isPackaged };
}

function appendLogSanitized(prefix, line) {
  appendLog(prefix, sanitizeStderrLine(line));
}

ipcMain.on('backend-command', (event, cmd) => {
  if (!backendSupervisor.supervisorState.backendAcceptingCommands) {
    appendLog('main', `rejected command while recovery/startup in progress: ${cmd && cmd.cmd}`);
    return;
  }
  const pythonProcess = backendSupervisor.supervisorState.pythonProcess;
  if (cmd && cmd.cmd === 'save_config' && cmd.data && typeof cmd.data.alwaysOnTop === 'boolean') {
    // Applied live as a side effect; still forwarded through to Python
    // below (unlike autostart) since there's no readback value to
    // substitute - the requested value is authoritative.
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setAlwaysOnTop(cmd.data.alwaysOnTop, 'floating');
  }
  if (cmd && cmd.cmd === 'save_config' && cmd.data && Object.prototype.hasOwnProperty.call(cmd.data, 'autostart')) {
    // SS11.1: autostart is intercepted and applied via the OS API, then
    // forwarded to Python with the read-back actual value - never the
    // unverified request. Any other fields in the same save_config call
    // pass straight through, forwarded unchanged.
    const rest = { ...cmd.data };
    delete rest.autostart;
    if (Object.keys(rest).length > 0 && pythonProcess && pythonProcess.stdin.writable) {
      pythonProcess.stdin.write(`${JSON.stringify({ cmd: 'save_config', data: rest })}\n`);
    }
    handleAutostartToggle(cmd.data.autostart);
    return;
  }
  if (pythonProcess && pythonProcess.stdin.writable) {
    pythonProcess.stdin.write(`${JSON.stringify(cmd)}\n`);
  } else {
    appendLog('main', `dropped command, no backend process: ${cmd && cmd.cmd}`);
  }
});

ipcMain.on('move-window-by', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + Math.round(dx), y + Math.round(dy));
});

ipcMain.on('resize-window', (event, width, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setBounds({ width: Math.round(width), height: Math.round(height) });
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// ---------- System tray ----------
// Kevin: closing the window (X, the in-app close button, or Alt+F4) should
// hide to tray, not quit - the app is only fully closed via the tray's own
// "Exit" item (or the machine restarting, which naturally kills the
// process). Reuses the existing `appQuitting` flag (already the single
// source of truth fatalNative() checks) rather than introducing a second,
// separate "are we quitting" flag.

function resolveTrayIconPath() {
  // nativeImage.createFromPath(process.execPath) does NOT work on Windows -
  // that API decodes actual image files, it does not extract the icon
  // resource embedded in an exe. Platform-specific resolution (icon.png on
  // darwin, icon.ico elsewhere) lives in tray-icon-path.js - direct
  // headless testing against this app's real Electron 43.2.0 runtime on
  // macOS found icon.ico AND icon.icns both decode empty; icon.png decodes
  // fine at 1024x1024.
  return trayIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    electronDir: __dirname,
  });
}

/** Optionally prepends one disabled current-status row and separator (only
 * while currentTrayStatus is set - stopping/recovering/unavailable), then
 * preserves the existing Show/separator/Exit entries. */
function buildTrayMenu(win) {
  const items = [];
  if (currentTrayStatus && currentTrayStatus.text) {
    items.push({ label: currentTrayStatus.text, enabled: false });
    items.push({ type: 'separator' });
  }
  items.push({
    label: 'Show Push 2 Talk', click: () => {
      win.show();
      win.focus();
    },
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Exit', click: async () => {
      // Turn-3 correction (Codex turn-2 finding), now via quitEntryWiring
      // (lifecycle-wiring.js, Turn-5 item 6) rather than inlining
      // appQuitting/terminateAllKnownChildren/app.quit() here directly, so
      // this is the exact same exit path enterBackendUnavailable()'s own
      // persistent unavailable state relies on - one single, testable way
      // out that always retries an unconfirmed child first.
      await quitEntryWiring.trayExit();
    },
  });
  return Menu.buildFromTemplate(items);
}

/** Updates the tooltip and rebuilds the tray menu. `idle` clears the
 * transient status row; `stopping`, `recovering`, and the unavailable
 * state remain visible in the menu until superseded by a later status. */
function updateTrayStatus(state, text) {
  if (state === 'idle') {
    currentTrayStatus = null;
  } else if (text) {
    currentTrayStatus = { state, text };
  }
  if (!tray) return;
  tray.setToolTip(currentTrayStatus ? `Push 2 Talk — ${currentTrayStatus.text}` : 'Push 2 Talk');
  if (trayWindow) tray.setContextMenu(buildTrayMenu(trayWindow));
}

function createTray(win) {
  trayWindow = win;
  const iconPath = resolveTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    fatalNative('TRAY_ICON_EMPTY', 'The application tray icon could not be loaded.', { code: 'TRAY_ICON_EMPTY' });
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip('Push 2 Talk');
  tray.setContextMenu(buildTrayMenu(win));
  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 360,
    minWidth: 140,
    minHeight: 44,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Electron's native OS-level window shadow (hasShadow) follows the
    // window's actual rectangular frame on Windows, not the CSS rounded/
    // capsule content shape — invisible against a dark desktop, but shows
    // as a clearly visible grey square behind the rounded UI against a
    // light one. The CSS box-shadow (styles.css, properly clipped to the
    // rounded shape) supplies the drop shadow instead.
    hasShadow: false,
    resizable: false,
    show: false,
    // Kevin: clicking any other window sent this one to the background,
    // which defeats the point of a push-to-talk overlay you glance at
    // mid-typing. Keep it above normal windows always.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // macOS only — ignored elsewhere. vibrancy/visualEffectState removed
    // 2026-07-29: the 'hud' material's own native rendering carries a
    // built-in soft edge (Apple's HUD panel HIG style), visible as a
    // residual border even with hasShadow:false fully suppressed on every
    // lifecycle event - independent of this bug, and independent of the
    // app's own CSS-driven opacity-glass/-translucent look (styles.css),
    // which never relied on this option. Kevin wants zero visible border;
    // the CSS background alone now supplies the look.
    roundedCorners: true,
  });
  mainWindow = win;

  // Wired before any fatalNative()-capable code below (UI_MISSING,
  // TRAY_ICON_EMPTY, etc.) so backendSupervisor's hooks - in particular
  // setQuitting/quitApp, which the single shutdown coordinator
  // (requestAppQuit()) always calls - are never still the module's default
  // no-ops when an early-startup fatal condition fires before this used to
  // run (moved earlier than the pre-existing createTray()/spawnBackend()
  // call site below, which are otherwise unaffected).
  backendSupervisor.initSupervisor(win, {
    updateTrayStatus,
    sendToRenderer: sendToRendererHook,
    appendLog: appendLogSanitized,
    fatalNative,
    onBackendExit,
    clearDeadlines,
    armDeadlines,
    resolveBackendLaunch: resolveBackendLaunchHook,
    // Turn-3 correction (Codex turn-2 finding): enterBackendUnavailable()'s
    // own persistent presentation, wired to the real Electron window/IPC
    // surface instead of routing through fatalNative()'s quit-only dialog.
    showAndFocusWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    sendAppError: (payload) => sendAppError({ ...payload, logPath: LOG_PATH }),
    setQuitting: () => { appQuitting = true; },
    // markCleanupComplete() first: the coordinator's own final app.quit()
    // call re-fires 'before-quit' synchronously-ish, and quitEntryWiring's
    // beforeQuit() must see cleanup as already complete by then so it lets
    // this exact call through instead of recursing back into
    // requestAppQuit().
    quitApp: () => { quitEntryWiring.markCleanupComplete(); app.quit(); },
  });

  // Belt-and-suspenders: the constructor's hasShadow:false option should be
  // enough, but call it explicitly too in case that option doesn't fully
  // apply on this Electron/Windows combination.
  win.setHasShadow(false);

  // macOS-specific gap found live on real Apple Silicon hardware
  // (2026-07-29): a frameless transparent BrowserWindow redraws the native
  // OS shadow the moment it receives focus, even after an earlier
  // setHasShadow(false) call - a known Electron bug (electron/electron#7448).
  // The constructor option and the call above only cover the window's
  // initial unfocused state; re-assert on every focus so the shadow never
  // comes back once the window is actually shown and used.
  win.on('focus', () => win.setHasShadow(false));
  win.on('blur', () => win.setHasShadow(false));
  win.on('show', () => win.setHasShadow(false));

  // Same belt-and-suspenders reasoning for alwaysOnTop - explicit call
  // in addition to the constructor option. 'floating' keeps it above
  // normal windows without needing 'screen-saver' level, which can behave
  // oddly by grabbing focus over full-screen apps on some platforms.
  win.setAlwaysOnTop(true, 'floating');

  win.once('ready-to-show', () => win.show());

  // Corrected turn 3 (Codex turn-2 finding): dev mode's ui/ lives next to
  // electron/ in the repo, but a packaged app's `files` list packs only
  // main.js/preload.js/package.json into app.asar - ui/ is copied via
  // extraResources instead, landing at resources/ui/, not
  // resources/app.asar/ui/. __dirname-relative resolution silently pointed
  // at a path that doesn't exist once packaged.
  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ui', 'index.html')
    : path.join(__dirname, '..', 'ui', 'index.html');
  if (!fs.existsSync(indexPath)) {
    // UI_MISSING: the renderer panel necessarily can't show (there's no
    // renderer to show it in) - the native dialog is the only channel.
    fatalNative('UI_MISSING', 'The application UI could not be found.', { code: 'UI_MISSING' });
    return win;
  }
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    fatalNative('UI_LOAD_FAILED', 'The application UI failed to load.', {
      error_class: `ELECTRON_${errorCode}`,
    });
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('app-version', resolveBuildInfo());
  });
  win.loadFile(indexPath);

  // Tray created before the backend is spawned - this guarantees backend
  // status and recovery UI (updateTrayStatus()) have a visible tray target
  // from the first event onward, closing R7 (recovery UI depending on a
  // tray that might not exist yet).
  createTray(win);

  backendSupervisor.spawnBackend(win);

  // 'close' fires before the window is destroyed and can be cancelled,
  // unlike 'closed' below - hide instead of actually closing, unless the
  // app is genuinely quitting (tray Exit, a fatal error, or
  // window-all-closed's own non-mac fallback all set appQuitting first).
  win.on('close', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    // Item 4, Turn-5 binding checklist: no direct child killing or
    // pythonProcess = null mutation here - that would detach the backend
    // process from supervisorState before the coordinated shutdown path
    // (requestAppQuit() -> terminateAllKnownChildren()) can ever observe or
    // terminate it. The window closing alone never implies the app itself
    // is quitting (see the 'close' handler above and hide-to-tray) - actual
    // quitting always goes through quitEntryWiring/requestAppQuit(), which
    // terminates the real backend child itself.
  });

  return win;
}

if (isPrimaryInstance) {
  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Item 3/4, Turn-5 binding checklist: preserves existing macOS behavior
// (window-all-closed alone never quits on darwin - quitEntryWiring.
// windowAllClosed() is a no-op there); on non-mac platforms it routes
// through the single shutdown coordinator instead of inlining its own
// appQuitting/child-kill/app.quit() sequence.
app.on('window-all-closed', () => {
  quitEntryWiring.windowAllClosed();
});

// Item 3, Turn-5 binding checklist: covers Dock, application-menu, OS quit
// requests, and any external/direct app.quit() call - the one quit entry
// the pre-existing wiring didn't cover at all. Prevents quitting while
// cleanup is still in flight and lets the coordinator's own final
// app.quit() (fired once quitApp()'s hook calls
// quitEntryWiring.markCleanupComplete() first) proceed without recursing.
app.on('before-quit', (event) => {
  quitEntryWiring.beforeQuit(event);
});
