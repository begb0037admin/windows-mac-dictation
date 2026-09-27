import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCE = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const MIC_OFF_TEXT = 'Microphone is off or unavailable — turn it on and try again.';

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

function element() {
  return {
    classList: classList(),
    style: {},
    textContent: '',
    title: '',
    addEventListener() {},
    querySelector() { return null; },
  };
}

function loadApp() {
  const app = element();
  const elements = new Map([
    ['statusLight', element()],
    ['statusText', element()],
    ['pillStatus', element()],
  ]);
  const body = element();
  const pendingTimers = [];
  const document = {
    readyState: 'loading',
    body,
    querySelector: (selector) => (selector === '.app' ? app : null),
    getElementById: (id) => elements.get(id) || element(),
    addEventListener() {},
    createElement: () => element(),
  };
  const context = vm.createContext({
    document,
    navigator: { platform: 'Linux' },
    window: {
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    },
    console,
    setTimeout: (callback, delay) => {
      pendingTimers.push({ callback, delay });
      return pendingTimers.length;
    },
    clearTimeout() {},
  });

  vm.runInContext(APP_SOURCE, context, { filename: 'ui/app.js' });
  vm.runInContext('cacheDom()', context);

  return {
    app,
    body,
    statusLight: elements.get('statusLight'),
    statusText: elements.get('statusText'),
    pillStatus: elements.get('pillStatus'),
    pendingTimers,
    updateStatus: context.updateStatus,
  };
}

test('mic-off error gets a distinct mini-pill label while full text stays intact', () => {
  const harness = loadApp();

  harness.updateStatus('error', MIC_OFF_TEXT);

  assert.equal(harness.pillStatus.textContent, 'Mic off');
  assert.equal(harness.statusText.textContent, MIC_OFF_TEXT);
  assert.equal(harness.statusLight.title, MIC_OFF_TEXT);
});

test('unrelated error text keeps the generic mini-pill label', () => {
  const harness = loadApp();
  const pasteFailure = 'Failed to paste transcription.';

  harness.updateStatus('error', pasteFailure);

  assert.equal(harness.pillStatus.textContent, 'Error');
  assert.equal(harness.statusText.textContent, pasteFailure);
});

test('transcription safety rejection is distinct from an operational error', () => {
  const harness = loadApp();
  const rejection = 'No reliable speech was detected, so nothing was pasted.';

  harness.updateStatus('rejected', rejection);

  assert.equal(harness.pillStatus.textContent, 'Try again');
  assert.equal(harness.statusText.textContent, rejection);
  assert.equal(harness.statusLight.title, rejection);
  assert.equal(harness.app.classList.contains('state-rejected'), true);
  assert.equal(harness.pendingTimers.length, 1);

  harness.pendingTimers[0].callback();

  assert.equal(harness.statusText.textContent, 'Ready');
  assert.equal(harness.pillStatus.textContent, '');
  assert.equal(harness.app.classList.contains('state-rejected'), false);
  assert.equal(harness.app.classList.contains('state-idle'), true);
});

test('error still schedules the four-second reset to idle and Ready', () => {
  const harness = loadApp();

  harness.updateStatus('error', 'Transcription failed.');

  assert.equal(harness.pendingTimers.length, 1);
  assert.equal(harness.pendingTimers[0].delay, 4000);

  harness.pendingTimers[0].callback();

  assert.equal(harness.statusText.textContent, 'Ready');
  assert.equal(harness.pillStatus.textContent, '');
  assert.equal(harness.statusLight.title, 'Ready');
  assert.equal(harness.app.classList.contains('state-error'), false);
  assert.equal(harness.app.classList.contains('state-idle'), true);
});
