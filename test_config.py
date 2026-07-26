"""
Unit tests for config.py's resolution/deep-merge logic. No mic, GPU, or
hotkey needed — these can run anywhere, unlike the rest of this app.

Run with: python -m unittest test_config -v
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config


class DeepMergeTests(unittest.TestCase):
    def test_partial_override_keeps_other_platform_default(self):
        """A config.json that only overrides one platform's hotkey must not
        silently drop the other platform's default (the shallow
        dict.update() bug this replaces)."""
        merged = config._deep_merge(
            config.DEFAULTS, {"hotkey": {"windows": "ctrl_l"}}
        )
        self.assertEqual(merged["hotkey"]["windows"], "ctrl_l")
        self.assertEqual(
            merged["hotkey"]["darwin"], config.DEFAULTS["hotkey"]["darwin"]
        )

    def test_partial_whisper_override_keeps_other_fields(self):
        merged = config._deep_merge(
            config.DEFAULTS,
            {"whisper": {"windows": {"model_size": "medium"}}},
        )
        self.assertEqual(merged["whisper"]["windows"]["model_size"], "medium")
        self.assertEqual(
            merged["whisper"]["windows"]["device"],
            config.DEFAULTS["whisper"]["windows"]["device"],
        )
        self.assertEqual(
            merged["whisper"]["darwin"], config.DEFAULTS["whisper"]["darwin"]
        )

    def test_non_dict_override_replaces_value(self):
        merged = config._deep_merge({"a": {"b": 1}}, {"a": "not-a-dict"})
        self.assertEqual(merged["a"], "not-a-dict")

    def test_mac_default_hotkey_is_left_option(self):
        """Regression test: the 2026-07-26 fix (alt_r -> alt_l) must not
        silently revert if config.json is ever deleted and regenerated from
        DEFAULTS — standard Apple keyboards have no physical Right Option
        key."""
        self.assertEqual(config.DEFAULTS["hotkey"]["darwin"], "alt_l")


class LoadConfigTests(unittest.TestCase):
    def _load_with(self, raw_config, platform_name):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps(raw_config))
            with mock.patch.object(config, "CONFIG_PATH", config_path), mock.patch.object(
                config, "CURRENT_PLATFORM", platform_name
            ):
                return config.load_config()

    def test_partial_windows_only_override_still_works_on_mac(self):
        """Regression test for the shallow-merge bug: overriding just the
        Windows hotkey in config.json must not break hotkey resolution on
        Mac (it used to — the old dict.update() replaced the whole `hotkey`
        dict, dropping the darwin key entirely and raising ValueError)."""
        resolved = self._load_with({"hotkey": {"windows": "ctrl_l"}}, "darwin")
        self.assertEqual(resolved["hotkey"], "alt_l")

    def test_full_config_resolves_current_platform_only(self):
        resolved = self._load_with(dict(config.DEFAULTS), "windows")
        self.assertEqual(resolved["hotkey"], "ctrl_r")
        self.assertEqual(resolved["whisper"]["backend"], "faster-whisper")

    def test_platform_with_no_default_coverage_raises_clear_error(self):
        with self.assertRaises(ValueError):
            self._load_with({}, "linux")


if __name__ == "__main__":
    unittest.main()
