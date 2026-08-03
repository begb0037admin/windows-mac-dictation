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
import json
import os
import platform
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
from transcribe import transcribe

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

config = load_config()
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

if HOTKEY_IS_MOUSE:
    HOTKEY_DISPLAY = {
        "mouse_left": "Left Mouse Button",
        "mouse_right": "Right Mouse Button",
        "mouse_middle": "Middle Mouse Button",
        "mouse_x1": "Mouse Button 4",
        "mouse_x2": "Mouse Button 5",
    }[HOTKEY_NAME]
else:
    HOTKEY_DISPLAY = HOTKEY_NAME.replace("_r", " (right)").replace("_l", " (left)").replace("_", " ").title()
    if platform.system() == "Darwin":
        HOTKEY_DISPLAY = HOTKEY_DISPLAY.replace("Alt", "Option")
IDLE_STATUS = f"Hold {HOTKEY_DISPLAY} to record"

state_lock = threading.Lock()
transcribe_lock = threading.Lock()
recording = False
frames = []
stream = None
partial_stop_event = None
focus_target = None


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
                capture_output=True, text=True, timeout=2,
            )
            return result.stdout.strip() or None
        except Exception:
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
                timeout=2,
            )
        except Exception as exc:
            print(f"[focus] failed to restore macOS focus: {exc}", file=sys.stderr)


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

    if "hotkey" in data and data["hotkey"]:
        plat = "darwin" if platform.system() == "Darwin" else "windows"
        if "hotkey" not in raw or not isinstance(raw["hotkey"], dict):
            raw["hotkey"] = {}
        raw["hotkey"][plat] = data["hotkey"]

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


def handle_command(cmd):
    action = cmd.get("cmd")
    if action == "get_config":
        emit_event(get_config_dict())
    elif action == "save_config":
        cmd_save_config(cmd.get("data", {}))
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
        if recording:
            frames.append(indata.copy())
            rms = float(np.sqrt(np.mean(indata ** 2)))
            push_audio_level(rms)


PARTIAL_INTERVAL_SECONDS = 0.8
CHUNK_SECONDS = 5


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
            if not recording:
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


def start_recording():
    global recording, frames, stream, partial_stop_event, focus_target
    focus_target = capture_focus_target()
    with state_lock:
        if recording:
            return
        recording = True
        frames = []
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=audio_callback,
        )
        stream.start()
        partial_stop_event = threading.Event()
        local_stop_event = partial_stop_event
    push_status("recording", "Listening...")
    push_transcript("")
    print("[rec] recording started")
    threading.Thread(
        target=partial_transcription_loop, args=(local_stop_event,), daemon=True
    ).start()


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

    return True


def stop_recording():
    global recording, stream
    with state_lock:
        if not recording:
            return
        recording = False
        local_stream = stream
        stream = None
        local_stop_event = partial_stop_event

    if local_stop_event:
        local_stop_event.set()
    if local_stream:
        local_stream.stop()
        local_stream.close()

    with state_lock:
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

    push_status("transcribing", "Transcribing...")
    try:
        with transcribe_lock:
            text = transcribe(audio, SAMPLE_RATE, config["whisper"])
        print(f"[transcribe] result: {text!r}")
    except Exception as exc:
        print(f"[transcribe] failed: {exc}", file=sys.stderr)
        push_status("error", f"Transcription failed: {exc}")
        return

    push_transcript(text)
    push_status("cleanup", "Cleaning up...")
    try:
        cleaned = cleanup(text, config["cleanup"])
        print(f"[cleanup] result: {cleaned!r}")
    except Exception as exc:
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
    if HOTKEY_IS_MOUSE:
        listener = mouse.Listener(on_click=on_click)
    else:
        listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    return listener


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
        print(
            "[main] Accessibility / Input Monitoring permission not granted — "
            "the hotkey listener would silently receive no key events and "
            "paste simulation would silently do nothing. Grant it under "
            "System Settings > Privacy & Security > Accessibility (and Input "
            "Monitoring) for Terminal / your Python interpreter, then restart "
            "this app.",
            file=sys.stderr,
        )
        sys.exit(1)


def main():
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

    emit_event({"type": "ready", "hotkey_raw": HOTKEY_NAME, "hotkey_display": HOTKEY_DISPLAY})
    push_status("idle", IDLE_STATUS)
    print("[main] ready, listening for commands on stdin")

    stdin_reader_loop()
    print("[main] stdin closed, exiting")


if __name__ == "__main__":
    main()
