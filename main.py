"""
Full MVP pipeline: push-to-talk hotkey + audio capture + transcription +
Ollama cleanup + clipboard paste injection. Cross-platform (Windows + macOS)
via pynput, sounddevice, transcribe.py, cleanup.py, and inject.py.

This process owns no window at all — the UI is the Electron shell in
electron/, which spawns this script as a child process and speaks to it
over stdio: one JSON object per line. Stdout carries events (state
changes, transcript updates, audio levels) out to the UI; stdin carries
commands (get_config, save_config) in from it. See electron/main.js for
the other side of this channel.

Hold the hotkey (Right Ctrl on Windows, Right Option on Mac by default),
speak, release — the cleaned-up transcript is pasted automatically the
moment it's ready, wherever the cursor was when dictation started. No
review/confirm step: there is no window to click into or button to press.
The configured hotkey can also be a mouse button (config.json's "hotkey"
value: "mouse_left"/"mouse_right"/"mouse_middle"/"mouse_x1"/"mouse_x2") -
unlike the keyboard defaults, a mouse-button hotkey is not side-effect-free:
pynput listens passively and does not suppress the button's normal OS
behavior (e.g. middle-click still autoscrolls/opens-in-new-tab wherever the
cursor is, in addition to triggering dictation).

macOS note: the hotkey listener AND the paste injection need Accessibility
permission granted to whatever runs this script (Terminal, or your Python
interpreter) under System Settings > Privacy & Security > Accessibility.
Without it, pynput silently receives no key events, and pyautogui's paste
keystroke silently does nothing.
"""

import ctypes
import enum
import json
import os
import platform
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
from pynput import keyboard, mouse

from cleanup import cleanup
from config import CONFIG_PATH, load_config
from inject import inject
from transcribe import (
    UnreliableTranscriptionError,
    has_repetition_loop,
    is_model_ready,
    transcribe,
)

# A PyInstaller-frozen console exe on Windows does not reliably default its
# stdio streams to UTF-8 when there is no real console attached (e.g. piped
# from Electron's child_process, or from .NET's Process.StandardInput as
# build-app.ps1's own smoke test does) - confirmed live: a UTF-8 BOM
# (bytes EF BB BF) arriving on stdin was decoded as three separate Latin-1
# characters ('\xef\xbb\xbf') instead of the single U+FEFF codepoint dev-mode
# `python main.py` produces for the exact same bytes, which broke every
# downstream command parse. Force real UTF-8 on all three streams explicitly
# rather than trusting the frozen build's default encoding detection.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

# Capture the real stdout before anything else touches it, then redirect
# sys.stdout to stderr — every existing print() in this file (and any
# third-party progress-bar output from faster-whisper/huggingface_hub that
# writes to sys.stdout rather than sys.stderr) keeps working unchanged, but
# now lands on stderr instead of corrupting the JSON-lines event stream.
# Only emit_event() below writes to the real stdout, deliberately.
_event_stream = sys.stdout
sys.stdout = sys.stderr

def _resolve_whisper_device(whisper_cfg):
    """Auto-downgrade a configured CUDA device to CPU when no NVIDIA GPU is
    present, so the same Windows installer works on non-GPU machines instead
    of ctranslate2 raising (or crashing outright) at model-load time. Only
    touches faster-whisper's cuda default - never overrides an explicit
    non-cuda choice, so a user who deliberately set "cpu" is unaffected.
    float16 (the packaged default's compute_type) isn't a valid CPU compute
    type for ctranslate2, so it's remapped to int8 alongside the fallback."""
    if whisper_cfg.get("backend") != "faster-whisper" or whisper_cfg.get("device") != "cuda":
        return whisper_cfg
    try:
        import ctranslate2

        gpu_available = ctranslate2.get_cuda_device_count() > 0
    except Exception as exc:
        print(f"[main] CUDA availability check failed ({exc}); assuming no GPU")
        gpu_available = False
    if gpu_available:
        return whisper_cfg
    print("[main] no NVIDIA GPU detected - falling back to CPU transcription")
    whisper_cfg = dict(whisper_cfg)
    whisper_cfg["device"] = "cpu"
    if whisper_cfg.get("compute_type") == "float16":
        whisper_cfg["compute_type"] = "int8"
    return whisper_cfg


config = load_config()
config["whisper"] = _resolve_whisper_device(config["whisper"])
SAMPLE_RATE = config["sample_rate"]
HOTKEY_NAME = config["hotkey"]


# A hotkey name prefixed "mouse_" resolves to a pynput.mouse.Button instead
# of a keyboard key - x1/x2 (extra side buttons) only exist on some
# platforms/mice, so they're looked up defensively rather than assumed.
MOUSE_BUTTON_NAMES = {
    "mouse_left": getattr(mouse.Button, "left", None),
    "mouse_right": getattr(mouse.Button, "right", None),
    "mouse_middle": getattr(mouse.Button, "middle", None),
    "mouse_x1": getattr(mouse.Button, "x1", None),
    "mouse_x2": getattr(mouse.Button, "x2", None),
}


def resolve_hotkey(name):
    if name in MOUSE_BUTTON_NAMES:
        button = MOUSE_BUTTON_NAMES[name]
        if button is None:
            raise ValueError(f"Mouse button '{name}' is not available on this platform/device")
        return button
    key = getattr(keyboard.Key, name, None)
    if key is not None:
        return key
    if len(name) == 1:
        return keyboard.KeyCode.from_char(name)
    raise ValueError(
        f"Unrecognised hotkey '{name}' — use a pynput Key name "
        f"(e.g. 'ctrl_r', 'alt_r', 'cmd_r'), a single character, "
        f"or a mouse button ({', '.join(sorted(MOUSE_BUTTON_NAMES))})"
    )


HOTKEY = resolve_hotkey(HOTKEY_NAME)
HOTKEY_IS_MOUSE = isinstance(HOTKEY, mouse.Button)

