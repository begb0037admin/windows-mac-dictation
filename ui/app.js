/* app.js — Frontend logic for windows-dictation pywebview UI.
   Receives state updates from Python via global functions,
   manages the waveform visualisation, handles editing/sending transcripts,
   supports Mini Pill Mode, and bridges settings (hotkey, theme, opacity, cleanup model, autostart). */

'use strict';

// ── State ──

const STATES = ['idle', 'recording', 'transcribing', 'cleanup', 'review', 'pasting', 'error'];
let currentState = 'idle';
let waveformBars = [];
let pillBars = [];
let audioLevels = new Array(42).fill(0);
let isPillMode = false;

// ── DOM references ──

let dom = {};

function cacheDom() {
  dom = {
    app: document.querySelector('.app'),
    statusLight: document.getElementById('statusLight'),
    captionText: document.getElementById('captionText'),
    captionHint: document.getElementById('captionHint'),
    hotkeyLabel: document.getElementById('hotkeyLabel'),
    hotkeyKey: document.getElementById('hotkeyKey'),
    waveform: document.getElementById('waveform'),
    pillWaveform: document.getElementById('pillWaveform'),
    flash: document.getElementById('flash'),
    btnSend: document.getElementById('btnSend'),
    btnDismiss: document.getElementById('btnDismiss'),
    btnPill: document.getElementById('btnPill'),
    btnClose: document.getElementById('btnClose'),
    // Views
    viewDictation: document.getElementById('viewDictation'),
    viewPill: document.getElementById('viewPill'),
    viewSettings: document.getElementById('viewSettings'),
    btnSettings: document.getElementById('btnSettings'),
    btnBack: document.getElementById('btnBack'),
    appHeader: document.getElementById('appHeader'),
    pillBar: document.querySelector('.pill-bar'),
    // Settings fields
    settingTheme: document.getElementById('settingTheme'),
    settingOpacity: document.getElementById('settingOpacity'),
    settingHotkey: document.getElementById('settingHotkey'),
    settingBackend: document.getElementById('settingBackend'),
    settingCleanupModel: document.getElementById('settingCleanupModel'),
    settingAutostart: document.getElementById('settingAutostart'),
  };
}

// ── Waveform ──

function initWaveform() {
  const container = dom.waveform;
  if (container) {
    container.innerHTML = '';
    waveformBars = [];
    for (let i = 0; i < 42; i++) {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      bar.style.setProperty('--i', i);
      bar.style.animationDelay = `${i * -57}ms`;
      container.appendChild(bar);
      waveformBars.push(bar);
    }
  }

  const pillContainer = dom.pillWaveform;
  if (pillContainer) {
    pillContainer.innerHTML = '';
    pillBars = [];
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      bar.style.setProperty('--i', i);
      bar.style.animationDelay = `${i * -80}ms`;
      pillContainer.appendChild(bar);
      pillBars.push(bar);
    }
  }
}

/**
 * Called from Python with an RMS audio level (0.0–1.0).
 */
function updateAudioLevel(rms) {
  audioLevels.shift();
  audioLevels.push(Math.min(1.0, rms * 3.0));

  for (let i = 0; i < waveformBars.length; i++) {
    const level = audioLevels[i];
    const height = Math.max(4, level * 52);
    waveformBars[i].style.height = `${height}px`;
    waveformBars[i].style.opacity = Math.max(0.3, 0.3 + level * 0.6);
  }

  for (let i = 0; i < pillBars.length; i++) {
    const level = audioLevels[i * 2] || 0;
    const height = Math.max(3, level * 16);
    pillBars[i].style.height = `${height}px`;
    pillBars[i].style.opacity = Math.max(0.3, 0.3 + level * 0.6);
  }
}

function resetWaveform() {
  audioLevels.fill(0);
  for (const bar of waveformBars) {
    bar.style.height = '8px';
    bar.style.opacity = '';
  }
  for (const bar of pillBars) {
    bar.style.height = '6px';
    bar.style.opacity = '';
  }
}

// ── State management ──

