"""
Full MVP pipeline: push-to-talk hotkey + audio capture + transcription +
Ollama cleanup + clipboard paste injection. Cross-platform (Windows + macOS)
via pynput, sounddevice, transcribe.py, cleanup.py, and inject.py.

UI is a pywebview window rendering ui/index.html — a dark-themed web UI
with a live-updating waveform and partial transcript while you hold the
hotkey, purely for feedback. The real text only gets pasted into whatever
app has focus once, cleanly, on release. Closing the window quits the app.

Hold the hotkey (Right Ctrl on Windows, Right Option on Mac by default),
speak, release.

macOS note: the hotkey listener AND the paste injection need Accessibility
permission granted to whatever runs this script (Terminal, or your Python
interpreter) under System Settings > Privacy & Security > Accessibility.
Without it, pynput silently receives no key events, and pyautogui's paste
keystroke silently does nothing.
"""

import json
import os
import platform
import sys
import threading
from pathlib import Path

import numpy as np
import pyperclip
import sounddevice as sd
import webview
from pynput import keyboard

from cleanup import cleanup
from config import load_config
from inject import inject
from transcribe import transcribe

config = load_config()
SAMPLE_RATE = config["sample_rate"]
HOTKEY_NAME = config["hotkey"]

UI_DIR = Path(__file__).parent / "ui"


def resolve_hotkey(name):
    key = getattr(keyboard.Key, name, None)
    if key is not None:
        return key
    if len(name) == 1:
        return keyboard.KeyCode.from_char(name)
    raise ValueError(
        f"Unrecognised hotkey '{name}' — use a pynput Key name "
        f"(e.g. 'ctrl_r', 'alt_r', 'cmd_r') or a single character"
    )


HOTKEY = resolve_hotkey(HOTKEY_NAME)
HOTKEY_DISPLAY = HOTKEY_NAME.replace("_r", " (right)").replace("_l", " (left)").replace("_", " ").title()
IDLE_STATUS = f"Hold {HOTKEY_DISPLAY} to record"

state_lock = threading.Lock()
transcribe_lock = threading.Lock()
recording = False
frames = []
stream = None
partial_stop_event = None

window = None  # pywebview window reference


# ── UI bridge ──

def push_js(js_code):
    """Safely evaluate JS in the webview window."""
    if window:
        try:
            window.evaluate_js(js_code)
        except Exception:
            pass  # Window may be closing


def push_status(state, text):
    """Push a state change to the frontend."""
    safe_text = json.dumps(text)
    push_js(f"updateStatus({json.dumps(state)}, {safe_text})")


def push_transcript(text):
    """Push transcript text to the frontend."""
    push_js(f"updateTranscript({json.dumps(text)})")


def push_final_text(text):
    """Push the final cleaned text to the frontend."""
    push_js(f"updateFinalText({json.dumps(text)})")


def push_audio_level(rms):
    """Push an audio RMS level to the frontend waveform."""
    push_js(f"updateAudioLevel({rms:.4f})")


class DictationAPI:
    """Exposed to JavaScript via pywebview's js_api bridge."""

    def get_config(self):
        """Return current config for the settings panel."""
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
            "hotkey": HOTKEY_DISPLAY,
            "whisper_backend": backend_display,
            "cleanup_model": config["cleanup"].get("ollama_model", ""),
            "autostart": config.get("autostart", False),
        }

    def save_config(self, data):
        """Save editable settings to config.json."""
        config_path = Path(__file__).parent / "config.json"
        try:
            with open(config_path, "r") as f:
                raw = json.load(f)
        except Exception:
            raw = {}

        # Update editable fields
        if "cleanup_model" in data and data["cleanup_model"]:
            if "cleanup" not in raw:
                raw["cleanup"] = {}
            raw["cleanup"]["ollama_model"] = data["cleanup_model"]
            # Also update the in-memory config
            config["cleanup"]["ollama_model"] = data["cleanup_model"]

        if "autostart" in data:
            raw["autostart"] = data["autostart"]
            config["autostart"] = data["autostart"]

        with open(config_path, "w") as f:
            json.dump(raw, f, indent=2)

        return True


# ── Audio ──

def audio_callback(indata, frame_count, time_info, status):
    if status:
        print(f"[audio] status: {status}", file=sys.stderr)
    with state_lock:
        if recording:
            frames.append(indata.copy())
            # Compute RMS for the waveform
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
        except Exception:
            continue

        display_text = f"{finalized_text} {partial_text}".strip()
        if display_text:
            push_transcript(display_text)

        if len(chunk_audio) >= CHUNK_SECONDS * SAMPLE_RATE:
            finalized_text = display_text
            chunk_start = len(audio_so_far)


def start_recording():
    global recording, frames, stream, partial_stop_event
    with state_lock:
        if recording:
            return
        recording = True
        frames = []
    push_status("recording", "Listening...")
    push_transcript("")
    print("[rec] recording started")
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        callback=audio_callback,
    )
    stream.start()
    partial_stop_event = threading.Event()
    threading.Thread(
        target=partial_transcription_loop, args=(partial_stop_event,), daemon=True
    ).start()


def stop_recording():
    global recording, stream
    with state_lock:
        if not recording:
            return
        recording = False
    if partial_stop_event:
        partial_stop_event.set()
    if stream:
        stream.stop()
        stream.close()
        stream = None

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

    push_final_text(cleaned)
    push_status("pasting", "Pasting...")
    try:
        inject(cleaned)
        # Brief pause to show the pasted state, then return to idle
        threading.Timer(1.5, lambda: push_status("idle", IDLE_STATUS)).start()
    except Exception as exc:
        print(f"[inject] failed: {exc}", file=sys.stderr)
        push_status("error", f"Paste failed: {exc}")


# ── Hotkey ──

def on_press(key):
    if key == HOTKEY:
        start_recording()


def on_release(key):
    if key == HOTKEY:
        threading.Thread(target=stop_recording, daemon=True).start()


def run_hotkey_listener():
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    return listener


# ── Window lifecycle ──

def on_window_loaded():
    """Called once the webview window has loaded the HTML."""
    # Set the hotkey display
    push_js(f"setHotkeyDisplay({json.dumps(HOTKEY_NAME)}, {json.dumps(HOTKEY_DISPLAY)})")
    push_status("idle", IDLE_STATUS)


def on_window_closing():
    """Called when the window is about to close."""
    os._exit(0)


def main():
    global window

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

    api = DictationAPI()
    window = webview.create_window(
        "Dictation",
        url=str(UI_DIR / "index.html"),
        js_api=api,
        width=480,
        height=520,
        min_size=(380, 420),
    )

    window.events.loaded += on_window_loaded
    window.events.closing += on_window_closing

    webview.start()


if __name__ == "__main__":
    main()