MOUSE_BUTTON_DISPLAY_NAMES = {
    "mouse_left": "Left Mouse Button",
    "mouse_right": "Right Mouse Button",
    "mouse_middle": "Middle Mouse Button",
    "mouse_x1": "Mouse Button 4",
    "mouse_x2": "Mouse Button 5",
}


def describe_hotkey(name, resolved_hotkey):
    if isinstance(resolved_hotkey, mouse.Button):
        return MOUSE_BUTTON_DISPLAY_NAMES[name]
    display = (
        name.replace("_r", " (right)")
        .replace("_l", " (left)")
        .replace("_", " ")
        .title()
    )
    if platform.system() == "Darwin":
        display = display.replace("Alt", "Option")
    return display


HOTKEY_DISPLAY = describe_hotkey(HOTKEY_NAME, HOTKEY)
IDLE_STATUS = f"Hold {HOTKEY_DISPLAY} to record"
hotkey_listener = None


# ── Recording state machine ──
#
# Bounds an unbounded CoreAudio stream-teardown hang (a real, confirmed
# failure mode: sd.InputStream.close() can hang indefinitely after an
# occasional CoreAudio realtime-IO-thread deadline miss, with no timeout of
# its own) and closes a real hotkey-acceptance race at startup. See
# FINAL_BRIEF.md ("windows-mac-dictation: CoreAudio Stream-Teardown Hang &
# macOS Tray Icon Fix") for the full design and every handoff-review gap
# this closes.
class RecordingState(enum.Enum):
    INITIALIZING = "initializing"
    IDLE = "idle"
    STARTING = "starting"
    RECORDING = "recording"
    STOPPING = "stopping"


state_lock = threading.Lock()
transcribe_lock = threading.Lock()
# Starts INITIALIZING, not IDLE: run_hotkey_listener() starts accepting real
# OS hotkey events before this module tells Electron/the user it's ready
# (emit_event({"type": "ready", ...})) - hotkeys are handled entirely inside
# Python via pynput, never routed through Electron's own
# backendAcceptingCommands gate (that only ever covers Electron-IPC-forwarded
# commands). start_recording()'s existing "accept only if IDLE" check already
# rejects INITIALIZING the same way it rejects STOPPING, closing this window
# with no new special-casing needed. Transitions to IDLE in main(), in the
# one exact spot documented there.
recording_state = RecordingState.INITIALIZING
start_cancel_requested = False
frames = []
stream = None
partial_stop_event = None
focus_target = None

# Healthy teardown was observed within about one second; the confirmed hang
# lasted 2m14s. Three seconds gives normal teardown roughly a 3x margin
# while still bounding the failure.
STREAM_TEARDOWN_TIMEOUT_S = 3.0
STOPPING_STATUS = "Stopping..."
RECOVERING_STATUS = "Recovering from an audio problem…"
# Shown in place of "Transcribing..." for the very first transcription after
# a fresh install / cleared model cache, when the weights (up to ~1.5GB on
# Mac's large-v3-turbo) download inside the transcribe() call and it would
# otherwise look like a silent multi-minute hang.
MODEL_PREP_STATUS = "Preparing speech model (one-time, first run)…"


# ── Focus tracking ──
#
# Transcribing + cleanup takes a few seconds, during which OS focus can
# drift away from wherever the user was actually dictating into (a
# notification steals it, they alt-tab to check something while waiting,
# etc). paste_text() fires with zero confirmation step -- there's no
# review UI moment where a human notices the wrong window is focused
# before the paste keystroke goes out -- so this has to be handled
# defensively: snapshot whichever window/app had focus the instant the
# hotkey was first pressed, and force focus back to exactly that window
# immediately before pasting, regardless of what focus has done since.

def capture_focus_target():
    system = platform.system()
    if system == "Windows":
        try:
            return ctypes.windll.user32.GetForegroundWindow()
        except Exception:
            return None
    elif system == "Darwin":
        try:
            result = subprocess.run(
                ["osascript", "-e",
                 'tell application "System Events" to get name of first process whose frontmost is true'],
                capture_output=True, text=True, timeout=2, check=True,
            )
            return result.stdout.strip() or None
        except Exception as exc:
            # check=True turns a nonzero osascript exit (e.g. denied
            # AppleEvents automation permission) into a real exception
            # instead of a silent empty stdout - surfaced structurally so a
            # permission denial is diagnosable without ever blocking
            # dictation itself (still returns None either way).
            emit_diag("FOCUS_CAPTURE_FAILED", error_class=type(exc).__name__)
            return None
    return None


def restore_focus_target(target):
    if not target:
        return
    system = platform.system()
    if system == "Windows":
        try:
            user32 = ctypes.windll.user32
            fg = user32.GetForegroundWindow()
            if fg == target:
                return
            fg_thread = user32.GetWindowThreadProcessId(fg, None)
            target_thread = user32.GetWindowThreadProcessId(target, None)
            current_thread = ctypes.windll.kernel32.GetCurrentThreadId()
            # SetForegroundWindow silently refuses to switch focus for a
            # background process under normal circumstances (Windows'
            # anti-focus-stealing protection) -- attaching this process's
            # input queue to both the currently-focused and the target
            # window's threads is the standard workaround.
            user32.AttachThreadInput(fg_thread, current_thread, True)
            user32.AttachThreadInput(target_thread, current_thread, True)
            user32.SetForegroundWindow(target)
            user32.AttachThreadInput(fg_thread, current_thread, False)
            user32.AttachThreadInput(target_thread, current_thread, False)
        except Exception as exc:
            print(f"[focus] failed to restore Windows focus: {exc}", file=sys.stderr)
    elif system == "Darwin":
        try:
            subprocess.run(
                ["osascript", "-e", f'tell application "{target}" to activate'],
                timeout=2, check=True, capture_output=True, text=True,
            )
        except Exception as exc:
            emit_diag("FOCUS_RESTORE_FAILED", error_class=type(exc).__name__)
            # Continue without raising - paste proceeds using the current
            # fallback focus rather than being blocked by a focus-restore
            # failure.


# ── Event stream (Python -> Electron, stdout) ──

