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
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const { sanitizeStderrLine } = require('./diagnostics');
const { applyAutostartToggle, reconcileLoginItemOnStartup } = require('./login-item-logic');
const { FatalGate } = require('./fatal-gate');
const { installSingleInstanceGuard } = require('./single-instance-logic');

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
let pythonProcess = null;
let tray = null;
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
  backendReady = false; // fresh tracking for this (re)spawned backend process
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
let backendReady = false;

function markBackendReady() {
  backendReady = true;
  clearDeadlines();
}

function resetProgressDeadline() {
  if (stoppedSendingCommands || backendReady) return;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(() => onBackendTimeout('progress'), 30 * 1000);
}

/** SS12.2's bounded termination procedure: normal termination first, then a
 * narrowly targeted process-tree kill if it doesn't die within 5s. Windows
 * uses `taskkill /t` scoped to this specific PID's tree only - never a
 * blanket kill of unrelated python/Electron processes (SS12.2 V10). */
function terminateBackend() {
  return new Promise((resolve) => {
    if (!pythonProcess) return resolve();
    const proc = pythonProcess;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    proc.once('exit', finish);
    try { proc.kill(); } catch (e) { /* already gone */ }
    const forceTimer = setTimeout(() => {
      if (settled) return;
      if (process.platform === 'win32' && proc.pid) {
        try { spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f']); } catch (e) { /* best effort */ }
      } else if (proc.pid) {
        try { proc.kill('SIGKILL'); } catch (e) { /* best effort */ }
      }
      finish();
    }, 5000);
  });
}

/** SS13: async, idempotent (via fatalGate - fatal-gate.js). Every fatal
 * condition in this file (UI_MISSING, UI_LOAD_FAILED, BACKEND_MISSING,
 * BACKEND_EXIT, BACKEND_TIMEOUT) calls this exactly once and lets the
 * gate's idempotency absorb any race. */
function fatalNative(code, message, detail) {
  return fatalGate.claim(async () => {
    appendLog('exit', `FATAL ${code}: ${message}${detail ? ` ${sanitizeStderrLine(`P2T_DIAG ${JSON.stringify({ code, ...detail })}`)}` : ''}`);

    const rendererLive = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isLoadingMainFrame();
    if (rendererLive) {
      try {
        sendAppError({ severity: 'fatal', code, message, detail: detail || null, logPath: LOG_PATH });
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (e) { /* renderer gone - the native dialog below still shows */ }
    }

    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    try {
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
    } catch (e) {
      appendLog('exit', `showMessageBox rejected: ${sanitizeStderrLine(String(e && e.message))}`);
      appQuitting = true;
      await terminateBackend();
      app.quit();
      return;
    }
    appQuitting = true;
    await terminateBackend();
    app.quit();
  });
}

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
      if (pythonProcess && pythonProcess.stdin.writable) {
        pythonProcess.stdin.write(`${JSON.stringify(cmdObject)}\n`);
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

function spawnBackend(win) {
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
  // time, not by changing the executable's own subsystem. [VALIDATION V5,
  // not yet live-verified on an installed copy - see i3_claude.md.]
  const spawnOptions = { cwd, env };
  if (app.isPackaged) spawnOptions.windowsHide = true;

  let child;
  try {
    child = spawn(command, args, spawnOptions);
  } catch (e) {
    fatalNative('BACKEND_MISSING', 'The dictation backend could not be started.', {
      error_class: e && e.constructor ? e.constructor.name : 'Error',
    });
    return null;
  }
  pythonProcess = child;

  // Attach every listener before arming the deadlines - if a fast backend's
  // first stdout line arrived before a timer existed to reset, that would
  // be harmless (no timer yet to have expired); attaching listeners after
  // arming would instead risk racing against however Node schedules the
  // already-armed timer relative to stream 'data' events. Belt-and-braces
  // ordering, not the actual fix for the timeout bug found live in this
  // Electron process (see i1_claude.md) - kept because it is strictly safer
  // regardless of that bug's real cause.
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch (e) {
      appendLog('main', `malformed JSON from backend, skipping (len=${line.length})`);
      return;
    }
    if (evt && evt.type === 'ready') {
      markBackendReady();
    } else if (evt && (evt.type === 'status' || evt.type === 'config')) {
      resetProgressDeadline();
    }
    if (evt && evt.type === 'config') {
      evt = reconcileConfigOnStartup(evt);
    }
    sendToRenderer(evt);
  });

  const errRl = readline.createInterface({ input: child.stderr });
  errRl.on('line', (line) => appendLog('diag', sanitizeStderrLine(line)));

  child.on('error', (err) => {
    fatalNative('BACKEND_MISSING', 'The dictation backend could not be started.', {
      error_class: err && err.constructor ? err.constructor.name : 'Error',
    });
  });

  child.on('exit', (code) => {
    if (pythonProcess === child) pythonProcess = null;
    onBackendExit(code);
  });

  armDeadlines();
  return child;
}

ipcMain.on('backend-command', (event, cmd) => {
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
  // resource embedded in an exe (that silently produced an empty image,
  // which is why the tray slot rendered blank while still registering a
  // tooltip). Packaged: read the icon shipped as an extraResource
  // (generate-builder-config.js). Dev mode: read the committed source file
  // directly - present on disk, unpacked.
  if (app.isPackaged) {
    return nativeImage.createFromPath(path.join(process.resourcesPath, 'icons', 'icon.ico'));
  }
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
}

function createTray(win) {
  const icon = resolveTrayIconPath();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Push 2 Talk');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Push 2 Talk', click: () => {
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Exit', click: () => {
        appQuitting = true;
        app.quit();
      },
    },
  ]));
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
  win.loadFile(indexPath);

  spawnBackend(win);
  createTray(win);

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
    if (pythonProcess) {
      pythonProcess.kill();
      pythonProcess = null;
    }
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

app.on('window-all-closed', () => {
  appQuitting = true;
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
