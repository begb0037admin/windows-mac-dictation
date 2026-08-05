'use strict';

// The one genuinely Electron-runtime-dependent suite (acceptance-plan case
// 9): decodes the real committed electron/build/icon.png through this
// app's actual Electron runtime and asserts it is non-empty with positive
// dimensions - not just that the file exists. This directly repeats the
// live confirmation that found icon.ico AND icon.icns both decode empty on
// this app's real Electron 43.2.0 while icon.png decodes fine at
// 1024x1024, so a future Electron upgrade or icon-file change can't
// silently reintroduce a blank tray.
//
// Run via `npm run test:tray-runtime` (electron/package.json) - needs a
// real Electron binary, not plain Node, since nativeImage is an Electron
// API. Exits 0/1 via process.exitCode so it composes normally with a CI
// runner or shell `&&`.

const path = require('path');
const { app, nativeImage } = require('electron');
const { prepareTrayIcon } = require('../tray-icon-path');

async function main() {
  await app.whenReady();
  try {
    const pngPath = path.join(__dirname, '..', 'build', 'icon.png');
    const img = nativeImage.createFromPath(pngPath);
    if (img.isEmpty()) {
      throw new Error(`icon.png decoded empty at ${pngPath}`);
    }
    const sourceSize = img.getSize();
    if (!(sourceSize.width > 0 && sourceSize.height > 0)) {
      throw new Error(`icon.png decoded with non-positive dimensions: ${JSON.stringify(sourceSize)}`);
    }
    const prepared = prepareTrayIcon(img, 'darwin');
    const preparedSize = prepared.getSize();
    if (preparedSize.width !== 18 || preparedSize.height !== 18) {
      throw new Error(`macOS tray icon was not resized to 18x18: ${JSON.stringify(preparedSize)}`);
    }
    process.stdout.write(`OK: icon.png decoded ${sourceSize.width}x${sourceSize.height} and prepared ${preparedSize.width}x${preparedSize.height} (Electron ${process.versions.electron})\n`);
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`FAIL: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

main();
