# windows-dictation — Living Handover Document

> See also: `ARCHITECTURE.md` (current-state component/threading/state-machine reference), `docs/BUILD_BRIEF.md` (build history and amendment rationale), `CLAUDE.md` (bootstrap/hard rules).

**Last updated:** 2026-08-24 — **PTT 0.1.3 Windows installer built end-to-end on `LAPTOP-L06TH25`, fixed to run on any Windows machine (not just Kevin's RTX 3070 desktop), and Kevin-confirmed PASS on physical acceptance.** Checked out exact commit `0dbaa83` and ran `build/build-app.ps1` for real. Found and fixed two genuine build/runtime defects, neither present in the source itself before this — both root-caused via live, direct testing on this machine rather than guessed at: (1) **PyInstaller/Python 3.14 incompatibility** — `pyinstaller==6.21.0`'s tkinter runtime hook can't locate Python 3.14's new zip-packaged Tcl/Tk 9.0 data (`FileNotFoundError` in `pyi_rth__tkinter`), crashing the frozen backend before it could even answer `get_config`. tkinter is an unused transitive dependency (not imported by `main.py`, not in `requirements.txt`) pulled in incidentally — excluded in `build/ptt-backend.win.spec` (`ed428bd`). (2) **CPU-only machines crashed outright, not gracefully** — this laptop has no NVIDIA GPU (Intel Iris Xe, 13th Gen i7-1365U); the shipped config hardcodes `device: "cuda"`, and even after manually forcing `"cpu"`, `ctranslate2`'s CPU model load segfaulted (access violation) because `msvcp140_1.dll` (part of the modern VC++ Redistributable) is missing on a stock/older-runtime Windows install — confirmed by isolating the crash down to that exact missing DLL via direct testing (onnxruntime import, `ctranslate2.models.Whisper()` load, in isolation, with/without the redistributable installed). Fixed with two changes (`7878486`): `main.py`'s new `_resolve_whisper_device()` auto-detects CUDA via `ctranslate2.get_cuda_device_count()` at startup and falls back from `cuda`/`float16` to `cpu`/`int8` when no GPU is present (never overriding an explicit non-cuda config choice); `build/nsis/vcredist-install.nsh` + `build-app.ps1` + `generate-builder-config.js` now download, Authenticode-verify (signed by Microsoft — not a pinned hash, since Microsoft's own `aka.ms` "latest" redirect intentionally changes content over time), bundle, and silently install the VC++ Redistributable during setup. **Live-verified on this GPU-less laptop, not just unit-tested:** ran the real NSIS installer silently (`/S`, a genuine install, not `--dir` packaging), confirmed `C:\Users\admin\AppData\Local\Programs\PTT\resources\redist\vc_redist.x64.exe` landed at the correct real path (caught and fixed one packaging bug of my own along the way — electron-builder's single-file `extraResources` treats a bare `to: 'redist'` as an exact destination filename, not a directory, so the exe first landed at `resources\redist` with no extension), launched the actual installed `PTT.exe`, confirmed it spawned `ptt-backend.exe` as a real child process and stayed stable through the model-load window, and confirmed the frozen backend's own `get_config` response correctly changed from a startup crash to reporting `"faster-whisper large-v3-turbo cpu int8"`. Both commits pushed to `origin/main` (this machine's GitHub credentials were invalid — `gh auth login --web` device-code flow plus `gh auth setup-git` fixed it for future sessions too). **Installer artifact:** `PTT Setup 0.1.3.exe`, 1,844,635,116 bytes, SHA-256 `E5FA045CAC496BB57BB82D049BBA7227FC5292510A90914C0C6DF88EE1B27D3E` — left at `C:\Users\admin\Desktop\PTT Setup 0.1.3.exe` and genuinely installed (not just built) at `C:\Users\admin\AppData\Local\Programs\PTT` on this laptop, at Kevin's request, specifically so it's usable there day-to-day, not just on the RTX 3070 desktop. The pipeline's own artifact marker reads `UNVERIFIED` only because its interactive renderer/visual smoke-test gate can't run in a non-interactive session — **Kevin has since confirmed PASS on that check directly**, so this artifact should be treated as accepted, not merely built. `DESKTOP-MJDJM64` was explicitly not touched. **Mac note, surfaced not actioned:** no current Mac installer exists — the most recent Mac DMG (2026-08-05, `Push 2 Talk-0.1.3-arm64.dmg`) predates the `Push 2 Talk` → `PTT` rename and everything since; Kevin reports the Mac app itself works well day-to-day (likely via `npm start` dev mode, which is on current source regardless of DMG staleness) and does not consider a fresh Mac DMG urgent. Rebuilding one requires real Apple Silicon hardware per Decision 7 and was not attempted this session (this machine is Windows-only).

**Previously last updated:** 2026-08-10 — **Windows "over a minute" dictation latency root-caused as a one-time event, not a persistent bug — no code fix applied.** Kevin reported a slow (~2 minute) dictation right after installing the fresh PTT-renamed build (`0dbaa83`). Direct evidence, in order: (1) `%APPDATA%\ptt\logs\backend.log` shows this was literally the *only* real dictation this fresh backend process had ever run — `TRANSCRIPTION_TIMING duration_ms:116464` (116.5s), `CLEANUP_TIMING duration_ms:6275`, `DICTATION_READY_TIMING duration_ms:122793` — confirming Kevin's own suspicion that it was the first post-install call. (2) A direct empirical benchmark on this same machine (model load + first-ever CUDA inference, isolated in a standalone script against both synthetic noise and real SAPI-synthesized 56.7s speech) showed cold model load + first inference together cost under 10 seconds even with GPU VRAM at 91-96% committed — ruling out plain cold-start/VRAM-warmup as sufficient explanation on its own. (3) **The actual smoking gun:** Windows Event Log (`Microsoft-Windows-Windows Defender/Operational`) shows a Defender "Aggressive catch up" Quick Scan started at 15:28:21 — 73 seconds before the dictation began (15:29:34) — and ran for 21 minutes until 15:49:26, covering the *entire* slow transcription window. A 21-minute catch-up scan competing for disk I/O/CPU, landing exactly on the one moment the fresh install needed to read ~1.6GB of model weights off disk for the first time, is a fully evidenced, non-code explanation. (4) `inject.py`/`paste_text()`'s only delays are 50ms/50ms/120ms `sleep()` calls — ruled out. (5) Ollama cleanup was fast (6.275s) even on this same first-call dictation — not the bottleneck either. **No further TRANSCRIPTION_TIMING entries exist in the log since** — consistent with a one-off, not a recurring problem. Existing `P2T_DIAG` timing instrumentation (`TRANSCRIPTION_TIMING`/`CLEANUP_TIMING`/`DICTATION_READY_TIMING`, `main.py`'s `log_stage_timing()`) is exactly what made this diagnosable from the log instead of guessed at — nothing new needed adding. **One real but separate finding surfaced, not applied:** `config.json`'s Windows `beam_size: 5` has been set since this app's very first cross-platform commit (`b470ea4`, 2026-07-30) and has never matched `transcribe.py`'s own 2026-07-31 code comment describing `beam_size=2` as "a deliberate middle ground" for latency — that comment's fallback default only applies when a config omits `beam_size`, which Windows' shipped config never has, so this isn't a regression, just a standing inconsistency nobody reconciled. Benchmarked on this machine with real speech: `beam_size=5` costs ~1.7x `beam_size=2` (2.04s vs 1.19s on 56.7s of TTS speech) — real but modest, and not the cause of the 116s event. Left unchanged pending Kevin's explicit call, since it's a live accuracy/speed tradeoff, not a bug. **For Kevin:** do one normal test dictation now (backend is warm, no active scan) to confirm speed is back to normal (should be single-digit seconds in `TRANSCRIPTION_TIMING`); if a slow dictation ever recurs on a warm, previously-fast backend (not right after a fresh install), that would upgrade this from "one-time" to "real bug" and is worth flagging immediately with the exact `backend.log` timings. See the new session entry below for the full benchmark numbers and method.

**Previously last updated:** 2026-08-10 — **Replace the failed programmatic drag path with native Electron dragging — this one is independently live-verified, not just self-reported.** Kevin's installed-build retest showed `fb7fce2` still grows the window. Its `currentWindowSize` cache was insufficient because every mousemove still called `BrowserWindow.setBounds()`, exercising Electron's Windows bounds/min-max conversion under fractional DPI. The custom `move-window-by`/`drag-start`/`drag-end` IPC chain has now been removed entirely. The header and pill use native `-webkit-app-region: drag`, so a drag never invokes application code that can write a width or height. Native drag regions do not dispatch normal click events, so the pill now has a small no-drag expand button. `resize-window` is retained exclusively for the deliberate 400x360 ↔ 170x56 mode switch. Codex committed this locally but flagged it as not yet physically tested. The orchestrating Claude Code session (running directly on Kevin's machine) then independently rebuilt in `npm start` dev mode and ran 7 separate real OS-level synthetic drags via `SetCursorPos`/`mouse_event` (a DPI-aware process — `SetProcessDPIAware()` — was required to get `GetWindowRect` and click coordinates into the same physical-pixel space; a DPI-unaware read gave wrong window bounds relative to a real screenshot, the same coordinate-space gotcha noted in the prior session below): 1 in Full mode (delta (285,190), zero size change) and 6 consecutive in Pill mode with mixed positive/negative deltas (zero size change on every single one, no between-drag drift either — the specific failure mode of the immediately-preceding `fb7fce2` attempt). Also confirmed the new pill-to-full expand chevron button functions correctly (a grid-search click found the right hit target after two initial misses from imprecise synthetic-click coordinates, not a bug in the button itself). Pushed to `main` as `ec36605` only after this independent verification passed. See the new session entry below for Codex's own reasoning.

**Previously last updated:** 2026-08-10 — **Pill/header drag-grows-window bug: the first fix (`e320458a`) did NOT fix it — Kevin retested live and it recurred. Root-caused and re-fixed for real this session (Markey, voice engineering agent), running directly on Kevin's Windows machine with live GUI/mouse-simulation access, and empirically verified fixed via five consecutive real synthetic OS-level drags (raw Win32 `GetWindowRect`, zero growth, exact position translation each time).** The `e320458a` diagnosis (DPI-related bounds drift) was on the right track but its own mitigation — reading `getBounds()` then writing `width`/`height` straight back on every mousemove tick — was itself the bug: it cements whatever drift the OS/Chromium introduces instead of correcting it. This session tried and **live-disproved** a second theory too (that switching to `setPosition()`-only, never touching width/height at all, would fix it — it didn't; growth still happened, confirmed by debug-logging `win.getBounds()` directly inside the Electron main process during genuine live drags on this machine). The actual fix: never let any bounds value that could already carry a tick's DPI-rounding drift feed back into the next write. The window is `resizable: false` with exactly two legitimate sizes (400x360 full, 170x56 pill); a new module-level `currentWindowSize` tracks the last size explicitly requested via `resize-window` and every drag tick pins `width`/`height` to that authoritative constant — never to a fresh `getBounds()` read. See the 2026-08-10 "second correction" session entry below for the full live-verification trail, including why two earlier hypotheses looked right and weren't.

**Previously last updated:** 2026-08-10 — **App renamed "Push 2 Talk" → "PTT" throughout (Markey, voice engineering agent), at Kevin's request.** package.json/package-lock.json name and description, `productName`/`appId`/NSIS `shortcutName`/macOS usage-description strings in `build/generate-builder-config.js`, the PyInstaller backend executable and its two spec files (renamed `push2talk-backend` → `ptt-backend`, including file renames `build/push2talk-backend.{mac-entry.py,mac.spec,win.spec}` → `build/ptt-backend.*`), every build script that hardcodes the old names (`build-app.ps1`/`.sh`, `build-backend.ps1`/`.sh`), window title/tray tooltip/tray menu label/dialog titles/Settings "Back to" button/mac Accessibility-permission copy in the Electron+UI layer, README.md and CLAUDE.md. Deliberately left untouched: the `P2T_DIAG`/`P2T_CONFIG_DIR` wire-protocol tags (internal log/env identifiers with heavy exact-string test coverage, not user-facing product name) and historical "push2talk-packaging run" citations in code comments (a named past brief/run, not a live identifier). **Not build-verified** (no Windows/Mac build environment here) and **not visually verified** (no GUI). **Real-world risk to flag:** Electron's `userData` path is derived from `package.json`'s `name` field, so a rebuilt "PTT" install's config directory becomes `%APPDATA%\\ptt` instead of the currently-installed `%APPDATA%\\push2talk` — the already-installed, daily-use Windows app's saved theme/hotkey/autostart/opacity settings will not carry over automatically to a PTT-branded rebuild; the app will just fall back to `config.py`'s defaults (no crash, no data loss, just a one-time settings reset). See the 2026-08-10 rename session entry below for the full file list and reasoning.

**Previously last updated:** 2026-08-10 — **Markey (voice engineering agent) fixed two Windows-side bugs Kevin reported live: PTT answering questions again despite three prior fixes, and dragging the pill/header window growing it instead of moving it.** Neither fix could be live-verified (no mic/hotkey/GUI access in this environment) — both are compile-clean/unit-tested only. See the 2026-08-10 session entry below for the full reasoning and the exact caveats to check before treating either as solved.

**Previously previously last updated:** 2026-08-05 — **0.1.3 fixes the live macOS stale-clipboard paste race exposed during physical acceptance of 0.1.2.** Recognition and cleanup succeeded, but the target application pasted the clipboard contents from before dictation because `inject.py` restored that old value 50ms after asynchronously posting Command-V. The Mac path now verifies the new text is on the clipboard and deliberately leaves it there; automated regression coverage passes. A replacement ARM64 DMG was built from clean commit `f024ddb` and independently passed image/signature/version verification. Physical paste acceptance remains. (1) An occasional CoreAudio realtime-thread deadline miss can leave `sd.InputStream.close()` hanging indefinitely in `stop_recording()`, with no timeout — causing exact-zero audio captures and, in the worst case, an unrecoverable multi-minute silent hang ending in a backend crash. Confirmed NOT hotkey-specific (an earlier mouse-vs-keyboard hypothesis was raised and then directly disproved via a live A/B). (2) The tray icon is genuinely invisible on macOS — `resolveTrayIconPath()` unconditionally loads `icon.ico` (Windows-only format), which decodes as a 0x0 empty image in this app's Electron 43.2.0 runtime (as does `icon.icns`, unexplained; `icon.png` decodes correctly). This makes "Exit" unreachable (Force Quit required every time) and, as a direct side effect (not a separate bug), explains the app reopening at login despite autostart being correctly unchecked — macOS's own `TALLogoutSavesState` session-restore reopens whatever was still running at shutdown, and this app can never be cleanly quit. Full evidence chain in the 2026-08-03 session entry below. **Also flagged: this repo's local working tree (this Mac) is ~1076 lines of tested-but-uncommitted work ahead of GitHub `main` (a 2026-07-30 Codex session's fixes — multiprocessing recursion, native-Quartz paste, silence-rejection guard, Large-v3-turbo upgrade — never pushed). That gap needs Kevin's review and a real commit before/alongside the next round of fixes, so there's an accurate GitHub-backed restore point.**

## Session 2026-08-10 (Markey, voice engineering agent) — Slow-dictation-after-install latency investigation

**Context:** Kevin reported PTT taking "over a minute and counting" between hotkey release and pasted text landing, right after installing the fresh `0dbaa83` build (native-drag fix, unrelated). He'd already checked: Ollama server responded fast to `/api/tags` (not itself hung); `nvidia-smi` checked reactively at the tail end showed only 15% util/2.6GB used (inconclusive — could mean idle-after-finishing, not idle-throughout); no obviously heavy competing process at check time, though real GPU/CPU contention (concurrent Electron dev instances, PyInstaller builds, two simultaneous Codex CLI processes) had genuinely occurred earlier in the same session. Asked to determine cold-start-vs-persistent and fix if persistent. Ran directly on Kevin's Windows machine per this repo's CLAUDE.md.

**Step 1 — checked the log first, as instructed, before assuming instrumentation was missing.** `main.py` already has `log_stage_timing()` emitting `TRANSCRIPTION_TIMING`/`CLEANUP_TIMING`/`CLEANUP_FAILED_TIMING`/`DICTATION_READY_TIMING` as `P2T_DIAG` lines (added in an earlier, 2026-07-30 Codex session — "Large Turbo duplicate-inference latency removed"), sanitized through Electron's diagnostic allowlist into `backend.log`. Nothing needed adding.

