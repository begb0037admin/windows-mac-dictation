"""Unit tests for startup microphone selection and stream-device reuse.

The sounddevice calls are mocked, so these tests do not need a physical mic.
Run with: python -m unittest test_main_mic_device_fallback -v
"""

import unittest
from unittest import mock

import main


class MicDeviceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.saved_resolved_device = main.resolved_input_device
        main.resolved_input_device = None

    def tearDown(self):
        main.resolved_input_device = self.saved_resolved_device

    def test_default_succeeds_without_enumerating_devices(self):
        fake_default = mock.Mock(device=[17, 2])
        with mock.patch.object(main.sd, "check_input_settings") as check:
            with mock.patch.object(main.sd, "query_devices") as query:
                with mock.patch.object(main.sd, "default", fake_default):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        main._resolve_input_device()

        self.assertEqual(main.resolved_input_device, 17)
        check.assert_called_once_with(
            device=None,
            samplerate=main.SAMPLE_RATE,
            channels=1,
        )
        query.assert_not_called()
        emit_diag.assert_not_called()

    def test_default_failure_uses_first_passing_input_device(self):
        default_error = RuntimeError("Error querying device -1")
        devices = [
            {"name": "Output only", "max_input_channels": 0},
            {"name": "First microphone", "max_input_channels": 1},
            {"name": "Second microphone", "max_input_channels": 2},
        ]

        def check_input_settings(**kwargs):
            if kwargs["device"] is None:
                raise default_error

        with mock.patch.object(
            main.sd, "check_input_settings", side_effect=check_input_settings
        ) as check:
            with mock.patch.object(main.sd, "query_devices", return_value=devices) as query:
                with mock.patch.object(main, "emit_diag") as emit_diag:
                    main._resolve_input_device()

        self.assertEqual(main.resolved_input_device, 1)
        query.assert_called_once_with()
        self.assertEqual(
            [call.kwargs["device"] for call in check.call_args_list],
            [None, 1],
        )
        emit_diag.assert_called_once_with(
            "MIC_FALLBACK_DEVICE_USED",
            requested="default",
            actual=1,
        )

    def test_default_failure_and_no_working_device_preserves_default_error(self):
        default_error = RuntimeError("Error querying device -1")
        fallback_error = RuntimeError("unsupported format")
        devices = [
            {"name": "First microphone", "max_input_channels": 1},
            {"name": "Second microphone", "max_input_channels": 1},
        ]

        def check_input_settings(**kwargs):
            raise default_error if kwargs["device"] is None else fallback_error

        main.resolved_input_device = 99
        with mock.patch.object(
            main.sd, "check_input_settings", side_effect=check_input_settings
        ) as check:
            with mock.patch.object(main.sd, "query_devices", return_value=devices):
                with self.assertRaisesRegex(RuntimeError, "Error querying device -1"):
                    main._resolve_input_device()

        self.assertIsNone(main.resolved_input_device)
        self.assertEqual(
            [call.kwargs["device"] for call in check.call_args_list],
            [None, 0, 1],
        )


