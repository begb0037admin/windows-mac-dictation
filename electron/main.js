'use strict';

// Electron shell for windows-mac-dictation. Owns the window (frameless,
// transparent, shaped via CSS) and spawns main.py as a child process,
// speaking one JSON object per line over its stdio: main.py's stdout is
// events (state/transcript/config/...) forwarded to the renderer via
// 'backend-event'; the renderer's commands (send_text/dismiss/get_config/
// save_config) come back via 'backend-command' and are written to main.py's
// stdin. See main.py's module docstring for the Python side of this.

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PYTHON_EXE = process.platform === 'win32' ? 'python' : 'python3';

let pythonProcess = null;

function spawnBackend(win) {
  const child = spawn(PYTHON_EXE, ['main.py'], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  pythonProcess = child;

  const sendToRenderer = (event) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('backend-event', event);
    }
  };

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      console.error('[backend] malformed JSON from main.py, skipping:', line);
      return;
    }
    sendToRenderer(event);
  });

  const errRl = readline.createInterface({ input: child.stderr });
  errRl.on('line', (line) => console.error(`[python] ${line}`));

  child.on('error', (err) => {
    console.error('[backend] failed to spawn main.py:', err);
    sendToRenderer({ type: 'status', state: 'error', text: `Backend failed to start: ${err.message}` });
  });

  child.on('exit', (code) => {
    console.error(`[backend] main.py exited with code ${code}`);
    if (pythonProcess === child) pythonProcess = null;
    sendToRenderer({ type: 'status', state: 'error', text: 'Backend disconnected — restart the app' });
  });

  return child;
}

ipcMain.on('backend-command', (event, cmd) => {
  if (pythonProcess && pythonProcess.stdin.writable) {
    pythonProcess.stdin.write(JSON.stringify(cmd) + '\n');
  } else {
    console.error('[backend] dropped command, no backend process:', cmd);
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // macOS only — ignored elsewhere.
    vibrancy: 'hud',
    visualEffectState: 'active',
    roundedCorners: true,
  });

  // Belt-and-suspenders: the constructor's hasShadow:false option should be
  // enough, but call it explicitly too in case that option doesn't fully
  // apply on this Electron/Windows combination.
  win.setHasShadow(false);

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  spawnBackend(win);

  win.on('closed', () => {
    if (pythonProcess) {
      pythonProcess.kill();
      pythonProcess = null;
    }
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
