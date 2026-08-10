# PTT

*(Formerly "Push 2 Talk" — renamed 2026-08-10.)*

Personal, system-wide voice dictation assistant for **Windows and Mac** — like Wispr or Eloquent, built from scratch with open components.

Hold a hotkey, speak naturally (ums, false starts, self-corrections included), release — the cleaned-up text pastes automatically wherever the cursor was when you started, no confirm step. One codebase, same behaviour on both machines.

**Primary use case:** quick Teams messages and short chat-box text. Optimised for low latency and reliability over raw transcription accuracy.

> **File transcription** (uploaded audio/video files) is handled by [`meeting-transcriber`](https://github.com/begb0037admin/meeting-transcriber), not this tool. This tool is focused exclusively on live push-to-talk dictation.

## How it works

1. App runs as a small, always-on-top window (or minimized to the system tray)
2. Place cursor in any text box
3. Hold the hotkey — keyboard modifier or mouse button — while you speak; mic records while held
4. Release — audio is transcribed locally, then cleaned up by a local LLM (Ollama): filler words stripped, grammar fixed, meaning and tone preserved
5. The cleaned text pastes automatically at the cursor — no review/confirm step, no window to click into

## Architecture

Electron shell (window, tray, hotkey UI) spawning a Python backend (audio, transcription, cleanup, paste) as a child process, talking over stdin/stdout — one JSON object per line. See `ARCHITECTURE.md` for the full data flow.

| Component | Windows | Mac (Apple Silicon) |
|---|---|---|
| Shell / UI | Electron (frameless, always-on-top, system tray) | Electron (frameless, borderless) |
| Backend | Python, spawned by Electron (PyInstaller-frozen when packaged) | Python, spawned by Electron |
| Hotkey capture | `pynput` — keyboard (Right Ctrl default) or mouse button (middle-click / side buttons) | `pynput` — keyboard (Left Option default) or mouse button |
| Audio capture | `sounddevice` (in-memory numpy) | `sounddevice` (in-memory numpy) |
| Speech-to-text | `faster-whisper`, `small` model, CUDA + fp16 (RTX 3070) | `mlx-whisper`, `small` model, Metal-accelerated |
| Text cleanup | Ollama local REST API (`llama3.2:3b`) | Same — Ollama auto-accelerates via Metal |
| Text injection | Clipboard + simulated `Ctrl+V` | Clipboard + simulated `Cmd+V` |
| Config | `config.json` (dev) / `%APPDATA%\ptt\config.json` (packaged) — platform-keyed hotkey/whisper sections | same shape, macOS user data dir |

Local-first: free, private, no API keys. See `ARCHITECTURE.md` for the full state machine/threading model and `docs/BUILD_BRIEF.md` for build history and rationale.

## Status (2026-07-31)

- **Windows: done, packaged, and in daily use.** NSIS installer (Electron + PyInstaller-frozen backend), always-on-top with a Settings toggle, minimize-to-tray (closing the window hides it; fully quit via the tray icon's Exit), keyboard or mouse-button hotkey, run-on-login. The Settings panel shows exactly which build is installed (version, short commit, build time) — see `HANDOVER.md` for the session-by-session build history if you need to compare or roll back to an earlier installer (every past build's `.exe` is still kept under `build/out/`).
- **Mac: dev mode confirmed working** (hotkey, waveform, paste, borderless window) on real Apple Silicon. **Packaging is blocked**: the packaged `.app` fails its own Accessibility/Input Monitoring permission check on launch even after granting both permissions — root cause still under investigation. See `HANDOVER.md`'s 2026-07-30 entries for the full trail.
- Transcription tuned for speed (`beam_size=2`, a deliberate middle ground between the default's accuracy and greedy decoding's speed).

### Running (dev mode)

```
pip install -r requirements.txt
cd electron && npm install
```

Two processes: `python main.py` runs the backend standalone (useful for isolated debugging), but normal dev use is `npm start` from `electron/`, which spawns the Python backend itself and opens the real app window.

**Windows:** global hotkey hooking usually requires running the terminal **as Administrator**. If the mic can't be opened, check Settings → Privacy & security → Microphone and allow desktop apps.

**Mac:** grant **Accessibility** permission to Terminal (or your Python interpreter) under System Settings → Privacy & Security → Accessibility — without it, `pynput` silently receives no key events at all. If the mic can't be opened, grant Microphone access in the same Privacy & Security pane.

Hotkey (per platform), theme, window opacity, and always-on-top can all be changed from the in-app Settings panel (hotkey changes need an app restart to take effect).

### Building a Windows installer

```
.\build\build-app.ps1
```

Produces a fresh NSIS installer under `build\out\<run-id>\electron\PTT Setup 0.1.0.exe`. See `build/build-app.ps1`'s own comments and `HANDOVER.md` for known pitfalls (e.g. never background it with PowerShell's `*>&1` stream redirection — use `Start-Transcript` instead, see the 2026-07-29 session entry).

## Repo structure

```
main.py           # backend entry point: hotkey listener, audio capture, pipeline orchestration
transcribe.py      # faster-whisper / mlx-whisper wrapper
cleanup.py          # Ollama call + de-um-ify/grammar prompt
inject.py            # clipboard + paste simulation
config.py         # loads config.json / defaults, resolves platform-keyed sections
config.json
requirements.txt
electron/
  main.js         # window/tray/lifecycle, spawns and talks to the Python backend over stdio
  preload.js      # contextBridge API exposed to the renderer
  package.json
ui/
  index.html      # dictation view, Pill/mini-bar view, settings view
  styles.css      # dark/light theme styling
  app.js          # frontend state machine, waveform, Electron bridge
build/
  build-app.ps1   # Windows packaging pipeline (PyInstaller + electron-builder)
  build-app.sh    # Mac packaging pipeline (unverified end-to-end - see Status above)
  generate-builder-config.js  # per-run electron-builder config generator
docs/BUILD_BRIEF.md
ARCHITECTURE.md   # current-state component/threading/state-machine reference
CLAUDE.md / AGENT_MODEL.md / CONSTITUTION.md / HANDOVER.md   # governance stack
```

## Documentation

Suggested reading order for anyone (or any agent) new to this repo:

1. **This README** — what the project is, how to run it
2. [`CLAUDE.md`](CLAUDE.md) — bootstrap entry point, identity, hard rules
3. [`HANDOVER.md`](HANDOVER.md) — current state, session-by-session history, what's next
4. [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) — the original build brief plus every scope amendment since, with rationale
5. [`ARCHITECTURE.md`](ARCHITECTURE.md) — current component table, state machine, threading model, and data flow
6. [`CONSTITUTION.md`](CONSTITUTION.md) / [`AGENT_MODEL.md`](AGENT_MODEL.md) — cross-repo governance and role model (not specific to this project)

## License

Private repository — a personal/internal tool built by and for Kevin Lelitte (University of Oxford, HR Systems). Not licensed for external use or redistribution.
