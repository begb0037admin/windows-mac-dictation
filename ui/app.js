/* app.js — Frontend logic for windows-dictation pywebview UI.
   Receives state updates from Python via global functions,
   manages the waveform visualisation, and bridges settings. */

'use strict';

// ── State ──

const STATES = ['idle', 'recording', 'transcribing', 'cleanup', 'pasting', 'error'];
let currentState = 'idle';
let waveformBars = [];
let audioLevels = new Array(42).fill(0);
let idleAnimationId = null;

// ── DOM references (populated on ready) ──

let dom = {};

function cacheDom() {
  dom = {
    app: document.querySelector('.app'),
    statusText: document.getElementById('statusText'),
    captionText: document.getElementById('captionText'),
    hotkeyLabel: document.getElementById('hotkeyLabel'),
    hotkeyKey: document.getElementById('hotkeyKey'),
    waveform: document.getElementById('waveform'),
    flash: document.getElementById('flash'),
    // Status cells
    cellCapture: document.getElementById('cellCapture'),
    cellWhisper: document.getElementById('cellWhisper'),
    cellCleanup: document.getElementById('cellCleanup'),
    cellPaste: document.getElementById('cellPaste'),
    // Views
    viewDictation: document.getElementById('viewDictation'),
    viewSettings: document.getElementById('viewSettings'),
    btnSettings: document.getElementById('btnSettings'),
    btnBack: document.getElementById('btnBack'),
    // Settings fields
    settingHotkey: document.getElementById('settingHotkey'),
    settingBackend: document.getElementById('settingBackend'),
    settingCleanupModel: document.getElementById('settingCleanupModel'),
    settingAutostart: document.getElementById('settingAutostart'),
  };
}

// ── Waveform ──

function initWaveform() {
  const container = dom.waveform;
  container.innerHTML = '';
  waveformBars = [];
  for (let i = 0; i < 42; i++) {
    const bar = document.createElement('span');
    bar.className = 'wave-bar';
    bar.style.setProperty('--i', i);
    // Stagger the idle animation
    bar.style.animationDelay = `${i * -57}ms`;
    container.appendChild(bar);
    waveformBars.push(bar);
  }
}

/**
 * Called from Python with an RMS audio level (0.0–1.0).
 * Shifts the levels array and updates bar heights.
 */
function updateAudioLevel(rms) {
  // Shift levels left, add new level at the end
  audioLevels.shift();
  audioLevels.push(Math.min(1.0, rms * 3.0)); // amplify for visibility

  // Update bar heights
  for (let i = 0; i < waveformBars.length; i++) {
    const level = audioLevels[i];
    const height = Math.max(6, level * 88); // 6px min, 88px max
    waveformBars[i].style.height = `${height}px`;
    waveformBars[i].style.opacity = Math.max(0.3, 0.3 + level * 0.6);
  }
}

/**
 * Reset waveform to idle state.
 */
function resetWaveform() {
  audioLevels.fill(0);
  for (const bar of waveformBars) {
    bar.style.height = '12px';
    bar.style.opacity = '';
  }
}

// ── State management ──

/**
 * Called from Python to update the app state.
 * @param {string} state - One of: idle, recording, transcribing, cleanup, pasting, error
 * @param {string} text - Status text to display
 */
function updateStatus(state, text) {
  // Remove old state class, add new
  for (const s of STATES) {
    dom.app.classList.remove(`state-${s}`);
  }
  dom.app.classList.add(`state-${state}`);
  currentState = state;

  // Update status text
  dom.statusText.textContent = text;

  // Update status cells
  updateCells(state);

  // Handle state-specific behavior
  if (state === 'idle') {
    resetWaveform();
  }

  if (state === 'pasting') {
    showFlash('✓ Pasted');
  }

  if (state === 'error') {
    // Auto-return to idle after 4 seconds
    setTimeout(() => {
      if (currentState === 'error') {
        updateStatus('idle', dom.hotkeyLabel.dataset.idleText || 'Hold hotkey to record');
      }
    }, 4000);
  }
}

/**
 * Update status cell highlights based on current pipeline stage.
 */
function updateCells(state) {
  const cells = [dom.cellCapture, dom.cellWhisper, dom.cellCleanup, dom.cellPaste];
  cells.forEach(c => c.classList.remove('active'));

  const cellStates = {
    'recording': [dom.cellCapture],
    'transcribing': [dom.cellWhisper],
    'cleanup': [dom.cellCleanup],
    'pasting': [dom.cellPaste],
  };

  if (cellStates[state]) {
    cellStates[state].forEach(c => c.classList.add('active'));
  }
}

/**
 * Called from Python to update the live transcript text.
 * @param {string} text - The current transcript text
 */
function updateTranscript(text) {
  if (!text || text.trim() === '') {
    dom.captionText.innerHTML = '<span class="caption-placeholder">Waiting for speech...</span>';
    return;
  }
  dom.captionText.textContent = text;
  // Auto-scroll to bottom
  dom.captionText.scrollTop = dom.captionText.scrollHeight;
}

/**
 * Called from Python to show the final cleaned-up text.
 * @param {string} text - The cleaned text that was pasted
 */
