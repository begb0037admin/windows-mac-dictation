'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Window movement only, for now (Phase 1 spike) — -webkit-app-region: drag
// blocks normal DOM mouse events entirely on the region it's applied to,
// which is fine for pure dragging but means a region can never also be a
// click target (e.g. "click the pill to expand"). So drag regions are
// plain (non-app-region) elements instead, and app.js drives movement
// itself via mousedown/mousemove, calling this.
contextBridge.exposeInMainWorld('electronAPI', {
  moveWindowBy: (dx, dy) => ipcRenderer.send('move-window-by', dx, dy),
});
