/* app.js — Frontend logic for the Push 2 Talk UI (Electron shell, talks to
   main.py over the backend-event/backend-command IPC wired in preload.js;
   also keeps a pywebview.api fallback for the older non-Electron build).
   Manages the waveform visualisation, handles editing/sending transcripts,
   supports Mini Pill Mode, and bridges settings (hotkey, theme, opacity, cleanup model, autostart). */

'use strict';

// ── State ──

const STATES = ['idle', 'recording', 'transcribing', 'cleanup', 'pasting', 'error'];
// audioLevels must be at least as long as the larger of the two bar counts
// below (the pill reads it at index i*2, so it needs at least
// PILL_BAR_COUNT*2 slots too) -- a mismatch here previously left the
// rightmost bars reading past the end of the array (undefined -> NaN
// height), which froze them instead of scrolling like the rest.
const FULL_BAR_COUNT = 54;
const PILL_BAR_COUNT = 24;
let currentState = 'idle';
let waveformBars = [];
let pillBars = [];
let audioLevels = new Array(Math.max(FULL_BAR_COUNT, PILL_BAR_COUNT * 2)).fill(0);
let isPillMode = false;

// ── DOM references ──

let dom = {};

function cacheDom() {
  dom = {
    app: document.querySelector('.app'),
    statusLight: document.getElementById('statusLight'),
    captionText: document.getElementById('captionText'),
    hotkeyKey: document.getElementById('hotkeyKey'),
    waveform: document.getElementById('waveform'),
    pillWaveform: document.getElementById('pillWaveform'),
    pillStatus: document.getElementById('pillStatus'),
    flash: document.getElementById('flash'),
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
    settingAlwaysOnTop: document.getElementById('settingAlwaysOnTop'),
    buildInfo: document.getElementById('buildInfo'),
    // App error panel (SS14)
    appError: document.getElementById('appError'),
    appErrorCode: document.getElementById('appErrorCode'),
    appErrorMessage: document.getElementById('appErrorMessage'),
    appErrorDetail: document.getElementById('appErrorDetail'),
    appErrorDismiss: document.getElementById('appErrorDismiss'),
  };
}

// ── Waveform ──

function initWaveform() {
  const container = dom.waveform;
  if (container) {
    container.innerHTML = '';
    waveformBars = [];
    for (let i = 0; i < FULL_BAR_COUNT; i++) {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      bar.style.setProperty('--i', i);
      // Stagger spans one full wave-idle cycle (1.4s) across all bars, so
      // idle reads as one clean sweep travelling across the width instead
      // of several overlapping ripples (54 * 26ms ~= 1.4s).
      bar.style.animationDelay = `${i * -26}ms`;
      container.appendChild(bar);
      waveformBars.push(bar);
    }
  }

  const pillContainer = dom.pillWaveform;
  if (pillContainer) {
    pillContainer.innerHTML = '';
    pillBars = [];
    for (let i = 0; i < PILL_BAR_COUNT; i++) {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      bar.style.setProperty('--i', i);
      bar.style.animationDelay = `${i * -80}ms`;
      pillContainer.appendChild(bar);
      pillBars.push(bar);
    }
  }
}

// "Aurora" color treatment (approved from the waveform mockup): a
// teal -> violet -> magenta hue sweep across the bar array that also
// drifts slowly over time, brightening with how loud that instant is.
function auroraColor(index, count, level) {
  const hue = (175 + (index / count) * 130 + (Date.now() / 55) % 40) % 360;
  const light = 56 + level * 14;
  return `hsl(${hue}, 88%, ${light}%)`;
}