function updateFinalText(text) {
  if (text && text.trim() !== '') {
    dom.captionText.textContent = text;
    dom.captionText.scrollTop = dom.captionText.scrollHeight;
  }
}

// ── Flash notification ──

function showFlash(message) {
  dom.flash.textContent = message;
  dom.flash.classList.add('show');
  setTimeout(() => {
    dom.flash.classList.remove('show');
  }, 1500);
}

// ── View toggling ──

function showDictation() {
  dom.viewDictation.classList.add('active');
  dom.viewSettings.classList.remove('active');
  dom.btnSettings.classList.remove('active');
}

function showSettings() {
  dom.viewDictation.classList.remove('active');
  dom.viewSettings.classList.add('active');
  dom.btnSettings.classList.add('active');
  loadSettings();
}

// ── Settings ──

async function loadSettings() {
  if (!window.pywebview || !window.pywebview.api) return;
  try {
    const config = await pywebview.api.get_config();
    if (config) {
      dom.settingHotkey.value = config.hotkey || '';
      dom.settingBackend.value = config.whisper_backend || '';
      dom.settingCleanupModel.value = config.cleanup_model || '';

      const autostart = config.autostart || false;
      dom.settingAutostart.classList.toggle('on', autostart);
      dom.settingAutostart.setAttribute('aria-pressed', String(autostart));
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  if (!window.pywebview || !window.pywebview.api) return;
  try {
    await pywebview.api.save_config({
      cleanup_model: dom.settingCleanupModel.value,
      autostart: dom.settingAutostart.classList.contains('on'),
    });
    showFlash('Settings saved');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/**
 * Called from Python to set the hotkey display.
 */
function setHotkeyDisplay(name, display) {
  dom.hotkeyKey.textContent = display;
  const idleText = `Hold ${display} to record`;
  dom.hotkeyLabel.dataset.idleText = idleText;
}

// ── Initialisation ──

function init() {
  cacheDom();
  initWaveform();

  // View toggle
  dom.btnSettings.addEventListener('click', () => {
    if (dom.viewSettings.classList.contains('active')) {
      showDictation();
    } else {
      showSettings();
    }
  });

  dom.btnBack.addEventListener('click', () => {
    showDictation();
  });

  // Autostart toggle
  dom.settingAutostart.addEventListener('click', () => {
    const isOn = !dom.settingAutostart.classList.contains('on');
    dom.settingAutostart.classList.toggle('on', isOn);
    dom.settingAutostart.setAttribute('aria-pressed', String(isOn));
    saveSettings();
  });

  // Cleanup model save on blur
  dom.settingCleanupModel.addEventListener('change', saveSettings);

  // Set initial state
  updateStatus('idle', 'Initialising...');
  updateTranscript('');

  // Standalone preview: if no pywebview bridge after 500ms, run demo mode
  setTimeout(() => {
    if (!window.pywebview || !window.pywebview.api) {
      runDemoMode();
    }
  }, 500);
}

// ── Demo mode (standalone browser preview) ──

function runDemoMode() {
  console.log('[demo] No pywebview bridge detected — running in preview mode');

  // Set demo hotkey display
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const hotkeyDisplay = isMac ? 'Right Option' : 'Right Ctrl';
  setHotkeyDisplay('', hotkeyDisplay);
  updateStatus('idle', `Hold ${hotkeyDisplay} to record`);

  // Fill settings with demo values
  dom.settingHotkey.value = hotkeyDisplay;
  dom.settingBackend.value = isMac ? 'mlx-whisper small Metal' : 'faster-whisper small cuda float16';
  dom.settingCleanupModel.value = 'llama3.2:3b';

  // Demo cycle: walk through all states so the user can see the UI
  const demoText = 'I think the right approach is to keep live dictation focused and local, and move uploaded meeting files into the separate meeting transcriber tool.';

  setTimeout(() => {
    // Recording state
    updateStatus('recording', 'Listening...');
    updateTranscript('');

    // Simulate waveform with random levels
    let waveInterval = setInterval(() => {
      if (currentState !== 'recording') {
        clearInterval(waveInterval);
        return;
      }
      updateAudioLevel(Math.random() * 0.4 + 0.05);
    }, 80);

    // Simulate partial transcript building up
    const words = demoText.split(' ');
    let wordIndex = 0;
    let partialInterval = setInterval(() => {
      if (wordIndex >= words.length || currentState !== 'recording') {
        clearInterval(partialInterval);
        return;
      }
      wordIndex += 2;
      updateTranscript(words.slice(0, wordIndex).join(' '));
    }, 400);

    // After 4s, transition through pipeline stages
    setTimeout(() => {
      clearInterval(waveInterval);
      clearInterval(partialInterval);
      updateTranscript(demoText);
      updateStatus('transcribing', 'Transcribing...');

      setTimeout(() => {
        updateStatus('cleanup', 'Cleaning up...');

        setTimeout(() => {
          updateFinalText(demoText);
          updateStatus('pasting', 'Pasting...');

          setTimeout(() => {
            updateStatus('idle', `Hold ${hotkeyDisplay} to record`);
          }, 1500);
        }, 1200);
      }, 1500);
    }, 4000);
  }, 1000);
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Wait for pywebview bridge
window.addEventListener('pywebviewready', () => {
  loadSettings();
});