class MicDeviceStreamReuseTests(unittest.TestCase):
    def setUp(self):
        self.saved_state = {
            "recording_state": main.recording_state,
            "frames": list(main.frames),
            "stream": main.stream,
            "partial_stop_event": main.partial_stop_event,
            "focus_target": main.focus_target,
            "start_cancel_requested": main.start_cancel_requested,
            "resolved_input_device": main.resolved_input_device,
        }
        main.recording_state = main.RecordingState.IDLE
        main.frames = []
        main.stream = None
        main.partial_stop_event = None
        main.focus_target = None
        main.start_cancel_requested = False
        main.resolved_input_device = 4

    def tearDown(self):
        for name, value in self.saved_state.items():
            setattr(main, name, value)

    def test_start_recording_passes_cached_device_index_to_input_stream(self):
        fake_stream = mock.Mock()
        with mock.patch.object(main.sd, "InputStream", return_value=fake_stream) as input_stream:
            with mock.patch.object(main, "capture_focus_target", return_value=None):
                with mock.patch.object(main, "push_status"):
                    with mock.patch.object(main, "push_transcript"):
                        with mock.patch.object(
                            main, "live_partial_transcription_enabled", return_value=False
                        ):
                            main.start_recording()

        input_stream.assert_called_once_with(
            device=4,
            samplerate=main.SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=main.audio_callback,
        )
        self.assertEqual(main.recording_state, main.RecordingState.RECORDING)

    def test_start_recording_retries_with_a_refreshed_device_after_construction_failure(self):
        stale_device_error = main.sd.PortAudioError("invalid device")
        fake_stream = mock.Mock()

        def refresh_device():
            main.resolved_input_device = 9

        with mock.patch.object(
            main.sd, "InputStream", side_effect=[stale_device_error, fake_stream]
        ) as input_stream:
            with mock.patch.object(main, "_resolve_input_device", side_effect=refresh_device) as resolve:
                with mock.patch.object(main, "capture_focus_target", return_value=None):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        with mock.patch.object(main, "push_status") as push_status:
                            with mock.patch.object(main, "push_transcript"):
                                with mock.patch.object(
                                    main, "live_partial_transcription_enabled", return_value=False
                                ):
                                    main.start_recording()

        self.assertEqual([call.kwargs["device"] for call in input_stream.call_args_list], [4, 9])
        resolve.assert_called_once_with()
        emit_diag.assert_called_once_with(
            "STREAM_CONSTRUCTION_RETRY", error_class="PortAudioError"
        )
        push_status.assert_called_once_with("recording", "Listening...")
        self.assertEqual(main.recording_state, main.RecordingState.RECORDING)

    def test_start_recording_does_not_retry_non_portaudio_construction_error(self):
        construction_error = RuntimeError("programming error")

        with mock.patch.object(main.sd, "InputStream", side_effect=construction_error) as input_stream:
            with mock.patch.object(main, "_resolve_input_device") as resolve:
                with mock.patch.object(main, "capture_focus_target", return_value=None):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        with mock.patch.object(main, "push_status") as push_status:
                            with mock.patch.object(main, "push_transcript") as push_transcript:
                                main.start_recording()

        input_stream.assert_called_once()
        resolve.assert_not_called()
        emit_diag.assert_called_once_with(
            "STREAM_CONSTRUCTION_FAILED", error_class="RuntimeError"
        )
        push_status.assert_called_once_with(
            "error", "Could not start recording: programming error"
        )
        push_transcript.assert_called_once_with("")
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)

    def test_start_recording_cancelled_during_retry_returns_to_idle_without_error(self):
        first_error = main.sd.PortAudioError("invalid device")
        retry_error = main.sd.PortAudioError("still invalid")

        def cancel_during_refresh():
            with main.state_lock:
                main.start_cancel_requested = True

        with mock.patch.object(
            main.sd, "InputStream", side_effect=[first_error, retry_error]
        ):
            with mock.patch.object(main, "_resolve_input_device", side_effect=cancel_during_refresh):
                with mock.patch.object(main, "capture_focus_target", return_value=None):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        with mock.patch.object(main, "push_status") as push_status:
                            with mock.patch.object(main, "push_transcript") as push_transcript:
                                main.start_recording()

        emit_diag.assert_called_once_with(
            "STREAM_CONSTRUCTION_RETRY", error_class="PortAudioError"
        )
        push_status.assert_called_once_with("idle", main.IDLE_STATUS)
        push_transcript.assert_not_called()
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)

    def test_start_recording_retry_exhausted_clears_transcript_with_error_status(self):
        first_error = main.sd.PortAudioError("invalid device")
        retry_error = main.sd.PortAudioError("still invalid")

        with mock.patch.object(
            main.sd, "InputStream", side_effect=[first_error, retry_error]
        ):
            with mock.patch.object(main, "_resolve_input_device"):
                with mock.patch.object(main, "capture_focus_target", return_value=None):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        with mock.patch.object(main, "push_status") as push_status:
                            with mock.patch.object(main, "push_transcript") as push_transcript:
                                main.start_recording()

        self.assertEqual(
            emit_diag.call_args_list,
            [
                mock.call("STREAM_CONSTRUCTION_RETRY", error_class="PortAudioError"),
                mock.call("STREAM_CONSTRUCTION_FAILED", error_class="PortAudioError"),
            ],
        )
        push_status.assert_called_once_with(
            "error", "Could not start recording: still invalid"
        )
        push_transcript.assert_called_once_with("")
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)


if __name__ == "__main__":
    unittest.main()
