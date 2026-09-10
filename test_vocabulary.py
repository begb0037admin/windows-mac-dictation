"""
Unit tests for vocabulary.py — the personal-vocabulary replacement pass,
the two-file merge, and the Whisper prompt string. No mic/GPU/hotkey
needed; runs anywhere.

Run with: python -m unittest test_vocabulary -v
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import vocabulary

ENTRIES = [
    {"heard": "codec", "write": "Codex"},
    {"heard": "code x", "write": "Codex"},
]


class ApplyVocabularyTests(unittest.TestCase):
    def test_replaces_whole_word_any_case(self):
        self.assertEqual(
            vocabulary.apply_vocabulary("run it in codec now", ENTRIES),
            "run it in Codex now",
        )
        self.assertEqual(
            vocabulary.apply_vocabulary("Codec is the tool", ENTRIES),
            "Codex is the tool",
        )

    def test_leaves_partial_matches_untouched(self):
        # word boundary: "codecs" / "codecx" must not be rewritten
        self.assertEqual(
            vocabulary.apply_vocabulary("compare the codecs here", ENTRIES),
            "compare the codecs here",
        )
        self.assertEqual(
            vocabulary.apply_vocabulary("xcodec and codecx", ENTRIES),
            "xcodec and codecx",
        )

    def test_multi_word_phrase_key_matches_across_spaces(self):
        self.assertEqual(
            vocabulary.apply_vocabulary("open code x please", ENTRIES),
            "open Codex please",
        )
        self.assertEqual(
            vocabulary.apply_vocabulary("open code   x please", ENTRIES),
            "open Codex please",
        )

    def test_empty_list_or_no_match_is_noop(self):
        self.assertEqual(vocabulary.apply_vocabulary("nothing to do", []), "nothing to do")
        self.assertEqual(
            vocabulary.apply_vocabulary("nothing to do here", ENTRIES),
            "nothing to do here",
        )
        self.assertEqual(vocabulary.apply_vocabulary("", ENTRIES), "")

    def test_write_value_is_inserted_verbatim_not_as_regex(self):
        entries = [{"heard": "backref", "write": r"a\1b$0c"}]
        self.assertEqual(
            vocabulary.apply_vocabulary("the backref token", entries),
            r"the a\1b$0c token",
        )


class WhisperPromptTests(unittest.TestCase):
    def test_joins_write_terms_deduped(self):
        self.assertEqual(vocabulary.whisper_prompt(ENTRIES), "Codex")

    def test_preserves_order_and_dedupes_case_insensitively(self):
        entries = [
            {"heard": "a", "write": "Ollama"},
            {"heard": "b", "write": "Anthropic"},
            {"heard": "c", "write": "ollama"},
        ]
        self.assertEqual(vocabulary.whisper_prompt(entries), "Ollama, Anthropic")

    def test_empty(self):
        self.assertEqual(vocabulary.whisper_prompt([]), "")


class LoadVocabularyMergeTests(unittest.TestCase):
    def _write(self, directory, name, data):
        path = Path(directory) / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_baseline_only_when_no_local(self):
        with tempfile.TemporaryDirectory() as d:
            base = self._write(d, "vocabulary.json", ENTRIES)
            with mock.patch.object(vocabulary, "_baseline_path", return_value=base):
                self.assertEqual(vocabulary.load_vocabulary(None), ENTRIES)

    def test_local_overrides_matching_heard_and_appends_new(self):
        with tempfile.TemporaryDirectory() as d:
            base = self._write(d, "vocabulary.json", ENTRIES)
            local = self._write(
                d,
                "vocabulary.local.json",
                [
                    {"heard": "CODEC", "write": "CODEX!"},
                    {"heard": "llama", "write": "LLaMA"},
                ],
            )
            with mock.patch.object(vocabulary, "_baseline_path", return_value=base):
                merged = vocabulary.load_vocabulary(local)
            self.assertEqual(
                merged,
                [
                    {"heard": "codec", "write": "CODEX!"},   # overridden (case-insensitive)
                    {"heard": "code x", "write": "Codex"},    # untouched
                    {"heard": "llama", "write": "LLaMA"},     # appended
                ],
            )

    def test_missing_local_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            base = self._write(d, "vocabulary.json", ENTRIES)
            with mock.patch.object(vocabulary, "_baseline_path", return_value=base):
                merged = vocabulary.load_vocabulary(Path(d) / "does-not-exist.json")
            self.assertEqual(merged, ENTRIES)

    def test_malformed_file_is_ignored_not_fatal(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / "vocabulary.json"
            base.write_text("{ not json", encoding="utf-8")
            with mock.patch.object(vocabulary, "_baseline_path", return_value=base):
                self.assertEqual(vocabulary.load_vocabulary(None), [])

    def test_non_list_and_bad_entries_are_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            base = self._write(
                d,
                "vocabulary.json",
                [
                    {"heard": "keep", "write": "Keep"},
                    {"heard": "", "write": "blank heard dropped"},
                    {"heard": "no write"},
                    "not a dict",
                    {"heard": 5, "write": "wrong type"},
                ],
            )
            with mock.patch.object(vocabulary, "_baseline_path", return_value=base):
                self.assertEqual(
                    vocabulary.load_vocabulary(None),
                    [{"heard": "keep", "write": "Keep"}],
                )


if __name__ == "__main__":
    unittest.main()
