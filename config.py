import json
import os
import platform
from pathlib import Path


def resolve_config_path() -> Path:
    """Corrected turn 4 (Codex finding): FINAL_BRIEF.md SS5 already specifies
    this exact contract - P2T_CONFIG_DIR (a directory, not a file path) - and
    turn 1 independently reinvented a differently-shaped PUSH2TALK_CONFIG_PATH
    instead of using it. Conforms to SS5 now: if P2T_CONFIG_DIR is non-empty,
    the config lives at <P2T_CONFIG_DIR>/config.json; otherwise dev mode's
    historical script-relative path is preserved unchanged. electron/main.js
    sets P2T_CONFIG_DIR to app.getPath('userData') only when packaged - never
    inside process.resourcesPath, which is typically not user-writable and
    would defeat uninstall's "preserve userData" requirement. Single source
    of truth - main.py's cmd_save_config() imports CONFIG_PATH rather than
    re-deriving its own copy."""
    config_dir = os.environ.get("P2T_CONFIG_DIR")
    if config_dir:
        return Path(config_dir) / "config.json"
    return Path(__file__).parent / "config.json"


def ensure_config_file(path: Path) -> Path:
    """SS5's exact steps: resolve the path (done by the caller), compute its
    parent, os.makedirs(parent, exist_ok=True) only when parent is non-empty
    (a bare relative filename would otherwise pass os.makedirs("") and raise
    FileNotFoundError - guarded explicitly, not just assumed unreachable),
    write platform defaults only when the destination is absent, return the
    path."""
    parent = str(path.parent)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if not path.exists():
        path.write_text(json.dumps(DEFAULTS, indent=2))
    return path


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
    "alwaysOnTop": True,
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
    existed_before = CONFIG_PATH.exists()
    ensure_config_file(CONFIG_PATH)
    if not existed_before:
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
        "alwaysOnTop": merged["alwaysOnTop"],
    }
