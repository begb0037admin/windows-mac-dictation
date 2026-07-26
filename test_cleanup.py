"""
Unit tests for cleanup.py's Ollama request construction and error handling.
Mocks urllib.request.urlopen — no real Ollama instance needed.

Run with: python -m unittest test_cleanup -v
"""

import json
import unittest
import urllib.error
from unittest import mock

import cleanup


def _fake_response(payload):
    body = json.dumps(payload).encode("utf-8")

    class _Resp:
        def read(self):
            return body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    return _Resp()


class CleanupTests(unittest.TestCase):
    CONFIG = {
        "ollama_model": "llama3.2:3b",
        "ollama_url": "http://localhost:11434/api/generate",
    }

    def test_empty_text_short_circuits_without_network_call(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            result = cleanup.cleanup("   ", self.CONFIG)
        urlopen.assert_not_called()
        self.assertEqual(result, "   ")

    def test_request_wraps_transcript_in_tags_and_pins_temperature(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["payload"] = json.loads(request.data)
            return _fake_response({"response": "cleaned text"})

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = cleanup.cleanup("um so anyway", self.CONFIG)

        expected_prompt_body = "<transcript>\n" + "um so anyway" + "\n</transcript>"
        self.assertEqual(result, "cleaned text")
        self.assertIn(expected_prompt_body, captured["payload"]["prompt"])
        self.assertEqual(captured["payload"]["options"]["temperature"], 0)
        self.assertEqual(captured["payload"]["model"], "llama3.2:3b")
        self.assertIn("never", cleanup.SYSTEM_PROMPT.lower())

    def test_unreachable_ollama_raises_clear_runtime_error(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                cleanup.cleanup("hello", self.CONFIG)
        self.assertIn("Ollama", str(ctx.exception))

    def test_missing_model_error_response_raises_with_pull_hint(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=lambda *a, **k: _fake_response({"error": "model not found"}),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                cleanup.cleanup("hello", self.CONFIG)
        self.assertIn("ollama pull", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