def emit_event(obj):
    """Write one JSON object as a line to the real stdout, flushed
    immediately — piped stdout is block-buffered by default, not
    line-buffered, so without an explicit flush the UI would see nothing
    until an internal buffer filled up."""
    _event_stream.write(json.dumps(obj) + "\n")
    _event_stream.flush()


def push_status(state, text):
    emit_event({"type": "status", "state": state, "text": text})


def push_transcript(text):
    emit_event({"type": "transcript", "text": text})


def push_final_text(text):
    emit_event({"type": "final_text", "text": text})


def push_audio_level(rms):
    emit_event({"type": "audio_level", "rms": round(float(rms), 4)})


# ── Commands (Electron -> Python, stdin) ──

def get_config_dict():
    """Current config, in the shape the Settings panel and the startup
    'ready' event both need."""
    whisper_cfg = config["whisper"]
    backend_name = whisper_cfg.get("backend", "unknown")
    model_size = whisper_cfg.get("model_size", "unknown")

    if backend_name == "faster-whisper":
        device = whisper_cfg.get("device", "cpu")
        compute = whisper_cfg.get("compute_type", "")
        backend_display = f"faster-whisper {model_size} {device} {compute}".strip()
    elif backend_name == "mlx-whisper":
        backend_display = f"mlx-whisper {model_size} Metal"
    else:
        backend_display = f"{backend_name} {model_size}"

    return {
        "type": "config",
        "hotkey_raw": HOTKEY_NAME,
        "whisper_backend": backend_display,
        "cleanup_model": config["cleanup"].get("ollama_model", ""),
        "autostart": config.get("autostart", False),
        "theme": config.get("theme", "dark"),
        "opacity": config.get("opacity", "glass"),
        "alwaysOnTop": config.get("alwaysOnTop", True),
    }


def paste_text(text):
    """Restore focus to wherever the user was dictating into, then paste the
    cleaned-up text there. Called automatically the instant cleanup
    finishes -- there is no review/confirm step, so this has to land
    correctly the first time with no user action at all."""
    if not text or not text.strip():
        push_status("idle", IDLE_STATUS)
        return
    push_status("pasting", "Pasting...")
    try:
        restore_focus_target(focus_target)
        time.sleep(0.12)  # let the OS actually finish switching focus
        inject(text.strip())
        print(f"[inject] sent: {text.strip()!r}")
        threading.Timer(1.0, lambda: push_status("idle", IDLE_STATUS)).start()
    except Exception as exc:
        print(f"[inject] failed: {exc}", file=sys.stderr)
        push_status("error", f"Paste failed: {exc}")


def cmd_save_config(data):
    """Save editable settings to config.json. Uses config.py's CONFIG_PATH
    (the single source of truth - see config.resolve_config_path()) rather
    than re-deriving its own copy, so dev mode and a packaged app's
    userData-relative location never disagree."""
    try:
        with open(CONFIG_PATH, "r") as f:
            raw = json.load(f)
    except Exception:
        raw = {}

    requested_hotkey = data.get("hotkey")
    if requested_hotkey:
        # Validate before changing either disk or the live listener. This
        # makes a bad renderer value fail visibly instead of being persisted
        # and then crashing the backend on its next launch.
        resolve_hotkey(requested_hotkey)
        plat = "darwin" if platform.system() == "Darwin" else "windows"
        if "hotkey" not in raw or not isinstance(raw["hotkey"], dict):
            raw["hotkey"] = {}
        raw["hotkey"][plat] = requested_hotkey

    if "theme" in data:
        raw["theme"] = data["theme"]
        config["theme"] = data["theme"]

    if "opacity" in data:
        raw["opacity"] = data["opacity"]
        config["opacity"] = data["opacity"]

    if "autostart" in data:
        raw["autostart"] = data["autostart"]
        config["autostart"] = data["autostart"]

    if "alwaysOnTop" in data:
        raw["alwaysOnTop"] = data["alwaysOnTop"]
        config["alwaysOnTop"] = data["alwaysOnTop"]

    with open(CONFIG_PATH, "w") as f:
        json.dump(raw, f, indent=2)

    if requested_hotkey:
        apply_runtime_hotkey(requested_hotkey)

    emit_event({
        "type": "settings_saved",
        "config": get_config_dict(),
        "hotkey_display": HOTKEY_DISPLAY,
    })


def handle_command(cmd):
    action = cmd.get("cmd")
    if action == "get_config":
        emit_event(get_config_dict())
    elif action == "save_config":
        try:
            cmd_save_config(cmd.get("data", {}))
        except Exception as exc:
            print(f"[settings] save failed: {exc}", file=sys.stderr)
            emit_event({
                "type": "settings_error",
                "message": f"Could not save settings: {exc}",
            })
    else:
        print(f"[stdin] unknown command: {action!r}", file=sys.stderr)


def clean_stdin_line(line: str) -> str:
    """Strips a leading UTF-8 BOM (U+FEFF) plus surrounding whitespace.

    .NET's Process.StandardInput (used by both Electron's Node child_process
    on some code paths and PowerShell's ProcessStartInfo, confirmed live via
    build-app.ps1's own smoke test) can prepend a UTF-8 BOM to the very first
    write on a redirected stdin pipe, even when the caller writes raw UTF-8
    bytes with no BOM of its own - json.loads has no BOM tolerance, so strip
    one defensively before parsing rather than trusting every caller's stdio
    plumbing not to add one."""
    return line.lstrip("﻿").strip()


def stdin_reader_loop():
    """Blocks on the main thread reading one JSON command per line until
    stdin closes (Electron's child process pipe closing on app quit),
    at which point this returns and main() exits cleanly."""
    for line in sys.stdin:
        line = clean_stdin_line(line)
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"[stdin] malformed JSON, skipping: {exc}", file=sys.stderr)
            continue
        try:
            handle_command(cmd)
        except Exception as exc:
            print(f"[stdin] command {cmd.get('cmd')!r} failed: {exc}", file=sys.stderr)


# ── Audio ──

