# CLAUDE.md — windows-dictation
> AI bootstrap entry point. Read this first.
> Keep this file under 200 lines. Push details to linked docs.

## Identity
- **Project:** Dictation — system-wide push-to-talk voice dictation assistant, **cross-platform: Windows and Mac**
- **Purpose:** Hold a hotkey, speak naturally, release — cleaned-up text (fillers stripped, grammar fixed, meaning preserved) is pasted into whatever text box has focus. Built for quick Teams messages and short chat-box text. One codebase, unified behaviour on both machines — added as a requirement 2026-07-09 (originally scoped Windows-only; see `docs/BUILD_BRIEF.md` §10).
- **Owner:** Kevin Lelitte, Manager/Director HR Systems, University of Oxford
- **Status:** MVP in progress — Steps 1–4 + live-caption rework confirmed working end-to-end on both platforms. UI reworked from tkinter to pywebview (web-based, dark theme, animated waveform). File transcription removed — it belongs to `meeting-transcriber`. Outstanding: Mac retest after UI rework, Step 5 (run on login), a real Teams desktop/browser test, and packaging for colleagues (deferred — see `docs/BUILD_BRIEF.md` §12)
- **Repo:** https://github.com/begb0037admin/windows-dictation *(name predates the cross-platform scope — flag to Kevin if a rename is wanted; not done unilaterally)*
- **Runs on:** Kevin's Windows 11 machine (RTX 3070, 8GB VRAM) AND a Mac (Apple Silicon, confirmed) — local-only, no cloud dependencies in MVP

## Bootstrap Order
1. This file (orientation)
2. `AGENT_MODEL.md` and `CONSTITUTION.md` — governance and role model (cross-repo standard)
3. `HANDOVER.md` — current state, what was just built, what's next
4. `docs/BUILD_BRIEF.md` — the full build brief; §1–9 original Windows-only brief, §10 cross-platform amendment, §11 UI rework (Transcribe File removed — moved to `meeting-transcriber`), §12 distribution/packaging (deferred), §13 pywebview UI rework — all apply
5. `README.md` — condensed overview

Do NOT ask Kevin for a recap. HANDOVER.md is the recap.

## Build Order
Build the MVP checklist in `docs/BUILD_BRIEF.md` §4, in the order listed, testing each step on **both** machines before moving to the next (confirm hotkey + recording works on Windows and Mac before wiring up transcription, etc.). Incremental and debuggable — not one big untested drop.

## Architecture
| Component | Windows | Mac (Apple Silicon) |
|---|---|---|
| `main.py` | `pywebview` app window (dark-themed web UI with waveform + live partial transcript + settings), `pynput` hotkey listener, background partial-transcription loop while recording (shared code, platform branches only where required) | same file |
| `transcribe.py` | faster-whisper — `small` model, `device: cuda`, `compute_type: float16` | mlx-whisper — `small` model, Metal-accelerated |
| `cleanup.py` | Ollama local REST API (`llama3.2:3b` / `gemma2:2b`) — swap point for a cloud LLM later | same — Ollama auto-accelerates via Metal |
| `inject.py` | Clipboard + simulated `Ctrl+V` via `pyperclip` + `pyautogui` | Clipboard + simulated `Cmd+V` via `pyperclip` + `pyautogui` |
| `config.py` / `config.json` | Platform-keyed hotkey (`ctrl_r`) and whisper backend sections, resolved by `platform.system()` at load; shared cleanup/sample-rate/autostart settings | Platform-keyed hotkey (`alt_r`) |

**No system tray.** Original design used `pystray` as a background tray utility; Kevin asked for a normal always-visible app window instead (see `docs/BUILD_BRIEF.md` §11).

