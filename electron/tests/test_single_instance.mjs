import { test } from 'node:test';
import assert from 'node:assert/strict';
import singleInstance from '../single-instance-logic.js';

const { activatePrimaryWindow, installSingleInstanceGuard } = singleInstance;

test('secondary process quits before it can create a backend', () => {
  let quitCalls = 0;
  let handlers = 0;
  const app = {
    requestSingleInstanceLock: () => false,
    quit: () => { quitCalls += 1; },
    on: () => { handlers += 1; },
  };

  assert.equal(installSingleInstanceGuard(app, () => null), false);
  assert.equal(quitCalls, 1);
  assert.equal(handlers, 0);
});

test('primary process registers one second-instance handler', () => {
  const handlers = new Map();
  const app = {
    requestSingleInstanceLock: () => true,
    quit: () => assert.fail('primary instance must not quit'),
    on: (name, handler) => handlers.set(name, handler),
  };
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => false,
    showCalls: 0,
    focusCalls: 0,
    show() { this.showCalls += 1; },
    focus() { this.focusCalls += 1; },
  };

  assert.equal(installSingleInstanceGuard(app, () => win), true);
  assert.equal(handlers.size, 1);
  handlers.get('second-instance')();
  assert.equal(win.showCalls, 1);
  assert.equal(win.focusCalls, 1);
});

test('activation restores a minimized primary window', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  assert.equal(activatePrimaryWindow(win), true);
  assert.deepEqual(calls, ['restore', 'focus']);
});