def audio_callback(indata, frame_count, time_info, status):
    if status:
        print(f"[audio] status: {status}", file=sys.stderr)
    with state_lock:
        # STARTING as well as RECORDING - a synchronous callback fired by
        # sd.InputStream.start() itself must not be dropped (R3: ".start()
        # emits callbacks before the code resets frames"). Rejects callbacks
        # from a stream already detached (stream is None) after the
        # transition to STOPPING, even if the underlying native callback
        # fires once more before teardown actually completes.
        if recording_state in (RecordingState.STARTING, RecordingState.RECORDING) and stream is not None:
            frames.append(indata.copy())
            rms = float(np.sqrt(np.mean(indata ** 2)))
            push_audio_level(rms)


PARTIAL_INTERVAL_SECONDS = 0.8
CHUNK_SECONDS = 5
AUDIO_MIN_RMS = 0.0015
AUDIO_MIN_PEAK = 0.008
AUDIO_ACTIVITY_FLOOR = 0.003
AUDIO_MIN_ACTIVE_FRACTION = 0.02


def audio_signal_metrics(audio):
    flat = np.asarray(audio, dtype=np.float32).reshape(-1)
    if flat.size == 0:
        return 0.0, 0.0, 0.0
    rms = float(np.sqrt(np.mean(np.square(flat))))
    peak = float(np.max(np.abs(flat)))
    active_fraction = float(np.mean(np.abs(flat) >= AUDIO_ACTIVITY_FLOOR))
    return rms, peak, active_fraction


def audio_signal_is_usable(audio):
    """Reject silence/near-silence before a language model can invent text."""
    rms, peak, active_fraction = audio_signal_metrics(audio)
    return (
        rms >= AUDIO_MIN_RMS
        and peak >= AUDIO_MIN_PEAK
        and active_fraction >= AUDIO_MIN_ACTIVE_FRACTION
    )


def live_partial_transcription_enabled(whisper_config):
    """Large Turbo is reserved for the final pass to avoid duplicate latency."""
    model_size = str(whisper_config.get("model_size", "")).lower()
    repo = str(whisper_config.get("hf_repo", "")).lower()
    return "large-v3-turbo" not in model_size and "large-v3-turbo" not in repo


def emit_diag(code, **fields):
    """Writes one structured P2T_DIAG line to stderr - electron/diagnostics.js
    sanitizes it through DIAG_ALLOWED_KEYS before it ever reaches backend.log
    or a native dialog, so only allowlisted keys (never exception messages or
    transcript content) survive. `code` is always included; every extra
    keyword becomes an allowlist-checked field."""
    payload = {"code": code}
    payload.update(fields)
    print(f"P2T_DIAG {json.dumps(payload)}", file=sys.stderr)


def log_stage_timing(code, started_at, char_count=None):
    """Emit content-free timings through Electron's diagnostic allowlist."""
    payload = {
        "code": code,
        "duration_ms": round((time.perf_counter() - started_at) * 1000),
    }
    if char_count is not None:
        payload["char_count"] = char_count
    print(f"P2T_DIAG {json.dumps(payload)}", file=sys.stderr)


def choose_safe_cleanup_output(raw_text, cleaned_text):
    """Never let a cleanup-model repetition loop replace a safe transcript."""
    if has_repetition_loop(cleaned_text):
        print(
            'P2T_DIAG {"code":"CLEANUP_REPETITION_REJECTED"}',
            file=sys.stderr,
        )
        return raw_text
    return cleaned_text


def partial_transcription_loop(stop_event):
    """While recording, show a live-updating transcript that never loses
    earlier words: audio is split into ~5s chunks; once a chunk is that
    long it's "finalized" (transcribed once, appended permanently to
    finalized_text, never re-transcribed again) while the current
    in-progress chunk keeps re-transcribing every ~0.8s for the live feel.
    This keeps each call bounded to ~5s of audio — fast regardless of how
    long the whole recording runs — while still showing the full transcript
    built up so far. Pure visual feedback, never pasted; the final paste
    re-transcribes the complete recording in one shot after release for
    maximum accuracy."""
    finalized_text = ""
    chunk_start = 0

    while not stop_event.wait(PARTIAL_INTERVAL_SECONDS):
        with state_lock:
            if recording_state != RecordingState.RECORDING:
                return
            snapshot = list(frames)
        if not snapshot:
            continue
        audio_so_far = np.concatenate(snapshot, axis=0)
        chunk_audio = audio_so_far[chunk_start:]
        if len(chunk_audio) < SAMPLE_RATE * 0.5:
            continue
        try:
            with transcribe_lock:
                partial_text = transcribe(chunk_audio, SAMPLE_RATE, config["whisper"])
        except Exception as exc:
            print(f"[partial-transcribe] skipped: {exc}", file=sys.stderr)
            continue

        display_text = f"{finalized_text} {partial_text}".strip()
        if display_text:
            push_transcript(display_text)

        if len(chunk_audio) >= CHUNK_SECONDS * SAMPLE_RATE:
            finalized_text = display_text
            chunk_start = len(audio_so_far)