// Kevin (2026-07-30): idle should stay monochrome (black/grey/chrome), not
// Aurora - only the *size*/rendering mechanics are shared with active, not
// the colour. A near-zero-saturation hue with a slow per-bar brightness
// shimmer keeps the original "traveling flash of light across chrome"
// idle character. Light theme needs darker charcoal tones, or a light
// chrome gradient nearly vanishes against the near-white panel background.
// `frac` (this bar's position 0-1 across its own view) rather than a raw
// index - see shapeLevel()'s matching comment for why.
function chromeColor(frac, level) {
  const isLight = document.body.classList.contains('theme-light');
  const shimmer = 0.5 + 0.5 * Math.sin(Date.now() / 500 + frac * WAVE_PHASE_SCALE * 0.4);
  const light = isLight
    ? 30 + level * 15 + shimmer * 10
    : 62 + level * 15 + shimmer * 14;
  return `hsl(220, 6%, ${Math.max(15, Math.min(92, light))}%)`;
}

// Reference bar count all the phase formulas below are tuned against
// (matches FULL_BAR_COUNT). The pill has far fewer bars (PILL_BAR_COUNT),
// so indexing its wobble/shimmer phase by raw index alone made the same
// wave-per-index frequency complete far fewer visible ripples across its
// shorter length - it read as flatter than the full view even though it
// was driven by the identical formula. Normalizing to *fraction across
// this bar's own view* first, then rescaling by WAVE_PHASE_SCALE, makes
// every view show the same wave density regardless of how many bars it has.
const WAVE_PHASE_SCALE = FULL_BAR_COUNT;

// Kevin (2026-07-30): "they need to match for idle and active, because the
// pill is smaller we need to increase the animation" - matching wave
// density (WAVE_PHASE_SCALE) wasn't enough on its own; the pill still read
// as calmer purely because of its smaller physical size, so its swing is
// amplified beyond the full view's on top of that.
const PILL_ANIMATION_BOOST = 1.8;

function paintBar(bar, level, maxHeight, minHeight, index, count, mono) {
  const height = Math.max(minHeight, level * maxHeight);
  bar.style.height = `${height}px`;
  // Kevin (2026-07-30): opacity used to scale down to 0.4 for quiet bars,
  // which against the light-theme container's near-white background
  // washed the colour out toward grey/white instead of staying vivid like
  // the reference - only height should convey level, colour should stay
  // consistently saturated regardless of how tall any one bar is right now.
  bar.style.opacity = 0.92;
  const frac = index / count;
  const color = mono ? chromeColor(frac, level) : auroraColor(index, count, level);
  bar.style.background = color;
  bar.style.boxShadow = mono
    ? `0 0 ${3 + level * 6}px rgba(255, 255, 255, 0.3)`
    : `0 0 ${5 + level * 12}px ${color.replace('hsl', 'hsla').replace(')', ',0.55)')}`;
}

// See the "almost straight, not enough curves" comment in updateAudioLevel
// below for why this exists - shared by both the full and pill views so
// neither reads as a flat plateau during sustained speech. Takes `count`
// so the wobble's wave density matches across views of different bar
// counts - see WAVE_PHASE_SCALE above. `boost` (Kevin, 2026-07-30: "because
// the pill is smaller we need to increase the animation") lets a
// physically smaller view amplify its swing beyond just matching density,
// since the same relative motion reads as far less lively at a smaller
// physical size - the pill passes >1 here, the full view leaves it at 1.
function shapeLevel(level, index, count, now, boost = 1) {
  const frac = (index / count) * WAVE_PHASE_SCALE;
  const wobble = 0.5 + 0.5 * Math.sin(now / 130 + frac * 1.7) + 0.3 * Math.sin(now / 260 + frac * 0.6);
  return Math.max(0, Math.min(1, level * (0.3 + 0.7 * wobble) * boost));
}

/**
 * Called from Python with an RMS audio level (0.0–1.0).
 */
