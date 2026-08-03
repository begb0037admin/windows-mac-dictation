"""
Ad hoc tool: compare faster-whisper transcription speed and accuracy across
different beam_size values on one real captured audio sample, so the
beam_size=1 speed change (transcribe.py) can be judged on real evidence
instead of a guess. Not part of the app or its test suite - run manually.

Usage:
    python build\\compare-beam-size.py path\\to\\sample.wav

Produces a .wav via main.py's P2T_SAVE_LAST_AUDIO debug hook - see
HANDOVER.md for the two-step "record a real sample, then compare" workflow.
"""

import sys
import time
import wave
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from config import load_config  # noqa: E402


def load_wav_as_float32(path):
    with wave.open(path, "rb") as wf:
        assert wf.getsampwidth() == 2, "expected 16-bit PCM"
        assert wf.getnchannels() == 1, "expected mono"
        raw = wf.readframes(wf.getnframes())
    pcm16 = np.frombuffer(raw, dtype=np.int16)
    return pcm16.astype(np.float32) / 32767.0


def main():
    if len(sys.argv) != 2:
        print("usage: python build\\compare-beam-size.py path\\to\\sample.wav")
        sys.exit(1)

    wav_path = sys.argv[1]
    audio = load_wav_as_float32(wav_path)
    duration_s = len(audio) / 16000
    print(f"Loaded {wav_path}: {duration_s:.2f}s of audio\n")

    config = load_config()
    whisper_config = config["whisper"]

    from faster_whisper import WhisperModel

    print(
        f"Loading '{whisper_config['model_size']}' on {whisper_config['device']} "
        f"({whisper_config['compute_type']})...\n"
    )
    model = WhisperModel(
        whisper_config["model_size"],
        device=whisper_config["device"],
        compute_type=whisper_config["compute_type"],
    )

    print(f"{'beam_size':<10} {'time (s)':<10} transcript")
    print("-" * 70)
    for beam_size in (1, 2, 3, 5):
        start = time.perf_counter()
        segments, _info = model.transcribe(audio, language="en", beam_size=beam_size)
        text = " ".join(s.text.strip() for s in segments).strip()
        elapsed = time.perf_counter() - start
        print(f"{beam_size:<10} {elapsed:<10.2f} {text!r}")


if __name__ == "__main__":
    main()
