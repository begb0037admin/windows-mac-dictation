import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { trayIconFilename, trayIconPath } from '../tray-icon-path.js';

test('trayIconFilename: darwin resolves to icon.png, every other platform to icon.ico', () => {
  assert.equal(trayIconFilename('darwin'), 'icon.png');
  assert.equal(trayIconFilename('win32'), 'icon.ico');
  assert.equal(trayIconFilename('linux'), 'icon.ico');
});

test('trayIconPath: darwin dev resolves electron/build/icon.png', () => {
  const p = trayIconPath({ platform: 'darwin', isPackaged: false, resourcesPath: '/res', electronDir: '/repo/electron' });
  assert.equal(p, path.join('/repo/electron', 'build', 'icon.png'));
});

test('trayIconPath: darwin packaged resolves Resources/icons/icon.png', () => {
  const p = trayIconPath({ platform: 'darwin', isPackaged: true, resourcesPath: '/App/Contents/Resources', electronDir: '/repo/electron' });
  assert.equal(p, path.join('/App/Contents/Resources', 'icons', 'icon.png'));
});

test('trayIconPath: Windows continues resolving ICO, dev and packaged', () => {
  const dev = trayIconPath({ platform: 'win32', isPackaged: false, resourcesPath: 'C:/res', electronDir: 'C:/repo/electron' });
  assert.equal(dev, path.join('C:/repo/electron', 'build', 'icon.ico'));
  const packaged = trayIconPath({ platform: 'win32', isPackaged: true, resourcesPath: 'C:/res', electronDir: 'C:/repo/electron' });
  assert.equal(packaged, path.join('C:/res', 'icons', 'icon.ico'));
});