/**
 * Called from Python to update the app state.
 * @param {string} state - One of: idle, recording, transcribing, cleanup, review, pasting, error
 * @param {string} text - Status text, shown as the status light's hover tooltip
 */
function updateStatus(state, text) {
  for (const s of STATES) {
    dom.app.classList.remove(`state-${s}`);
  }
  dom.app.classList.add(`state-${state}`);
  currentState = state;

  if (dom.statusLight) dom.statusLight.title = text;

  // Review state: make text editable, allow Enter to send / Esc to dismiss
  if (state === 'review') {
    dom.captionText.setAttribute('contenteditable', 'true');
    if (dom.captionHint) dom.captionHint.textContent = 'Enter to send • Esc to dismiss';
    setTimeout(() => {
      dom.captionText.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(dom.captionText);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }, 50);
  } else {
    dom.captionText.setAttribute('contenteditable', 'false');
    if (dom.captionHint) dom.captionHint.textContent = '';
  }

  if (state === 'idle') {
    resetWaveform();
  }

  if (state === 'pasting') {
    showFlash('✓ Pasted');
  }

  if (state === 'error') {
    setTimeout(() => {
      if (currentState === 'error') {
        updateStatus('idle', 'Ready');
      }
    }, 4000);
  }
}

function updateTranscript(text) {
  if (!text || text.trim() === '') {
    dom.captionText.innerHTML = '<span class="caption-placeholder">Waiting for speech...</span>';
    return;
  }
  dom.captionText.textContent = text;
  dom.captionText.scrollTop = dom.captionText.scrollHeight;
}

function updateFinalText(text) {
  if (text && text.trim() !== '') {
    dom.captionText.textContent = text;
    dom.captionText.scrollTop = dom.captionText.scrollHeight;
  }
}

function clearEditor() {
  updateTranscript('');
}

// ── Send / Dismiss ──

async function sendText() {
  const text = dom.captionText.innerText || dom.captionText.textContent || '';
  if (!text.trim() || text.includes('Waiting for speech...')) return;

  if (window.pywebview && window.pywebview.api) {
    try {
      await pywebview.api.send_text(text.trim());
    } catch (e) {
      console.error('Failed to send text:', e);
    }
  } else {
    updateStatus('pasting', 'Pasting...');
    setTimeout(() => {
      updateStatus('idle', 'Ready');
      updateTranscript('');
    }, 1200);
  }
}

async function dismissText() {
  if (window.pywebview && window.pywebview.api) {
    try {
      await pywebview.api.dismiss();
    } catch (e) {
      console.error('Failed to dismiss:', e);
    }
  } else {
    updateStatus('idle', 'Ready');
    updateTranscript('');
  }
}

// ── Pill / Mini Bar Mode ──

async function enablePillMode() {
  isPillMode = true;
  dom.app.classList.add('mode-pill');
  document.body.classList.add('pill-mode');
  if (window.electronAPI) {
    window.electronAPI.resizeWindow(170, 56);
  } else if (window.pywebview && window.pywebview.api) {
    try {
      await pywebview.api.set_window_size(170, 56, true);
    } catch (e) {
      console.error('Failed to resize window to pill mode:', e);
    }
  }
}

async function disablePillMode() {
  isPillMode = false;
  dom.app.classList.remove('mode-pill');
  document.body.classList.remove('pill-mode');
  showDictation();
  if (window.electronAPI) {
    window.electronAPI.resizeWindow(400, 360);
  } else if (window.pywebview && window.pywebview.api) {
    try {
      await pywebview.api.set_window_size(400, 360, false);
    } catch (e) {
      console.error('Failed to resize window to full mode:', e);
    }
  }
}

// ── Window drag ──
//
// -webkit-app-region: drag regions never dispatch normal DOM mouse events
// to JS at all (Chromium routes them straight to native window-move
// handling) — fine for pure dragging, but it means a drag region can never
// also be a click target. Since the pill has no expand button (only the
// waveform is visible — a plain click on it expands back to Full mode),
// .header/.pill-bar are plain elements instead, and movement is driven
// here via mousedown/mousemove, through window.electronAPI.moveWindowBy()
// (exposed by preload.js). Click-vs-drag is distinguished by total pointer
// movement since mousedown: below CLICK_THRESHOLD_PX counts as a click.

