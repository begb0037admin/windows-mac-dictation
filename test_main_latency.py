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

    def test_digital_silence_is_classified_as_device_silent(self):
        self.assertTrue(
            main.audio_signal_is_device_silent(
                main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
            )
        )

    def test_device_silence_threshold_distinguishes_nearby_peaks(self):
        just_above = main.np.array(
            [main.AUDIO_TRUE_SILENCE_PEAK * 10], dtype=main.np.float32
        )
        just_below = main.np.array(
            [main.AUDIO_TRUE_SILENCE_PEAK / 10], dtype=main.np.float32
        )

        self.assertFalse(main.audio_signal_is_device_silent(just_above))
        self.assertTrue(main.audio_signal_is_device_silent(just_below))

    def test_clear_audio_signal_is_accepted(self):
        audio = main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        audio[::2] = 0.02
        audio[1::2] = -0.02
        self.assertTrue(main.audio_signal_is_usable(audio))
        self.assertFalse(main.audio_signal_is_device_silent(audio))

    def test_brief_click_without_sustained_signal_is_rejected(self):
        audio = main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        audio[0] = 0.5
        self.assertFalse(main.audio_signal_is_usable(audio))
        self.assertFalse(main.audio_signal_is_device_silent(audio))


class StopRecordingAudioSignalTests(unittest.TestCase):
    def setUp(self):
        self.saved_state = {
            "recording_state": main.recording_state,
            "frames": main.frames,
            "stream": main.stream,
            "partial_stop_event": main.partial_stop_event,
            "start_cancel_requested": main.start_cancel_requested,
            "resolved_input_device": main.resolved_input_device,
        }
        main.recording_state = main.RecordingState.RECORDING
        main.frames = []
        main.stream = mock.Mock()
        main.partial_stop_event = None
        main.start_cancel_requested = False

    def tearDown(self):
        for name, value in self.saved_state.items():
            setattr(main, name, value)

    def stop_with_audio(self, audio, resolve_side_effect=None):
        main.frames = [audio]
        with mock.patch.object(main, "bounded_teardown_stream", return_value=True):
            with mock.patch.object(main, "push_status") as push_status:
                with mock.patch.object(
                    main, "_resolve_input_device", side_effect=resolve_side_effect
                ) as resolve:
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        main.stop_recording()
        return push_status, resolve, emit_diag

    def test_digital_silence_reacquires_device_and_shows_mic_message(self):
        push_status, resolve, _ = self.stop_with_audio(
            main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        )

        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        resolve.assert_called_once_with()
        push_status.assert_called_with(
            "error", "Microphone is off or unavailable — turn it on and try again."
        )

    def test_digital_silence_reacquires_device_while_holding_state_lock(self):
        def resolve_while_checking_lock():
            acquired = main.state_lock.acquire(blocking=False)
            if acquired:
                main.state_lock.release()
            self.assertFalse(acquired)

        _, resolve, _ = self.stop_with_audio(
            main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32),
            resolve_side_effect=resolve_while_checking_lock,
        )

        resolve.assert_called_once_with()

    def test_real_but_unclear_audio_keeps_existing_message_without_reacquiring(self):
        audio = main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32)
        audio[0] = 0.5
        push_status, resolve, _ = self.stop_with_audio(audio)

        resolve.assert_not_called()
        push_status.assert_called_with(
            "error", "No clear speech was detected, so nothing was pasted."
        )

    def test_mic_reacquire_failure_does_not_block_mic_off_message(self):
        push_status, resolve, emit_diag = self.stop_with_audio(
            main.np.zeros(main.SAMPLE_RATE, dtype=main.np.float32),
            resolve_side_effect=RuntimeError("device unavailable"),
        )

        resolve.assert_called_once_with()
        emit_diag.assert_called_once_with(
            "MIC_REACQUIRE_FAILED", error_class="RuntimeError"
        )
        push_status.assert_called_with(
            "error", "Microphone is off or unavailable — turn it on and try again."
        )


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
