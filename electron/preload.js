'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// -webkit-app-region: drag blocks normal DOM mouse events entirely on the
// region it's applied to, which is fine for pure dragging but means a
// region can never also be a click target (e.g. "click the pill to
// expand"). So drag regions are plain (non-app-region) elements instead,
// and app.js drives movement itself via mousedown/mousemove, calling
// moveWindowBy. sendCommand/onBackendEvent are the JSON-lines pipe to the
// Python backend (see main.py's module docstring / electron/main.js).
contextBridge.exposeInMainWorld('electronAPI', {
  moveWindowBy: (dx, dy) => ipcRenderer.send('move-window-by', dx, dy),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', width, height),
  closeWindow: () => ipcRenderer.send('close-window'),
  sendCommand: (cmd) => ipcRenderer.send('backend-command', cmd),
  onBackendEvent: (callback) => {
    ipcRenderer.on('backend-event', (_event, data) => callback(data));
  },
  // SS14: fatal/warning errors main.js can't route through the regular
  // backend-event channel (e.g. before the backend even spawns, or a
  // login-item failure that never touches Python at all).
  onAppError: (callback) => {
    ipcRenderer.on('app-error', (_event, data) => callback(data));
  },
  // Sent once by main.js after the UI finishes loading - see
  // resolveBuildInfo() there for what's in it (version/gitSha/builtAt/...).
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_event, data) => callback(data));
  },
});
