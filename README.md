# Dictation

Personal, system-wide voice dictation assistant for **Windows and Mac** — like Wispr or Eloquent, built from scratch with open components.

Hold a hotkey, speak naturally (ums, false starts, self-corrections included), release — a live caption appears, then clean, polished text is shown for a quick review before being pasted into whatever text box has focus: Teams chat, browser, email, anywhere. One codebase, same behaviour on both machines.

**Primary use case:** quick Teams messages and short chat-box text. Optimised for low latency and reliability over raw transcription accuracy. Target round-trip: under ~3 seconds for a short sentence.

> **File transcription** (uploaded audio/video files) is handled by [`meeting-transcriber`](https://github.com/begb0037admin/meeting-transcriber), not this tool. This tool is focused exclusively on live push-to-talk dictation.

## How it works

1. App runs as a normal, always-visible desktop window (pywebview)
2. Place cursor in any text box
3. Hold the global hotkey (push-to-talk); mic records while held
4. A live partial transcript updates in the app window while you speak
5. Release — audio is transcribed locally, then cleaned up by a local LLM (Ollama): filler words stripped, grammar fixed, meaning and tone preserved
6. The cleaned text appears in the app's transcript area for review — edit it if needed, then press **Enter**/**Send** to paste it at the cursor, or **Esc**/**Dismiss** to discard it

> **Status note (2026-07-26):** step 6's review-and-confirm behaviour, plus a compact Pill/mini-bar window mode, replaced the previous "paste automatically on release" flow today and has not been tested on either platform yet. See `HANDOVER.md` and `ARCHITECTURE.md`.

## Architecture

| Component | Windows | Mac (Apple Silicon) |
|---|---|---|
| Language | Python (shared codebase) | Python (shared codebase) |
| UI | `pywebview` — native window rendering web UI | `pywebview` — native window rendering web UI |
| Hotkey capture | `pynput` — Right Ctrl by default | `pynput` — Left Option by default |
| Audio capture | `sounddevice` (in-memory numpy) | `sounddevice` (in-memory numpy) |
| Speech-to-text | `faster-whisper`, `small` model, CUDA + fp16 (RTX 3070) | `mlx-whisper`, `small` model, Metal-accelerated |
| Text cleanup | Ollama local REST API (`llama3.2:3b` / `gemma2:2b`) | Same — Ollama auto-accelerates via Metal |
| Text injection | Clipboard + simulated `Ctrl+V` (`pyperclip` + `pyautogui`) | Clipboard + simulated `Cmd+V` (`pyperclip` + `pyautogui`) |
| Config | `config.json` — platform-keyed hotkey/whisper sections, shared cleanup/sample-rate/theme/opacity settings | same file |

Local-first: free, private, no API keys. This table is a quick-reference summary — see `ARCHITECTURE.md` for the full state machine, threading model, and data flow, and `docs/BUILD_BRIEF.md` for the build history and rationale behind each decision.

## Status

- [x] **Step 1** — Push-to-talk hotkey (Right Ctrl / Left Option) triggers recording start/stop; audio captured to memory. Cross-platform via `pynput`. **Confirmed working on both platforms.**
- [x] **Step 2** — Transcribe: `faster-whisper` + CUDA on Windows, `mlx-whisper` on Mac. **Confirmed working on both platforms.**
- [x] **Step 3** — Clean up the transcript via a local Ollama model (`llama3.2:3b`), strips fillers/fixes grammar while preserving meaning. **Confirmed working on both platforms.**
- [x] **Step 4** — Paste cleaned text at cursor via clipboard (`pyperclip` + `pyautogui`, `Ctrl+V` / `Cmd+V`); original clipboard contents restored afterward. **Confirmed working on both platforms.**
- [x] **Live captions** — Live-updating partial transcript shown in the app window while recording (chunk-and-finalize so earlier words never disappear). **Confirmed working.**
- [x] **Web UI rework** — Replaced tkinter with pywebview. Dark-themed web UI with animated waveform, live transcript, status cells, and settings panel. **Confirmed working (2026-07-25).**
- [ ] **Compact review UI, Pill mode, frameless/vibrancy window** — editable transcript with Enter-to-send/Esc-to-dismiss (replaces auto-paste-on-release), a compact Pill/mini-bar window mode, a frameless transparent window with macOS Vibrancy, and a corrected Mac hotkey default. Built 2026-07-26, **not yet tested on either platform**.
- [ ] Step 5 — Run on login (optional toggle)
- [ ] Packaging/installer for colleagues — deferred; needs GPU-fallback + Ollama-distribution decisions first

### Running

```
pip install -r requirements.txt
python main.py
```

A dark-themed app window opens showing status, a live waveform, and a transcript area. Click into any other text box (Teams, Notepad, a browser), hold the hotkey (**Right Ctrl** on Windows, **Left Option** on Mac by default), speak, release — review the cleaned-up text, then press Enter/Send to paste it at your cursor there, or Esc/Dismiss to discard it. Close the window (in-app close button) to quit.

**Windows:** global hotkey hooking usually requires running the terminal **as Administrator**. If the mic can't be opened, check Settings → Privacy & security → Microphone and allow desktop apps.

**Mac:** grant **Accessibility** permission to Terminal (or your Python interpreter) under System Settings → Privacy & Security → Accessibility — without it, `pynput` silently receives no key events at all. If the mic can't be opened, grant Microphone access in the same Privacy & Security pane.

Hotkey (per platform), sample rate, and whisper backend are all configurable in `config.json`. Hotkey, theme, and window opacity can also be changed from the in-app Settings panel (hotkey changes need an app restart to take effect).

## Repo structure

```
main.py           # pywebview app window, hotkey listener, audio capture, live partial transcript
ui/
  index.html      # web UI (dictation view, Pill/mini-bar view, settings view)
  styles.css      # dark/light theme styling
  app.js          # frontend state machine, waveform, Python bridge
config.py         # loads config.json / defaults, resolves platform-keyed sections
config.json
requirements.txt
transcribe.py     # faster-whisper / mlx-whisper wrapper
cleanup.py        # Ollama call + de-um-ify/grammar prompt
inject.py         # clipboard + paste simulation
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
