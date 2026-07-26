# windows-dictation — Living Handover Document

> See also: `ARCHITECTURE.md` (current-state component/threading/state-machine reference), `docs/BUILD_BRIEF.md` (build history and amendment rationale), `CLAUDE.md` (bootstrap/hard rules).

**Last updated:** 2026-07-26 — compact review UI, Pill mode, frameless/vibrancy window (logged this session); documentation audit and refresh; three code fixes + a starter test suite from the engineering review
**Status:** Steps 1–4 + live-caption rework confirmed on both platforms (as of 2026-07-25). A further UI rework landed today (2026-07-26) — editable review step (Enter to send / Esc to dismiss), Pill/mini-bar mode, frameless transparent/vibrancy window, theme/opacity settings — **not yet tested on either platform**. Same session: config.py's stale Mac hotkey default and shallow merge fixed, main.py's lock consistency and a macOS Accessibility preflight check added, and a starter test suite added (test_config.py, test_cleanup.py) — all logic-level fixes, verified passing locally, but not yet exercised on real hardware. Outstanding: retest both platforms against all of the above, Step 5 (run on login), a real Teams test, packaging (deferred).

---

## Session 2026-07-26 — Compact review UI, Pill mode, frameless/vibrancy window (logged retroactively); documentation audit; engineering-review fixes

**Part A — six commits from earlier today, not previously logged.** Between this file's last entry (2026-07-25, commit `a5d1a82`) and this session, six commits landed that reworked the UI further without a HANDOVER entry or BUILD_BRIEF amendment. Logged now for the record, per `CONSTITUTION.md` §5 (documentation permanence — undocumented work is debt):

1. `763cecf` — **Mac hotkey default fixed:** `alt_r` (Right Option) → `alt_l` (Left Option). Standard Apple keyboards have no physical Right Option key, so the previous default was unusable as shipped. Display label also corrected to show "Option" rather than "Alt" on Mac.
2. `81cb1cd` — **Standalone demo mode** added to `app.js` (`runDemoMode()`): when no `pywebview` bridge is present (i.e. `ui/index.html` opened directly in a browser), the UI runs a scripted fake dictation so the interface can be previewed/designed without the Python backend. Dev convenience only, not part of the real pipeline.
3. `1e4237f` — **Compact UI + editable review step.** The transcript area is now editable (`contenteditable`) once cleanup finishes; a new `review` state was added to the state machine (between `cleanup` and `pasting`) with Send/Dismiss buttons and Enter/Esc keyboard shortcuts. **This changes the documented behavior in `docs/BUILD_BRIEF.md` §11 and this file's earlier sessions** — the pipeline no longer pastes automatically on release; it now stops and waits for explicit confirmation. Settings gained hotkey/theme fields.
4. `1e214d4` — **Pill/mini-bar mode** added: a compact 260×44 bar view, toggled via a new button, backed by a real window resize (`DictationAPI.set_window_size`). Window opacity/glass controls (`solid`/`glass`/`translucent`) added to Settings. The cleanup-model field in Settings is now greyed out (read-only via UI, config.json-only).
5. `8f0d7d0` — **Frameless, transparent window.** `webview.create_window()` now passes `frameless=True`, `transparent=True`, `easy_drag=False` — no native title bar or OS close button; a custom close button in the UI calls the new `close_window()` bridge method.
6. `76bee48` — **Native macOS Vibrancy** (`vibrancy=True`, backed by `NSVisualEffectView`) for the glassmorphism look from Kevin's original mockup.

**None of this has been tested yet on Windows or Mac** — same "built, not confirmed" state as every other session in this file before Kevin runs it. Two things specifically worth testing given what changed: (1) whether `vibrancy`/`transparent` render sensibly on Windows' WebView2, since that pywebview feature is documented as macOS-oriented, and (2) the corrected Mac hotkey.

