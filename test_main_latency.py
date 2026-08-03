"""Regression tests for Large Turbo's low-latency recording path."""

import json
import unittest
from unittest import mock

import main


class LivePartialPolicyTests(unittest.TestCase):
    def test_large_v3_turbo_disables_duplicate_live_inference(self):
        self.assertFalse(
            main.live_partial_transcription_enabled(
                {
                    "model_size": "large-v3-turbo",
                    "hf_repo": "mlx-community/whisper-large-v3-turbo",
                }
            )
        )

    def test_small_model_keeps_live_captions(self):
        self.assertTrue(
            main.live_partial_transcription_enabled(
                {
                    "model_size": "small",
                    "hf_repo": "mlx-community/whisper-small-mlx",
                }
            )
        )


class AudioSignalGuardTests(unittest.TestCase):
    def test_digital_silence_is_rejected(self):
        self.assertFalse(
            main.audio_signal_is_usable(
                main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
            )
        )

    def test_clear_audio_signal_is_accepted(self):
        audio = main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        audio[::2] = 0.02
        audio[1::2] = -0.02
        self.assertTrue(main.audio_signal_is_usable(audio))

    def test_brief_click_without_sustained_signal_is_rejected(self):
        audio = main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        audio[0] = 0.5
        self.assertFalse(main.audio_signal_is_usable(audio))


class TimingDiagnosticTests(unittest.TestCase):
    def test_timing_diagnostic_contains_no_transcript(self):
        with (
            mock.patch.object(main.time, "perf_counter", return_value=2.234),
            mock.patch("builtins.print") as print_mock,
        ):
            main.log_stage_timing("TRANSCRIPTION_TIMING", 1.0, char_count=17)

        line = print_mock.call_args.args[0]
        self.assertTrue(line.startswith("P2T_DIAG "))
        payload = json.loads(line.removeprefix("P2T_DIAG "))
        self.assertEqual(
            payload,
            {
                "code": "TRANSCRIPTION_TIMING",
                "duration_ms": 1234,
                "char_count": 17,
            },
        )

    def test_cleanup_repetition_falls_back_to_raw_transcript(self):
        raw = "Please check the report tomorrow."
        repeated = "Check the report tomorrow. " * 3
        with mock.patch("builtins.print") as print_mock:
            selected = main.choose_safe_cleanup_output(raw, repeated)

        self.assertEqual(selected, raw)
        self.assertIn("CLEANUP_REPETITION_REJECTED", print_mock.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