const CLICK_THRESHOLD_PX = 4;

function initDrag() {
  const targets = [dom.appHeader, dom.pillBar].filter(Boolean);
  if (!targets.length) return;

  let dragging = false;
  let startEl = null;
  let lastX = 0;
  let lastY = 0;
  let totalMove = 0;

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, [contenteditable="true"]')) return;
    dragging = true;
    startEl = e.currentTarget;
    lastX = e.screenX;
    lastY = e.screenY;
    totalMove = 0;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (dx === 0 && dy === 0) return;
    lastX = e.screenX;
    lastY = e.screenY;
    totalMove += Math.abs(dx) + Math.abs(dy);
    if (window.electronAPI) {
      window.electronAPI.moveWindowBy(dx, dy);
    }
  }

  function onMouseUp() {
    if (!dragging) return;
    if (startEl === dom.pillBar && totalMove < CLICK_THRESHOLD_PX && isPillMode) {
      disablePillMode();
    }
    dragging = false;
    startEl = null;
  }

  targets.forEach((el) => el.addEventListener('mousedown', onMouseDown));
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
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

// ── Appearance (Theme & Opacity) ──

function applyTheme(isLight) {
  if (isLight) {
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
  }
  if (dom.settingTheme) {
    dom.settingTheme.classList.toggle('on', isLight);
    dom.settingTheme.setAttribute('aria-pressed', String(isLight));
  }
  localStorage.setItem('dictation_theme', isLight ? 'light' : 'dark');
}

function applyOpacity(opacityMode) {
  const modes = ['opacity-solid', 'opacity-glass', 'opacity-translucent'];
  modes.forEach(m => dom.app.classList.remove(m));
  dom.app.classList.add(`opacity-${opacityMode || 'glass'}`);
  if (dom.settingOpacity) {
    dom.settingOpacity.value = opacityMode || 'glass';
  }
  localStorage.setItem('dictation_opacity', opacityMode || 'glass');
}

// ── Settings ──

