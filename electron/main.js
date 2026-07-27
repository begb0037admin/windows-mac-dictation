'use strict';

// Phase 1 shape spike (see plan: pywebview -> Electron migration).
// Loads the existing, unmodified ui/index.html directly — no Python
// process, no IPC. app.js's runDemoMode() fallback (fires when
// window.pywebview is absent, which it is here) drives a fake state
// cycle so the real CSS/drag/pill-toggle behaviour can be verified.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

ipcMain.on('move-window-by', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + Math.round(dx), y + Math.round(dy));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 360,
    minWidth: 200,
    minHeight: 44,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
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

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