def bounded_teardown_stream(local_stream, *, operation, call_stop):
    """Runs stream.stop()/close() in a daemon worker thread, bounded by
    STREAM_TEARDOWN_TIMEOUT_S, so a hung native close() (the confirmed real
    failure mode - a CoreAudio realtime-IO-thread deadline miss can leave
    close() hanging indefinitely with no timeout of its own) can never again
    hang this process indefinitely. Returns True only on a confirmed close
    within the timeout (even if stop() itself raised); False on a timeout or
    a close() exception, in which case a recovery has already been
    requested. The caller may enter IDLE only when this returns True."""
    emit_event({"type": "stream_teardown", "phase": "started", "operation": operation})

    stop_exc = []
    close_exc = []

    def worker():
        if call_stop:
            try:
                local_stream.stop()
            except Exception as exc:  # recorded separately, never fails teardown alone
                stop_exc.append(exc)
        try:
            local_stream.close()
        except Exception as exc:
            close_exc.append(exc)

    worker_thread = threading.Thread(target=worker, daemon=True)
    worker_thread.start()
    worker_thread.join(STREAM_TEARDOWN_TIMEOUT_S)

    if worker_thread.is_alive():
        emit_diag(
            "STREAM_TEARDOWN_TIMEOUT",
            operation=operation,
            timeout_ms=int(STREAM_TEARDOWN_TIMEOUT_S * 1000),
        )
        push_status("recovering", RECOVERING_STATUS)
        emit_event({"type": "backend_recovery_required", "code": "STREAM_TEARDOWN_TIMEOUT"})
        return False

    if close_exc:
        emit_diag("STREAM_CLOSE_ERROR", operation=operation, error_class=type(close_exc[0]).__name__)
        push_status("recovering", RECOVERING_STATUS)
        emit_event({"type": "backend_recovery_required", "code": "STREAM_CLOSE_ERROR"})
        return False

    if stop_exc:
        # stop() raising alone never fails teardown (close() is what
        # actually matters), but it's still worth a non-fatal diagnostic.
        emit_diag("STREAM_STOP_ERROR", operation=operation, error_class=type(stop_exc[0]).__name__)

    emit_event({"type": "stream_teardown", "phase": "completed", "operation": operation})
    return True


def _finish_unsuccessful_start_teardown(confirmed):
    """Shared terminal-state rule for start_recording()'s three teardown call
    sites (cancelled_start, start_failure, post_start_cancelled). None of
    these three paths ever produced a real completed recording, so a
    confirmed close skips straight to IDLE rather than the stop-side
    signal/transcribe/cleanup/paste pipeline. An unconfirmed close (timeout
    or close exception) stays STOPPING - bounded_teardown_stream() has
    already pushed 'recovering' and requested backend recovery."""
    global recording_state
    if confirmed:
        with state_lock:
            recording_state = RecordingState.IDLE
        push_status("idle", IDLE_STATUS)


def start_recording():
    global recording_state, frames, stream, partial_stop_event, focus_target, start_cancel_requested

    with state_lock:
        if recording_state == RecordingState.STOPPING:
            push_status("stopping", STOPPING_STATUS)
            return
        if recording_state != RecordingState.IDLE:
            # INITIALIZING, STARTING, or RECORDING - duplicate/ineligible
            # presses are silently ignored, no focus capture or stream
            # construction attempted.
            return
        recording_state = RecordingState.STARTING
        frames = []
        stream = None
        start_cancel_requested = False
        partial_stop_event = threading.Event()
        local_stop_event = partial_stop_event

    focus_target_local = capture_focus_target()

    try:
        local_stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=audio_callback,
        )
    except Exception as exc:
        with state_lock:
            recording_state = RecordingState.IDLE
        emit_diag("STREAM_CONSTRUCTION_FAILED", error_class=type(exc).__name__)
        push_status("error", f"Could not start recording: {exc}")
        return

    with state_lock:
        # Install the constructed stream while still STARTING - this makes
        # frames/stream callback-ready before .start() is ever called.
        stream = local_stream
        if start_cancel_requested:
            recording_state = RecordingState.STOPPING
            stream = None
            cancelled_before_start = True
        else:
            cancelled_before_start = False

    if cancelled_before_start:
        confirmed = bounded_teardown_stream(local_stream, operation="cancelled_start", call_stop=False)
        _finish_unsuccessful_start_teardown(confirmed)
        return

    try:
        local_stream.start()
    except Exception as exc:
        with state_lock:
            recording_state = RecordingState.STOPPING
            stream = None
        emit_diag("STREAM_START_FAILED", error_class=type(exc).__name__)
        confirmed = bounded_teardown_stream(local_stream, operation="start_failure", call_stop=True)
        _finish_unsuccessful_start_teardown(confirmed)
        return

    with state_lock:
        if start_cancel_requested:
            recording_state = RecordingState.STOPPING
            stream = None
            cancelled_after_start = True
        else:
            focus_target = focus_target_local
            recording_state = RecordingState.RECORDING
            cancelled_after_start = False

    if cancelled_after_start:
        # .start() already succeeded, so unlike step 6's cancelled_before_start
        # branch, the stream is actively running - call_stop=True actually
        # invokes stop(), not just close().
        confirmed = bounded_teardown_stream(local_stream, operation="post_start_cancelled", call_stop=True)
        _finish_unsuccessful_start_teardown(confirmed)
        return

    # No code clears `frames` after .start() has begun - a synchronous
    # callback fired during .start() itself must be preserved (R3).
    push_status("recording", "Listening...")
    push_transcript("")
    print("[rec] recording started")
    if live_partial_transcription_enabled(config["whisper"]):
        threading.Thread(
            target=partial_transcription_loop, args=(local_stop_event,), daemon=True
        ).start()
    else:
        print(
            'P2T_DIAG {"code":"LIVE_CAPTIONS_DISABLED_LARGE_TURBO"}',
            file=sys.stderr,
        )


# ── Cleanup sanity check ──
#
# Guards against the cleanup LLM (a small local model, run with an explicit
# anti-answer system prompt in cleanup.py) answering the transcript instead
# of editing it — a failure mode already hit and partly fixed once before
# (commit da68be3, 2026-07-09: "model was answering the transcript instead
# of editing it"). Prompt wording alone isn't a guarantee with a 3B model,
# and there's no review step to catch a bad result before paste_text() fires
# (deliberately removed 2026-07-27, commit c57733a — "we want instant
# paste"). This is a deterministic backstop that doesn't depend on the model
# actually following instructions: cleanup only ever strips filler
# words/false starts, so a result that's much longer than the input, or
# that adds list/heading structure the input never had, did not come from
# editing what was said — it's the model generating new content, and gets
# rejected in favour of the raw transcript.

def _looks_like_list_item(line: str) -> bool:
    if not line:
        return False
    if line[0] in "-*•":
        return True
    i = 0
    while i < len(line) and line[i].isdigit():
        i += 1
    return 0 < i < len(line) and line[i] in ".)"


_WORD_RE = re.compile(r"[a-zA-Z0-9']+")
_FILLER_WORDS = {"um", "umm", "uh", "uhh", "erm", "ah", "like"}


