'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer uses Electron's native draggable regions for window movement;
// only deliberate mode changes cross this bridge. sendCommand/onBackendEvent
// are the JSON-lines pipe to the Python backend (see main.py's module
// docstring / electron/main.js).
contextBridge.exposeInMainWorld('electronAPI', {
  // invoke, not send: the renderer must know the native resize has actually
  // happened before it flips CSS classes that size themselves off 100vh
  // (mode-pill/pill-mode) - see electron/main.js's resize-window handler.
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),
  closeWindow: () => ipcRenderer.send('close-window'),
  openMacAccessibilitySettings: () => ipcRenderer.send('open-accessibility-settings'),
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
