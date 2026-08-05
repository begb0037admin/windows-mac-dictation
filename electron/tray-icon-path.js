'use strict';

const path = require('path');

// Platform-specific tray icon resolution. Kept as a pure module (no
// Electron dependency of its own beyond the path shapes) so it is directly
// unit-testable (electron/tests/test_tray_icon_path.mjs) without a running
// Electron process.
//
// Direct headless test against this app's real Electron 43.2.0 runtime on
// macOS found icon.ico AND icon.icns both decode empty (isEmpty():true),
// while icon.png decodes fine at 1024x1024 - so darwin uses the PNG, every
// other platform keeps the working ICO behavior.

function trayIconFilename(platform) {
  return platform === 'darwin' ? 'icon.png' : 'icon.ico';
}

function trayIconPath({ platform, isPackaged, resourcesPath, electronDir }) {
  const filename = trayIconFilename(platform);
  if (isPackaged) {
    return path.join(resourcesPath, 'icons', filename);
  }
  return path.join(electronDir, 'build', filename);
}

module.exports = { trayIconFilename, trayIconPath };