def _content_words(text: str) -> set:
    return {w.lower() for w in _WORD_RE.findall(text)}


# Below this ratio, the cleaned result is treated as unrelated to what was
# actually said rather than an edit of it. Low enough that legitimate
# self-correction cleanup (which can legitimately drop an entire
# superseded word/clause, e.g. "call John no wait call Mike" -> "Call
# Mike.", observed ratio 0.4) still passes, while every fabricated-answer
# case tried (observed ratio 0.0-0.25) does not.
_MIN_VOCAB_OVERLAP = 0.35

# Cleanup may add a few connective words for grammar, but generated answers
# introduce vocabulary that was never spoken. Allow up to 40% of the cleaned
# result's distinct non-filler words to be new. This keeps small legitimate
# additions ("send report Sarah" -> "send the report to Sarah") while
# rejecting answers that merely echo the original words inside a response
# ("call John" -> "Okay, I'll call John for you").
_MAX_NOVEL_VOCAB_RATIO = 0.40

# Neither vocabulary check above catches a fabrication that rephrases a
# request/question into a first-person confirmation using mostly the raw
# transcript's own words — e.g. "remind me to call sarah at five" ->
# "I'll remind you to call Sarah at five." shares 6 of 7 raw words (passes
# _MIN_VOCAB_OVERLAP) and adds only "I'll"/"you" (2 of 8 cleaned words,
# passes _MAX_NOVEL_VOCAB_RATIO). No legitimate filler-stripping/grammar
# edit ever introduces a conversational reply opener that wasn't already
# there — cleanup edits the sentence that was spoken, it never switches
# who's speaking. Catch this by structure instead of vocabulary: reject a
# cleaned result that opens with one of these markers unless the raw
# transcript already opened with it too (a person's own dictated speech
# starting with "Yes,"/"Sorry,"/etc. is legitimate and must pass through
# unchanged). Apostrophes are stripped before matching so contractions
# match regardless of exactly how Whisper punctuated them.
_ANSWER_OPENERS = (
    "yes", "yeah", "yep", "no", "nope", "sure", "okay", "ok", "certainly",
    "of course", "absolutely",
    "ill", "i can", "i cant", "i cannot", "i dont", "i do not",
    "im", "i am", "ive", "i have", "id", "i would",
    "let me", "heres", "here is", "here are",
    "sounds good", "got it", "no problem", "happy to", "sorry",
)


def _has_answer_opener(text: str) -> bool:
    normalized = text.strip().lower().replace("'", "")
    return any(
        normalized == opener
        or normalized.startswith(opener + " ")
        or normalized.startswith(opener + ",")
        for opener in _ANSWER_OPENERS
    )


def is_plausible_cleanup(raw: str, cleaned: str) -> bool:
    raw_stripped = raw.strip()
    cleaned_stripped = cleaned.strip()
    if not raw_stripped or not cleaned_stripped:
        return True

    # Cleanup removes content (filler words, false starts) — it never
    # legitimately adds enough to make the result much longer than the
    # input. The "+30" keeps short transcripts from tripping this on
    # ordinary punctuation/expansion noise.
    max_plausible_len = max(len(raw_stripped) * 1.5, len(raw_stripped) + 30)
    if len(cleaned_stripped) > max_plausible_len:
        return False

    # A single spoken sentence never legitimately turns into a bulleted or
    # numbered list — that structure is a signature of generated content,
    # not an edited transcript.
    if "\n" not in raw_stripped:
        list_like_lines = sum(
            1
            for line in cleaned_stripped.splitlines()
            if _looks_like_list_item(line.strip())
        )
        if list_like_lines >= 2:
            return False

    # Neither check above catches a short, plainly-worded fabricated
    # answer -- e.g. "what is your name" -> "I don't have a personal
    # name." is about the same length as the question and a single
    # sentence, so it slips past both. Catch this class by vocabulary:
    # cleanup only ever edits or removes words that were actually said,
    # it never substitutes different ones, so the cleaned result should
    # share most of the raw transcript's words. A result sharing very
    # little vocabulary with the raw transcript is an answer to it, not
    # an edit of it, regardless of length or shape.
    raw_words = _content_words(raw_stripped) - _FILLER_WORDS
    cleaned_words = _content_words(cleaned_stripped) - _FILLER_WORDS
    if raw_words:
        overlap_ratio = len(raw_words & cleaned_words) / len(raw_words)
        if overlap_ratio < _MIN_VOCAB_OVERLAP:
            return False

    # The overlap check is recall-like: it only asks how much of the raw
    # vocabulary survived. An answer can score perfectly by repeating all of
    # the spoken words and surrounding them with invented content. Add the
    # precision-side check as well: reject results where too much of the
    # cleaned vocabulary was never present in the transcript. Run this even
    # when raw_words is empty (an all-filler utterance), since any cleaned
    # content words would necessarily be invented.
    if cleaned_words:
        novel_ratio = len(cleaned_words - raw_words) / len(cleaned_words)
        if novel_ratio > _MAX_NOVEL_VOCAB_RATIO:
            return False

    # Structural check, independent of both vocabulary ratios above — see
    # _ANSWER_OPENERS' comment for the exact gap this closes.
    if _has_answer_opener(cleaned_stripped) and not _has_answer_opener(raw_stripped):
        return False

    return True


