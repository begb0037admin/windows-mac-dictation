# CLAUDE.md — windows-dictation
> AI bootstrap entry point. Read this first.
> Keep this file under 200 lines. Push details to linked docs.

## Identity
- **Project:** PTT — system-wide push-to-talk voice dictation assistant, **cross-platform: Windows and Mac** *(renamed from "Push 2 Talk" 2026-08-10 — see HANDOVER.md)*
- **Purpose:** Hold a hotkey, speak naturally, release — cleaned-up text (fillers stripped, grammar fixed, meaning preserved) is shown for a quick review/edit, then pasted into whatever text box has focus on confirm (Enter/Send) — or discarded (Esc/Dismiss). Built for quick Teams messages and short chat-box text. One codebase, unified behaviour on both machines — added as a requirement 2026-07-09 (originally scoped Windows-only; see `docs/BUILD_BRIEF.md` §10).
- **Owner:** Kevin Lelitte, Manager/Director HR Systems, University of Oxford
- **Status:** **A replacement Mac Large V3 Turbo package was built on 2026-07-30 after live evidence exposed recursive PyInstaller resource-tracker children creating five dictation pipelines.** A Mac-only frozen entry point now calls `multiprocessing.freeze_support()` before importing the backend; the exact packaged tracker-diversion test passes. Installation and physical acceptance of this latest DMG remain. **Windows was deliberately untouched by this Mac-only repair.** Windows' installed Small-model build was confirmed working end-to-end on 2026-07-29; source already targets `large-v3-turbo`, so a future Windows/RTX 3070 build and acceptance test remains separate work. See `HANDOVER.md`. File transcription removed — it belongs to `meeting-transcriber`.
- **Repo:** https://github.com/begb0037admin/windows-mac-dictation *(renamed from `windows-dictation`, which still resolves via GitHub's redirect — closes the rename flag raised in `HANDOVER.md`'s 2026-07-09 session)*
- **Runs on:** Kevin's Windows 11 machine (RTX 3070, 8GB VRAM) AND a Mac (Apple Silicon, confirmed) — local-only, no cloud dependencies in MVP

## Bootstrap Order
1. This file (orientation)
2. `AGENT_MODEL.md` and `CONSTITUTION.md` — governance and role model (cross-repo standard)
3. `HANDOVER.md` — current state, what was just built, what's next
4. `docs/BUILD_BRIEF.md` — the full build brief; §1–9 original Windows-only brief, §10 cross-platform amendment, §11 UI rework (Transcribe File removed — moved to `meeting-transcriber`), §12 distribution/packaging (deferred), §13 pywebview UI rework, §14 compact/review UI + Pill mode + frameless window — all apply
5. `ARCHITECTURE.md` — current component/threading/state-machine reference (start here for "how does the code actually work right now")
6. `README.md` — condensed overview

Do NOT ask Kevin for a recap. HANDOVER.md is the recap.

## Build Order
Build the MVP checklist in `docs/BUILD_BRIEF.md` §4, in the order listed, testing each step on **both** machines before moving to the next (confirm hotkey + recording works on Windows and Mac before wiring up transcription, etc.). Incremental and debuggable — not one big untested drop.

## Architecture
See `ARCHITECTURE.md` for the full component table, threading model, state machine, and data flow. Design constraints that must not be silently reintroduced:
- **System tray (added 2026-07-29, reverses the original "no system tray" decision below).** Kevin explicitly asked for minimize-to-tray: the window still opens normally and stays always-visible/always-on-top by default (the original always-visible intent is preserved) - closing it (X, the in-app close button, or Alt+F4) hides it to the tray instead of quitting. The app is only fully closed via the tray icon's own "Exit" item, or the machine restarting. Do not silently revert this back to quit-on-close. *(Original 2026-07 reasoning, now superseded: "Kevin asked for a normal, always-visible app window instead of a background tray utility" — docs/BUILD_BRIEF.md §11.)*
- **Live captions, not live typing.** The live partial transcript is feedback only, shown in this app's own window — never typed directly into the focused app (rejected as too fragile, §11).
- **No file transcription.** That belongs to `meeting-transcriber`, not this repo.