function updateAudioLevel(rms) {
  // Raw mic RMS for normal speaking volume is small (roughly 0.02-0.1) --
  // a flat rms*3 scale left the waveform barely moving for anything short
  // of shouting. This compressive curve (boost, then a <1 power) makes
  // normal speech read as clearly visible motion while still leaving
  // headroom for genuinely loud input to look proportionally bigger.
  // Kevin (2026-07-30): bars still weren't using the container's available
  // height at normal speaking volume - pushed the boost/compression much
  // further so typical speech pins close to the ceiling, not just a
  // "visible but small" swing.
  const boosted = Math.pow(Math.min(1, rms * 18), 0.4);
  audioLevels.shift();
  audioLevels.push(boosted);

  // audioLevels is sized to the larger of the two views' needs (see its
  // declaration above), so the full view - unlike the pill below - must
  // read the *tail* of the buffer (the most recent samples), not index 0,
  // or it would show stale, lagging history once the buffer is longer than
  // waveformBars itself.
  const fullOffset = audioLevels.length - waveformBars.length;
  const now = Date.now();
  for (let i = 0; i < waveformBars.length; i++) {
    const level = audioLevels[fullOffset + i];
    paintBar(waveformBars[i], shapeLevel(level, i, waveformBars.length, now), 60, 4, i, waveformBars.length);
  }

  // Kevin (2026-07-30): mini pill view was never given the same wobble
  // shaping as the full view above, so it still read as "one straight line
  // with minimal movement" - same treatment here, just against the pill's
  // own bar count/index so its ripple isn't simply a cropped copy of the
  // full view's. PILL_ANIMATION_BOOST on top of that, per Kevin's own call:
  // "because the pill is smaller we need to increase the animation."
  for (let i = 0; i < pillBars.length; i++) {
    const level = audioLevels[i * 2] || 0;
    paintBar(pillBars[i], shapeLevel(level, i, pillBars.length, now, PILL_ANIMATION_BOOST), 20, 3, i, pillBars.length);
  }
}

function resetWaveform() {
  audioLevels.fill(0);
  // Bar styling itself is no longer cleared here - the idle shimmer loop
  // (started by updateStatus whenever state becomes 'idle') immediately
  // repaints every bar via the same paintBar() used while recording, so
  // idle and active are the same-sized, same-coloured component instead of
  // two different-looking ones.
}

// Kevin (2026-07-30): "use the active as the default in terms of size and
// bars" - idle used to be a completely separate CSS animation (a small
// grey/chrome gradient scaled via transform on an 8px base), which looked
// like a different, smaller component than the real Aurora-coloured,
// full-height bars shown while recording. This drives idle through the
// exact same paintBar() rendering as updateAudioLevel() above, just fed a
// gentle synthetic level instead of real mic RMS, so idle is literally a
// calmer instance of the same bars, not a lookalike.
let idleAnimFrame = null;

function idleShimmerTick() {
  const now = Date.now();
  // Kevin (2026-07-30): "add more solid bars together" - the previous
  // frac*0.5 spatial frequency made each "high" part of the cycle only
  // span a couple of bars, reading as isolated peaks in a sea of thin
  // dashes. A much slower spatial frequency (frac*0.15) spreads each
  // high/low swing across many more consecutive bars, so a wider clump
  // reads as solid together, travelling as one group rather than as
  // scattered individual peaks. Raised the baseline too, so more of the
  // cycle sits in "clearly solid" territory rather than "thin dash."
  for (let i = 0; i < waveformBars.length; i++) {
    const frac = (i / waveformBars.length) * WAVE_PHASE_SCALE;
    const synthetic = 0.2 + 0.14 * Math.sin(now / 900 + frac * 0.15);
    paintBar(waveformBars[i], shapeLevel(synthetic, i, waveformBars.length, now), 60, 4, i, waveformBars.length, true);
  }
  for (let i = 0; i < pillBars.length; i++) {
    const frac = (i / pillBars.length) * WAVE_PHASE_SCALE;
    const synthetic = 0.2 + 0.14 * Math.sin(now / 620 + frac * 0.15);
    paintBar(pillBars[i], shapeLevel(synthetic, i, pillBars.length, now, PILL_ANIMATION_BOOST), 20, 3, i, pillBars.length, true);
  }
  idleAnimFrame = requestAnimationFrame(idleShimmerTick);
}

function startIdleShimmer() {
  if (idleAnimFrame !== null) return;
  idleShimmerTick();
}

