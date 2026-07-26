import json
import platform
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "config.json"

CURRENT_PLATFORM = "windows" if platform.system() == "Windows" else "darwin" if platform.system() == "Darwin" else "linux"

DEFAULTS = {
    "sample_rate": 16000,
    "hotkey": {
        "windows": "ctrl_r",
        "darwin": "alt_l",
    },
    "whisper": {
        "windows": {
            "backend": "faster-whisper",
            "model_size": "small",
            "device": "cuda",
            "compute_type": "float16",
        },
        "darwin": {
            "backend": "mlx-whisper",
            "model_size": "small",
            "hf_repo": "mlx-community/whisper-small-mlx",
        },
    },
    "cleanup": {
        "backend": "local",
        "ollama_model": "llama3.2:3b",
        "ollama_url": "http://localhost:11434/api/generate",
    },
    "autostart": False,
}


def _deep_merge(defaults, overrides):
    """Recursively merge `overrides` onto `defaults`. Unlike dict.update(),
    a nested dict in `overrides` fills in missing keys from `defaults` rather
    than wholesale replacing the entire nested value - so a config.json that
    only overrides one platform's hotkey/whisper section doesn't silently drop
    the other platform's default."""
    if not isinstance(overrides, dict):
        return overrides
    merged = dict(defaults)
    for key, value in overrides.items():
        if (
            key in merged
            and isinstance(merged[key], dict)
            and isinstance(value, dict)
        ):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config():
    """Load config.json, deep-merge with defaults, and resolve the platform-keyed
    hotkey/whisper sections down to the values for the OS this is running on.
    """
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULTS, indent=2))
        raw = dict(DEFAULTS)
    else:
        with open(CONFIG_PATH, "r") as f:
            raw = json.load(f)

    merged = _deep_merge(DEFAULTS, raw)

    if CURRENT_PLATFORM not in merged["hotkey"]:
        raise ValueError(
            f"No hotkey configured for platform '{CURRENT_PLATFORM}' in config.json "
            f"(have: {list(merged['hotkey'].keys())})"
        )
    if CURRENT_PLATFORM not in merged["whisper"]:
        raise ValueError(
            f"No whisper backend configured for platform '{CURRENT_PLATFORM}' in config.json "
            f"(have: {list(merged['whisper'].keys())})"
        )

    return {
        "sample_rate": merged["sample_rate"],
        "hotkey": merged["hotkey"][CURRENT_PLATFORM],
        "whisper": merged["whisper"][CURRENT_PLATFORM],
        "cleanup": merged["cleanup"],
        "autostart": merged["autostart"],
    }
