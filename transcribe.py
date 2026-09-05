"""
Step 2 of the MVP: transcribe captured audio to text.
Cross-platform backend: faster-whisper + CUDA on Windows, mlx-whisper on Mac.

The model is loaded once and cached for the life of the process. First call
downloads model weights (hundreds of MB to a few GB) via huggingface_hub,
which prints its own progress bar — nothing to hang silently here.

`transcribe()` accepts a mono float32 numpy array (live dictation, already
at the correct sample rate). File transcription is handled separately by
the meeting-transcriber tool.
"""

import re

import numpy as np

_model = None
_backend = None


class UnreliableTranscriptionError(RuntimeError):
    """The model produced text that is unsafe to paste automatically."""

    def __init__(self, reason):
        self.reason = reason
        super().__init__("No reliable speech was detected, so nothing was pasted.")


def has_repetition_loop(text, min_words=4, repeats=3):
    """Detect an obvious contiguous phrase loop without rejecting brief emphasis."""
    words = re.findall(r"[a-z0-9']+", text.lower())
    max_unit = len(words) // repeats
    for unit_size in range(min_words, max_unit + 1):
        span = unit_size * repeats
        for start in range(0, len(words) - span + 1):
            unit = words[start : start + unit_size]
            if all(
                words[start + index * unit_size : start + (index + 1) * unit_size]
                == unit
                for index in range(1, repeats)
            ):
                return True
    return False


def _segment_value(segment, key):
    if isinstance(segment, dict):
        return segment.get(key)
    return getattr(segment, key, None)


def _validate_transcription(text, segments, whisper_config):
    if not text:
        return
    if has_repetition_loop(text):
        raise UnreliableTranscriptionError("repetition_loop")

    no_speech_threshold = whisper_config.get("no_speech_threshold", 0.6)
    logprob_threshold = whisper_config.get("logprob_threshold", -1.0)
    compression_threshold = whisper_config.get("compression_ratio_threshold", 2.4)

    no_speech_values = [
        value
        for segment in segments
        if (value := _segment_value(segment, "no_speech_prob")) is not None
    ]
    if no_speech_values and all(
        value > no_speech_threshold for value in no_speech_values
    ):
        raise UnreliableTranscriptionError("probable_no_speech")

    logprobs = [
        value
        for segment in segments
        if (value := _segment_value(segment, "avg_logprob")) is not None
    ]
    if logprobs and sum(logprobs) / len(logprobs) < logprob_threshold:
        raise UnreliableTranscriptionError("low_confidence")

    compression_ratios = [
        value
        for segment in segments
        if (value := _segment_value(segment, "compression_ratio")) is not None
    ]
    if compression_ratios and max(compression_ratios) > compression_threshold:
        raise UnreliableTranscriptionError("high_compression")


def _load_windows_model(whisper_config):
    from faster_whisper import WhisperModel

    print(
        f"[transcribe] loading faster-whisper model "
        f"'{whisper_config['model_size']}' on {whisper_config['device']} "
        f"({whisper_config['compute_type']})... first run downloads the model."
    )
    return WhisperModel(
        whisper_config["model_size"],
        device=whisper_config["device"],
        compute_type=whisper_config["compute_type"],
    )


def _load_mac_model(whisper_config):
    # mlx-whisper resolves and caches the model from a Hugging Face repo id
    # lazily, inside transcribe() itself — there's no separate "load" step.
    # We just resolve the repo id here and let the first transcribe() call
    # trigger the download.
    repo = whisper_config.get(
        "hf_repo", f"mlx-community/whisper-{whisper_config['model_size']}-mlx"
    )
    print(
        f"[transcribe] using mlx-whisper repo '{repo}' — first run downloads "
        f"the model weights."
    )
    return repo


def _get_model(whisper_config):
    global _model, _backend
    if _model is not None:
        return _model
    _backend = whisper_config["backend"]
    if _backend == "faster-whisper":
        _model = _load_windows_model(whisper_config)
    elif _backend == "mlx-whisper":
        _model = _load_mac_model(whisper_config)
    else:
        raise ValueError(f"Unknown whisper backend '{_backend}'")
    return _model


def is_model_ready() -> bool:
    """True once the speech model has been resolved/loaded in this process,
    i.e. the one-time first-run weight download has already happened.

    Purely a read-only accessor for callers that want to show a distinct
    "first run" status — it does not change anything about how transcribe()
    or _get_model() load or download the model.
    """
    return _model is not None


def transcribe(audio, sample_rate: int, whisper_config: dict) -> str:
    """Transcribe a mono float32 numpy array to text."""
    model = _get_model(whisper_config)

    audio_input = audio.reshape(-1).astype(np.float32)

    if _backend == "faster-whisper":
        # beam_size defaults to 2 (Kevin, 2026-07-31): beam search explores
        # N x the decoding paths of greedy search per step, which is real
        # wall-clock time on short push-to-talk clips where model-load and
        # fixed decode overhead already dominate. 2 is a deliberate middle
        # ground - most of the speed win over the whisper-default 5 without
        # going all the way to greedy's single guess. Still configurable via
        # whisper_config for future tuning.
        segments_iter, _info = model.transcribe(
            audio_input,
            language=whisper_config.get("language", "en"),
            beam_size=whisper_config.get("beam_size", 2),
            condition_on_previous_text=whisper_config.get(
                "condition_on_previous_text", False
            ),
            compression_ratio_threshold=whisper_config.get(
                "compression_ratio_threshold", 2.4
            ),
            log_prob_threshold=whisper_config.get("logprob_threshold", -1.0),
            no_speech_threshold=whisper_config.get("no_speech_threshold", 0.6),
        )
        segments = list(segments_iter)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        _validate_transcription(text, segments, whisper_config)
        return text

    if _backend == "mlx-whisper":
        import mlx_whisper

        result = mlx_whisper.transcribe(
            audio_input,
            path_or_hf_repo=model,
            language=whisper_config.get("language", "en"),
            condition_on_previous_text=whisper_config.get(
                "condition_on_previous_text", False
            ),
            compression_ratio_threshold=whisper_config.get(
                "compression_ratio_threshold", 2.4
            ),
            logprob_threshold=whisper_config.get("logprob_threshold", -1.0),
            no_speech_threshold=whisper_config.get("no_speech_threshold", 0.6),
        )
        text = result["text"].strip()
        _validate_transcription(text, result.get("segments", []), whisper_config)
        return text

    raise ValueError(f"Unknown whisper backend '{_backend}'")
