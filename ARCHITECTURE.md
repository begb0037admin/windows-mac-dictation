# ARCHITECTURE.md — windows-dictation

> Current-state architecture reference — the single place documenting component responsibilities, threading, state machine, and data flow as they actually exist in the code today. For build history and the rationale behind each design decision, see `docs/BUILD_BRIEF.md`. For session-by-session change history, see `HANDOVER.md`. For project orientation and hard rules, see `CLAUDE.md`.
>
> Repo note: the GitHub repository is `begb0037admin/windows-mac-dictation` (renamed from `windows-dictation`; the old name still resolves via GitHub's redirect). See `HANDOVER.md`'s 2026-07-26 entry.

## 1. Pipeline overview

```
hold hotkey -> capture audio -> live partial transcript (feedback only)
   -> release -> full transcribe (Whisper) -> cleanup (Ollama)
   -> review (editable, in-app) -> send -> clipboard + simulated paste
```

Only the "send" step touches the focused application. Everything before it is local to this app's own window.

## 2. Components

| Component | Windows | Mac (Apple Silicon) |
|---|---|---|
| `main.py` | `pywebview` window (frameless, transparent, `vibrancy=True`), `pynput` hotkey listener, `sounddevice` capture, `DictationAPI` JS bridge | same file, same class — platform branches only where required |
| `transcribe.py` | `faster-whisper`, `small`, CUDA, fp16 | `mlx-whisper`, `small`, Metal, HF repo `mlx-community/whisper-small-mlx` |
| `cleanup.py` | Ollama local REST API (`llama3.2:3b`), `<transcript>` tag guard, `temperature: 0` | same |
| `inject.py` | clipboard + `Ctrl+V` via `pyperclip`/`pyautogui` | clipboard + `Cmd+V` |
| `config.py` / `config.json` | resolves platform-keyed `hotkey`/`whisper` sections via `platform.system()`; shared `cleanup`/`sample_rate`/`theme`/`opacity`/`autostart` | same |
| `ui/index.html`, `ui/app.js`, `ui/styles.css` | dark/light themed web UI, waveform, editable review panel, Pill mode, Settings panel | same files, rendered via WebView2 (Windows) / WebKit (Mac) |

## 3. State machine

`main.py`/`app.js` drive a shared state machine, pushed from Python via `push_status()`:

```
idle -> recording -> transcribing -> cleanup -> review -> pasting -> idle
                                              (any state) -> error -> idle
```

- **review** (added 2026-07-26) is a deliberate stop: the cleaned transcript is shown editable in the UI. The user presses **Enter**/**Send** to paste, or **Esc**/**Dismiss** to discard. This replaced the original "paste happens once, cleanly, on release" behavior described in `docs/BUILD_BRIEF.md` §11 — the pipeline no longer auto-pastes; see `HANDOVER.md` 2026-07-26.
- **error** can be entered from most stages (mic failure, transcription exception — cleanup failure instead falls back to the raw transcript rather than erroring, see §5) and auto-returns to idle after ~4s (`app.js`).

## 4. Threading model

| Thread | Owner | Responsibility |
|---|---|---|
| Main thread | `webview.start()` | Runs the pywebview event loop; owns the native window |
| Hotkey listener | `pynput.keyboard.Listener` (its own thread) | `on_press`/`on_release` — starts recording synchronously; spawns a new thread for `stop_recording()` so the listener thread is never blocked by transcription |
| Audio callback | `sounddevice.InputStream`'s callback thread | Appends frames to the shared buffer, computes RMS, pushes waveform updates to the UI — all under `state_lock` |
| Partial-transcription loop | one daemon thread per recording (`partial_transcription_loop`) | Every 0.8s, transcribes the in-progress ~5s chunk for live captions; never touches the app's real paste |
| Final transcription / cleanup / inject | the `stop_recording()` thread spawned by `on_release` | Runs the full-buffer transcribe -> cleanup -> (on Send) inject sequence |

**Locks:**
- `state_lock` — guards the shared `recording` flag and `frames` buffer between the audio callback, the partial loop, and `stop_recording()`.
- `transcribe_lock` — serializes all calls into the Whisper model object, so the partial-caption loop and the final post-release transcription never call the model concurrently.

**Python -> UI:** `window.evaluate_js()`, called from any thread, injects a JS function call into the webview's JS context (`updateStatus`, `updateTranscript`, `updateFinalText`, `updateAudioLevel`).

**UI -> Python:** `pywebview.api.*` calls into `DictationAPI` methods (`send_text`, `dismiss`, `get_config`, `save_config`, `set_window_size`, `close_window`), dispatched by pywebview on its own thread(s).

## 5. Data flow detail

1. Hotkey press -> `start_recording()` opens the `sounddevice` stream and starts the partial-transcription thread.
2. While held: `audio_callback` buffers audio and pushes RMS to the waveform; `partial_transcription_loop` shows a live, never-losing-earlier-words transcript (chunk-and-finalize: each ~5s chunk is transcribed once and locked in, only the current in-progress chunk keeps re-transcribing).
3. Release -> `stop_recording()`: stream closes, the **entire** captured buffer is transcribed once in full (`transcribe.py`) for maximum accuracy — independent of whatever the partial loop showed.
4. `cleanup.py` sends the transcript to local Ollama (system prompt wraps it in `<transcript>` tags and instructs the model never to respond to its contents; `temperature: 0`). On any Ollama error (unreachable, model not pulled, timeout), the raw transcript is used instead — no crash, no lost text.
5. Result is pushed into the **review** state: editable text, Send/Dismiss buttons, Enter/Esc shortcuts.
6. On Send: `DictationAPI.send_text()` -> `inject.py` — clipboard is swapped, paste keystroke simulated (`Ctrl+V`/`Cmd+V`), original clipboard contents restored.

## 6. Window management

- `webview.create_window(frameless=True, transparent=True, vibrancy=True, easy_drag=False, min_size=(200, 44))` — no native title bar or OS close button; a custom in-UI close button calls `DictationAPI.close_window()` -> `window.destroy()`.
- Two layouts, toggled client-side and backed by a real OS resize: **Full** (400×360, default) and **Pill/mini-bar** (260×44), via `DictationAPI.set_window_size()`.
- Theme (dark/light) and opacity (`solid`/`glass`/`translucent`) are user-togglable in Settings, cached in `localStorage` for instant restore, and persisted to `config.json` via `save_config()`.
- `vibrancy=True` maps to macOS's `NSVisualEffectView` — a macOS-specific pywebview feature. Its behavior on Windows (WebView2) is **not yet confirmed** — see §7.

## 7. Known gaps / open questions (as of 2026-07-26)

- The entire UI rework described in §3 and §6 (review/edit flow, Pill mode, frameless/transparent/vibrancy window, theme/opacity settings) was built in one session today and **has not been tested on either Windows or Mac yet** — see `HANDOVER.md`.
- `vibrancy` and `transparent` window styling is a macOS-native concept; how (or whether) it renders on Windows/WebView2 is unverified.
- Mac's default hotkey changed today from `alt_r` (Right Option — a key that doesn't physically exist on standard Apple keyboards) to `alt_l` (Left Option); not yet re-tested.
- No GPU-absent (CPU) fallback exists for Windows transcription — `config.json` hardcodes `device: cuda`. Tracked as a packaging blocker in `docs/BUILD_BRIEF.md` §12.
- No automated tests exist for any module.