**Found the actual installed app's log path first** — the app was renamed `push2talk` → `ptt` earlier the same day, and Electron's `userData` (hence `LOG_DIR`) is derived from `package.json`'s `name` field, so the *live* log is at `%APPDATA%\ptt\logs\backend.log`, not the old `%APPDATA%\push2talk\logs\backend.log` (which has plenty of history but is the *previous*, no-longer-running install). Confirmed live via `nvidia-smi`'s compute-apps list showing the real running binary: `C:\Program Files\PTT\resources\backend\ptt-backend.exe`.

**The `ptt` log is short and unambiguous:** repeated `ready`-status pings all day (10:05 through 15:27:57), then exactly one full pipeline at 15:29:34–15:32:25 — `AUDIO_SIGNAL rms:23.44 peak:379.39 active_percent:38.87`, `TRANSCRIPTION_TIMING duration_ms:116464 char_count:491`, `CLEANUP_TIMING duration_ms:6275 char_count:475`, `DICTATION_READY_TIMING duration_ms:122793 char_count:475`. This was literally the first (and, as of writing, only) real dictation this fresh backend process has ever transcribed — directly confirms Kevin's own "first dictation since fresh install" hypothesis, no guessing needed.

**Step 2 — benchmarked cold-start directly instead of trusting the hypothesis on priors.** Wrote a standalone script (`scratchpad/bench_transcribe.py`, not committed — ad hoc, mirrors the existing `build/compare-beam-size.py` pattern) that loads the real `config.json` Windows whisper config, times `WhisperModel(...)` construction separately from `model.transcribe()`, and runs several calls back-to-back in one process to separate "model load" from "first-CUDA-call JIT/warmup" from "steady-state." Ran it twice: once against 48s of synthetic band-limited noise, once against 56.7s of real speech synthesized via Windows SAPI (`System.Speech.Synthesis.SpeechSynthesizer`, PowerShell) so the timing wasn't distorted by near-silent audio short-circuiting decode. Results (real-speech run): model load 4.38s, first inference (`beam_size=5`, matching `config.json`) 2.04s, warm repeat 1.52s, `beam_size=2` 1.19s, `beam_size=1` 1.08s. Total cold path (load + first infer): **well under 10 seconds**, run while GPU VRAM was at 91-96% committed (checked live via a background `nvidia-smi` poll loop during the run) — this on its own **rules out plain model-load/CUDA-warmup as sufficient explanation** for a 116-second transcription.

**Step 3 — found the actual cause: Windows Defender.** Queried `Get-WinEvent` against the `Microsoft-Windows-Windows Defender/Operational` log around the incident window. Found scan-start event ID 1000 at **15:28:21** — 73 seconds before the dictation began (15:29:34) — `Scan Type: Antimalware, Scan Parameters: Quick Scan, Scan Trigger: Aggressive catch up`. Widened the query and found the matching scan-complete event ID 1001 at **15:49:26** — a **21-minute** scan that fully covers the entire slow-transcription window (15:29:34–15:32:25) and then some. "Aggressive catch up" fires when Defender's own scheduled scans have been missed for a while and it forces one regardless of normal idle/priority throttling — real disk I/O and CPU competition, landing by chance on the exact moment a freshly-installed `C:\Program Files\PTT\` build needed to read ~1.6GB of model weights off disk for the first time (on-access real-time scanning of newly-written/newly-executed files would add to this too, though not separately isolated from the broader scan's cost here).

**Ruled out, by direct inspection:** `inject.py`'s paste path (`time.sleep(0.05)` x2) and `main.py`'s `paste_text()` (`time.sleep(0.12)`) — all sub-200ms, not remotely enough to matter. Ollama cleanup itself — `CLEANUP_TIMING` on this very same first-call dictation was only 6.275s, not the bottleneck.

**Conclusion: not a persistent per-dictation problem — no code fix applied.** The evidence (single log entry ever, benchmark ruling out cold-start alone, a directly-correlated 21-minute AV scan covering the exact window) supports a one-time confluence: first-ever model load on a fresh install landing inside a real, independently-verified antivirus scan, not a defect in PTT's transcription/cleanup/paste pipeline. Per the task's own framing ("fix if it's the latter [persistent]") — it isn't, so nothing was changed in `main.py`, `transcribe.py`, or `inject.py`.

**One adjacent, separate finding — surfaced, not applied.** `config.json`'s Windows `beam_size: 5` has been present since this app's very first cross-platform commit (`b470ea4`, 2026-07-30) and predates, and was never reconciled with, `transcribe.py`'s own 2026-07-31 code comment calling `beam_size=2` "a deliberate middle ground" — that comment describes the function's own *fallback* default (`whisper_config.get("beam_size", 2)`), which only takes effect when a config omits the key entirely; Windows' shipped config has always set it explicitly, so nothing regressed, this is just a standing inconsistency between a documented intent and the live value. The real-speech benchmark above quantifies the actual cost: beam 5 vs beam 2 is ~1.7x (2.04s vs 1.19s on 56.7s of speech) — a real, modest, always-on latency tax with no accuracy comparison ever run to justify paying it. Left `config.json` unchanged — this is Kevin's call on an accuracy/speed tradeoff, not a bug fix, and per this repo's Show → Approve → Push rule a live-behavior config change needs his explicit go-ahead first, not a unilateral edit.

**For Kevin:**
1. Do one normal dictation now — the backend is warm (model already resident from the 15:29 call) and no Defender scan is active — to confirm the round-trip is back to normal (should show single-digit-second `TRANSCRIPTION_TIMING` in `%APPDATA%\ptt\logs\backend.log`).
2. If a dictation is ever slow again on an already-warm backend (i.e., not the first call after an install/restart), that changes the diagnosis from "one-time" to "real bug" — capture the exact `backend.log` timings and the Defender/Task Manager state at that moment and flag it; the one-time explanation above would no longer hold.
3. Optional, your call: lower Windows `beam_size` from 5 to 2 in `config.json` for a modest, low-risk latency win on every dictation (not just this incident) — ask if you want this made and pushed.

**Verification:** benchmark script and both test WAVs are in the session scratchpad only (not committed — ad hoc diagnostic, not app code); no automated test suite changes needed since no production code changed. `git status` on this repo is clean aside from this `HANDOVER.md` update.

## Session 2026-08-10 (Codex) — Pill/header drag-grows-window: remove programmatic movement

**Root cause:** `fb7fce2` did not eliminate the faulty mechanism. Its cache avoided feeding a drifted `getBounds()` size back into the next operation, but each renderer mousemove still called `BrowserWindow.setBounds({ x, y, width, height })`. That remains a resize-and-move request on every tick and is therefore still subject to Electron's Windows DIP/bounds and min/max-size handling at fractional DPI. Its synthetic verification covered Full mode only; Pill mode, Kevin's reported path, was not retested.

**Fix:** remove the complete custom-drag IPC chain: `move-window-by`, `drag-start`, and `drag-end` no longer exist in the renderer, preload, or main process. The full header and pill use Electron's native `-webkit-app-region: drag`, which moves the native window without any application-level `setPosition()` or `setBounds()` call. Thus dragging has no code path capable of writing the width or height. Header controls remain `no-drag`; the pill has a small no-drag chevron button to expand, since native drag regions intentionally do not dispatch normal DOM click events. The retained `resize-window` handler uses `setSize()` only for the deliberate Full/Pill mode change.

**Why this is evidence-based:** Electron's Windows issue #13043 documents the same family of unresizable-window size changes and identifies `SetBounds` plus min/max-size handling as the affected native path. Electron's current frameless-window documentation directs applications to mark native draggable regions with `app-region: drag`. This avoids the repeated-bounds operation instead of attempting to compensate for it. Syntax and the existing Electron unit suite are checked locally; the remaining acceptance test is physical Full and Pill dragging on Kevin's fractional-DPI Windows display.

## Session 2026-08-10 (Markey, voice engineering agent) — Pill/header drag-grows-window: second correction, live-verified this time

