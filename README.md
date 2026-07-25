# Dictation

Personal, system-wide voice dictation assistant for **Windows and Mac** — like Wispr or Eloquent, built from scratch with open components.

Hold a hotkey, speak naturally (ums, false starts, self-corrections included), release — clean, polished text is pasted into whatever text box has focus: Teams chat, browser, email, anywhere. One codebase, same behaviour on both machines.

**Primary use case:** quick Teams messages and short chat-box text. Optimised for low latency and reliability over raw transcription accuracy. Target round-trip: under ~3 seconds for a short sentence.

> **File transcription** (uploaded audio/video files) is handled by [`meeting-transcriber`](https://github.com/begb0037admin/meeting-transcriber), not this tool. This tool is focused exclusively on live push-to-talk dictation.

## How it works

1. App runs as a normal, always-visible desktop window (pywebview)
2. Place cursor in any text box
3. Hold the global hotkey (push-to-talk); mic records while held
4. A live partial transcript updates in the app window while you speak
5. Release — audio is transcribed locally, then cleaned up by a local LLM (Ollama): filler words stripped, grammar fixed, meaning and tone preserved
6. Cleaned text is pasted at the cursor via clipboard simulation

## Architecture

| Component | Windows | Mac (Apple Silicon) |
|---|---|---|
| Language | Python (shared codebase) | Python (shared codebase) |
| UI | `pywebview` — native window rendering web UI | `pywebview` — native window rendering web UI |
| Hotkey capture | `pynput` — Right Ctrl by default | `pynput` — Right Option by default |
| Audio capture | `sounddevice` (in-memory numpy) | `sounddevice` (in-memory numpy) |
| Speech-to-text | `faster-whisper`, `small` model, CUDA + fp16 (RTX 3070) | `mlx-whisper`, `small` model, Metal-accelerated |
| Text cleanup | Ollama local REST API (`llama3.2:3b` / `gemma2:2b`) | Same — Ollama auto-accelerates via Metal |
| Text injection | Clipboard + simulated `Ctrl+V` (`pyperclip` + `pyautogui`) | Clipboard + simulated `Cmd+V` (`pyperclip` + `pyautogui`) |
| Config | `config.json` — platform-keyed hotkey/whisper sections, shared cleanup/sample-rate settings | same file |

Local-first: free, private, no API keys. See `docs/BUILD_BRIEF.md` for the full build brief.

## Status

- [x] **Step 1** — Push-to-talk hotkey (Right Ctrl / Right Option) triggers recording start/stop; audio captured to memory. Cross-platform via `pynput`. **Confirmed working on both platforms.**
- [x] **Step 2** — Transcribe: `faster-whisper` + CUDA on Windows, `mlx-whisper` on Mac. **Confirmed working on both platforms.**
- [x] **Step 3** — Clean up the transcript via a local Ollama model (`llama3.2:3b`), strips fillers/fixes grammar while preserving meaning. **Confirmed working on both platforms.**
- [x] **Step 4** — Paste cleaned text at cursor via clipboard (`pyperclip` + `pyautogui`, `Ctrl+V` / `Cmd+V`); original clipboard contents restored afterward. **Confirmed working on both platforms.**
- [x] **Live captions** — Live-updating partial transcript shown in the app window while recording (chunk-and-finalize so earlier words never disappear). **Confirmed working.**
- [x] **Web UI rework** — Replaced tkinter with pywebview. Dark-themed web UI with animated waveform, live transcript, status cells, and settings panel.
- [ ] Step 5 — Run on login (optional toggle)
- [ ] Mac retest after UI rework
- [ ] Packaging/installer for colleagues — deferred; needs GPU-fallback + Ollama-distribution decisions first

### Running

```
pip install -r requirements.txt
python main.py
```

A dark-themed app window opens showing status, a live waveform, and a transcript area. Click into any other text box (Teams, Notepad, a browser), hold the hotkey (**Right Ctrl** on Windows, **Right Option** on Mac by default), speak, release — the cleaned-up text is pasted at your cursor there. Close the window to quit.

**Windows:** global hotkey hooking usually requires running the terminal **as Administrator**. If the mic can't be opened, check Settings → Privacy & security → Microphone and allow desktop apps.

**Mac:** grant **Accessibility** permission to Terminal (or your Python interpreter) under System Settings → Privacy & Security → Accessibility — without it, `pynput` silently receives no key events at all. If the mic can't be opened, grant Microphone access in the same Privacy & Security pane.

Hotkey (per platform), sample rate, and whisper backend are all configurable in `config.json`. The cleanup model can also be changed from the in-app Settings panel.

## Repo structure

```
main.py           # pywebview app window, hotkey listener, audio capture, live partial transcript
ui/
  index.html      # web UI (dictation view + settings view)
  styles.css      # dark theme styling
  app.js          # frontend state machine, waveform, Python bridge
config.py         # loads config.json / defaults, resolves platform-keyed sections
config.json
requirements.txt
transcribe.py     # faster-whisper / mlx-whisper wrapper
cleanup.py        # Ollama call + de-um-ify/grammar prompt
inject.py         # clipboard + paste simulation
docs/BUILD_BRIEF.md
CLAUDE.md / AGENT_MODEL.md / CONSTITUTION.md / HANDOVER.md   # governance stack
```