def stop_recording():
    global recording_state, stream, start_cancel_requested
    pipeline_started_at = time.perf_counter()

    with state_lock:
        if recording_state == RecordingState.INITIALIZING:
            # Hotkey release raced module startup, before run_hotkey_listener()
            # emitted "ready" and before start_recording() could ever have run.
            # No-op: no state change, no stream ops, no cancellation mutation,
            # no status/event/diag emission.
            return
        if recording_state == RecordingState.STARTING:
            # start_recording() owns cleanup once construction/start
            # returns - this only records the request and returns.
            start_cancel_requested = True
            push_status("stopping", STOPPING_STATUS)
            return
        if recording_state in (RecordingState.STOPPING, RecordingState.IDLE):
            return
        # RECORDING: atomically detach the stream and transition to STOPPING.
        recording_state = RecordingState.STOPPING
        local_stream = stream
        stream = None
        local_stop_event = partial_stop_event

    if local_stop_event:
        local_stop_event.set()
    push_status("stopping", STOPPING_STATUS)

    confirmed = bounded_teardown_stream(local_stream, operation="stop_recording", call_stop=True)
    if not confirmed:
        # Timeout or close failure never transitions to IDLE -
        # bounded_teardown_stream() has already pushed 'recovering' and
        # requested backend recovery.
        return

    with state_lock:
        recording_state = RecordingState.IDLE
        captured = list(frames)

    if not captured:
        print("[rec] recording stopped — no audio captured")
        push_status("idle", IDLE_STATUS)
        return

    audio = np.concatenate(captured, axis=0)
    duration_s = len(audio) / SAMPLE_RATE
    print(
        f"[rec] recording stopped — {len(audio)} samples, "
        f"{duration_s:.2f}s captured at {SAMPLE_RATE}Hz"
    )
    rms, peak, active_fraction = audio_signal_metrics(audio)
    print(
        "P2T_DIAG "
        + json.dumps(
            {
                "code": "AUDIO_SIGNAL",
                "rms_milli": round(rms * 1000, 2),
                "peak_milli": round(peak * 1000, 2),
                "active_percent": round(active_fraction * 100, 2),
            }
        ),
        file=sys.stderr,
    )
    if not audio_signal_is_usable(audio):
        print(
            'P2T_DIAG {"code":"TRANSCRIPTION_REJECTED","error_class":"insufficient_audio_signal"}',
            file=sys.stderr,
        )
        push_status(
            "error",
            "No clear speech was detected, so nothing was pasted.",
        )
        return

    # Debug-only: dump the raw captured audio to a WAV file for offline
    # beam_size speed/accuracy comparison (build/compare-beam-size.py) -
    # never active unless P2T_SAVE_LAST_AUDIO is explicitly set, so it has
    # zero effect on normal/packaged runs.
    save_path = os.environ.get("P2T_SAVE_LAST_AUDIO")
    if save_path:
        import wave

        pcm16 = np.clip(audio * 32767, -32768, 32767).astype(np.int16)
        with wave.open(save_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm16.tobytes())
        print(f"[debug] saved captured audio to {save_path}")

    # Same transcribe() call as always — only the status label differs on the
    # first, uncached run, where the weight download happens inside it. Warm
    # runs (is_model_ready() true) are byte-for-byte unchanged.
    if is_model_ready():
        push_status("transcribing", "Transcribing...")
    else:
        push_status("preparing-model", MODEL_PREP_STATUS)
    transcription_started_at = time.perf_counter()
    try:
        with transcribe_lock:
            text = transcribe(audio, SAMPLE_RATE, config["whisper"])
        log_stage_timing(
            "TRANSCRIPTION_TIMING",
            transcription_started_at,
            char_count=len(text),
        )
        print(f"[transcribe] result: {text!r}")
    except UnreliableTranscriptionError as exc:
        print(
            f'P2T_DIAG {json.dumps({"code": "TRANSCRIPTION_REJECTED", "error_class": exc.reason})}',
            file=sys.stderr,
        )
        push_status("error", str(exc))
        return
    except Exception as exc:
        print(f"[transcribe] failed: {exc}", file=sys.stderr)
        push_status("error", f"Transcription failed: {exc}")
        return

    push_transcript(text)
    push_status("cleanup", "Cleaning up...")
    cleanup_started_at = time.perf_counter()
    try:
        cleaned = cleanup(text, config["cleanup"])
        cleaned = choose_safe_cleanup_output(text, cleaned)
        log_stage_timing(
            "CLEANUP_TIMING",
            cleanup_started_at,
            char_count=len(cleaned),
        )
        print(f"[cleanup] result: {cleaned!r}")
    except Exception as exc:
        log_stage_timing("CLEANUP_FAILED_TIMING", cleanup_started_at)
        print(f"[cleanup] failed: {exc}", file=sys.stderr)
        print("[cleanup] falling back to the raw transcript for injection")
        cleaned = text
    else:
        if not is_plausible_cleanup(text, cleaned):
            print(
                f"[cleanup] rejected implausible result (looks like an answer, "
                f"not an edit) — falling back to the raw transcript: {cleaned!r}",
                file=sys.stderr,
            )
            cleaned = text

    push_final_text(cleaned)
    log_stage_timing(
        "DICTATION_READY_TIMING",
        pipeline_started_at,
        char_count=len(cleaned),
    )
    paste_text(cleaned)


# ── Hotkey ──

def on_press(key):
    if key == HOTKEY:
        start_recording()


def on_release(key):
    if key == HOTKEY:
        threading.Thread(target=stop_recording, daemon=True).start()


def on_click(x, y, button, pressed):
    if button != HOTKEY:
        return
    if pressed:
        start_recording()
    else:
        threading.Thread(target=stop_recording, daemon=True).start()


def run_hotkey_listener():
    # pynput listens passively - it does not suppress the original OS
    # action, unlike the keyboard case where the default hotkeys are
    # deliberately chosen lone modifier keys with no side effects of their
    # own. A mouse-button hotkey (e.g. middle-click) still triggers
    # whatever that button normally does wherever the cursor is
    # (autoscroll, open-link-in-new-tab, etc) in addition to dictation.
    global hotkey_listener
    if HOTKEY_IS_MOUSE:
        listener = mouse.Listener(on_click=on_click)
    else:
        listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    hotkey_listener = listener
    return listener