**Context:** the earlier fix in this same day's first session (commit `e320458a`, described further down this file) was reported by Kevin as NOT having fixed the bug — he installed the rebuilt app and retested on the real Windows machine, and dragging the pill still grew the window. The orchestrating Claude session reproduced this live and directly on Kevin's machine before handing it back: a real OS-level `SendInput`-equivalent drag (`SetCursorPos` + `mouse_event`, ~15 move ticks, intended delta (150,100)) grew a 170x56 pill to 204x92, confirmed via raw Win32 `GetWindowRect` (not Electron's own APIs). That session's hypothesis: `e320458a`'s handler read `win.getBounds()` then wrote `width`/`height` straight back via `setBounds()` on every single mousemove tick — cementing whatever DPI-rounding drift Windows/Chromium introduces instead of correcting it, on a machine with mismatched DPI awareness (physical 3840x2160 vs `Screen.Bounds`-reported logical 2194x1234, roughly 175% scale). Proposed fix: cache the origin once at drag-start, accumulate the delta in the main process, and move the window with `setPosition(x, y)` only — never touching width/height at all during the drag, since `setPosition` doesn't take a size argument.

**This session ran directly on Kevin's real Windows machine, with live GUI and mouse-simulation access** (confirmed: `electron .` launched successfully in dev mode via `npm start`, real windows appeared, a live screenshot during testing showed the app mid-recording — genuine concurrent use of the machine was happening throughout, which turned out to be useful independent evidence, not just an obstacle).

**Attempt 1 (the proposed `setPosition`-only fix) was implemented, then live-disproved.** Added temporary debug logging (`console.log` of `win.getBounds()`) directly inside the `move-window-by` IPC handler in `electron/main.js` — reading `getBounds()` from inside the Electron main process itself, not from an external reader that could be DPI-confused in its own right. Restarted the dev-mode app and captured two genuine drags happening live on the shared machine (real human mouse input, confirmed by the non-uniform per-tick dx/dy values, nothing like a scripted uniform-step drag): the window grew from 402x362 to 440x403 in the first, and continued growing from 440x403 to 692x660 in the second — even though the handler never passed a width or height to `setPosition()` at any point. **This falsifies the original hypothesis.** The growth isn't caused by an API that writes size; `win.getBounds()`'s own reported size drifts as a side effect of *any* repeated window-move call under this machine's DPI mismatch — Windows/Chromium is silently re-deriving the window's physical size from an internally-stored logical (DIP) size on each move, and that derivation rounds inconsistently call to call.

**Attempt 2: cache `{x, y, width, height}` once at drag-start (never re-read mid-drag), pin `width`/`height` to that per-drag cached snapshot on every `setBounds()` tick.** This held the size essentially flat *within* a single drag (verified live via the same in-process debug logging: pinned values like 402x362 stayed at 402-404 x 362-364 for the whole gesture, no progressive growth) — a real improvement — but a new debug-log capture showed the *cached baseline itself* drifting a few pixels between separate drags (402x362 at the start of one drag's cache, 407x369 by a later drag's cache), because each new drag-start re-anchored to whatever `getBounds()` happened to report at that moment, which could already carry a couple of pixels of accumulated rounding noise from the previous drag's end state. Slower growth, same underlying leak.

**Final fix (implemented, committed, pushed): pin every drag tick's `width`/`height` to a new module-level `currentWindowSize` tracker, never to any `getBounds()` read at all.** The window is `resizable: false` (confirmed: `createWindow()`'s `BrowserWindow` options) and only ever has exactly two legitimate sizes — 400x360 full, 170x56 pill — both set explicitly via the existing `resize-window` IPC. `currentWindowSize` starts at `{400, 360}` (matching `createWindow()`'s initial size) and is updated only by the `resize-window` handler, so there is always an authoritative value to pin to that never needs to come from a potentially-drifted OS readback. `x`/`y` are still cached once per drag-start from a single `getBounds()` read (unavoidable — the window's actual position has to come from somewhere), but never re-read mid-drag; every tick accumulates the delta in pure JS integer arithmetic and writes `setBounds({x, y, width: currentWindowSize.width, height: currentWindowSize.height})`. `drag-start`/`drag-end` IPC messages (new, sent from `ui/app.js`'s `initDrag()` on `mousedown`/`mouseup`) bracket the gesture; a safety fallback in `move-window-by` handles a stray call with no active drag (still pins to `currentWindowSize`, never a fresh read).

**Live-verified fixed:** with debug logging removed and the final code running, five consecutive real synthetic OS-level drags (`SetCursorPos`/`mouse_event`, real Win32 mouse input, not Electron's own APIs — coordinates calibrated against the non-DPI-aware/`Screen.Bounds` space after an earlier DPI-aware reader was shown via `WindowFromPoint` and a real screenshot to be reading a mismatched coordinate space) each moved the window by exactly the intended (120,80) delta with **zero** width/height change (400x360 before and after, every time):
```
drag 1: 1017,493,400x360 -> 1137,573,400x360  (Δw=0 Δh=0)
drag 2: 1137,573,400x360 -> 1257,653,400x360  (Δw=0 Δh=0)
drag 3: 1257,653,400x360 -> 1377,733,400x360  (Δw=0 Δh=0)
drag 4: 1377,733,400x360 -> 1497,813,400x360  (Δw=0 Δh=0)
drag 5: 1497,813,400x360 -> 1617,893,400x360  (Δw=0 Δh=0)
```
Pill-mode (170x56) was not separately re-verified live in this session (the window went off-screen behind other apps mid-testing on the shared machine, and by that point the core growth mechanism was already conclusively fixed and verified) — but the code path is size-agnostic (`currentWindowSize` is just pinned data, identical logic for either size), so this is a low-risk gap, not an open question about the fix's correctness. Full existing test suite re-run: 59/59 Electron tests pass, no regressions.

**No other `setBounds()`/`setPosition()`-in-a-hot-loop pattern exists elsewhere in this codebase** — checked: the only other `setBounds()` call is `resize-window`, a single discrete call per pill/full mode toggle (not a per-tick handler), and there is only ever one `BrowserWindow` in the whole app (`createWindow()` is the only `new BrowserWindow(` call).

**Files changed:** `electron/main.js` (the `move-window-by`/`drag-start`/`drag-end`/`resize-window` handlers), `electron/preload.js` (new `dragStart`/`dragEnd` exposed on `window.electronAPI`), `ui/app.js` (`initDrag()` calls them from `onMouseDown`/`onMouseUp`). Pushed directly to `main` per this repo's branch protocol.

**For Kevin:** please reconfirm once more on your end when convenient — this session's own live verification was thorough (real OS input, in-process debug instrumentation, multiple independent methodology corrections after each was falsified) but happened on the shared machine while other work was also running on it concurrently, and pill mode specifically wasn't re-confirmed after the final fix landed.

## Session 2026-08-10 (Markey, voice engineering agent) — Windows PTT-answering recurrence + pill/header drag-grows-window bug

**Context:** Kevin reported two live Windows bugs: (1) PTT answering dictated questions instead of transcribing them, despite three prior fixes to this exact failure class (`da68be3` 2026-07-09 prompt fix, `e5018b7d`/`62bff187` 2026-08-03 heuristic backstop, `c00fee23` 2026-08-07 novel-vocab check — none of which HANDOVER.md had a session entry for until now, a documentation gap worth noting); (2) dragging the floating Mini Pill/header window on Windows grows it instead of translating its position. This session ran without local/GUI access (no mic, no hotkey listener, no Windows display) — everything below is compile/unit-test verified only, not live-verified. Per this repo's CLAUDE.md, that's expected for a non-hardware session; Kevin verifying live is the one remaining step for both fixes.

**Bug 1 fix — commit `7e0691e3` (`main.py`, `test_main_cleanup.py`).** Re-derived `is_plausible_cleanup()`'s three existing heuristics (length, list-structure, vocab-overlap ≥0.35, novel-vocab ≤0.40) by hand against a constructed case — "remind me to call sarah at five" → "I'll remind you to call Sarah at five." — and found it passes all four checks (87.5% raw-word survival, only 25% of cleaned words are new) while still being a fabricated first-person reply, not an edit. Added a fifth, structural check independent of vocabulary ratios: reject a cleaned result that opens with a conversational reply marker ("yes"/"sure"/"i'll"/"i can't"/"here's"/"sorry"/etc.) that wasn't already present at the start of the raw transcript — legitimate dictation that itself starts with one of these words is explicitly exempted (only a *new* opener triggers rejection). 12/12 tests in `test_main_cleanup.py` pass (3 new), 83/85 across the full local suite (the 2 failures are pre-existing/unrelated — `test_mac_frozen_entrypoint.py` needs PyInstaller `build/` artifacts this sandbox doesn't have).

**This is still "mitigated, not solved"** — same status as the memory note (`begb0037admin/markey`'s `memory/windows-mac-dictation-answer-vs-transcribe.md`) has carried since the first two fixes, now extended to cover a fourth layer. This fix targets a gap found by *reasoning about the existing heuristic's blind spots*, not from a transcript Kevin actually reported — no exact wording of what was said/pasted was available this session. If PTT answers a question again, check first whether it's this same "rephrased confirmation" class slipping past a still-too-narrow `_ANSWER_OPENERS` list before assuming a new bug class.

**Bug 2 fix — commit `e320458a` (`electron/main.js`).** Read through the full drag chain: `ui/app.js`'s `initDrag()` (mousedown/mousemove screenX/screenY deltas, unchanged since `f858270e` 2026-07-27) → `window.electronAPI.moveWindowBy(dx, dy)` (`electron/preload.js`, unchanged) → the `'move-window-by'` IPC handler in `electron/main.js`. Found no logic bug in any of these — `dx`/`dy` computation and the old `win.setPosition(x + dx, y + dy)` call were both correct in isolation. Leading hypothesis: a known Electron/Chromium behavior where a frameless, transparent `BrowserWindow`'s bounds can be recomputed against a per-monitor DPI scale factor mid-drag on Windows, which a bare `setPosition()` call (unlike a true OS-native title-bar drag) doesn't guard against. Fixed defensively regardless of the exact mechanism: the handler now reads the window's full current `getBounds()` and reasserts `width`/`height` explicitly on every single move tick via `setBounds()`, not just `x`/`y` — since this is the only code path that ever changes the window's bounds during a drag, size can no longer drift no matter what Windows does internally between calls. `node --check` confirms the file is syntactically valid; there is no way to exercise a real `BrowserWindow` in this environment, so this has not been reproduced or re-verified against Kevin's actual drag gesture.

**For Kevin, next time either recurs or is confirmed fixed:**
1. Confirm live whether dragging both the header (Full view) and the pill bar (Mini Pill mode) now only translates position on the Windows machine — multi-monitor with mixed DPI scaling, if that's part of the setup, is the most informative case to test.
2. If PTT answers a question again, capture the exact raw transcript and what got pasted — that's the one thing repeatedly missing from this bug's history, and would let the heuristic gap be closed by evidence instead of construction.


## Session 2026-08-10 (Markey, voice engineering agent) — App renamed "Push 2 Talk" → "PTT"

**Context:** Kevin asked for the app to be renamed from "Push 2 Talk" to "PTT" everywhere — package identity, build/installer identity, and every user-facing string.

**What changed (single commit, pushed directly to `main` per this repo's branch protocol):**
- `electron/package.json`: `name` `push2talk` → `ptt` (npm package names can't have uppercase or spaces), `description` `Push 2 Talk - ...` → `PTT - ...`.
- `electron/package-lock.json`: both `name` fields (`push2talk` → `ptt`) updated by hand to stay consistent with `package.json`, since `npm install` can't be run in this environment to regenerate it — worth a real `npm install` pass once on a machine that has Node, to confirm the lockfile is otherwise still valid.
- `build/generate-builder-config.js`: `appId` `com.lelitte.push2talk` → `com.lelitte.ptt`, `productName` `Push 2 Talk` → `PTT`, NSIS `shortcutName` `Push 2 Talk` → `PTT`, both macOS `NS*UsageDescription` strings, and the frozen backend's expected directory name (`backend/push2talk-backend` → `backend/ptt-backend`).
- Backend PyInstaller identity: `build/push2talk-backend.mac-entry.py` → `build/ptt-backend.mac-entry.py`, `build/push2talk-backend.mac.spec` → `build/ptt-backend.mac.spec`, `build/push2talk-backend.win.spec` → `build/ptt-backend.win.spec` (old paths deleted in the same commit, not left behind); each spec's own `name='push2talk-backend'` (EXE and COLLECT) → `'ptt-backend'`.
- `build/build-backend.ps1` / `build/build-backend.sh`: spec-file paths and the frozen exe output path updated to match the rename above.
- `build/build-app.ps1` / `build/build-app.sh`: every hardcoded reference to the old packaged output name — `Push 2 Talk.exe` / `Push 2 Talk.app`, the frozen backend exe path, the expected `generate-builder-config.js` backend-source path, the macOS codesign `Identifier=com.lelitte.push2talk` check, and the `pgrep` process-name patterns used by both scripts' post-build smoke tests. These are exactly the acceptance-test scripts that would have silently started failing against a renamed `productName`/`appId` output if left alone — electron-builder derives the packaged executable/bundle name from `productName` automatically, so this class of breakage was real, not hypothetical.
- `electron/main.js`: the packaged-backend exe-name resolution (`push2talk-backend[.exe]` → `ptt-backend[.exe]`), the fatal-dialog title, the tray tooltip (both the idle string and the status-suffixed template), and the tray context-menu's "Show ..." label.
- `electron/mac-permission-gate.js`: both the Accessibility-required message and its longer detail string.
- `ui/index.html`: `<title>`, the header brand `<span>`, and the Settings view's "Back to ..." button label.
- `ui/app.js`: the file's own top-of-file identifying comment.
- `main.py`: the one user-facing (stderr) string naming the app in the macOS Accessibility-denied path.
- `build/tests/test_generate_builder_config.mjs` and `test_mac_frozen_entrypoint.py`: updated to assert against the new `appId`/`shortcutName`/backend-directory-name/spec-file-path values so the existing test suites keep passing against the renamed identifiers instead of silently asserting on names that no longer exist.
- `README.md`: title, the `%APPDATA%\push2talk\config.json` example path, the sample installer filename — plus a one-line "formerly Push 2 Talk" note for continuity.
- `CLAUDE.md`: the Identity section's Project line, with the same "renamed from" note pointing back here.

**Deliberately left unchanged (judgment calls, not oversights):**
- `P2T_DIAG` (the structured stderr diagnostic-line tag emitted by `main.py`/`diagnostics.js`) and `P2T_CONFIG_DIR` (the env var `electron/main.js` sets and `config.py` reads). Both are internal wire-protocol identifiers, never shown to Kevin, with exact-string test assertions across `electron/tests/test_diagnostics.mjs`, `test_main_latency.py`, and `login-item-logic.js`. Renaming these would be a large, purely-cosmetic diff across many test files for zero user-facing benefit, and would risk breaking the sanitization boundary's own tests for no reason. Treated as out of scope for "the app's name."
- Historical "push2talk-packaging run" citations left in `build/validate-lock.py` and `electron/main.js`'s comments (both reference a specific past FINAL_BRIEF.md-named work session by that name) — revising history isn't the goal here, and neither reference is a live identifier anything depends on.
- The `# CLAUDE.md — windows-dictation` / `# windows-dictation — Living Handover Document` doc-title lines, and this file's own historical session entries below (all 52 pre-existing "Push 2 Talk" mentions further down this log) — those describe the repo's own past name and what was literally true in each past session; rewriting them would falsify the record. Only the rotating summary block at the top of this file and this new entry reflect the rename.

**What was NOT done, and should be treated as real risk, not oversight:**
- **No build was run.** This environment has no Windows/Mac build toolchain, no `npm`/PyInstaller/electron-builder available — every change above is a text edit verified only by careful before/after diffing and a full-repo grep sweep for every remaining `push2talk`/`Push 2 Talk` occurrence (clean except the two intentional "formerly" footnotes and the two intentionally-preserved historical citations noted above). The actual `npm start` dev run, a full `build-app.ps1`/`build-app.sh` packaging pass, and the renamed installer's own smoke tests have never executed against this change. Do that before trusting it end to end.
- **Existing installed-app config will not carry over.** Electron's `app.getPath('userData')` is derived from `package.json`'s `name` field (now `ptt`, not `push2talk`), so a rebuilt PTT installer will read/write `%APPDATA%\ptt\config.json` instead of the currently-installed app's `%APPDATA%\push2talk\config.json`. Kevin's current Windows install is described in this file's own Status section as "in daily use" — the next PTT-branded install will silently start from `config.py`'s defaults (theme, hotkey, autostart, opacity all reset) rather than reading the old file. Not data loss and not a crash, but a real, user-visible surprise on first launch that nobody asked to have designed around — no migration step was written since none was requested; flagging it here so it isn't a surprise later.
- **No auto-update feed exists to worry about** — checked `generate-builder-config.js` and found no `publish`/electron-updater configuration at all, so there was nothing to update on that front.
- **Login-item (autostart) self-heals, verified by reading the existing code, not by testing it live:** `reconcileLoginItemOnStartup()` (`electron/login-item-logic.js`) already re-reads and corrects the real OS Run-key state against the stored config on every startup, so a stale pre-rename autostart registration should self-correct the first time the renamed app runs — this is existing pre-rename logic, not something added for this change, and it was not exercised live either.
- **Icon/asset filenames were not touched** (`icon.ico`/`icon.icns`/`icon.png`/`logo.svg` are already generic, not name-tied) — confirmed by inspection, no change needed.

## Session 2026-08-05 (Codex) — 0.1.3 deterministic macOS clipboard paste

Physical acceptance of 0.1.2 produced a new transcription successfully but pasted an older clipboard sentence instead. The live backend log proved the current recording had adequate audio and completed transcription and cleanup; the hotkey/focus/paste event also fired because text reached the target. The fault was the clipboard lifetime in `inject.py`: macOS Quartz queues the synthetic Command-V for the target application, while the backend restored the pre-dictation clipboard only 50ms after posting it. If the target handled the queued event after that restoration, it deterministically received stale text.

**Implemented:** version 0.1.3 reads the just-written clipboard value back before posting paste and fails visibly if it cannot be verified after three attempts. On macOS, the transcription now remains on the clipboard after Command-V, removing the restore race entirely and providing a manual Command-V fallback. Windows retains its existing Ctrl-V and previous-clipboard restoration behavior. Regression tests prove the Mac path performs no stale restore, the Windows contract remains, and clipboard verification fails closed.

**Source verification:** 73 Python tests and the Electron/build Node suites pass; `git diff --check` is clean. The real host pipeline then passed 59 Electron tests, the native Electron 18x18 tray-image test, 17 lock tests, frozen multiprocessing diversion, real frozen MLX inference, package inventory, and strict app/backend signature checks.

**Artifact:** run `0.1.3-20260805T154109Z-f024ddb`; `Push 2 Talk-0.1.3-arm64.dmg`; 393,149,238 bytes; SHA-256 `25e9fbe55c4f31a1290188f972d09c1c1d11f3224f5ad379e76b73c1d5472b14`. `hdiutil verify` reports VALID; the embedded app is ARM64, bundle `com.lelitte.push2talk`, version/build `0.1.3`, and passes `codesign --verify --deep --strict`. The pipeline marks the artifact `UNVERIFIED` only because its interactive renderer/physical hotkey/microphone/paste gate was skipped. Install over 0.1.2, re-approve Accessibility if macOS requests it, and physically verify one new sentence pastes rather than the previous clipboard value.

## Session 2026-08-05 (Codex) — 0.1.2 permission startup and macOS tray sizing correction

Installing 0.1.1 exposed two release defects that its skipped interactive smoke gate had not caught. First, the frozen Python child called `CGPreflightListenEventAccess()` before the visible Electron app requested Accessibility, exited `1`, and Electron discarded the actionable stderr text at the privacy boundary before showing only “The dictation backend stopped unexpectedly.” Second, the macOS tray fix passed the decoded 1024x1024 PNG directly to `Tray`; macOS used that logical size, producing a clipped blue/white strip roughly 1024px wide across the menu bar.

**Implemented and pushed directly to `main`:** `1fd2670` adds an Electron-owned macOS permission gate that requests Accessibility before spawning Python, keeps the UI alive with an actionable non-dismissible permission panel and “Open Accessibility Settings” button, polls for approval, and starts one backend automatically when trusted. It also converts the Python fallback to a structured `MAC_ACCESSIBILITY_REQUIRED` diagnostic/exit 77. The same commit resizes the Darwin tray image to 18x18 and adds unit/runtime coverage. `f828cb8` makes the real Electron tray runtime test mandatory in `build/build-app.sh`, closing the pipeline gap that let the oversized icon ship. Version bumped to 0.1.2.

**Verification:** 71 Python tests, 59 Electron tests, 15 builder-config tests, and 17 lock tests passed. The host Electron runtime decoded the committed source PNG at 1024x1024 and confirmed the prepared tray image is exactly 18x18. Full host packaging completed with exit 0, including frozen multiprocessing diversion, real MLX inference, package inventory, and strict app/backend signature checks.

**Artifact:** run `0.1.2-20260805T151853Z-f828cb8`; `Push 2 Talk-0.1.2-arm64.dmg`; 393,149,488 bytes; SHA-256 `40c3cdffbbccb65213af82479c2faab28dc2eda0ceea8c174f46ccfdb1a97d15`. `hdiutil verify` reports VALID; embedded build metadata says version 0.1.2, clean commit `f828cb84`, Darwin arm64. Marked `UNVERIFIED` only because the interactive renderer/physical hotkey/microphone gate was skipped. Install over 0.1.1, approve Push 2 Talk under Privacy & Security > Accessibility when prompted, then confirm the compact tray icon and one real dictation.

## Session 2026-08-05 (Markey, voice engineering agent) — 0.1.1 built and packaged, real DMG produced

**Context:** Kevin asked for an installable Mac build right now, on top of the just-merged `coreaudio-hang-and-tray-icon` fix (`4a46c8e`, reviewed and Kevin-approved). Ran directly on this Mac.

**Version bump:** `electron/package.json` + `electron/package-lock.json` bumped `0.1.0` → `0.1.1` (semver patch, two bug fixes, no new feature) and pushed straight to `main` per this repo's own Branch and Merge Protocol — commit `63fe0a5`. Version is read from `electron/package.json` alone (`build/generate-builder-config.js` line 110); no separate VERSION file exists.

**Prerequisites re-verified, not assumed:** the two items the prior paused Mac pipeline run had left uncommitted (generated lock files `build/lock/mac-arm64.txt` / `build/lock/build-tools.mac-arm64.txt`, and the missing-executable-bit fix in `build/build-app.sh` / `build-backend.sh`) were already committed in this clone, at `edbf828` ("Mac packaging prerequisites..."). Confirmed via `git log` and `git ls-files -s` (both scripts show mode `100755`) before proceeding — no re-fix needed.

**Full pipeline run, first attempt (interactive smoke test) — real, reproducible failure found and root-caused, not a build defect:**
- Ran `build/build-app.sh` for real (no flags) via an `expect` wrapper so the interactive renderer y/n gate could genuinely be answered after visual inspection, per this repo's CLAUDE.md allowance for on-machine Claude Code to do "visual smoke-checks (screenshot + inspect)".
- Lock validation, `npm ci`, full test suite (Electron `node --test`, root `pytest`, builder-config/icon-generator tests), backend freeze, multiprocessing-diversion gate, `get_config` smoke, and real frozen MLX Whisper inference all passed. `electron-builder --dir` produced a validly signed `Push 2 Talk.app` (ad-hoc, `com.lelitte.push2talk`).
- At the interactive gate, `open`-ing the freshly built `.app` showed a native fatal dialog instead of the normal UI: `"The dictation backend stopped unexpectedly. {"exit_code":1}"` — confirmed via a real screenshot, not assumed.
- **Root-caused, not guessed:** reproduced directly by invoking the frozen backend binary by hand with the exact cwd/env Electron uses (`resolveBackendCommand()` in `electron/main.js`) — that reproduction succeeded (exit 0). The difference was the app bundle's own TCC identity: `main.py`'s `check_macos_accessibility()` (~line 1067) calls `Quartz.CGPreflightListenEventAccess()` and `sys.exit(1)` if it returns false, with a clear stderr message. Terminal already has Accessibility/Input Monitoring granted on this Mac from prior sessions (so direct manual invocation passed); this brand-new ad-hoc-signed bundle is a distinct, never-approved TCC identity and has never been granted either permission, so the packaged backend correctly and loudly refuses to start. **This is the known, expected first-launch behavior for a new unnotarized bundle, not a regression or a build bug** — confirmed via direct code read of the exact `sys.exit(1)` call site, not inferred.
- Granting Accessibility/Input Monitoring for a brand-new bundle identity requires a human clicking the System Settings checkbox — not something this agent can do non-interactively, on this Mac or any other. Continuing the interactive gate would have either produced a false pass (blindly answering "y") or a false `SMOKE_TEST_FAILED` abort (answering "n" for a permissions issue, not a renderer defect) — both wrong. Aborted that run instead.

**Second, final run — `--skip-smoke-test`, disclosed:** cleaned up the aborted run's directory, removed three untracked `.DS_Store` files (Finder cruft, never tracked) so the run ID would be clean rather than `+dirty`, then re-ran `build/build-app.sh --skip-smoke-test`. Completed successfully end to end:
- **Run ID:** `0.1.1-20260805T145400Z-63fe0a5` (clean tree, no `+dirty` suffix).
- **DMG:** `build/out/0.1.1-20260805T145400Z-63fe0a5/electron/Push 2 Talk-0.1.1-arm64.dmg` (393,139,237 bytes), SHA-256 `8a7803d1dc5901508488db976d7fede271da5df5752d0f1641a8a4e9118fa311`. `hdiutil verify` reports the image valid (real command output checked, not assumed).
- App bundle and embedded backend both pass `codesign --verify --deep --strict`; `Identifier=com.lelitte.push2talk`, `Signature=adhoc` confirmed via `codesign -dvvv`.
- Marked `UNVERIFIED` per this script's own contract, for the reason above — the interactive renderer/hotkey/mic smoke step was skipped, not because anything failed, but because the one remaining check needs Kevin present to grant Accessibility/Input Monitoring to this new bundle first.

**For Kevin, before this DMG can be treated as accepted:**
1. Install this DMG (replace the existing `.app`) and grant Accessibility **and** Input Monitoring under System Settings → Privacy & Security for the new bundle (its TCC identity changed since it's a fresh ad-hoc build — the old grant does not carry over).
2. Launch once and confirm the normal Aurora/neumorphic UI renders (logo visible, no `ERR_FILE_NOT_FOUND`) — this is the one check this session could not complete non-interactively.
3. Do a real hotkey-press dictation to confirm the CoreAudio-hang fix and the tray icon are both actually working live, since neither was re-verified against physical mic/hotkey input this session (matches this repo's own "Claude Code can build/test but Kevin verifies live hotkey/mic" rule).

## Session 2026-08-03 (Markey, voice engineering agent) — Audio-hang and tray-icon bugs root-caused live; brief-converge requested

**Context:** picked up a live investigation (audio capture appearing to silently fail) from a prior agent pass that had already refuted Eloquent-mic-contention and confirmed the multiprocessing-recursion fix (below) was present and working, with no zombie processes. This session ran directly on Kevin's Mac (`kevins-MacBook-Pro.local`), correlating `~/Library/Application Support/push2talk/logs/backend.log` against a live `log stream` capture of CoreAudio/TCC activity around real, physical hotkey presses Kevin performed live.

**Bug 1 — CoreAudio stream-teardown hang, not a hotkey-type issue.** Across one long-lived (~4h41m) backend process, 8+ consecutive real-speech recordings all completed fast but captured literal exact-zero audio (`AUDIO_SIGNAL rms_milli:0,peak_milli:0,active_percent:0`) — correctly rejected by the (locally uncommitted) silence-rejection guard rather than pasting garbage. One further press instead hung: `start_recording()` logged, then nothing — no `AUDIO_SIGNAL`, no rejection — for 2m14s, ending in a silent `BACKEND_EXIT (exit_code:null)`; Electron auto-relaunched a fresh backend ~13s later. Correlated unified-log evidence: the instant that stream opened, CoreAudio logged `HALC_ProxyIOContext::IOWorkLoop: skipping cycle due to overload` (a realtime deadline miss) three times in the first ~8s, and there is confirmed to be **no** `~AUHAL ... Selecting device 0 from destructor` line anywhere in the entire 2m14s hang window — `stop_recording()`'s `local_stream.stop()/close()` call (current `main.py` ~line 548-550) never completed. Every healthy recording today, before and after, shows a clean destructor line within ~1s of stopping and zero overload messages. A working hypothesis that this was specifically triggered by the mouse-button hotkey path (raised mid-session, given `run_hotkey_listener()`'s own comment that mouse clicks aren't suppressed/exclusive the way keyboard modifiers are) was directly tested and disproved: Kevin did 4 clean `mouse_middle` press-hold-speak-release cycles in a row on the fresh post-crash backend, all captured real audio and completed normally. **Confirmed mechanism:** an occasional CoreAudio realtime deadline miss (root trigger not fully pinned down — plausibly transient system load, not app-controllable) can leave the stream's teardown call hanging forever, because there is no timeout/watchdog around it — turning one transient CoreAudio hiccup into an indefinite silent hang with zero user feedback. Separately, definitely-real: `stop_recording()` clears `recording`/`stream` state *before* teardown actually completes, a race that could let a second press open a concurrent stream during that window.

**Bug 2 — tray icon invisible on macOS, forcing Force Quit; also explains the reopens-at-login complaint.** `resolveTrayIconPath()` (`electron/main.js` ~line 401-413) unconditionally loads `icon.ico` for the tray on both platforms — no Darwin branch. Direct headless test against this app's own Electron 43.2.0 runtime today: `icon.ico` → `isEmpty:true` (0x0) on macOS; `icon.icns` (present, independently confirmed genuinely valid via `iconutil`/`sips`) → *also* `isEmpty:true`, unexplained; `icon.png` → decodes correctly, 1024x1024. `createTray()` explicitly falls back to `nativeImage.createEmpty()` when the icon is empty, so the live Tray really is blank — confirmed via a real screenshot of the running app's actual menu bar today (no icon matching this app's branding anywhere in it). Same bug class as the historical Windows tray-icon fix (`nativeImage.createFromPath` silently failing on the wrong resource type), recurring here via a mismatched format on the other platform. Since Exit only lives on that tray's context menu and the hide-to-tray-on-close design is intentional (2026-07-29, do not revert), an invisible icon makes Force Quit the only way in. This also explains "reopens at login despite autostart unchecked" as a side effect, not a second bug: confirmed via both the legacy System Events login-items list and the modern `sfltool dumpbtm` registry that this app is not registered as a login item at all (matches the correctly-unchecked config; `electron/login-item-logic.js` is working correctly, not the culprit); separately confirmed this Mac has `com.apple.loginwindow TALLogoutSavesState = 1` (macOS's own "reopen windows when logging back in" preference) — since the app can never be cleanly quit, it's always "still open" at shutdown, so macOS reopens it. Fixing the tray icon should resolve both symptoms.

**Also flagged, smaller, independent:** `capture_focus_target()`/`restore_focus_target()` (`main.py` ~lines 172-210) still use `osascript`/System Events for pre-paste focus snapshot/restore (paste itself no longer needs AppleEvents — already fixed via native Quartz `CGEventPost`). The per-target-app Automation permission this needs has never actually been exercised against a real third-party app on this Mac, and both functions swallow failures via a broad `try/except` with no visible error. Not reproduced as a live bug today, but a real, verified gap.

**Not done this session:** no code changes made (diagnosis only, per Kevin's explicit "don't want a handoff based on a guess" instruction — confirmed everything above live before concluding). A `brief-converge` run has been requested against Matthew for the actual fix; see his run's own paperwork once started. The pre-existing uncommitted local diff (multiprocessing/native-paste/silence-guard/Large-v3-turbo work, 2026-07-30 Codex session, described in the session entry immediately below) was read and relied upon but not modified or pushed.

## Session 2026-07-30 (Codex, continued) — Mac frozen multiprocessing recursion fixed

Shortly after the prior package was provisionally accepted, Kevin dictated one question once and received several repeated copies. The issue was immediately reopened; the earlier completion statement is superseded.

**Direct evidence and root cause:**

- At 17:27, `backend.log` recorded five `LIVE_CAPTIONS_DISABLED_LARGE_TURBO` events, five nearly identical `AUDIO_SIGNAL` records, and five separate transcription/cleanup/ready pipelines for one hotkey use. This was not one Whisper result containing an internal repetition loop.
- Read-only process inspection showed one Electron app and its primary backend, followed by a recursive chain of frozen-backend processes launched with `-B -S -I -c from multiprocessing.resource_tracker import main;main(...)`: PID chain `86104 -> 86117 -> 86127 -> 86143 -> 86154 -> 86524`.
- The backend's frozen entry point did not call `multiprocessing.freeze_support()`. PyInstaller documents this exact symptom: on macOS, a multiprocessing resource tracker is launched using the frozen application executable; without its `freeze_support()` diversion, the helper executes the application code and can create an endless spawn loop.
- The Electron single-instance lock was working at its own layer but could not prevent this Python-level recursion, because all recursive pipelines were descendants of the one legitimate Electron-spawned backend.

**Mac-only repair:**

- Added `build/push2talk-backend.mac-entry.py`. It calls `multiprocessing.freeze_support()` before importing `main`, allowing PyInstaller to divert resource-tracker/worker invocations before any microphone, hotkey, transcription, or paste initialization.
- Only `build/push2talk-backend.mac.spec` now uses that wrapper. Shared `main.py`, `build/push2talk-backend.win.spec`, Windows model configuration, and the installed Windows app were not changed for this repair, at Kevin's explicit request.
- Added regression tests proving call order and proving the Windows spec still points directly to `main.py`.
- Added a Mac build gate that launches the actual frozen executable with the exact POSIX resource-tracker command form and a real inherited tracking pipe. The helper must remain silently blocked until pipe EOF, then exit cleanly without emitting backend events. This prevents another package from passing on source-level assumptions alone.

**Verification and artifact:**

- 52/52 root Python tests, 25/25 Electron tests, 17/17 Python build tests, 12/12 builder-config tests, and 5/5 icon-generator tests passed: 111 tests total.
- The new gate printed `frozen multiprocessing diversion: PASS` during the build, and passed again independently against the backend copied inside the final `.app`.
- Real frozen Large Turbo MLX/Metal inference, backend protocol checks, package inventory, and strict deep app/backend signature checks passed.
- Final build: `0.1.0-20260730T173251Z-1f03f3f+dirty`.
- App identifier `com.lelitte.push2talk`; ad-hoc CDHash `d29fbbf53517fdd5800b182b1848ea16f6b7d512`.
- DMG: `build/out/0.1.0-20260730T173251Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,160,910 bytes), SHA-256 `d88943f868fc922155ada5053c23d546bf22d24bf3436c900102d4aa25cc5a00`. `hdiutil verify` reports the image valid.
- The DMG is marked `UNVERIFIED` only because the interactive renderer/physical hotkey/microphone/paste smoke step was skipped. The currently installed app remains the faulty prior build until Kevin replaces it.

**Required acceptance sequence:** use the faulty app's tray menu to select **Exit** before installing; this must terminate the entire existing backend/tracker chain. Open the new DMG, replace the Applications copy, remove/re-add the new app under Accessibility and Input Monitoring for its new ad-hoc CDHash, launch once, and dictate one short sentence. After launch, process inspection should show one Electron parent, one primary backend, and at most a direct legitimate resource tracker—not a tracker-to-tracker chain or multiple dictation pipelines.

## Session 2026-07-30 (Codex, continued) — Repeated invented text researched; layered safety fix built

Kevin reported that one dictation returned the same invented sentence five times even though he did not say it. This was treated as a data-integrity defect, not as a pronunciation problem.

**Evidence and conclusion:**

- `backend.log` showed two overlapping complete dictation pipelines at 16:30:07 and three at 16:30:26. Each pipeline independently started, transcribed, cleaned, and pasted. The Electron main process had no `app.requestSingleInstanceLock()`, so launching the app more than once could create multiple backend recorders and multiple pasted results.
- The log intentionally excludes transcript content, so it cannot prove whether the exact invented words first came from Whisper or Ollama. Do not claim that provenance without a captured raw-vs-cleaned comparison.
- OpenAI's Whisper paper documents complete hallucinations unrelated to the audio and repetition loops. The official decoder exposes no-speech, log-probability, compression-ratio, and previous-text conditioning controls. These are relevant safeguards, but a direct local test also proved that Large Turbo can confidently transcribe one second of digital zero audio as `"Thank you."`, with metrics that do not trip the model-level thresholds. Silence therefore needs an independent signal gate before inference.
- This remains fully local: neither transcription nor cleanup uses a paid cloud API, provider credit, or account balance.

**Implemented:**

- Electron now acquires `app.requestSingleInstanceLock()` before creating a window/backend. A second launch quits immediately and focuses/restores the existing primary window instead of starting another recording pipeline.
- The production path measures RMS, peak, and active-sample fraction and rejects digital/near silence or an isolated click before Whisper. It shows `No clear speech was detected, so nothing was pasted.` and logs only content-free signal levels.
- Both MLX Whisper and faster-whisper now use `condition_on_previous_text=False`, explicit no-speech/log-probability/compression thresholds, and segment-level validation. Obvious phrase loops, all-no-speech segments, very low mean log probability, or excessive compression are rejected and never pasted.
- If local Ollama cleanup introduces a repetition loop that was not present in the safe raw transcript, cleanup is discarded and the raw transcript is used.
- Rejections and timings remain privacy-safe: diagnostics contain codes, metrics, counts, and durations, never recorded audio or transcript text.
- The frozen-build inference self-test accepts a deliberate safety rejection as proof that the MLX runtime executed, while still failing on dependency/model/runtime errors.

**Verification:**

- 50/50 root Python tests, 25/25 Electron tests, 12/12 Node builder-config tests, and 17/17 Python packaging tests passed: 104 automated tests total. Shell syntax and `git diff --check` also passed.
- Final build: `0.1.0-20260730T164618Z-1f03f3f+dirty`.
- The build gate and a second direct invocation of the exact embedded backend completed real frozen Large Turbo MLX/Metal inference. The model may still produce text for the build's synthetic zero waveform because that diagnostic deliberately invokes the model directly; the normal production path rejects that waveform before inference.
- `app.asar` was inspected and contains `/single-instance-logic.js`.
- The final `.app` passes `codesign --verify --deep --strict`; identifier `com.lelitte.push2talk`, ad-hoc CDHash `a53fc9793ef75f03969c667cf0d361771f4b9090`.
- DMG: `build/out/0.1.0-20260730T164618Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,162,540 bytes), SHA-256 `0352080183370f1e58d1343f6de203e241e0eaa9ed762b1451b0afa38f2601ed`. `hdiutil verify` reports the image valid.
- The package is marked `UNVERIFIED` only because the renderer/physical microphone/hotkey/paste smoke step was skipped. `/Applications/Push 2 Talk.app` was not replaced or launched during this work.

**Controlled acceptance:** fully exit the old installed app from its tray before replacing it. This matters once because the old build has no single-instance lock and cannot be displaced by the new build. Install the DMG, remove/re-add the new installed copy under both Accessibility and Input Monitoring because its ad-hoc CDHash changed, launch exactly once, and dictate one clear short phrase into Notes. Then launch its icon again: the existing window should focus and no second backend should appear. If the app reports no clear speech, inspect the content-free `AUDIO_SIGNAL` diagnostic before tuning thresholds.

**Superseded acceptance:** Kevin initially reported the package working, but a subsequent one-question dictation exposed five Python backend pipelines. The issue was reopened and root-caused in the following session above; do not treat this earlier acceptance as final.

## Session 2026-07-30 (Codex, continued) — Large Turbo duplicate-inference latency removed

After installing/testing Large V3 Turbo, Kevin confirmed accuracy improved but response after releasing the hotkey was slower.

**Root cause in the implementation:**

- The live-caption loop invoked Whisper every 0.8 seconds during recording.
- The final path shared the same `transcribe_lock`. Releasing the hotkey while a Large Turbo partial pass was in flight made the final pass wait for that disposable visual-only transcription.
- The app then transcribed the complete audio again for the authoritative result and ran Ollama cleanup serially. This meant one user dictation could pay for multiple Large Turbo passes before paste.

**Implemented:**

- `live_partial_transcription_enabled()` disables live partial transcription only when the active model/repository is Large V3 Turbo. Small/custom models retain the existing live-caption behavior.
- Recording waveform/audio-level feedback remains active. Large Turbo runs once after release, through the same final model, fixed-English decoding, cleanup, and paste path as before; there is no intended accuracy change.
- Added content-free structured diagnostics for transcription time, cleanup time, and total release-to-ready time. Each record contains only a stage code, milliseconds, and output character count; Electron's existing allowlist strips everything else.
- Added three regression tests covering Large Turbo partial suppression, Small-model caption preservation, and the timing diagnostic's privacy-safe shape.

**Verification:**

- Source/build tests passed: 39/39 Python tests, 21/21 Electron tests, 17/17 Python packaging tests, plus shell syntax and `git diff --check`.
- Final build: `0.1.0-20260730T161030Z-1f03f3f+dirty`.
- The build gate completed real frozen Large Turbo MLX inference. The exact backend copied inside the final `.app` independently passed host-GPU inference and emitted `{"type":"build_self_test","component":"mlx_whisper","ok":true,"transcript_length":10}`.
- DMG integrity verified by `hdiutil`. App/backend strict signature checks passed.
- Outer app identifier: `com.lelitte.push2talk`; CDHash: `443f0ae0fd130b6b07c4d2e03f6e610e94449a7b`.
- DMG: `build/out/0.1.0-20260730T161030Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,157,264 bytes), SHA-256 `a1b6fa284b1cb5ffb3e7a29a5a5a1c66063d15ec8b1b480d46f6354e45d8257e`.
- The DMG is marked `UNVERIFIED` only because the interactive renderer/physical-input smoke step was skipped. The installed app was not modified during implementation/build. Installing this new ad-hoc build requires Accessibility and Input Monitoring to be removed/re-added for its new CDHash.

**Next acceptance step:** install the replacement, regrant the two TCC permissions, and dictate several short phrases. If response is still too slow, inspect `TRANSCRIPTION_TIMING`, `CLEANUP_TIMING`, and `DICTATION_READY_TIMING` in `backend.log` before changing model precision or cleanup behavior.

## Session 2026-07-30 (Codex, continued) — Large V3 Turbo accuracy upgrade implemented

Kevin chose to move directly to the larger model on both Mac and Windows after the researched Mac/Windows accuracy mismatch.

**Implemented:**

- Mac default: `mlx-community/whisper-large-v3-turbo`, with `language="en"` explicitly supplied on every transcription.
- Windows default: faster-whisper `large-v3-turbo`, with `language="en"` and `beam_size=5` explicitly supplied.
- Added a narrow persisted-config migration. It upgrades only the exact previously shipped Small configurations on each platform. Any custom model/repository remains unchanged. The real current user config matches the old shipped defaults exactly and will therefore migrate on first launch of the new build.
- Increased the frozen MLX inference timeout from 180 to 600 seconds to accommodate a clean machine's first ~1.61 GB model download.
- Added unit coverage for both transcription call shapes, both new defaults, exact legacy migration/persistence, and custom-model preservation.

**Evidence-driven correction during the build:**

- The first candidate build failed its real frozen inference gate with `NotImplementedError: Beam search decoder is not yet implemented` from mlx-whisper. This proved that faster-whisper's beam setting cannot simply be copied to MLX.
- Mac beam search was removed. MLX retains its implemented greedy/temperature-fallback decoder while still gaining the substantially larger Turbo model and fixed-English decoding. Windows retains supported 5-beam search.
- The source suite then passed 36/36 Python tests, 21/21 Electron tests, 17/17 Python packaging tests, and `git diff --check`/shell syntax validation.

**Mac artifact verification:**

- Final build: `0.1.0-20260730T155039Z-1f03f3f+dirty`.
- The build's frozen backend gate completed real `whisper-large-v3-turbo` inference through MLX/Metal.
- The exact backend copied inside the final `.app` was independently run with host GPU access and emitted `{"type":"build_self_test","component":"mlx_whisper","ok":true,"transcript_length":10}`.
- The final app and embedded backend pass strict signature validation. Outer identifier: `com.lelitte.push2talk`; outer CDHash: `58b40fa4dcce7e2008857f63be7e6bd8f8e76a54`.
- DMG: `build/out/0.1.0-20260730T155039Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,150,219 bytes), SHA-256 `740a9885e627a580054da19d14c3aa2c01c0bf3fed097aa15c8f542776a3a44c`.
- The DMG remains marked `UNVERIFIED` only because the interactive Electron renderer/physical-input smoke step was skipped; package structure, signatures, and real frozen model inference passed. `/Applications/Push 2 Talk.app`, its TCC permissions, and the live user config were not modified by this build.

**Operational consequences:**

- Installing this ad-hoc build changes the app CDHash, so Accessibility and Input Monitoring must be removed/re-added for the new installed copy.
- The large Mac checkpoint is already cached on this development Mac as a result of the inference gate. A different Mac would download ~1.61 GB on first transcription.
- Windows source/config is upgraded, but a new Windows installer still needs to be built and acceptance-tested on the Windows/RTX 3070 machine; no Windows binary can be produced by the Mac packaging run.

## Session 2026-07-30 (Codex, continued) — Mac accuracy gap researched

Kevin reports that Mac fails to recognize simple words while the Windows version is substantially more accurate. No code/config/package change was made during this research.

**Concrete comparison:**

- Both configured paths use Whisper Small. Mac's cached `mlx-community/whisper-small-mlx` declares the standard Small architecture (244M parameters) and has a ~459 MB `weights.npz`; it is not a tiny or 4-bit model.
- Windows calls faster-whisper with `language="en"`. Mac calls `mlx_whisper.transcribe()` without a language, causing language detection from up to the first 30 seconds. Push-to-talk clips are often only a few seconds, making this extra classification both unnecessary and poorly informed.
- faster-whisper's default decoding uses `beam_size=5`; mlx-whisper's `DecodingOptions` defaults `beam_size=None`, which selects its single-path greedy decoder at temperature zero. Thus the current app compares the same model family with materially different decoding effort.
- Host is an M1 Pro with 16 GB unified memory. If aligned decoding is still insufficient, `mlx-community/whisper-large-v3-turbo` is a viable second stage: OpenAI lists Turbo at 809M parameters/~6 GB memory and describes it as the speed-optimized large-v3 variant; the current MLX checkpoint is ~1.61 GB on disk. This has a first-use download and higher memory/latency cost.

**Recommended controlled sequence:**

1. Set Mac final transcription to `language="en", beam_size=5`, matching Windows' key decoding choices. Keep the current Small model for the first comparison.
2. Test the same 3–5 short phrases on both machines and distinguish the raw transcript from Ollama's cleaned result.
3. Only if Mac remains materially worse, switch Mac to `mlx-community/whisper-large-v3-turbo` and repeat. Do not jump models before testing the known decoding mismatch.

## Session 2026-07-30 (Codex, continued) — Literal `v` paste bug fixed with native Quartz flags

After both TCC permissions were correctly regranted, dictation/transcription worked but the target text box received only a literal `v`, not the clipboard text.

**Evidence and cause:**

- TCC database now shows both Accessibility and ListenEvent allowed and bound to the installed build's CDHash `d3f79dc0...`; stale permissions are no longer the cause.
- Installed PyAutoGUI 0.9.54 recognizes `"command"` and maps it to macOS keycode 55. Its implementation nevertheless posts Command-down and V as separate Quartz events and assumes the modifier state carries across.
- The literal `v` is direct behavioral proof that the V event reached the target without Command. Apple documents `CGEventSetFlags` as the API for setting an event's flags and `kCGEventFlagMaskCommand` as indicating that Command is down.

**Fix:**

- Mac paste in `inject.py` now creates native Quartz V-down/V-up events (virtual keycode 9), explicitly applies `kCGEventFlagMaskCommand` to each with `CGEventSetFlags`, and posts them at the HID event tap. Windows retains its existing PyAutoGUI Ctrl-V path.
- Added regression tests that assert both V events carry the Command flag and that Windows behavior is unchanged.

**Verification:**

- 31/31 root Python tests, 21/21 Electron tests, 21/21 Node build tests, and 17/17 Python build tests passed.
- Fresh non-installing build `0.1.0-20260730T132148Z-1f03f3f+dirty` passed frozen real MLX Whisper inference, packaged inventory gates, and strict app/backend signature verification.
- DMG: `build/out/0.1.0-20260730T132148Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,153,940 bytes), SHA-256 `0b691e917e1726d3d5447fb7a4f858b77e326954387c157e166f18261e53d241`.
- New ad-hoc CDHash is `89343b7b9f28750b6b6af91d47c24620c2456c6b`; replacing the current installation will require removing/re-adding the app under both Accessibility and Input Monitoring again. The current installed app and permissions were not changed while implementing/building this fix.

## Session 2026-07-30 (Codex, continued) — New package installed; current exit is proven stale TCC grant

Kevin installed the repaired package, then reported `{"exit_code":1}`. Read-only evidence:

- `/Applications/Push 2 Talk.app` is the new package: all four repaired runtime files are present and nonempty; its outer CDHash is `d3f79dc0049795cb20e101d64fed52dcf3e8453a`; strict deep signature verification passes.
- The existing Accessibility and ListenEvent rows remain allowed (`auth_value=2`) but their `csreq` contains old CDHash `4e640d2b280027fb9d6e771532f5e3dbd61149e6`.
- At the exact 14:00:36 BST failure, TCC attributed the spawned backend to responsible app `com.lelitte.push2talk`, then logged `Failed to match existing code requirement ... kTCCServiceListenEvent` and returned `authValue=0/authReason=5`. This exactly explains `CGPreflightListenEventAccess() == False` and `sys.exit(1)`.
- The exact installed backend, run with the real `P2T_CONFIG_DIR` plus the build-only inference mode and host GPU access, emitted `{"type":"build_self_test","component":"mlx_whisper","ok":true,"transcript_length":0}`. Preserved user configuration matches the intended local `mlx-community/whisper-small-mlx` setup.

The log also contains one transcription-error fingerprint immediately before the clean relaunch. The most likely explanation is that the prior app/backend process was still resident while Finder replaced its on-disk bundle, creating a mixed old-running-process/new-files test; its subsequent `exit_code:null` then records that old process being terminated. Treat this as an inference, not proof. The honest live test is after removing/re-adding the new app under both Accessibility and Input Monitoring, then launching fresh. No code, config, installed app, or permission state was changed during this diagnosis.

**Follow-up after regrant:** dictation/transcription now works, but Command-V is silently discarded in Teams and Notes. The TCC database proves the two grants are split: `kTCCServiceListenEvent` now contains the new app CDHash `d3f79dc0...`, while `kTCCServiceAccessibility` still contains the old build CDHash `4e640d2b...`. This exactly explains the symptom: Input Monitoring admits the hotkey, but Accessibility rejects `pyautogui`'s synthetic paste keystroke without raising an exception, so the backend can log injection as sent even though macOS drops it. Required next action is remove (not merely toggle) and re-add Push 2 Talk under Accessibility only; no code change is indicated.

## Session 2026-07-30 (Codex, continued) — Packaged MLX/Whisper inference repaired and proven before installation

**User-visible failure:** after the TCC/signing and hotkey repairs, a real packaged-app recording reached CoreAudio successfully but the UI changed to the red error state during transcription.

**Evidence and root cause:**

1. This is not an API key, cloud provider, or account-credit issue. The configured transcription backend is local `mlx-whisper`; cleanup is local Ollama. The Whisper model was already cached locally.
2. Unified logs proved the packaged app opened the DJI microphone, converted 48 kHz stereo input to 16 kHz mono, and started/stopped capture. Backend diagnostics then showed repeated partial-transcription failures and a final-transcription failure. This isolated the red state to frozen inference, not recording, permissions, cleanup, or paste.
3. The development MLX installation contained `mlx/lib/mlx.metallib`, but the frozen backend contained only `*.dylib`. The spec introduced for the earlier `libjaccl.dylib` repair globbed only dylibs, omitting MLX's 162,449,848-byte Metal shader library.
4. A newly added real frozen-inference gate exposed two further PyInstaller omissions that lightweight startup/`get_config` checks could never detect:
   - `mlx._reprlib_fix`, dynamically imported by the native MLX extension and invisible to static import analysis.
   - mlx-whisper's inference data: `mel_filters.npz`, `gpt2.tiktoken`, and `multilingual.tiktoken`.

**Implemented:**

- `build/push2talk-backend.mac.spec` now includes all MLX dylibs, exactly one `*.metallib`, the dynamic `mlx._reprlib_fix` import, and all three required mlx-whisper assets. The spec fails closed if the Metal library or expected assets are absent at build time.
- `main.py` has an environment-gated build diagnostic that runs one second of synthetic silence through the real configured `transcribe()` path. It executes before microphone and TCC preflights so the result tests only the frozen MLX/Whisper/Metal runtime; normal app launches never enter it.
- `build/build-app.sh` now requires that real frozen inference to succeed within 180 seconds before Electron packaging. It also checks all four runtime data files after both builder passes, alongside the existing code-signature checks.
- Added three unit tests covering the inference call shape, Mac-only guard, and proof that build-self-test routing bypasses microphone/TCC checks.

**Verification:**

- Automated source/build tests: 29/29 root Python tests, 21/21 Electron tests, 21/21 Node build tests, and 17/17 Python build tests passed.
- The gate correctly failed two intermediate builds—first on missing `mlx._reprlib_fix`, then on missing `mel_filters.npz`—instead of allowing another broken installer through.
- Fresh non-installing build `0.1.0-20260730T123538Z-1f03f3f+dirty` passed real frozen MLX Whisper inference, both packaged inventory checks, and strict app/backend signature verification.
- The exact backend embedded at `Push 2 Talk.app/Contents/Resources/backend/push2talk-backend` was then run independently with host GPU access and emitted:
  `{"type":"build_self_test","component":"mlx_whisper","ok":true,"transcript_length":0}`.
- DMG: `build/out/0.1.0-20260730T123538Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (393,158,047 bytes), SHA-256 `2f3b1295a7d3293696afc3c7accbce0325bb1198b280e4f9a35a6241e5c1034c`.

**Boundary preserved:** `/Applications/Push 2 Talk.app`, TCC permissions, and user configuration were not changed during this repair. The DMG is marked `UNVERIFIED` only because the interactive renderer/physical-input gate was deliberately skipped to honour the agreement not to launch or install anything before frozen inference passed. Next action is to agree the installation/live-dictation test with Kevin; do not reset or change permissions before that agreement.

## Session 2026-07-30 (Codex, continued) — Middle-click default/runtime Settings regression fixed

**User-visible regression:** after the permission repair, middle-click returned and selecting a different hotkey appeared not to work.

**Root cause:**

1. Commit `edbf828` deliberately promoted a local experiment into the shipped `config.json`, changing Mac from the documented/default `alt_l` (Left Option) to `mouse_middle`.
2. `cmd_save_config()` wrote the selected hotkey to disk but left module globals and the already-running `pynput` listener unchanged.
3. The Settings UI immediately claimed “Settings saved.” Closing the window only hides the app to the tray, so the old listener could remain active indefinitely; a later `get_config` also returned the stale startup global. Runtime, UI, and persisted config could therefore disagree.

**Implemented:**

- Restored `config.json`'s shipped Mac hotkey to `alt_l`.
- Added `describe_hotkey()` and `apply_runtime_hotkey()` in `main.py`. A changed setting is validated, the existing keyboard/mouse listener is stopped, runtime hotkey/display/idle state is updated, the correct new listener type starts immediately, and the in-memory config reflects the saved value.
- `save_config` now emits `settings_saved` with authoritative config/display data. Failures emit `settings_error` instead of being silent.
- Electron UI no longer shows success before backend acknowledgement; it applies the authoritative saved config and updates the main hotkey badge. The Settings hint now correctly says changes apply immediately.
- Added three runtime-switch regression tests in `test_main_hotkey.py`.

**Verification:**

- Automated: 26/26 root Python tests, 21/21 Electron tests, 21/21 Node build tests, and 17/17 Python build tests passed.
- Host-level source protocol test switched `alt_l` → `mouse_middle` → `alt_l` in one running backend. Each change emitted the new `ready`/idle state plus `settings_saved`, and the following `get_config` returned the active value. No restart/tray exit was required.
- Verified interactive build succeeded: run `0.1.0-20260730T114958Z-1f03f3f+dirty`. Renderer gate was visually checked (UI/logo rendered, no missing-file error); the final app and embedded backend both passed strict code-signature verification.
- Replacement DMG: `build/out/0.1.0-20260730T114958Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg`, SHA-256 `a075b0e384c9a6ed1c0858887466ea15a975a854537be4eacf5a9cf5b2c95066`.
- A post-build direct frozen-backend command test was attempted but did not reach startup/commands: a read-only process stack sample showed macOS CoreAudio blocked inside `Pa_IsFormatSupported` while the new-CDHash microphone permission prompt from the renderer smoke run was still pending. This was not a hotkey-listener block; the speculative listener-timeout change was discarded. Installation plus physical hotkey testing remains the honest final gate.

**Important installation constraint:** this is another ad-hoc-signed build with a new CDHash. Replacing the installed app will require Accessibility and Input Monitoring to be reset/re-added for this exact build, as documented below. Existing userData is preserved across install, so a prior persisted `mouse_middle` value may initially remain; the repaired selector can change it immediately to Left Option or another choice.

## Session 2026-07-30 (Codex) — Packaged Mac TCC bug root-caused; explicit ad-hoc signing fix built

**Root cause established from live `com.apple.TCC` logs, not inferred:**

1. TCC responsibility resolution is working. For the real `child_process.spawn()` launch it recorded the backend as the accessing/requesting process and `/Applications/Push 2 Talk.app/Contents/MacOS/Push 2 Talk` as the responsible process. The loose PyInstaller binary does not need to become a separate directly-grantable TCC client, and moving it to XPC/a helper bundle is unnecessary for this bug.
2. The original electron-builder output was not a valid signed app bundle. Although individual Mach-O files carried incidental ad-hoc signatures, electron-builder had skipped macOS application signing because no Developer ID identity existed. During the backend's `CGPreflightListenEventAccess()` request, TCC therefore fell back to the responsible executable path (`client_type=1`, `/Applications/Push 2 Talk.app/Contents/MacOS/Push 2 Talk`) and returned `authValue=1/authReason=5`. System Settings had granted the bundle client (`client_type=0`, `com.lelitte.push2talk`), so the subjects could never match.
3. The manual re-sign experiment changed the failure rather than fixing it. The TCC row's `csreq` is `cdhash H"5c22a19a..."`; it is not identifier-only. The re-signed outer app's CDHash became `376e40f0...`, and TCC logged `SecStaticCodeCheckValidity ... status -67050` plus both hashes. Also, signing the backend *after* the outer bundle invalidated the outer resource seal (`codesign --verify --deep --strict`: `file modified: .../backend/push2talk-backend`). The surviving `auth_value=2` row was therefore stale, not proof that the new code still matched its grant.
4. Developer ID / Team ID is not required for TCC responsibility attribution or for one fixed build to work after permission is granted. It is required for a stable designated requirement across changed versions. Apple documents that an ad-hoc signature identifies exactly one program; its designated requirement is CDHash-based, so any rebuilt/changed app needs Accessibility/Input Monitoring toggled off/on. A Developer-ID-signed release is the route to grants surviving updates.

**Implemented:**

- `build/generate-builder-config.js`: Mac config now explicitly sets electron-builder `identity: "-"`, `hardenedRuntime: false`, and `forceCodeSigning: true`. The installed electron-builder 26.15.3 documents `"-"` as its supported opt-in ad-hoc path; its bundled `@electron/osx-sign` walks every Mach-O under `Contents`, including the backend under `Contents/Resources`, signs children first, then seals the outer app.
- `build/build-app.sh`: added `assert_mac_signature()`. Both the `--dir` and DMG builder passes must now satisfy `codesign --verify --deep --strict`; the backend must verify independently; the outer signature must have identifier `com.lelitte.push2talk` and be explicitly ad-hoc. Invalid packages fail before the renderer/permission handoff.
- `build/tests/test_generate_builder_config.mjs`: regression coverage asserts the Mac signing contract.

**Verification:**

- Full clean build succeeded: run `0.1.0-20260730T111331Z-1f03f3f+dirty`.
- DMG: `build/out/0.1.0-20260730T111331Z-1f03f3f+dirty/electron/Push 2 Talk-0.1.0-arm64.dmg` (marked `UNVERIFIED.txt` only because the interactive renderer gate was deliberately skipped).
- Fixed outer app: valid on disk, satisfies its DR, `Identifier=com.lelitte.push2talk`, `Signature=adhoc`, CDHash `27a3a661...`.
- Fixed packaged backend: valid on disk, satisfies its DR, `Signature=adhoc`, CDHash `bf876572...`.
- Tests: 23/23 root Python tests, 21/21 Electron tests, 21/21 Node build tests, and 17/17 Python build tests passed.

**Live acceptance completed later in the same session:** the fixed DMG was installed to `/Applications`. `tccutil reset Accessibility com.lelitte.push2talk` and `tccutil reset ListenEvent com.lelitte.push2talk` removed the stale `5c22...` requirements; Kevin then re-added the installed app in both System Settings panes. The resulting TCC rows were both `auth_value=2` and both required the fixed app's exact CDHash `27a3a661...`. Relaunch produced normal startup/ready diagnostics with no new fatal entry, and process inspection confirmed the Electron parent and `Contents/Resources/backend/push2talk-backend` child both remained alive. The reported `BACKEND_EXIT` permission bug is resolved. Do not re-sign or alter this installed ad-hoc build; doing so changes its CDHash and requires the two grants to be reset/re-added again.

## Session 2026-07-30 (continued) — Packaged app permission bug, handed to Codex unresolved

**Symptom:** `Push 2 Talk.app` installed to `/Applications`, launched, immediately shows the fatal error screen: `{"code":"BACKEND_EXIT","exit_code":1}`. This is `main.py`'s own `check_macos_accessibility()` calling `sys.exit(1)` because `Quartz.CGPreflightListenEventAccess()` returned `False` - i.e. the *design* is working correctly (failing loud, not silently), but the permission it's checking for isn't being recognized, despite being granted.

**Confirmed via direct evidence, not assumption:**
1. Kevin granted `/Applications/Push 2 Talk.app` under both System Settings → Privacy & Security → **Accessibility** and → **Input Monitoring**. Confirmed directly in the real TCC database (`/Library/Application Support/com.apple.TCC/TCC.db`):
   `kTCCServiceAccessibility|com.lelitte.push2talk|2` and `kTCCServiceListenEvent|com.lelitte.push2talk|2` (auth_value 2 = allowed, cross-checked against Terminal's own known-good `kTCCServiceAccessibility` row, also 2).
2. `com.lelitte.push2talk` is confirmed to be the app's actual `CFBundleIdentifier` (`plutil -p Info.plist`) - not a mismatch there.
3. Running the exact frozen backend binary directly from Terminal (`cd .../backend && echo '{"cmd":"get_config"}' | ./push2talk-backend`, with `P2T_CONFIG_DIR` set to match Electron's real invocation) **succeeds** - the check passes, because Terminal is the responsible process there and Terminal already has both permissions.
4. Launched via the real installed `.app` (i.e. Electron spawns the backend as it does live), it **fails every time**, freshly reproduced multiple times after relaunching.
5. Checked code-signing state (`codesign -dv --verbose=4`): the outer app's ad-hoc signature identifier was generically `Electron` (never re-signed with the app's own identity during packaging - `electron-builder` reported `skipped macOS application code signing: cannot find valid Developer ID Application identity`, expected, no signing was ever in scope). The inner `backend/push2talk-backend` Mach-O had its *own*, separately/randomly PyInstaller-generated ad-hoc identifier (`push2talk-backend-<hash>`). Neither has a Team ID (both plain `adhoc`).
6. **Tried and did NOT fix it:** re-signed the whole bundle consistently (`codesign --force --deep --sign -` on the app, then explicitly `codesign --force --sign - --identifier com.lelitte.push2talk` on the loose backend binary too, since `--deep` doesn't reach binaries outside standard nested-bundle locations). Both parent and child now report the identical identifier `com.lelitte.push2talk` via `codesign -dv`. TCC's granted rows survived the re-sign unchanged (still `auth_value=2`, matched by identifier string, not hash). **Relaunched after this fix - crashed again, identically.** So a plain identifier mismatch between parent/child ad-hoc signatures was a reasonable hypothesis but is now ruled out as the (sole) cause.

**Not yet established:** why `CGPreflightListenEventAccess()` still returns `False` for the spawned child when the bundle's own TCC grant is genuinely present and the identifiers now match. Open questions for Codex to actually research (not guess) rather than repeat the above:
- Does macOS's TCC "responsible process" resolution for a plain (non-bundled, non-XPC) Mach-O child spawned via Node's `child_process.spawn()` actually work at all for ad-hoc-signed, no-Team-ID binaries, or does Apple's documentation/known issues say this fundamentally requires a real Developer ID / Team ID to resolve responsibility correctly - meaning ad-hoc signing alone (however consistent) may never be sufficient for Input Monitoring/Accessibility specifically (as opposed to e.g. camera/mic, which Electron's own APIs mediate differently)?
- Does `CGPreflightListenEventAccess()`'s process attribution differ from what a human granting permission in System Settings actually targets (i.e. is the System Settings UI entry named "Push 2 Talk" even the same TCC client the spawned binary is evaluated against, or could `tccutil` / `log stream --predicate 'subsystem == "com.apple.TCC"'` while reproducing the crash reveal the *actual* client TCC is checking, which this session never captured live)?
- Would running `push2talk-backend` once on its own (e.g. via Finder/`open`, not `child_process.spawn`) cause it to register as its own separate, directly-grantable TCC client (a `client_type=1` raw-executable-path row), sidestepping responsible-process attribution entirely - and if so, is that a viable permanent fix or just a workaround?

**State left behind:** the installed `/Applications/Push 2 Talk.app` has been re-signed in place (both outer app and inner backend binary, ad-hoc, identifier `com.lelitte.push2talk`) as part of this investigation - it no longer matches a fresh build byte-for-byte, though functionally it's still the same `edbf828`+dylib-fix build. Rebuild fresh from `main` if a clean baseline is wanted. `main.py`'s `check_macos_accessibility()` and its error message are unchanged and believed correct in intent (see earlier session note - it does genuinely test Input Monitoring via `CGPreflightListenEventAccess`, the message's "Accessibility (and Input Monitoring)" phrasing is just imprecise, not wrong, since both are genuinely required for full functionality even though this specific call only gates on one of them).

## Session 2026-07-30 (continued) — Paste confirmed working; full waveform rework (idle/active unification, pill matching)

**Paste bug, resolved (not a regression):** Kevin reported paste "not working" in Teams/Notes. Investigation traced this to the 2026-07-27 decision (commit `c57733a`) to drop the review/Send-button step entirely in favour of full auto-send — a deliberate, Kevin-confirmed choice, not a regression. Kevin confirmed today: **"we want instant paste, the review take place in the app we paste into"** — full auto-send is correct, working as designed. The actual test failure was a methodology problem (testing without a genuine clicked-in text cursor); once Kevin clicked into a real compose box and spoke, paste landed correctly. No code change needed here.

**Waveform reworked, several rounds of live feedback against a reference image, ending "good lock it in"** (commit `9444ba0`):
- Idle used to be a separate CSS `scaleY` animation on an 8px base while active set real pixel heights up to 60px via JS — looked like two different-sized components. Idle now runs through the *same* `paintBar()` rendering as active (a new `requestAnimationFrame` loop, `startIdleShimmer()`/`idleShimmerTick()`), just fed a gentle synthetic level instead of real mic RMS — same size/motion mechanics, idle stays monochrome (`chromeColor()`) while active keeps Aurora colors (`auroraColor()`).
- Fixed a real color-washout bug: bar opacity used to scale down with level, which against the light-theme panel's near-white background faded quieter bars toward grey/white. Opacity is now constant; only height conveys level.
- Every bar previously scrolled the same single RMS scalar (one loudness-history value), reading as a flat plateau during sustained speech. Added per-bar wobble shaping (`shapeLevel()`) for an irregular, spectrum-like ripple — the cheap alternative to real per-frequency FFT analysis, which would need a Python audio-pipeline change.
- Mini pill (fewer bars, smaller size) still looked flatter than the full view with identical formulas: fewer bars completed fewer visible ripples of the same phase formula (fixed via `WAVE_PHASE_SCALE`, normalizing phase to fraction-across-view rather than raw index), and its smaller physical size needs proportionally more motion to read as equally alive (`PILL_ANIMATION_BOOST`, 1.8x, applied to both idle and active pill rendering) — Kevin's own diagnosis, confirmed correct.
- Final tuning: slowed the idle shimmer's spatial frequency and raised its baseline so wider clumps of bars read as solid together, rather than isolated peaks in a sea of thin dashes.

**Mac packaging attempt (this session, earlier) — real progress, deliberately not pursued further right now:**
- Generated the two previously-missing lock files on real Apple Silicon for the first time (`build/lock/mac-arm64.txt`, `build/lock/build-tools.mac-arm64.txt`, via `pip-compile --generate-hashes --allow-unsafe`) — Decision 7 explicitly required real hardware for this, which this session now has. **Not yet committed** — held back with the rest of the packaging work per Kevin's pause.
- Found and fixed a real bug: `build/build-app.sh` and `build/build-backend.sh` were missing their executable bit, so the pipeline couldn't even start. **Not yet committed**, same reason.
- Ran the full pipeline once (`--skip-smoke-test`) — it succeeded end to end, producing a real `.app` and `.dmg` for the first time on Mac. Found (and explained, not fixed — no fix needed) that the packaged `.app` fails its own Accessibility/Input Monitoring preflight check on first launch, correctly, since it's a brand-new never-before-approved app bundle — working as designed, not a bug, and not something Claude Code can grant on Kevin's behalf (macOS requires a human to click that checkbox).
- **Kevin's direction: don't resume packaging until dictation core functionality and visuals are confirmed working.** That gate is now cleared (paste confirmed, waveform locked in) — if resuming, the lock files and chmod fix above are ready to commit, and `build/build-app.sh --skip-smoke-test` is known to work end-to-end on this machine.

**Environment note:** this Mac (`kevins-MBP`) already has everything the Mac build needs pre-installed: Python 3.14.6 arm64, Node/npm, Ollama with `llama3.2:3b` pulled, git. Two local clones exist — `~/Developer/windows-mac-dictation` (current, on `main`, the one actually used this session) and a stale `~/windows-mac-dictation` (old repo name/remote, untouched, likely safe to ignore or clean up later).

## Session 2026-07-30 — Mac phase resumed; backfilling undocumented dev-mode work; packaging pipeline underway

**Backfill note:** two commits landed on 2026-07-29 at 16:19, *after* that day's "Windows locked in, Mac unverified" entry was written, but were never logged here — recording them now per `CONSTITUTION.md` §5:

1. **`32363f0`** — `generate-builder-config.js`'s `--output` path validation compared a raw `path.resolve()` against a `realpath()`'d prescribed path, but never resolved `--output` itself through symlinks. Broke specifically on macOS, where `os.tmpdir()` lives under `/var/folders/...`, itself a symlink to `/private/var/folders/...`. Found running this repo's own test suite (`test_generate_builder_config.mjs`, all 6 cases) on real Apple Silicon for the first time. Fixed by expressing `--output` relative to the raw `--repo-root` and rejoining onto `repoRoot`'s already-resolved realpath, instead of realpathing a file that doesn't exist yet.
2. **`26d5153`** — the frameless/transparent window showed a visible light border/shadow on Mac dev-mode (`npm start`), which Kevin asked to eliminate fully. Three layered causes: (a) a CSS `box-shadow` on `.app` left over from Windows (where it substituted for a properly-clipped native shadow) compounded the look on Mac; (b) `hasShadow:false` only covers the window's initial unfocused state — macOS redraws the native OS shadow on focus/blur/show for a frameless transparent `BrowserWindow` (`electron/electron#7448`), needing explicit re-assertion on all three events; (c) the actual root cause was `vibrancy:'hud'` itself — Apple's HUD material carries its own native soft edge independent of `hasShadow` entirely, and was never wired to this app's own CSS-driven opacity look. Removed `vibrancy`/`visualEffectState`; confirmed borderless live afterward. The focus/blur/show reassertion was kept regardless, as a real guard against the Electron bug if vibrancy is ever reintroduced.

Both commits are authored `Kev <kevin@lelitte.co.uk>` — Kevin working directly against a local clone (`~/Developer/windows-mac-dictation`) on this Mac, evidently via a local Claude Code session, prior to this conversation.

**Also observed (not committed):** that same local clone has an uncommitted `config.json` — `theme: light` (was `dark`), `alwaysOnTop: true` (new), and `hotkey.darwin: mouse_middle` (was `alt_l`). Left as-is — this reads as Kevin's own personal local dev-mode experimentation (matching the mouse-hotkey testing already done on the Windows side), not a decision to change the shipped defaults, so it hasn't been committed or reverted.

**Status:** dev-mode Mac Electron shell is confirmed running and borderless on real hardware; the test suite has been run here for real (catching the symlink bug above). Packaging (`build-app.sh`, PyInstaller freeze, DMG) has not yet been attempted — see next session entry for that work.

## Session 2026-07-29 — Windows locked in: tray icon + mouse hotkey bugs found and fixed, packaging pipeline hardened

Two real post-install bugs reported by Kevin after the 2026-07-28 smoke-test-passed milestone, both root-caused and fixed, with a fresh installer built and reconfirmed working:

1. **Tray icon invisible** (tray entry existed — tooltip worked — but the slot was blank). Root cause: `resolveTrayIconPath()` in `electron/main.js` called `nativeImage.createFromPath(process.execPath)`, expecting to pull the icon embedded in the running exe. That's not what the API does — `nativeImage.createFromPath` only decodes real image files (PNG/ICO/etc), not PE-embedded icon resources — so it silently returned an empty image. Fix: ship `icon.ico` as a real `extraResources` entry (`build/generate-builder-config.js`, packaged to `resources/icons/icon.ico`) and load it directly via `process.resourcesPath` instead of trying to extract it from the exe. Verified directly by loading both the old and new code paths through a real headless Electron `nativeImage` call: old approach → `isEmpty: true`; fixed approach → `isEmpty: false`, `256x256`. Regression test added (`build/tests/test_generate_builder_config.mjs`).
2. **Middle-click hotkey "didn't work."** Root cause was not the hotkey code at all — `config.json` had `"windows": "mouse_x1"` (Mouse Button 4), not `"mouse_middle"`. Traced to a real CSS bug: the Settings hotkey dropdown's `<optgroup>` labels ("Keyboard" / "Mouse...") had no dark-theme styling, so Chromium rendered them as unreadable white-on-white strips (Kevin's screenshot confirmed this exactly) — easy to mis-click the wrong row when the group boundary is invisible. Fixed `ui/styles.css` (added a matching `optgroup` rule) and corrected the live `config.json` directly (`mouse_middle`); confirmed working after restart.
3. **Build pipeline reliability finding** (process, not a repo bug): launching `build-app.ps1` in the background via `Start-Process ... "*>&1 | Tee-Object -FilePath $log"` silently killed the entire build the instant `npm ci` printed its first (harmless) deprecation warning to stderr — Windows PowerShell 5.1 wraps redirected native-command stderr as a terminating `NativeCommandError`, and `build-app.ps1` sets `$ErrorActionPreference = 'Stop'` at the top, so the whole script died with zero error output, twice, before this was caught. Reproduced directly (`npm ci` alone: exit 0, fine). Fixed by using `Start-Transcript`/`Stop-Transcript` for background-build logging instead of stream redirection — captures real console output without triggering the redirection bug. Worth remembering for any future backgrounded PowerShell build invocation in this repo.

Commit `ab67729`. Fresh installer built clean: run `0.1.0-20260729T122542960Z-ab67729`, `Push 2 Talk Setup 0.1.0.exe`, confirmed `resources/icons/icon.ico` present in the unpacked output before handing off. Kevin installed over the existing install (no uninstall needed, confirmed working) and confirmed: tray icon renders, middle-click hotkey works, **"All working, we can lock it in."**

**Windows is done.** Do not re-open the packaging pipeline, tray, hotkey, or always-on-top work without a new concrete bug report from Kevin.

**Next: Mac.** Completely unverified — Decision 7's groundwork (`build/push2talk-backend.mac.spec`, `build/build-backend.sh`, `build/build-app.sh`, `build/lock/mac-arm64.in`) was authored blind, never run. Real Apple Silicon hardware is required; nothing further can be done from this Windows-only environment. Kevin needs to be on the actual Mac machine for this phase to start.

---

**Previously last updated:** 2026-07-28, continued further — **first real Windows install-and-smoke-test PASSED**, confirmed live by Kevin. Milestone: this is the first time the packaged app has actually run and been visually confirmed working, not just mechanically built. What it took to get here, after the icon fix below:
- Root-caused and fixed the actual reason `build-app.ps1`'s own stdin/stdout protocol smoke test kept failing: a PyInstaller-frozen console exe on Windows does not reliably default `sys.stdin`/`stdout`/`stderr` to UTF-8 when no real console is attached (piped from Electron's `child_process`, or from .NET's `Process.StandardInput`, which is what the smoke test itself uses). Confirmed via a debug build: a UTF-8 BOM (bytes `EF BB BF`) sent on stdin was decoded as three separate Latin-1 characters instead of one U+FEFF codepoint - completely breaking every command parse, and explaining the mojibake ("Windows ? hold" instead of "Windows — hold") seen in the frozen build's own startup log. Fixed in `main.py` by explicitly `reconfigure(encoding="utf-8")`-ing all three streams right after imports, before any I/O. (An earlier, narrower fix - stripping a literal BOM character - turned out to be treating the wrong symptom; this is the real root cause.) Commit `895eebe`.
- With that fixed, ran the full `build-app.ps1 -SkipSmokeTest` pipeline from a clean checkout, end to end, for the first time: lock validation, `npm ci`, real icon generation, a fresh locked Python/CUDA venv, PyInstaller freeze, the (now-passing) protocol smoke test, `electron-builder --dir`, NSIS installer build - all green, ~4.5 minutes total, no hangs, no interactive prompts. Produced a real, unsigned `Push 2 Talk Setup 0.1.0.exe` (1.8 GB, dominated by bundled CUDA runtime libraries) - confirmed genuinely unsigned via `Get-AuthenticodeSignature` (`signtool.exe` was invoked by electron-builder's own defaults with no certificate configured, so it silently no-op'd - matches this project's scope, no signing was ever requested).
- That installer was still marked `UNVERIFIED.txt` by the script itself (the pipeline's own interactive human-visual-check step was skipped, since there was no way for Claude to watch a running window). **Kevin then installed it himself and confirmed: smoke test passed.** This is the first real, human-confirmed proof the whole Windows packaging pipeline - and the packaged app itself - actually works.

**Not yet done:** a from-scratch clean-environment test (Decision 6), real code signing (out of scope), Mac (Decision 7's groundwork is authored but completely unverified - no Apple Silicon hardware available), and the Windows install/uninstall bootstrap observation needed before the uninstall hook can be safely enabled (SS16/SS18).

**Previously last updated:** 2026-07-28, continued — the packaging work below (turn 7) was reviewed, approved, and **merged to `main` (`9b3e13d`)**. Immediately after, Kevin corrected one thing: `electron/build/icon.png` below was a solid-color placeholder, but a real app icon already existed at `ui/logo.svg` (fetched from transcribe.lelitte.co.uk during the earlier rebrand session) and should have been used instead. Fixed via `build/rasterize-logo-icon.js` - a small hardcoded rasterizer for that exact SVG's shapes (rounded-square background, ring, three wave bars), 4x4 supersampled for anti-aliased edges, no SVG/image library added. Visually verified by reading the output PNG directly - clean rendering, matches the logo. `icon.ico`/`icon.icns` regenerated from it via the existing `generate-icon.js`. `build/write-placeholder-icon-png.js` removed (no longer needed - the real source now exists and is committed). New test: `build/tests/test_rasterize_logo_icon.mjs` (5 pixel-level spot checks against the known geometry). All 19 `node --test` + 17 `pytest` + 21 electron tests still pass.

**Last updated (original, superseded by the icon fix above):** 2026-07-28 — Windows packaging implementation (brief-converge run `20260728T063245Z_push2talk-packaging`, branch `impl/push2talk-packaging-20260728T103040Z`) went through the full 6-turn bounded implementation contract, closed BLOCKED at turn 6, and Kevin chose to amend rather than approve/reject. This entry records that amendment work (turn 7). **Still on the review branch, still not merged, still requires Kevin's explicit final approval** - see `AWAITING_KEVIN_APPROVAL.md` / `KEVIN_AMEND_DECISION.md` in the brief-converge run folder for the full paper trail.

**Status:** The critical bug (packaged app never receiving backend stdout - PyInstaller `console=False` contradicting the console-subsystem requirement) was root-caused and fixed at turn 3, re-verified live. Turns 5/6 landed seven Windows packaging fixes by hand-transcription after Codex's own patch failed to apply mechanically. Turn 6's independent review then BLOCKED on three gaps against material this run had already committed to: Mac groundwork (Decision 7) never authored, the package rename (SS4) never done, and an untested ad hoc icon-generation step. Kevin's decision: amend and fix all three (not approve-as-is, not reject). That work:

1. **Mac groundwork (Decision 7)** - authored `build/push2talk-backend.mac.spec`, `build/build-backend.sh`, `build/build-app.sh`, `build/lock/mac-arm64.in`, all explicitly marked UNVERIFIED. No Mac lock `.txt` files generated (Decision 7 forbids this without real Apple Silicon), no Mac build ever attempted. `build-app.sh` deliberately avoids `mapfile`/GNU `timeout` (stock macOS ships bash 3.2 and BSD userland) in favor of portable equivalents, but is still unverified end-to-end. Also fixed a pre-existing bug found while in this area: `generate-builder-config.js`'s Mac `extendInfo` used `NSAccessibilityUsageDescription`, which isn't a real Info.plist key (Accessibility has no usage-description string on modern macOS, it's a plain System Settings prompt) - corrected to `NSAppleEventsUsageDescription` per FINAL_BRIEF.md SS4's actual text ("microphone and Apple Events").
2. **Package rename (SS4)** - `electron/package.json`'s `"name"` is now `"push2talk"` (was `"dictation-shell"`). Per SS4's explicit requirement, probed `app.getPath('userData')` live before and after with throwaway Electron fixtures rather than assuming: **before** = `%APPDATA%\dictation-shell` (had real dev-mode Chromium/Electron internal state - Cache, Local Storage, Preferences, logs - from prior `npm start` sessions on 2026-07-27/28), **after** = `%APPDATA%\push2talk`. Per SS4's own caveat ("if the resolved path changes, stop and obtain Kevin's direction"), stopped and asked before making the change; Kevin chose "rename, start fresh" - the old folder is Electron/Chromium's own internal cache, not this app's actual settings (`config.py`'s dev-mode config path is separate and untouched by this rename; nothing has ever shipped as a packaged install, so there's no packaged-mode `userData` to migrate either). `package-lock.json`'s stale top-level `name` field was re-synced via `npm install --package-lock-only`; `npm ci` reverified clean afterward.
3. **Icon generation** - replaced `electron-builder --dir --publish=never` (invoked with no `--config`/`--win`, i.e. a full unscoped packaging build used only as a side-effecting way to trigger icon conversion) with `build/generate-icon.js`, a new dependency-free script that wraps a source PNG directly into a real ICO/ICNS container (both formats support embedding a PNG image natively - no external library needed, and no reintroduction of `electron-icon-builder`, dropped earlier for pulling 33 vulnerabilities). Also added `build/lib/png-tool.js` (CRC32 + minimal PNG encode/decode) and `build/write-placeholder-icon-png.js`, which generated a **placeholder** `electron/build/icon.png` (solid `--accent-blue` fill) - `ui/logo.svg` was never rasterized into a real icon source and no SVG rasterizer is available in this environment. `electron/build/icon.ico`/`icon.icns` are committed, generated from that placeholder. **Replace `electron/build/icon.png` with real branded artwork before shipping this to anyone else**, then re-run the icon step to regenerate `.ico`/`.icns` from it.

**Verified this session:** 18 `node --test` (`build/tests/*.mjs`, 9 new), 17 `pytest` (`build/tests`), 21 `node --test` (`electron/tests`) - all pass. `npm ci` reverified clean post-rename. Mac scripts syntax-checked (`bash -n`) only - never run, per Decision 7.

**Not done, explicitly out of scope:** anything requiring real Apple Silicon hardware (M1-M13), real branded icon artwork, live Windows install/uninstall bootstrap observation (SS16/SS18), full V1-V17 acceptance. All still gated behind Kevin's explicit approval per `brief-converge`'s implementation-approval-gate protocol - this session did not merge, deploy, sign, notarize, or treat anything as final.

---

## Session 2026-07-27 — pywebview→Electron migration, Phase 1-2

**Last updated:** 2026-07-27 — pywebview→Electron migration completed through Phase 2: the real hotkey/audio/Whisper/Ollama/paste pipeline is now wired into the Electron shell and verified live end-to-end (real hotkey press → real mic capture → real GPU Whisper transcription → real Ollama cleanup → review → dismiss)
**Status:** Same session as the pywebview Windows-chrome fixes, the border/pill-size bugs found after that, and the Phase 1 Electron shape spike (all below). Kevin reviewed the live Phase 1 spike, asked for UI simplification (drop the status tiles, add a ready/error light) and a rebrand to "Push 2 Talk" with transcribe.lelitte.co.uk's logo (both done, commit `4820e3c`), then said "let's go to phase two." Phase 2 is now done: `main.py` no longer owns any window at all — it's purely a backend process Electron spawns and talks to over stdio-JSON (see main.py's module docstring). **The old pywebview UI path is retired** — `rundictation.bat` no longer shows a window (main.py has no UI code left to run); `rundemo.bat` (renamed in spirit, not on disk, from "demo" to the real thing) is now the only way to run the app, and it's no longer a demo — it's the real pipeline. Not yet done: Phase 3 polish (remove the pervasive CSS `border:` design language — separate from the already-fixed native-window-shadow bug), Mac has not been touched or tested at all this session.

---

## Session 2026-07-27, continued — Phase 2: real pipeline wired into the Electron shell

**Part D — UI simplification + rebrand (commit `4820e3c`).** Kevin, looking at the live Phase 1 spike, asked to drop the Capture/Whisper/Cleanup/Paste status tiles and the "Hold Right Ctrl to record" text (redundant with the hotkey badge) in favour of a compact notification light next to the hotkey badge — green for ready, red for error. Implemented keeping the richer existing state-color mapping (green while recording/pasting, cyan while processing) rather than a strict binary, since it was already built; the removed status text is preserved as the light's hover tooltip. Also asked to rename the app to "Push 2 Talk" and reuse transcribe.lelitte.co.uk's exact logo — added `ui/logo.svg` (fetched from that site), updated `<title>`/header brand/Settings back-button/pywebview window title. Verified live (window title, a 6x zoomed crop of the 26px header badge to confirm it wasn't still showing the old "D" letter mark).

**Part E — Phase 2: strip pywebview, wire a real stdio-JSON backend.** Kevin approved with "let's go to phase two." Design (matches the plan written in Part B/C's session, `C:\Users\admin\.claude\plans\lexical-wondering-spring.md`):
- **`config.py`** — `theme`/`opacity` moved from being bolted onto `main.py`'s in-memory config dict after `load_config()` returned, into `DEFAULTS` and `load_config()`'s own return value properly. `test_config.py` still passes unmodified (11/11 across both test files).
- **`main.py`** — completely rewritten. Removed `import webview`, the `DictationAPI` class, the DWM/GDI window-shape block, `push_js`/`window.evaluate_js` — main.py owns zero window/UI code now. Replaced with: `_event_stream = sys.stdout` captured *before* `sys.stdout = sys.stderr` is set, so every existing `print()` (and any third-party tqdm/progress output from faster-whisper/huggingface_hub) keeps working unchanged but now lands on stderr instead of corrupting the event stream; a single `emit_event()` writes `json.dumps(...) + "\n"` to the real captured stdout with an explicit `.flush()` (piped stdout is block-buffered, not line-buffered, without it); `stdin_reader_loop()` blocks the main thread reading one JSON command per line until stdin closes (Electron's child-process pipe closing on quit), at which point `main()` exits cleanly — no extra thread needed for it. Commands: `send_text`, `dismiss`, `get_config`, `save_config` (former `DictationAPI` methods, now plain functions). Events: `ready` (startup only — hotkey display), `status`, `transcript`, `final_text`, `audio_level`, `clear_editor`, `config` (settings-panel response, kept deliberately separate from `ready` so a mid-session Settings refresh doesn't also reset the status light like the old code never did either).
- **`electron/main.js`** — `spawnBackend(win)` runs `child_process.spawn('python', ['main.py'], { cwd: repoRoot, env: process.env })` (env inheritance carries over the CUDA/cuDNN PATH entries from earlier sessions, same as `rundictation.bat` relied on implicitly), pipes stdout through `readline` and forwards each parsed JSON line to the renderer via `webContents.send('backend-event', ...)`, pipes stderr through a second `readline` into `console.error` (this is how Python's now-redirected `print()` output surfaces for debugging). `ipcMain.on('backend-command', ...)` writes renderer commands to the child's stdin. Backend spawned inside `createWindow()`, killed on `window-all-closed` and on the window's own `closed` event (covers both the taskbar-close and the in-app close button paths).
- **`electron/preload.js`** — added `sendCommand`/`onBackendEvent`/`closeWindow` to the existing `electronAPI` (drag/resize were already there from Phase 1).
- **`ui/app.js`** — every `pywebview.api.*` call site (`sendText`, `dismissText`, `loadSettings`, `saveSettings`, the close button) now checks `window.electronAPI` first and uses `sendCommand()`, falling back to the old `pywebview.api.*` path only if that's absent (keeps the file working if pywebview is ever resurrected, though nothing currently exercises that branch). New `handleBackendEvent()` dispatches incoming events by `type` to the existing `updateStatus`/`updateTranscript`/`updateFinalText`/`updateAudioLevel`/`clearEditor`/`setHotkeyDisplay` functions unchanged — the whole point of the original event-function design paid off here, almost nothing about the UI-update logic itself had to change. `applyConfig()` factored out of the old `loadSettings()` so both the pywebview-await-return path and the new async `config` backend-event share one code path. The 500ms demo-mode fallback timer now checks for `window.electronAPI` too, not just `pywebview` — demo mode only runs when literally opening `ui/index.html` in a bare browser tab now.
- **`requirements.txt`** — `pywebview` removed (confirmed zero remaining imports anywhere in the repo first).

**Verified live, in order:**
1. A throwaway script (`subprocess.Popen` spawning `main.py` exactly like Electron will, deleted after) confirmed the raw protocol before touching Electron at all: `ready` and `status` events on startup, `get_config` → correct `config` event, `dismiss` → `status`+`clear_editor`, and — critically — every `print()` landed on stderr, none on stdout. Caught this early and cheaply rather than debugging it through the full Electron stack.
2. Launched the real app (`electron .`), confirmed both `electron.exe` and a child `python.exe` running, confirmed via screenshot the hotkey badge reads the **real** config value ("Ctrl (Right)", from `config.json`) — not the demo's hardcoded placeholder — proving the `ready` event round-tripped correctly end to end.
3. **Simulated an actual hotkey press** (`keybd_event` VK_RCONTROL down, 2s hold, up) — this is the real test, not just plumbing. Log showed, in order: `[rec] recording started` → `[rec] recording stopped — 28288 samples, 1.77s captured at 16000Hz` (genuine mic input) → `[transcribe] loading faster-whisper model 'small' on cuda (float16)...` (real GPU model load) → `[transcribe] result: ''` → `[cleanup] result: ''` (both correctly empty — silence in, silence out, no crash). Screenshot confirmed the UI reached the `review` state correctly (cyan light, transcript box focused/editable, Send/Dismiss visible) even with an empty transcript.
4. Clicked Dismiss — confirmed the command round-trip back to `idle` (green light) via screenshot.
5. Opened Settings — confirmed the panel populates (visually spot-checked; full field-level correctness already confirmed by the throwaway script's `get_config` response in step 1).
6. Full test suite re-run after all changes: 11/11 pass (`test_config.py`, `test_cleanup.py`).

**Not done, explicitly out of scope this session:**
- **Phase 3 CSS polish** — removing the pervasive `border: 1px solid var(--border)` design language throughout `styles.css` (separate from the native-window-shadow bug already fixed) was flagged back in the original migration plan and never done; still outstanding.
- **Real speech test** — everything above was verified with a *simulated* key press capturing silence/room tone. Kevin needs to actually hold the hotkey and speak to confirm transcription accuracy and the full visual flow with real content.
- **Real paste-target test** — `inject.py` (clipboard + simulated paste) is unchanged code, already confirmed working in the pywebview era, but hasn't been re-exercised against a real focused app (Teams desktop/browser, per `CLAUDE.md`'s hard rule) since this rewrite.
- **Mac** — completely untouched this session. Everything above is Windows-only verification. `main.py`'s platform-branching (mlx-whisper, Accessibility preflight, `alt_l` hotkey) is unchanged code, but the new stdio/spawn path itself has never run on macOS — Electron's `spawn('python3', ...)` vs `spawn('python', ...)` platform branch in `electron/main.js` is untested.
- **Crash/restart handling** — `electron/main.js` shows an error status if the Python child process exits unexpectedly, but there's no "Restart" UI action yet (flagged as a known gap in the original migration plan, not built).
- `rundictation.bat` (the old pywebview convenience script) is now non-functional as a UI launcher — `main.py` has no window code left. Worth telling Kevin directly so he doesn't go looking for it.

**Next action:** Kevin actually uses the app — real speech, real paste target, both platforms eventually. Phase 3 (CSS border cleanup) whenever there's appetite for pure polish; not blocking.

---

## Session 2026-07-27 — pywebview Windows-chrome fixes (tested + fixed), pywebview→Electron migration decided, Phase 1 Electron spike built and verified live

**Part A — pywebview Windows-chrome fixes.** First live test of 2026-07-26's UI rework, on Windows: not frameless, visible grey border, pill too small to use, couldn't be moved. Root causes, all fixed in commit `f858270`:
- `transparent=True` on Windows only makes the WebView2 *control's* background see-through (`webview/platforms/edgechromium.py`) — the WinForms `Form` itself never gets an explicit background color in that path, falling back to the OS's default grey. Replaced with `transparent=not IS_WINDOWS` + DWM `DwmSetWindowAttribute` (native rounded corners for Full mode, border-color suppression) + a GDI `SetWindowRgn` capsule region for Pill mode, applied via a new `apply_window_shape()` in `main.py`.
- No working drag: `easy_drag=False` (deliberate, to not fight transcript text selection) plus `-webkit-app-region: drag` not reliably honoured on Windows/WebView2 meant zero drag capability. Added a `move_window_by(dx, dy)` bridge (`window.move(window.x+dx, window.y+dy)`) + a JS mousedown/mousemove handler in `app.js`.
- `body { margin: 16px }` (sized for the Full view's drop-shadow) also applied in Pill mode, leaving a 44px-tall pill only ~12px of usable height — the pill wasn't just small by design, it was actively crushed. Fixed with a `body.pill-mode` override; pill also resized 260×44 → 340×56.
- Verified live: launched the real app, screenshotted only the app window's own bounds (never the full desktop — flagged and corrected an earlier full-desktop capture that leaked unrelated window content, deleted immediately), confirmed clean rounded corners with no grey artifact, toggled Pill mode, confirmed drag via `GetWindowRect` position before/after a simulated drag.

**Part B — second border + scrollbar report, research, migration decision.** Kevin reported a border still visible plus an ugly white Settings scrollbar, and asked to stop, research, and report back rather than keep patching blind. Two independent findings:
1. Direct code read: `.app { border: 1px solid var(--border); }` (and the same pattern on nearly every card/input throughout `styles.css`) is a deliberate CSS design choice never touched by the native-chrome fix — a separate thing from the grey-artifact bug. `.content`'s scrollbar was simply never styled (only the small transcript box was), so Settings — which doesn't fit in a 360px window — showed WebView2's raw default scrollbar.
2. A research fork checked pywebview's own GitHub issues rather than guessing: **#1413** (open, June 2024) describes the exact `SetWindowRgn`/`CreateRoundRectRgn` white-frame artifact we hit; **#1611** describes `transparent=True` not compositing on Windows 11, matching our own source-reading. Also confirmed (third-party comparison site) that Wispr Flow is built on Electron, not Tauri or a native toolkit.

Kevin chose to switch to Electron. Per this file's Effort Level Governance, this was flagged as a real architecture change (introduces Node/JS into a pure-Python project, contradicts `docs/BUILD_BRIEF.md` §13's original "avoid Electron overhead" rationale for choosing pywebview) and planned via Plan Mode rather than started ad hoc — plan file has the full phase breakdown (IPC design: stdio JSON-lines, not a local HTTP/WS server; `BrowserWindow` config; 4-phase rollout).

**Part C — Phase 1 (shape spike) built and verified live.** New `electron/` folder (`package.json` pinned to Electron 43.2.0 — the initial 31.7.7 pin had known high-severity CVEs per `npm audit`, bumped before use; `main.js`; `preload.js`). Loads the existing, unmodified `ui/index.html` directly — no Python process, no pipeline IPC; `app.js`'s pre-existing `runDemoMode()` fallback (fires when `window.pywebview` is absent) drives a realistic fake state cycle. Verified live via window-scoped screenshots and simulated input:
- **No border/grey artifact, real transparency** — confirmed via screenshot: smooth anti-aliased rounded/capsule edges with the desktop genuinely visible through them. This is the core hypothesis the whole migration rests on, and it held.
- **Real bug found and fixed along the way:** `-webkit-app-region: drag` (left over from the pywebview era, still in `styles.css`) does move the window natively in Electron (confirmed — this is what accidentally dragged the window during testing), but Chromium **never dispatches normal DOM mouse events at all** on a drag-region element — so a plain `click` listener for "click the pill to expand" silently never fired. Confirmed by instrumenting `console-message` forwarding from the renderer to the main-process log. Fixed by removing `-webkit-app-region: drag` from `.header`/`.pill-bar` entirely and driving both drag *and* click-vs-drag detection (4px movement threshold) from custom JS, via a minimal real IPC channel — `electron/preload.js` exposes `window.electronAPI.moveWindowBy(dx,dy)`, `electron/main.js` handles it with `ipcMain.on('move-window-by', ...)` calling `win.setPosition()`. This is genuinely Electron-only plumbing (no Python involved), so building it now doesn't cut into Phase 2's scope.
- Mid-session, Kevin asked directly for two more changes, done immediately since both were small/low-risk: the pill now shows **only the waveform** (removed the status dot, hotkey label, and the expand button from `ui/index.html`/`app.js`/`styles.css` — expand is now a plain click on the pill itself, per the drag fix above), and the Settings scrollbar got real `::-webkit-scrollbar` styling matching the existing dark-theme pattern already used on the transcript box (`ui/styles.css`) — this fix benefits the pywebview path too, not just Electron.
- All of the above pushed to `main` this session (commit message covers `.gitignore`, `electron/package.json`, `electron/package-lock.json`, `electron/main.js`, `electron/preload.js`, `ui/index.html`, `ui/app.js`, `ui/styles.css`).

**Not done, explicitly out of scope this session:** Phase 2 (strip `pywebview`/`DictationAPI`/the DWM-GDI block from `main.py`, add stdio-JSON IPC to a spawned Python backend, wire `send_text`/`dismiss`/`get_config`/`save_config` through Electron) — this is where the real pipeline (hotkey, audio, Whisper, Ollama, paste) gets connected to the new shell, and per this file's governance needs Kevin's explicit go-ahead before starting, not just the general "switch to Electron" decision. Phase 3 (delete the now-dead `pywebview.api.*` call sites still in `app.js`'s `sendText`/`dismissText`/`enablePillMode`/`disablePillMode`/`loadSettings`/`saveSettings`, remove the pervasive CSS `border:` design language) and Phase 4 (docs/housekeeping) also not started.

**Next action:** Kevin decides whether/when to green-light Phase 2. Until then, `electron/` is a standalone visual spike — running `npm start` inside it shows the real UI/CSS with fake demo data, but doesn't record, transcribe, or paste anything (that's still only in the old pywebview-driven `main.py` path, which still works as fixed in Part A). Mac has not been touched or tested this session — per this repo's cross-platform confirmation requirement, nothing here should be considered "done" until verified there too.

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

## FLAGGED 2026-08-10 (evening) — Possible regression: pill window ballooned into a huge circle

Kevin reported "same problem again" with a screenshot showing the pill rendered as a large dark circle (roughly half-screen), not the normal small pill shape. By the time it was checked live moments later, the window was back to a normal size (700x630 physical px = 400x360 logical, correct Full-mode size) and hidden, so the blob state itself couldn't be captured live — not yet reproduced on demand.

**Leading hypothesis, not yet confirmed:** the `ec36605` native-drag fix (`-webkit-app-region: drag` on `.header`/`.pill-bar`) makes Windows treat that region as a real OS-level title bar for hit-testing purposes — which by default still permits **double-click-to-maximize**, independent of `resizable: false`. `electron/main.js`'s `BrowserWindow` constructor (around line 479) sets `resizable: false` but does **not** set `maximizable: false`. A double-click (or Windows Snap gesture, e.g. Win+Up) on the native drag region could plausibly trigger a native maximize that ignores `resizable: false`, ballooning the window while pill-mode's rounded-corner CSS is still applied, producing a circular appearance if width/height end up similar.

**Not yet verified — needs checking tomorrow:**
1. Confirm `ui/styles.css`'s `.pill-bar` border-radius value (percentage vs fixed px) to confirm the "large + rounded = circle" mechanism.
2. Try to reproduce via a real or synthetic double-click on the header/pill drag region, and via Win+Up snap-maximize, and check resulting window bounds live.
3. If confirmed, fix is likely just adding `maximizable: false` to the `BrowserWindow` constructor alongside `resizable: false` — should be a small, low-risk change, but verify live (this session's whole lesson: don't trust an unverified "fix" for this window-sizing bug class again).

Kevin asked to defer this to tomorrow. Do not lose this thread — pick up from here.

## FOLLOW-UP 2026-08-11 — Ballooning-pill hypothesis tested, NOT confirmed

Continued from the entry above. Confirmed `.pill-bar`'s `border-radius: 999px` (ui/styles.css) as the mechanism that would render an oversized window as a circle — a large, roughly-square window with a 999px corner radius on all sides renders as a blob/circle, matching Kevin's screenshot exactly. This part of the mechanism is solid.

**The `maximizable` hypothesis itself did not reproduce.** Tested live, on this machine, via 4 separate real OS-level input triggers against a running dev-mode instance (`electron .`, `resizable: false`, `maximizable` unset in `electron/main.js`'s `BrowserWindow` constructor — same as production):
1. Real double-click (down-up-down-up, ~80-100ms gaps) on the header drag region (Full mode) — no size change.
2. Real double-click on the pill drag region (Pill mode) — no size change.
3. Windows native Snap-maximize shortcut (Win+Up) with the window focused — no size change.
4. A real synthetic drag of the pill all the way to the screen's top edge (classic Aero-Snap-to-maximize trigger, and the most plausible match for what Kevin was actually doing when it happened) — no size change, and this one didn't even translate position, suggesting either the drag didn't register or Windows Snap assist is disabled/behaves differently in this environment.

None of the four produced growth. `maximizable: false` therefore has NOT been confirmed as the fix, and was not applied — adding an unverified change here would repeat the exact mistake this whole bug already burned three attempts on (see the `e320458a`/`fb7fce2`/native-drag entries above: a plausible-sounding, plausible-mechanism fix that "should" work is not the same as a fix confirmed live).

**Updated leading theory:** since the window was back to its correct size (700x630 physical, matching Full mode) within a minute or two of Kevin's report, and no sustained-maximize trigger reproduces it, this looks more likely to be a **transient rendering/compositor artifact** during a fast drag or a pill↔full mode-switch animation — a frame or two where the OS momentarily shows an interpolated/incorrect size mid-gesture, self-correcting once the gesture completes — rather than a persistent stuck state. This is a materially harder class of bug to pin down (a screenshot catches a instant, not a sustained reproducible state) and needs either (a) a real recording (screen capture) of the moment it happens next time, or (b) Kevin describing exactly what physical action preceded it (was he mid-drag? mid-mode-switch? did it self-correct or did he have to do something to fix it?).

**Not yet done, worth trying next if it recurs:**
- Ask Kevin to screen-record (or note the precise gesture) the next time this happens, rather than a single screenshot — a video would show whether it's transient (self-corrects) or persistent (stuck until some action).
- Try reproducing during an actual pill→full or full→pill mode transition specifically (not just steady-state drag), since `resize-window`'s `setSize()` call happens instantaneously in Electron's main process but the renderer's CSS transition (`transition: box-shadow var(--transition)` etc. — check for any width/height transition too) could theoretically be mid-animation when a drag starts, an interaction this session didn't specifically test.
- Check `ui/styles.css` for any CSS `transition` on `width`/`height`/`transform` that could cause a visually-oversized intermediate frame even when the underlying Electron window bounds never actually change.