## Key Constraints
- Local-first: no API keys, no cloud calls in MVP. Cloud cleanup is a later config toggle.
- **One shared codebase, not two apps.** Platform differences are handled with `platform.system()` branches inside the same files (config-driven where possible), not separate scripts per OS.
- `keyboard` library is dropped — unreliable on macOS. `pynput` is the only hotkey library, used on both platforms.
- Default hotkeys are lone modifier keys (Right Ctrl on Windows, Left Option on Mac — corrected 2026-07-26; standard Apple keyboards have no physical Right Option key), not Caps Lock — Caps Lock has OS-level toggle behaviour that fights push-to-talk and needs per-key suppression `pynput` can't do selectively. Modifier keys held alone have no side effects, so no suppression is needed.
- Clipboard-paste injection, NOT simulated individual keystrokes — Teams' web view drops simulated keystrokes. Verify paste in both Teams desktop and Teams-in-browser, on both OSes.
- macOS requires Accessibility permission (hotkey listener) and Input Monitoring/Microphone permission (paste simulation, audio) granted to Terminal/the Python interpreter under System Settings → Privacy & Security — there is no Windows equivalent. Fail loudly with a clear message if these aren't granted; never silently receive no events.
- GPU: Windows transcription/cleanup run on the RTX 3070 (sanity-check with `nvidia-smi` — 0% during a test dictation means silent CPU fallback). Mac transcription runs on Apple Silicon via MLX/Metal (mlx-whisper); Ollama cleanup auto-accelerates via Metal on Mac too.
- Surface model-download progress on first run (faster-whisper/mlx-whisper + Ollama pull hundreds of MB to a few GB) — never hang silently.
- Fail loudly with a clear message if the OS blocks mic access — never silently record nothing.
- Default hotkeys must avoid OS/Teams shortcut collisions and be configurable per platform.
- `vibrancy`/`transparent` window styling (added 2026-07-26) is a macOS-native pywebview feature — its behaviour on Windows/WebView2 is unverified; see `ARCHITECTURE.md` §7.

## Effort Level Governance
Before any task where higher effort is warranted, signal to Kevin: what the task is, why higher effort is needed, and an explicit request to raise the effort level. Wait — do not proceed until Kevin raises it. Signal when the high-effort phase is done; Kevin decides when to return to normal. Never change effort level unilaterally. See CONSTITUTION.md Section 10 (v2.0, 2026-06-27).

## Hard Rules
- Never commit credentials or API keys — the MVP needs none; if a cloud cleanup toggle is added later, keys live in env vars only
- The brief (`docs/BUILD_BRIEF.md` §1–10) defines scope — do not add stretch goals (§5) before the MVP checklist (§4) is complete and working on both platforms
- Build and test one MVP checklist item at a time — Kevin confirms each step works on **both** Windows and Mac before the next is built
- This is a local app on two machines. The default assumption is Claude Code writes and pushes the code but cannot run or test it (no mic, no hotkey listener, no GPU in a cloud sandbox); Kevin runs and verifies. **This does not hold when Claude Code is running directly on one of the two machines themselves** (confirmed first on Windows 2026-07-09, again on Mac 2026-07-30, `kevins-MBP`) — in that case Claude Code can run builds, test suites, and even visual smoke-checks (screenshot + inspect) directly. Live hotkey-press/mic/speech testing still needs Kevin physically present regardless of where Claude Code runs.
- Always update `HANDOVER.md` at end of session
- All mockups and visual designs are produced as Claude Artifacts — never committed to the repository (see CONSTITUTION.md Section 11)

## Branch and Merge Protocol
Always push directly to main. If a branch must be used, merge it to main immediately upon completion — never leave files on a branch.