**Part B — documentation audit and refresh (this session).** Read every doc in the repo (`CLAUDE.md`, `CONSTITUTION.md`, `AGENT_MODEL.md`, this file, `README.md`, `docs/BUILD_BRIEF.md`) plus all source files, per a documentation audit request. Findings and changes:
- Added `ARCHITECTURE.md` — this repo had no single current-state architecture reference; the component table was duplicated across README/CLAUDE.md/HANDOVER with no owner, and (per Part A) had drifted out of date regardless.
- Removed this file's trailing `## Architecture` / `## Key Constraints` / `## Next Action` section (unstructured leftover from the very first commit of this file) — it still described Steps 3–5 as "not yet built," directly contradicting the status block at the top of this same file. Fully superseded by `ARCHITECTURE.md` and `CLAUDE.md`; nothing unique was lost.
- Closed the rename flag raised in the "Cross-platform pivot" session below: the GitHub repo is now `begb0037admin/windows-mac-dictation` (the old `windows-dictation` name still resolves via GitHub's redirect). Current-state docs (`CLAUDE.md`, `README.md`, `ARCHITECTURE.md`) now reference the current name; the historical entries in this file are left exactly as written, since they were accurate at the time.
- `docs/BUILD_BRIEF.md` gained §14 recording Part A's UI changes, in keeping with its existing amendment pattern (§10–13).
- `README.md`'s status checklist, hotkey default, and "How it works" step 6 (paste-on-release) corrected to match the current pipeline; added a Documentation section cross-linking every doc, and a License note (private/internal, no license granted).
- Did not create TESTING.md, DECISIONS.md, API_REFERENCE.md, RELEASE.md, or CHANGELOG.md — flagged as premature for a solo-developer MVP tool with no test suite, no release process, and no public API. Recommend revisiting once packaging (`docs/BUILD_BRIEF.md` §12) is actually underway.

**Part C — approved engineering-review fixes (this session, after go-ahead).** An engineering review of the codebase (architecture, threading, config, error handling, cross-platform risk, testing, packaging) surfaced a handful of small, independently-verifiable issues. Three were fixed, each as its own commit:
1. **`config.py`** — fixed the stale Mac hotkey default (`DEFAULTS["hotkey"]["darwin"]` still said `alt_r` even after Part A's commit `763cecf` corrected it — that commit only patched the tracked `config.json`, so a fresh install or a deleted `config.json` would have silently regenerated the broken default) and replaced the shallow `dict.update()` merge with a real deep merge, so a `config.json` that only overrides one platform's `hotkey`/`whisper` section no longer silently drops the other platform's default.
2. **`main.py`** — brought `stream`/`partial_stop_event` under `state_lock` consistently (previously read/written outside the lock, unlike `recording`/`frames` — a theoretical race if the hotkey is pressed/released/pressed fast enough, given auto-repeat already produces duplicate key events per the 2026-07-09 session notes above). Added `check_macos_accessibility()`, a preflight check via `Quartz.CGPreflightListenEventAccess()` (already a transitive `pynput` dependency on Mac — no new requirement) that exits with a clear message if Accessibility/Input Monitoring isn't granted, instead of silently starting a hotkey listener that will never receive events — closing a real gap between `CLAUDE.md`'s "fail loudly, never silently receive no events" hard rule and what the code actually did.
3. **`test_config.py` / `test_cleanup.py`** (new) — stdlib `unittest` only, no new dependency. Covers the deep-merge fix (including a direct regression test reproducing the shallow-merge bug), the Mac hotkey default, and `cleanup.py`'s `<transcript>`-tag/temperature/error-handling behaviour — none of it needs a mic, GPU, or a real Ollama instance.

**Self-caught mistake, logged for the record:** the first attempt at the `config.py` fix accidentally committed the file's *base64-encoded* content as literal text instead of the decoded source (a tooling mismatch — one write path expects already-encoded content, another expects plain text, and the wrong one was used) — this would have made the app fail to start at all (`SyntaxError` on import). The new test suite caught it immediately when run locally, before this was reported as done. Fixed in the same session and re-verified by re-fetching all four files fresh via the GitHub API (bypassing the raw CDN, which briefly served a stale cached copy of the broken version) and re-running the full suite: 11/11 pass. Logged per `CONSTITUTION.md` §5 — worth knowing this failure mode exists, and that testing before declaring something done is what caught it.

**Verification note:** `config.py` and `cleanup.py` have zero mic/GPU/hardware dependencies, so their tests were actually executed this session (not just written) — a narrow, deliberate exception to `CLAUDE.md`'s "Claude Code cannot run or test it" hard rule, which is about the app as a whole and doesn't apply to these two pure-logic modules.

**Next action:** Kevin (or Hope) tests today's full set of changes end-to-end on both platforms — the review/Send/Dismiss flow, Pill mode resize, the frameless/vibrancy window on Windows, the corrected Mac hotkey, and (on Mac) the new Accessibility preflight message. Once confirmed, revisit Step 5 (run on login) and the packaging/GPU-fallback questions.

---

## Session 2026-07-25 — pywebview UI rework + file-transcription trim

Two changes in one session:

**1. UI reworked from tkinter to pywebview.** The basic tkinter window (status label + text box + "Transcribe File" button) has been replaced with a web-based UI rendered in a native window via `pywebview`. The new UI is based on Kevin's HTML mockup and provides:
- Dark-themed interface (`#111827` base, gradient accents, glassmorphism panels)
- Real-time animated waveform that responds to actual microphone audio levels
- Live partial transcript area with auto-scroll
- Pipeline status cells (Capture / Whisper / Cleanup / Paste) that highlight as each stage runs
- Hotkey badge showing which key to hold
- Settings panel (gear icon toggle) for changing the Ollama cleanup model and viewing read-only config
- State machine with visual transitions: idle → recording → transcribing → cleaning up → pasting → idle (with error state)

The entire Python backend (hotkey listener, audio capture, partial transcription loop, transcribe.py, cleanup.py, inject.py) is completely unchanged — only the window/UI layer was replaced.

New files: `ui/index.html`, `ui/styles.css`, `ui/app.js`. New dependency: `pywebview` in `requirements.txt`.

**2. "Transcribe File" feature removed.** Per Kevin's brief, this tool is for live push-to-talk dictation only (like Wispr / Eloquent). File transcription belongs to `meeting-transcriber`. Removed from `main.py`: `choose_audio_file()`, `_process_audio_file()`, `AUDIO_FILETYPES`, `file_processing`, `file_button`, filedialog/messagebox imports. Removed from `transcribe.py`: file-path branch (`isinstance(audio, (str, Path))`), `pathlib` import, ffmpeg docstring references.

**Not yet tested.** Needs testing on both platforms:
1. Does the pywebview window open and display correctly?
2. Does the waveform respond to audio levels while recording?
3. Does the live partial transcript update correctly?
4. Does the full pipeline still work (transcribe → cleanup → paste)?
5. Does the settings panel display and save correctly?
6. Does closing the window quit cleanly?

**Next action:** Kevin tests on Windows first, then Mac.

---

## Session 2026-07-09 (continued) — "Transcribe File" built

**Note (2026-07-25): This feature has been removed.** File transcription now belongs to `meeting-transcriber`. The code described below was removed in the 2026-07-25 session.

Kevin's priority order: Transcribe File first, then a packaging design conversation.

**Built:** `transcribe.py`'s `transcribe()` now accepts either a numpy array (live dictation, unchanged) or a file path string/`Path` — for a path, it's handed straight to the whisper backend, which decodes it itself (faster-whisper via its bundled PyAV; mlx-whisper by shelling out to system `ffmpeg`, **a new Mac-only prerequisite** — `brew install ffmpeg` — that live dictation doesn't need).

`main.py` gained a "Transcribe File..." button in the same window (no separate process needed for this, unlike the original plan sketched before the tray was dropped — with no tray icon there's only ever one tkinter root, so the main-thread-conflict problem that motivated a separate process doesn't exist here). Clicking it opens a file picker, then runs transcribe → cleanup on a background thread, and on completion: copies the result to the clipboard, displays it in the window, and saves a `.txt` file next to the audio file. Guards added so it can't run concurrently with a live dictation (disabled while recording, and vice versa) — not a hard technical requirement (the `transcribe_lock` already serializes actual model calls safely) but avoids the two flows visually fighting over the same status label/text box.

**Not yet tested at all.** Needs a test on both platforms:
1. Windows: pick an audio file, confirm transcribe → cleanup → clipboard + on-screen + `.txt` file all happen correctly.
2. Mac: same, but first confirm/install `ffmpeg` via `brew install ffmpeg` — if that's missing, mlx-whisper's file decoding will fail with an unhelpful error.

**Next action:** test Transcribe File on both platforms, then move to the packaging conversation Kevin asked for (GPU-fallback design + how colleagues get Ollama set up).

---

## Session 2026-07-09 (continued) — Mac confirmed on the reworked app

Same test as Windows: window opened correctly, live transcript displayed and matched speech, and the cleaned-up (or fallback) text pasted correctly into a real target app on Mac. Only needed `pip3.14 install -r requirements.txt` to pick up the two new dependencies (`pyperclip`, `pyautogui`) added for Step 4.

**Both platforms are now fully confirmed on the current app.** This is a good checkpoint — MVP Steps 1–4 plus the UI rework are done and working, not just built.

**Still outstanding, not yet started:**
- Step 5 — run on login (optional toggle)
- Parked "Transcribe File" upload feature (scoped earlier this session — pick an audio file, same transcribe→cleanup pipeline, output to clipboard + on-screen + `.txt` file, simple tkinter window)
- Packaging/distribution to colleagues — deferred pending two open questions (Ollama can't be bundled; no GPU-absent fallback exists yet). See previous session note for full detail.

---

## Session 2026-07-09 (continued) — Windows confirmed end-to-end; two live-caption iterations; packaging flagged for later

**Live caption needed two rounds of tuning after the initial rework:**
1. First test: caption updates were "really delayed" — root cause was re-transcribing the *entire* growing recording every 1.5s, so cost (and lag) grew with recording length. Fixed by bounding each call to a rolling 5s window and polling every 0.8s instead of 1.5s.
2. Second test: now fast, but each update *overwrote* the previous text instead of accumulating — a direct side effect of only looking at a rolling window (older words fell out of the window entirely). Fixed properly: audio is split into ~5s chunks. Once a chunk reaches ~5s it's "finalized" — transcribed once, permanently appended to a running `finalized_text` string, never re-transcribed again — while only the *current* in-progress chunk keeps re-transcribing every 0.8s for the live feel. This keeps every call bounded to ~5s of audio (fast, regardless of total recording length) while the displayed text keeps the full growing transcript, not just a recent snippet. Kevin confirmed: "I like the way it works."

**End-to-end confirmed on Windows (24.67s recording):** transcript accurate, cleanup **timed out** (60s) and gracefully fell back to the raw transcript exactly as designed — no crash, no lost text — and the fallback text pasted correctly into Notepad. The timeout is most likely GPU contention between faster-whisper and Ollama sharing the RTX 3070's VRAM, or Ollama reloading its model after sitting idle — not a code bug. Worth watching if it recurs frequently; if so, `OLLAMA_KEEP_ALIVE` or similar tuning could help, but not acted on now since the fallback already handles it gracefully.

**Packaging/distribution flagged, deferred:** Kevin wants to give this to colleagues eventually and asked about an installer for both platforms. This is already a listed stretch goal (`docs/BUILD_BRIEF.md` §5 — PyInstaller + Inno Setup). Recommended deferring until the app is stable and tested on both platforms (packaging a moving target means repackaging repeatedly), and flagged two real open questions that packaging will force a decision on:
1. **Ollama can't be bundled into an installer** — it's a separate background service each user has to install and pull a model for themselves, same as Kevin did on both his own machines.
2. **GPU assumption isn't built for other users** — `config.json`'s Windows `whisper` section hardcodes `device: cuda`. Colleagues without an NVIDIA GPU need a CPU fallback (or auto-detection), which doesn't exist yet.

Kevin agreed to defer packaging until the app itself is confirmed stable.

**Next action:** Mac hasn't been tested since today's window/live-caption rework — needs a full retest there (window opens correctly, live caption behaves the same way, paste works, closing the window quits cleanly). Once both platforms are confirmed on the reworked app, revisit: Step 5 (run on login), the parked "Transcribe File" upload feature, and the packaging/GPU-fallback questions above.

---

## Session 2026-07-09 (continued) — Step 4 built; UI reworked (no tray, live captions, normal window)

**Step 4 built:** `inject.py` (unchanged from earlier plan) — clipboard + simulated paste, restores original clipboard after.

**Then two real requirement changes from Kevin, in sequence, after seeing Step 4 work:**

1. Asked about a "Transcribe File" upload feature (pick an audio file, run through the same pipeline, output to clipboard + on-screen + `.txt` file, same Ollama cleanup, simple tkinter window). **Scoped via AskUserQuestion, not yet built** — parked in favour of the next point, which Kevin raised as more urgent.

2. Said the hold→release→silence→then-paste flow "isn't something I can work with" — wanted live text-as-you-speak like Windows Voice Typing / Mac Dictation. Presented two options:
   - **(A)** Type live, continuously-updating text directly into the focused app (replicating native OS dictation) — flagged as fragile (would need to track exactly what was typed and select/replace it as more speech arrives, in whatever third-party app has focus).
   - **(B)** A live-updating partial transcript shown in this app's own window while recording; the real paste into the focused app still happens once, cleanly, on release.

   Kevin picked **B**.

3. Immediately followed up: also don't want a system tray at all — just a normal, always-visible app window, on both platforms.

**Both changes led to one rework**, documented in `docs/BUILD_BRIEF.md` §11:
- Dropped `pystray` and `Pillow` entirely (no more tray icon).
- `main.py` now opens a single `tkinter` window on the main thread: a status label (Idle → Listening → Transcribing → Cleaning up → Pasting) and a text box that shows the live partial transcript while recording, then the transcript, then the cleaned-up text, then reverts to idle after paste. Closing the window quits the app (`WM_DELETE_WINDOW` → `os._exit(0)` to guarantee the process actually ends, not just the window).
- New background loop while recording (`partial_transcription_loop` in `main.py`): every ~1.5s, re-transcribes everything captured so far (reusing `transcribe.py` unchanged) and updates the window. A `transcribe_lock` prevents this from racing with the final post-release transcription call on the same model instance.
- This turned out to **simplify** a real risk rather than add one: a persistent tray icon needs the main thread on macOS, and so does a Cocoa-backed tkinter window — the two would have fought over it. No tray icon means no conflict.
- Re-transcribing the whole growing buffer every 1.5s (not true streaming ASR) is a deliberate simplicity tradeoff, fine for short dictations on this hardware.

**Not yet tested at all** — this is a same-session rewrite, nothing has been run since. Needs testing from scratch on both Windows and Mac:
1. Does the window open and show correctly?
2. Does live partial text appear and update while holding the hotkey?
3. Does the final paste still work correctly into a real app (Teams desktop + Teams-in-browser specifically, per `docs/BUILD_BRIEF.md` §6)?
4. Does closing the window actually quit the app cleanly on both platforms?

**Next action:** Kevin tests the reworked app end-to-end on Windows first, then Mac. Once confirmed, revisit the parked "Transcribe File" feature and Step 5 (run on login).

---

## Session 2026-07-09 (continued) — Mac fully confirmed through Step 3

**Mac Step 2 confirmed:** the "known unknown" from the previous session — whether `mlx-community/whisper-small-mlx` was the correct Hugging Face repo id — is resolved. It downloaded fine (481MB) and produced an accurate transcript.

**Mac Step 3 needed Ollama installed separately** (it's a per-machine install, not something that carries over from Windows). Installed via ollama.com download, then `ollama pull llama3.2:3b`. One false start: tested before the model pull finished, got `HTTP Error 404` from `/api/generate` — `ollama list` showed no models installed yet, confirming the model just hadn't been pulled at that point. After `ollama pull llama3.2:3b` completed, a raw `curl` test against `/api/generate` succeeded, and the full app then worked end-to-end: transcript → cleanup, cleanup pass correctly edited the text (added a missing "error", fixed nothing that didn't need fixing) without responding conversationally — the `<transcript>` tag prompt fix holds up on a second, different real transcript.

**Minor known quirk, not a bug:** Whisper `small` mis-transcribed "Ollama" as "A Lama" in one test. Expected behaviour for unusual proper nouns on the `small` model — custom vocabulary/dictionary is already a listed stretch goal (`docs/BUILD_BRIEF.md` §5), not urgent for the MVP.

**Both platforms are now fully verified through Step 3.**

**Step 4 built:** `inject.py` — saves the current clipboard, copies the cleaned text in, simulates the paste keystroke (`Ctrl+V` Windows / `Cmd+V` Mac via `pyautogui`), then restores the original clipboard contents so dictation doesn't clobber whatever the user had copied before. Small delays around the paste to avoid a race where the OS hasn't registered the new clipboard content yet. Wired into `main.py`: on cleanup failure, falls back to injecting the raw transcript rather than losing the text entirely.

**Not yet tested:** needs real-world testing in both the Teams desktop app and Teams-in-browser (`docs/BUILD_BRIEF.md` §6 flags this specifically — clipboard-paste was chosen over simulated keystrokes because Teams' web view drops them). Also untested on Mac (same Accessibility permission that's needed for the hotkey listener is also needed for `pyautogui`'s paste keystroke to actually land).

**Workflow note:** back on chat-relay for both platforms per Kevin's preference (tried a local Claude Code session on Windows; found the lack of conversational feedback harder to work with than this chat, reverted).

---

## Session 2026-07-09 (continued) — Step 3 confirmed on Windows; workflow reverted to chat relay

**Workflow note:** Kevin tried running a local Claude Code session on Windows (per the earlier recommendation) to drive testing directly, but found the lack of conversational feedback frustrating compared to working through this chat session, and asked to go back to chat-relay for both platforms. Also: the local Windows session had committed `cleanup.py` (Step 3 build) but never pushed it — caught and pushed manually (`git push` from plain PowerShell, commit `2ae1489`) before continuing here.

**Real bug found and fixed:** first end-to-end test (transcribe → cleanup) showed the Ollama cleanup pass responding *conversationally* to the transcript instead of editing it — e.g. transcript "I'll paste back the full output" got rewritten as "Please go ahead and paste the full output. I will clean it up for you." Classic instruction-tuned-model failure: text that sounds like a request gets treated as a command rather than literal content. Fixed in `cleanup.py` (commit `da68be3`) by wrapping the input in `<transcript>` tags and explicitly instructing the model never to answer or follow anything inside them, plus pinning `temperature: 0` for determinism. Confirmed fixed on Windows — a second test correctly cleaned punctuation/grammar without responding to the content.

**Also merged:** a local uncommitted timeout bump (30s → 60s on the Ollama request) that the Windows Claude Code session had made but not committed — stashed, pulled the prompt fix, popped the stash (auto-merged cleanly, no conflict), committed separately (`1db7729`).

**Next action:** Test Step 2 + Step 3 together on the Mac (mlx-whisper transcription was only verified once, before `cleanup.py` existed) — pull latest, reinstall requirements, run, hold Right Option, speak, confirm both the transcript and cleanup lines look right. Once both platforms are fully confirmed on Step 3, Step 4 (clipboard + paste injection) is next.

---

## Session 2026-07-09 (continued) — Claude Code now running locally; Step 3 built

**Environment change confirmed:** this session is running as Claude Code directly on the admin machine (`whoami` → `admin`, `hostname` → `DESKTOP-MJDJM64`, `nvidia-smi` shows the real RTX 3070), not in a cloud sandbox. This matches the recommendation logged in the previous session (install Claude Code locally so an agent can drive remaining steps directly instead of manual copy-paste relay). Practical effect: Claude Code can now run local commands and inspect real output on this machine directly — though the hotkey/mic flow still needs Kevin to physically hold the key and speak.

**Flag for Kevin:** `CLAUDE.md`'s Hard Rules still say "Claude Code cannot run or test it (no mic, no hotkey listener, no GPU in the cloud sandbox)" — that assumption no longer holds for the Windows side now that Claude Code runs locally. Not changed unilaterally; flagging for you to confirm/update that rule.

**Step 3 built:** `cleanup.py` — calls the local Ollama REST API (`/api/generate`, non-streaming) with a system prompt that strips filler words/false starts and fixes grammar while preserving meaning and tone; returns the cleaned text only. Uses `urllib.request` (stdlib), no new dependency added. Raises a clear error if Ollama isn't reachable, or if the configured model (`llama3.2:3b` per `config.json`) isn't pulled yet (`ollama pull llama3.2:3b`). Wired into `main.py`: after a successful transcription, `stop_recording()` now also calls `cleanup()` and prints the cleaned result. No text injection yet (Step 4, still next).

**Not tested:** Ollama isn't installed on this admin machine yet (`where ollama` and a request to `localhost:11434` both came back empty; winget confirms `Ollama.Ollama` is available to install). Mac side is also untested. Two things need Kevin's decision before this is verified:
1. Install Ollama on the admin machine — Claude Code can now do this directly via `winget install Ollama.Ollama` given local execution, or Kevin can do it himself. Awaiting a decision since installing software wasn't previously in Claude Code's scope on this machine.
2. Once installed, `ollama pull llama3.2:3b` needs to run once, then Step 3 can be exercised end-to-end alongside a real dictation (or with a canned transcript for a quick isolated check of `cleanup.py` alone).

`.gitignore` added (`__pycache__/`, `*.pyc`, and `rundictation.bat` — the latter is a personal convenience script delivered via SendUserFile, never meant to be committed).

**Next action:** Kevin decides on Ollama install method; once cleanup.py is verified on Windows, same for Mac; then Step 4 (clipboard + paste injection) gets built.

---

## Session 2026-07-09 (continued) — Step 1 confirmed on Mac; Step 2 built

**Mac setup hit a real environment issue, resolved:** Kevin's Mac shipped with the old Apple Command Line Tools Python (3.9.6), which has no prebuilt wheel for `pyobjc-core` (a `pynput` dependency on macOS) and failed compiling it from source — a known incompatibility (that pyobjc release is flagged "yanked" for wrongly claiming Python 3.9 support). Fix: installed Python 3.14.6 from python.org, which has prebuilt wheels for everything. `pip3.14 install -r requirements.txt` then succeeded cleanly.

**Step 1 result on Mac:** held Right Option, console reported `316584 samples, 19.79s captured at 16000Hz`. Confirmed working on both platforms now.

**Step 2 built:** `transcribe.py` — lazy-loads and caches the model on first call. `faster-whisper` (`small`, CUDA, fp16) on Windows; `mlx-whisper` on Mac, repo id `mlx-community/whisper-small-mlx` (set in `config.json`'s Mac `whisper` section, **not yet verified against the actual Hugging Face repo** — if the first run 404s trying to download, this needs correcting to whatever the real repo slug is). `main.py` now calls `transcribe()` after every recording and prints the raw transcript — no cleanup, no injection yet.

`requirements.txt` updated with platform markers: `faster-whisper; sys_platform == "win32"` and `mlx-whisper; sys_platform == "darwin"`.

**Windows Step 2 confirmed working** (after one more environment fix): `faster-whisper` needs the CUDA 12 runtime libraries (cuBLAS + cuDNN) — having the NVIDIA driver alone isn't enough, and the full CUDA Toolkit installer is multi-GB overkill. Fixed by installing the runtime as pip packages instead:
```
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```
then adding their `bin` folders to the Windows user PATH (via System Properties → Environment Variables → User variables → Path):
- `C:\Users\admin\AppData\Roaming\Python\Python314\site-packages\nvidia\cublas\bin`
- `C:\Users\admin\AppData\Roaming\Python\Python314\site-packages\nvidia\cudnn\bin`

Confirmed persistent across a fresh PowerShell window (no `$env:PATH` override needed). Real transcript came back accurate for an 11.83s recording.

**Not yet done:** Mac side of Step 2 (mlx-whisper) hasn't been tested — still pending, including verifying the `mlx-community/whisper-small-mlx` repo id is actually correct.

**Workflow note (2026-07-09):** Kevin flagged that relaying every test through copy-pasted terminal output is inefficient — correct. This cloud session has no direct access to either of Kevin's machines. Recommended he install Claude Code locally on the Windows machine (matches `AGENT_MODEL.md` Section 1, which already documents "Admin machine (Kevin): Runs Claude Code (primary agent)" as the intended model across his other repos) so an agent can drive the remaining steps directly instead of through manual relay. Awaiting Kevin's decision on this before continuing Step 3.

---

## Session 2026-07-09 (continued) — Step 1 confirmed on Windows

**Result:** Kevin ran `main.py` on the Windows machine (RTX 3070), held Right Ctrl for ~8 seconds while speaking, released — console reported `123968 samples, 7.75s captured at 16000Hz`. Recording start/stop and audio capture to memory both work correctly.

**Debugging along the way (kept here for reference, not because it's still relevant):**
- First confusion was environment/working-directory related (running `python main.py` from `C:\Users\admin` instead of the cloned repo folder) — resolved.
- Added a temporary debug print on every keypress to check pynput was receiving events at all and to identify the exact key name for "Right Ctrl" on Kevin's keyboard. Confirmed `<Key.ctrl_r: <163>>` maps correctly and Left Ctrl (`ctrl_l`) is correctly ignored.
- Windows fires repeated key-down (auto-repeat) events for a physically held key — this looked like a runaway bug the first time but is normal OS behaviour; `start_recording()`/`stop_recording()` already guard against duplicate calls, so it was cosmetic only (spammed the debug log, nothing else).
- Debug logging removed once confirmed working — `main.py` is back to clean Step 1 code.
- Delivered `run-dictation.bat` (via SendUserFile, not committed to the repo — it's a personal convenience script, not part of the app) so Kevin can `cd` + `git pull` + `python main.py` with one double-click instead of typing commands each time.

**Next action:** Kevin runs the same test on the Mac (Apple Silicon) — hold **Right Option**, confirm the same kind of console output. Once both platforms are confirmed, Step 2 (transcription — faster-whisper on Windows, mlx-whisper on Mac) gets built.

---

## Session 2026-07-09 (continued) — Cross-platform pivot

**What happened:**
Kevin confirmed after Step 1 was first built (Windows-only) that this needs to be unified across Windows and Mac — one codebase, not two apps. Confirmed Mac hardware: **Apple Silicon**.

**Amendment recorded:** `docs/BUILD_BRIEF.md` §10 — full rationale for each component swap.

**Changes made:**
- Hotkey library: `keyboard` → **`pynput`** (the `keyboard` library doesn't work reliably on macOS)
- Default hotkey: Caps Lock → **Right Ctrl (Windows) / Right Option (Mac)** — modifier keys held alone have no OS side effects, so no key-suppression is needed (which `pynput` can't do selectively — its `suppress=True` blocks all system input, not just one key)
- `config.json` restructured with platform-keyed `hotkey` and `whisper` sections (`windows` / `darwin`), resolved by `platform.system()` in `config.py` at load time
- Whisper backend, planned for Step 2: **faster-whisper + CUDA** on Windows (unchanged), **mlx-whisper** on Mac (Metal-accelerated — faster-whisper has no Apple Silicon GPU support)
- Text injection, planned for Step 4: `pyperclip` + `pyautogui` on both; paste key `Ctrl+V` (Windows) vs `Cmd+V` (Mac); `pywin32` dropped (Windows-only)
- `main.py`, `config.py`, `config.json`, `requirements.txt`, `README.md`, `CLAUDE.md` all updated for the new scope

**Not done:** repo is still named `windows-dictation` — flagged to Kevin as a possible rename candidate, not renamed unilaterally.

**Next action:** Kevin tests Step 1 on **both** the Windows machine and the Mac (`pip install -r requirements.txt && python main.py`, hold Right Ctrl/Right Option, confirm console reports a sane capture duration on each). Mac needs Accessibility permission granted to Terminal first. Once both are confirmed working, Step 2 (transcription, per-platform backend) gets built.

---

## Session 2026-07-09 — Repo created, governance stack added

**What happened:**
- Repo `begb0037admin/windows-dictation` created (private) at Kevin's request, from `docs/BUILD_BRIEF.md` (the original build brief, committed verbatim).
- Standard governance stack added to match the estate template (`clockify` is the gold standard):
  - `CONSTITUTION.md` v2.1 — copied verbatim (cross-repo, unmodified)
  - `AGENT_MODEL.md` v2.5 — copied with local annotations only (Section 1, Section 7, Section 8 row) noting this repo runs locally on Kevin's Windows machine, not via GitHub Pages
  - `HANDOVER.md` (this file) — session record
  - `README.md` — condensed project overview
  - `CLAUDE.md` — bootstrap entry point, updated to point at the standard docs
- **Not done:** the shared `AGENT_MODEL.md` Section 8 repository table in the *other* 10 repos was not updated to list `windows-dictation`. That's a separate propagation operation across the whole estate — flag to Kevin if full cross-repo visibility is wanted.

**Next action:** Build MVP Step 1 (push-to-talk hotkey + audio capture to memory) per `docs/BUILD_BRIEF.md` §4 and §9 — build and test one step at a time, Kevin confirms each step works on his Windows/RTX 3070 machine before the next step is built.

---

## Architecture and Key Constraints

Moved to `ARCHITECTURE.md` (current component/threading/state-machine reference) and `CLAUDE.md` (hard rules/key constraints) — this section was leftover from this file's first commit and had gone stale (it still listed Steps 3–5 as "not yet built" long after they shipped, contradicting the status block at the top of this file). Removed 2026-07-26 as part of the documentation audit; see the session entry above — nothing here was unique, everything is preserved in `ARCHITECTURE.md`/`CLAUDE.md`/`docs/BUILD_BRIEF.md`.