**Web-based UI via pywebview.** The UI was reworked from tkinter to pywebview (see `docs/BUILD_BRIEF.md` §13). The Python backend is unchanged; only the window layer was replaced. The web UI provides a dark-themed interface with an animated waveform that responds to real audio levels, a live partial transcript, pipeline status cells, and a settings panel. `pywebview` renders the HTML in a native window (Edge WebView2 on Windows, WebKit on Mac) with no Electron bloat.

**Live captions, not live typing.** While the hotkey is held, a background loop transcribes speech in ~5s chunks — each finalized chunk permanently appended, only the current in-progress chunk re-transcribed every ~0.8s — and shows the growing transcript in this app's own window: full history stays visible, each call stays bounded/fast regardless of recording length. The actual paste into the focused app (Teams, etc.) still only happens once, cleanly, on release. Typing live directly into a third-party app was considered and rejected as too fragile (§11).

**No file transcription.** The "Transcribe File" feature that was previously scoped and built in this repo has been removed. File/meeting transcription belongs to `meeting-transcriber`.

## Key Constraints
- Local-first: no API keys, no cloud calls in MVP. Cloud cleanup is a later config toggle.
- **One shared codebase, not two apps.** Platform differences are handled with `platform.system()` branches inside the same files (config-driven where possible), not separate scripts per OS.
- `keyboard` library is dropped — unreliable on macOS. `pynput` is the only hotkey library, used on both platforms.
- Default hotkeys are lone modifier keys (Right Ctrl on Windows, Right Option on Mac), not Caps Lock — Caps Lock has OS-level toggle behaviour that fights push-to-talk and needs per-key suppression `pynput` can't do selectively. Modifier keys held alone have no side effects, so no suppression is needed.
- Clipboard-paste injection, NOT simulated individual keystrokes — Teams' web view drops simulated keystrokes. Verify paste in both Teams desktop and Teams-in-browser, on both OSes.
- macOS requires Accessibility permission (hotkey listener) and Input Monitoring/Microphone permission (paste simulation, audio) granted to Terminal/the Python interpreter under System Settings → Privacy & Security — there is no Windows equivalent. Fail loudly with a clear message if these aren't granted; never silently receive no events.
- GPU: Windows transcription/cleanup run on the RTX 3070 (sanity-check with `nvidia-smi` — 0% during a test dictation means silent CPU fallback). Mac transcription runs on Apple Silicon via MLX/Metal (mlx-whisper); Ollama cleanup auto-accelerates via Metal on Mac too.
- Surface model-download progress on first run (faster-whisper/mlx-whisper + Ollama pull hundreds of MB to a few GB) — never hang silently.
- Fail loudly with a clear message if the OS blocks mic access — never silently record nothing.
- Default hotkeys must avoid OS/Teams shortcut collisions and be configurable per platform.

## Effort Level Governance
Before any task where higher effort is warranted, signal to Kevin: what the task is, why higher effort is needed, and an explicit request to raise the effort level. Wait — do not proceed until Kevin raises it. Signal when the high-effort phase is done; Kevin decides when to return to normal. Never change effort level unilaterally. See CONSTITUTION.md Section 10 (v2.0, 2026-06-27).

## Hard Rules
- Never commit credentials or API keys — the MVP needs none; if a cloud cleanup toggle is added later, keys live in env vars only
- The brief (`docs/BUILD_BRIEF.md` §1–10) defines scope — do not add stretch goals (§5) before the MVP checklist (§4) is complete and working on both platforms
- Build and test one MVP checklist item at a time — Kevin confirms each step works on **both** Windows and Mac before the next is built
- This is a local app on two machines — Claude Code writes and pushes the code but cannot run or test it (no mic, no hotkey listener, no GPU in the cloud sandbox on either OS); Kevin runs and verifies on the admin machine and the Mac
- Always update `HANDOVER.md` at end of session
- All mockups and visual designs are produced as Claude Artifacts — never committed to the repository (see CONSTITUTION.md Section 11)

## Branch and Merge Protocol
Always push directly to main. If a branch must be used, merge it to main immediately upon completion — never leave files on a branch.
