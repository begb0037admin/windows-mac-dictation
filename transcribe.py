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

import numpy as np

_model = None
_backend = None


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


def transcribe(audio, sample_rate: int, whisper_config: dict) -> str:
    """Transcribe a mono float32 numpy array to text."""
    model = _get_model(whisper_config)

    audio_input = audio.reshape(-1).astype(np.float32)

    if _backend == "faster-whisper":
        segments, _info = model.transcribe(audio_input, language="en")
        return " ".join(segment.text.strip() for segment in segments).strip()

    if _backend == "mlx-whisper":
        import mlx_whisper

        result = mlx_whisper.transcribe(audio_input, path_or_hf_repo=model)
        return result["text"].strip()

    raise ValueError(f"Unknown whisper backend '{_backend}'")
