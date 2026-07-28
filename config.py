import json
import os
import platform
from pathlib import Path


def resolve_config_path() -> Path:
    """Dev mode (env var unset) keeps the historical script-relative path
    unchanged. A packaged app sets PUSH2TALK_CONFIG_PATH to a writable
    user-data location (electron/main.js: app.getPath('userData')) so
    settings never need to be written inside the install tree, which is
    typically not user-writable and would also defeat uninstall's
    "preserve userData" requirement. This is the single source of truth
    for the config path - main.py's cmd_save_config() imports it rather
    than re-deriving its own copy."""
    override = os.environ.get("PUSH2TALK_CONFIG_PATH")
    if override:
        return Path(override)
    return Path(__file__).parent / "config.json"


CONFIG_PATH = resolve_config_path()

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
    "theme": "dark",
    "opacity": "glass",
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
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
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
        "theme": merged["theme"],
        "opacity": merged["opacity"],
    }