function stopIdleShimmer() {
  if (idleAnimFrame !== null) {
    cancelAnimationFrame(idleAnimFrame);
    idleAnimFrame = null;
  }
}

// ── State management ──

// Short labels for the mini pill's status text — the full status text is
// too long for a 170px-wide pill, so this is a separate, deliberately
// terse mapping.
const PILL_STATUS_TEXT = {
  transcribing: 'Transcribing…',
  cleanup: 'Cleaning up…',
  pasting: 'Pasting…',
  error: 'Error',
};

/**
 * Called from Python to update the app state.
 * @param {string} state - One of: idle, recording, transcribing, cleanup, pasting, error
 * @param {string} text - Status text, shown as the status light's hover tooltip
 */
function updateStatus(state, text) {
  for (const s of STATES) {
    dom.app.classList.remove(`state-${s}`);
  }
  dom.app.classList.add(`state-${state}`);
  currentState = state;

  if (dom.statusLight) dom.statusLight.title = text;
  if (dom.pillStatus) dom.pillStatus.textContent = PILL_STATUS_TEXT[state] || '';

  if (state === 'idle') {
    resetWaveform();
    startIdleShimmer();
  } else {
    stopIdleShimmer();
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

// ── App error panel (SS14) ──
//
// Fatal errors (severity: 'fatal') are non-dismissible and force Full view
// - there's no point showing a fatal error behind the tiny pill. Warnings
// (severity: 'warning', e.g. LOGIN_ITEM_FAILED) are dismissible and never
// block dictation; they don't force a view change.

function handleAppError(payload) {
  if (!dom.appError || !payload) return;
  const isFatal = payload.severity === 'fatal';
  dom.appErrorCode.textContent = payload.code || '';
  dom.appErrorMessage.textContent = payload.message || '';
  dom.appErrorDetail.textContent = payload.detail ? JSON.stringify(payload.detail) : '';
  dom.appError.classList.remove('severity-fatal', 'severity-warning');
  dom.appError.classList.add(isFatal ? 'severity-fatal' : 'severity-warning');
  dom.appError.classList.add('visible');
  if (isFatal && isPillMode) disablePillMode();
}

// Sent once by main.js after the UI loads (electron/main.js's
// resolveBuildInfo()) - a plain, always-visible line in Settings rather
// than something you have to know to go looking for, since juggling
// several hand-built installers was the actual problem this solves.
function handleAppVersion(info) {
  if (!dom.buildInfo || !info) return;
  const shaLabel = info.gitDirty ? `${info.gitSha}+dirty` : info.gitSha;
  const dateLabel = info.builtAt
    ? new Date(info.builtAt).toLocaleString()
    : 'dev build';
  dom.buildInfo.textContent = `v${info.version} · ${shaLabel} · ${dateLabel}`;
}

function dismissAppError() {
  if (!dom.appError) return;
  if (dom.appError.classList.contains('severity-fatal')) return; // non-dismissible
  dom.appError.classList.remove('visible');
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

/**
 * Populate the Settings fields from a config object — shared by the
 * pywebview get_config() response and the Electron 'config' backend event.
 */
function applyConfig(config) {
  if (!config) return;
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

  const alwaysOnTop = config.alwaysOnTop !== false; // default true, matches config.py
  if (dom.settingAlwaysOnTop) {
    dom.settingAlwaysOnTop.classList.toggle('on', alwaysOnTop);
    dom.settingAlwaysOnTop.setAttribute('aria-pressed', String(alwaysOnTop));
  }

  if (config.theme) applyTheme(config.theme === 'light');
  if (config.opacity) applyOpacity(config.opacity);
}

async function loadSettings() {
  const savedTheme = localStorage.getItem('dictation_theme');
  if (savedTheme) applyTheme(savedTheme === 'light');

  const savedOpacity = localStorage.getItem('dictation_opacity');
  if (savedOpacity) applyOpacity(savedOpacity);

  if (window.electronAPI) {
    window.electronAPI.sendCommand({ cmd: 'get_config' });
    return;
  }

  if (!window.pywebview || !window.pywebview.api) return;
  try {
    const config = await pywebview.api.get_config();
    applyConfig(config);
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  const isLight = dom.settingTheme ? dom.settingTheme.classList.contains('on') : false;
  const data = {
    hotkey: dom.settingHotkey ? dom.settingHotkey.value : undefined,
    theme: isLight ? 'light' : 'dark',
    opacity: dom.settingOpacity ? dom.settingOpacity.value : 'glass',
    autostart: dom.settingAutostart ? dom.settingAutostart.classList.contains('on') : false,
    alwaysOnTop: dom.settingAlwaysOnTop ? dom.settingAlwaysOnTop.classList.contains('on') : true,
  };

  if (window.electronAPI) {
    window.electronAPI.sendCommand({ cmd: 'save_config', data });
    showFlash('Settings saved');
    return;
  }

  if (!window.pywebview || !window.pywebview.api) return;
  try {
    await pywebview.api.save_config(data);
    showFlash('Settings saved');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function setHotkeyDisplay(name, display) {
  if (dom.hotkeyKey) dom.hotkeyKey.textContent = display;
}

// ── Backend events (Electron only) ──
//
// main.py writes one JSON object per line to its stdout; electron/main.js
// forwards each as a 'backend-event' IPC message, delivered here via
// preload.js's onBackendEvent. See main.py's module docstring for the
// full event/command shapes.

function handleBackendEvent(event) {
  switch (event.type) {
    case 'status':
      updateStatus(event.state, event.text);
      break;
    case 'transcript':
      updateTranscript(event.text);
      break;
    case 'final_text':
      updateFinalText(event.text);
      break;
    case 'audio_level':
      updateAudioLevel(event.rms);
      break;
    case 'ready':
      setHotkeyDisplay(event.hotkey_raw, event.hotkey_display);
      break;
    case 'config':
      applyConfig(event);
      break;
    default:
      console.warn('[backend] unknown event type:', event.type);
  }
}

// ── Initialisation ──

function init() {
  cacheDom();
  initWaveform();
  startIdleShimmer();
  initDrag();

  if (window.electronAPI && window.electronAPI.onBackendEvent) {
    window.electronAPI.onBackendEvent(handleBackendEvent);
  }
  if (window.electronAPI && window.electronAPI.onAppError) {
    window.electronAPI.onAppError(handleAppError);
  }
  if (window.electronAPI && window.electronAPI.onAppVersion) {
    window.electronAPI.onAppVersion(handleAppVersion);
  }
  if (dom.appErrorDismiss) {
    dom.appErrorDismiss.addEventListener('click', dismissAppError);
  }

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
    if (window.electronAPI) {
      window.electronAPI.closeWindow();
    } else if (window.pywebview && window.pywebview.api) {
      await pywebview.api.close_window();
    } else {
      console.log('Close window');
    }
  });

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

  if (dom.settingAlwaysOnTop) {
    dom.settingAlwaysOnTop.addEventListener('click', () => {
      const isOn = !dom.settingAlwaysOnTop.classList.contains('on');
      dom.settingAlwaysOnTop.classList.toggle('on', isOn);
      dom.settingAlwaysOnTop.setAttribute('aria-pressed', String(isOn));
      saveSettings();
    });
  }

  // Set initial state
  updateStatus('idle', 'Initialising...');
  updateTranscript('');

  // Standalone preview fallback — only when neither a real Electron backend
  // nor a pywebview bridge is present (e.g. index.html opened directly in a
  // plain browser tab for quick CSS iteration).
  setTimeout(() => {
    const hasElectronBackend = !!window.electronAPI;
    const hasPywebviewBackend = !!(window.pywebview && window.pywebview.api);
    if (!hasElectronBackend && !hasPywebviewBackend) {
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
          updateStatus('pasting', 'Pasting...');
          setTimeout(() => updateStatus('idle', 'Ready'), 1000);
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