async function loadSettings() {
  const savedTheme = localStorage.getItem('dictation_theme');
  if (savedTheme) applyTheme(savedTheme === 'light');

  const savedOpacity = localStorage.getItem('dictation_opacity');
  if (savedOpacity) applyOpacity(savedOpacity);

  if (!window.pywebview || !window.pywebview.api) return;
  try {
    const config = await pywebview.api.get_config();
    if (config) {
      if (config.hotkey_raw && dom.settingHotkey) {
        dom.settingHotkey.value = config.hotkey_raw;
      }
      if (dom.settingBackend) dom.settingBackend.value = config.whisper_backend || '';
      if (dom.settingCleanupModel) dom.settingCleanupModel.value = config.cleanup_model || '';

      const autostart = config.autostart || false;
      if (dom.settingAutostart) {
        dom.settingAutostart.classList.toggle('on', autostart);
        dom.settingAutostart.setAttribute('aria-pressed', String(autostart));
      }

      if (config.theme) applyTheme(config.theme === 'light');
      if (config.opacity) applyOpacity(config.opacity);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  if (!window.pywebview || !window.pywebview.api) return;
  try {
    const isLight = dom.settingTheme ? dom.settingTheme.classList.contains('on') : false;
    await pywebview.api.save_config({
      hotkey: dom.settingHotkey ? dom.settingHotkey.value : undefined,
      theme: isLight ? 'light' : 'dark',
      opacity: dom.settingOpacity ? dom.settingOpacity.value : 'glass',
      autostart: dom.settingAutostart ? dom.settingAutostart.classList.contains('on') : false,
    });
    showFlash('Settings saved');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function setHotkeyDisplay(name, display) {
  if (dom.hotkeyKey) dom.hotkeyKey.textContent = display;
}

// ── Initialisation ──

function init() {
  cacheDom();
  initWaveform();
  initDrag();

  // Restore saved appearance early
  const savedTheme = localStorage.getItem('dictation_theme');
  if (savedTheme === 'light') applyTheme(true);

  const savedOpacity = localStorage.getItem('dictation_opacity');
  if (savedOpacity) applyOpacity(savedOpacity);

  // Navigation & Modes
  if (dom.btnSettings) {
    dom.btnSettings.addEventListener('click', () => {
      if (dom.viewSettings.classList.contains('active')) {
        showDictation();
      } else {
        showSettings();
      }
    });
  }

  if (dom.btnBack) {
    dom.btnBack.addEventListener('click', () => {
      showDictation();
    });
  }

  if (dom.btnPill) dom.btnPill.addEventListener('click', enablePillMode);
  if (dom.btnClose) dom.btnClose.addEventListener('click', async () => {
    if (window.pywebview && window.pywebview.api) {
      await pywebview.api.close_window();
    } else {
      console.log('Close window');
    }
  });

  // Action buttons
  if (dom.btnSend) dom.btnSend.addEventListener('click', sendText);
  if (dom.btnDismiss) dom.btnDismiss.addEventListener('click', dismissText);

  // Settings listeners
  if (dom.settingTheme) {
    dom.settingTheme.addEventListener('click', () => {
      const isLight = !dom.settingTheme.classList.contains('on');
      applyTheme(isLight);
      saveSettings();
    });
  }

  if (dom.settingOpacity) {
    dom.settingOpacity.addEventListener('change', () => {
      applyOpacity(dom.settingOpacity.value);
      saveSettings();
    });
  }

  if (dom.settingHotkey) {
    dom.settingHotkey.addEventListener('change', saveSettings);
  }

  if (dom.settingAutostart) {
    dom.settingAutostart.addEventListener('click', () => {
      const isOn = !dom.settingAutostart.classList.contains('on');
      dom.settingAutostart.classList.toggle('on', isOn);
      dom.settingAutostart.setAttribute('aria-pressed', String(isOn));
      saveSettings();
    });
  }

  // Keyboard shortcuts (Enter to send, Esc to dismiss in review state)
  window.addEventListener('keydown', (e) => {
    if (currentState === 'review') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dismissText();
      }
    }
  });

  // Set initial state
  updateStatus('idle', 'Initialising...');
  updateTranscript('');

  // Standalone preview fallback
  setTimeout(() => {
    if (!window.pywebview || !window.pywebview.api) {
      runDemoMode();
    }
  }, 500);
}

// ── Demo mode ──

function runDemoMode() {
  console.log('[demo] No pywebview bridge detected — running in preview mode');

  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const hotkeyDisplay = isMac ? 'Left Option' : 'Right Ctrl';
  setHotkeyDisplay('', hotkeyDisplay);
  updateStatus('idle', `Hold ${hotkeyDisplay} to record`);

  if (dom.settingHotkey) dom.settingHotkey.value = isMac ? 'alt_l' : 'ctrl_r';
  if (dom.settingBackend) dom.settingBackend.value = isMac ? 'mlx-whisper small Metal' : 'faster-whisper small cuda float16';
  if (dom.settingCleanupModel) dom.settingCleanupModel.value = 'llama3.2:3b';

  const demoText = 'I think the right approach is to keep live dictation focused and local, and move uploaded meeting files into the separate meeting transcriber tool.';

  setTimeout(() => {
    updateStatus('recording', 'Listening...');
    updateTranscript('');

    let waveInterval = setInterval(() => {
      if (currentState !== 'recording') {
        clearInterval(waveInterval);
        return;
      }
      updateAudioLevel(Math.random() * 0.4 + 0.05);
    }, 80);

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

    setTimeout(() => {
      clearInterval(waveInterval);
      clearInterval(partialInterval);
      updateTranscript(demoText);
      updateStatus('transcribing', 'Transcribing...');

      setTimeout(() => {
        updateStatus('cleanup', 'Cleaning up...');

        setTimeout(() => {
          updateFinalText(demoText);
          updateStatus('review', 'Edit if needed — Enter to send, Esc to dismiss');
        }, 1200);
      }, 1500);
    }, 4000);
  }, 1000);
}

// Event Listeners
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.addEventListener('pywebviewready', () => {
  loadSettings();
});
