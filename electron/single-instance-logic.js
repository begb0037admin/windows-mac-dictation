'use strict';

function activatePrimaryWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

function installSingleInstanceGuard(app, getPrimaryWindow) {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    activatePrimaryWindow(getPrimaryWindow());
  });
  return true;
}

module.exports = { activatePrimaryWindow, installSingleInstanceGuard };