def apply_runtime_hotkey(name):
    """Switch the active pynput listener to a newly saved hotkey.

    Settings used to update config.json only. Since closing the Electron
    window hides the app to the tray rather than quitting it, that left the
    old listener alive indefinitely and made Settings appear broken. Stop
    the old listener, update the runtime state, and start the appropriate
    keyboard/mouse listener immediately.
    """
    global HOTKEY_NAME, HOTKEY, HOTKEY_IS_MOUSE
    global HOTKEY_DISPLAY, IDLE_STATUS, hotkey_listener

    resolved = resolve_hotkey(name)
    if name == HOTKEY_NAME:
        return False

    previous = (
        HOTKEY_NAME,
        HOTKEY,
        HOTKEY_IS_MOUSE,
        HOTKEY_DISPLAY,
        IDLE_STATUS,
    )
    previous_listener = hotkey_listener

    if previous_listener is not None:
        previous_listener.stop()
        previous_listener.join()
        hotkey_listener = None

    HOTKEY_NAME = name
    HOTKEY = resolved
    HOTKEY_IS_MOUSE = isinstance(resolved, mouse.Button)
    HOTKEY_DISPLAY = describe_hotkey(name, resolved)
    IDLE_STATUS = f"Hold {HOTKEY_DISPLAY} to record"

    try:
        run_hotkey_listener()
    except Exception:
        (
            HOTKEY_NAME,
            HOTKEY,
            HOTKEY_IS_MOUSE,
            HOTKEY_DISPLAY,
            IDLE_STATUS,
        ) = previous
        run_hotkey_listener()
        raise

    config["hotkey"] = name
    emit_event({
        "type": "ready",
        "hotkey_raw": HOTKEY_NAME,
        "hotkey_display": HOTKEY_DISPLAY,
    })
    push_status("idle", IDLE_STATUS)
    return True


def check_macos_accessibility():
    """Preflight-check Accessibility/Input Monitoring access on macOS before
    starting the hotkey listener. Without this permission, pynput silently
    receives no key events at all and pyautogui's paste keystroke silently
    does nothing — this makes that failure loud instead, per CLAUDE.md's
    hard rule. Uses Quartz, already a transitive pynput dependency on Mac,
    so this adds no new requirement."""
    if platform.system() != "Darwin":
        return
    try:
        from Quartz import CGPreflightListenEventAccess
    except ImportError:
        return  # Can't preflight-check; existing docs/behaviour still apply

    if not CGPreflightListenEventAccess():
        emit_diag("MAC_ACCESSIBILITY_REQUIRED")
        print(
            "[main] macOS denied Accessibility permission to PTT; "
            "the Electron permission gate should prevent the backend from "
            "starting until the visible app has been approved.",
            file=sys.stderr,
        )
        # A dedicated exit code lets the Electron shell distinguish a TCC
        # permission race from a genuine backend crash.
        sys.exit(77)


def run_build_self_test_mlx():
    """Exercise the real Mac transcription path from a frozen build.

    Import-only and get_config smoke tests cannot detect omitted Metal
    runtime resources: MLX loads mlx.metallib only when inference begins.
    A second of synthetic silence is sufficient to force model and Metal
    initialization without needing microphone or TCC access.
    """
    whisper_config = config["whisper"]
    if platform.system() != "Darwin":
        raise RuntimeError("MLX build self-test is only valid on macOS")
    if whisper_config.get("backend") != "mlx-whisper":
        raise RuntimeError("MLX build self-test requires the mlx-whisper backend")

    audio = np.zeros(SAMPLE_RATE, dtype=np.float32)
    safety_rejected_silence = False
    try:
        text = transcribe(audio, SAMPLE_RATE, whisper_config)
    except UnreliableTranscriptionError:
        # Synthetic silence being rejected is the desired production
        # behavior. The model/Metal path still ran fully; dependency/runtime
        # errors remain uncaught and continue to fail the build.
        text = ""
        safety_rejected_silence = True
    emit_event({
        "type": "build_self_test",
        "component": "mlx_whisper",
        "ok": True,
        "transcript_length": len(text),
        "safety_rejected_silence": safety_rejected_silence,
    })


def main():
    # Build-only diagnostic: run before microphone and Accessibility checks
    # so this isolates the packaged MLX/Whisper/Metal runtime. Normal app
    # launches never set this environment variable.
    if os.environ.get("P2T_BUILD_SELF_TEST_MLX") == "1":
        run_build_self_test_mlx()
        return

    try:
        sd.check_input_settings(samplerate=SAMPLE_RATE, channels=1)
    except Exception as exc:
        print(f"[mic] no usable microphone found: {exc}", file=sys.stderr)
        if platform.system() == "Darwin":
            print(
                "[mic] grant microphone access: System Settings > Privacy & "
                "Security > Microphone > enable for Terminal (or your Python "
                "interpreter).",
                file=sys.stderr,
            )
        else:
            print(
                "[mic] check Windows microphone permissions for this app "
                "(Settings > Privacy & security > Microphone).",
                file=sys.stderr,
            )
        sys.exit(1)

    check_macos_accessibility()

    print(
        f"[main] windows-dictation starting on {platform.system()} — "
        f"hold '{HOTKEY_NAME}' to record"
    )
    if platform.system() == "Darwin":
        print(
            "[main] macOS: this needs Accessibility permission granted to "
            "Terminal / your Python interpreter under System Settings > "
            "Privacy & Security > Accessibility, or the hotkey listener and "
            "the paste keystroke will silently do nothing."
        )

    run_hotkey_listener()

    # Exactly here - between run_hotkey_listener() and emit_event(ready), not
    # tied to push_status("idle", ...) below - recording_state leaves
    # INITIALIZING. The backend should genuinely be capable of accepting a
    # hotkey by the moment it tells Electron/the user it's ready, not one
    # line later. A hotkey landing before this point is received by pynput
    # but produces no recording (start_recording()'s "accept only if IDLE"
    # check rejects INITIALIZING the same way it rejects STOPPING).
    global recording_state
    with state_lock:
        recording_state = RecordingState.IDLE

    emit_event({"type": "ready", "hotkey_raw": HOTKEY_NAME, "hotkey_display": HOTKEY_DISPLAY})
    push_status("idle", IDLE_STATUS)
    print("[main] ready, listening for commands on stdin")

    stdin_reader_loop()
    print("[main] stdin closed, exiting")


if __name__ == "__main__":
    main()
