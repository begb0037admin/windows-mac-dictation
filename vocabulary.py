"""
Personal vocabulary — deterministic word/phrase fixes for Whisper output.

Whisper sometimes consistently mishears a term (Kevin's example: "Codex"
transcribed as "codec"). This module fixes those from a small list, two
ways: a whole-word replacement pass on the raw transcript before the
cleanup LLM, and the correct spellings fed to Whisper as `initial_prompt`
to bias it up front.

Two sources, merged:
  1. the committed baseline `vocabulary.json` (repo root; bundled into the
     frozen backend via PyInstaller `datas`), and
  2. an optional per-machine `vocabulary.json` in the writable config dir
     (`<P2T_CONFIG_DIR>/vocabulary.json`), for instant additions with no
     rebuild.

A per-machine entry whose `heard` matches a baseline entry (case-insensitive)
overrides its `write`; new per-machine entries are appended. A missing or
malformed file is ignored with a stderr warning, never fatal.

See docs/VOCABULARY_BRIEF.md.
"""

import json
import re
import sys
from pathlib import Path


def _baseline_path() -> Path:
    """The committed list. When frozen, PyInstaller unpacks `datas` under
    sys._MEIPASS; in dev it sits next to this file at the repo root."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "vocabulary.json"
    return Path(__file__).parent / "vocabulary.json"


def _read_entries(path: Path) -> list:
    """Parse one vocabulary file into a list of {"heard", "write"} dicts.
    Anything unreadable or not shaped as expected yields an empty list (with
    a warning for a file that exists but is broken) — never raises."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (ValueError, OSError) as exc:
        print(f"[vocabulary] ignoring {path}: {exc}", file=sys.stderr)
        return []

    if not isinstance(raw, list):
        print(f"[vocabulary] ignoring {path}: expected a JSON list", file=sys.stderr)
        return []

    entries = []
    for item in raw:
        if (
            isinstance(item, dict)
            and isinstance(item.get("heard"), str)
            and isinstance(item.get("write"), str)
            and item["heard"].strip()
        ):
            entries.append(
                {"heard": item["heard"].strip(), "write": item["write"]}
            )
    return entries


def load_vocabulary(local_path=None) -> list:
    """Baseline entries with the per-machine file (if any) merged on top: a
    local entry whose `heard` matches an existing one (case-insensitive)
    replaces its `write`; genuinely new local entries are appended. Baseline
    order is otherwise preserved."""
    merged = _read_entries(_baseline_path())

    if local_path is not None:
        index_by_key = {
            entry["heard"].lower(): position
            for position, entry in enumerate(merged)
        }
        for entry in _read_entries(Path(local_path)):
            key = entry["heard"].lower()
            if key in index_by_key:
                # Override just the spelling; keep the baseline entry's own
                # `heard` text (matching is case-insensitive anyway).
                merged[index_by_key[key]]["write"] = entry["write"]
            else:
                index_by_key[key] = len(merged)
                merged.append(entry)

    return merged


def _pattern_for(heard: str) -> str:
    """A whole-word / whole-phrase, whitespace-tolerant regex for one
    `heard` key. `re.escape` each word separately and join on \\s+ so a
    multi-word key ("code x") still matches across any run of spaces."""
    words = [re.escape(word) for word in heard.split()]
    return r"\b" + r"\s+".join(words) + r"\b"


def apply_vocabulary(text: str, entries: list) -> str:
    """Case-insensitive whole-word / whole-phrase replacement. Longer
    `heard` keys are applied first so a multi-word phrase wins over a
    single word that overlaps it. `write` is inserted verbatim."""
    if not text or not entries:
        return text

    for entry in sorted(entries, key=lambda e: len(e["heard"]), reverse=True):
        text = re.sub(
            _pattern_for(entry["heard"]),
            lambda _match, replacement=entry["write"]: replacement,
            text,
            flags=re.IGNORECASE,
        )
    return text


def whisper_prompt(entries: list) -> str:
    """The `write` spellings as a short comma-separated string for Whisper's
    `initial_prompt` — deduplicated case-insensitively, order preserved,
    empty string when there are no entries."""
    seen = set()
    terms = []
    for entry in entries:
        term = entry["write"].strip()
        if term and term.lower() not in seen:
            seen.add(term.lower())
            terms.append(term)
    return ", ".join(terms)
