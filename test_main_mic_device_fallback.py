"""Unit tests for startup microphone selection and stream-device reuse.

The sounddevice calls are mocked, so these tests do not need a physical mic.
Run with: python -m unittest test_main_mic_device_fallback -v
"""

import threading
import time
import unittest
from unittest import mock

import main


class MicDeviceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.saved_resolved_device = main.resolved_input_device
        self.saved_resolved_identity = main.resolved_input_device_identity
        main.resolved_input_device = None
        main.resolved_input_device_identity = None

    def tearDown(self):
        main.resolved_input_device = self.saved_resolved_device
        main.resolved_input_device_identity = self.saved_resolved_identity

    def test_default_succeeds_and_captures_identity(self):
        fake_default = mock.Mock(device=[17, 2])
        default_info = {"name": "Built-in Mic", "hostapi": 0}
        with mock.patch.object(main.sd, "check_input_settings") as check:
            with mock.patch.object(main.sd, "query_devices", return_value=default_info) as query:
                with mock.patch.object(main.sd, "default", fake_default):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        main._resolve_input_device()

        self.assertEqual(main.resolved_input_device, 17)
        self.assertEqual(main.resolved_input_device_identity, main._device_identity(default_info))
        check.assert_called_once_with(
            device=17,
            samplerate=main.SAMPLE_RATE,
            channels=1,
        )
        query.assert_called_once_with(17)
        emit_diag.assert_not_called()

    def test_default_failure_uses_first_passing_input_device(self):
        default_error = RuntimeError("Error querying device -1")
        devices = [
            {"name": "Output only", "max_input_channels": 0},
            {"name": "First microphone", "max_input_channels": 1},
            {"name": "Second microphone", "max_input_channels": 2},
        ]

        fake_default = mock.Mock(device=[0, 2])

        def query_devices(index=None):
            return {"name": "Default", "hostapi": 0} if index is not None else devices

        def check_input_settings(**kwargs):
            if kwargs["device"] == 0:
                raise default_error

        with mock.patch.object(
            main.sd, "check_input_settings", side_effect=check_input_settings
        ) as check:
            with mock.patch.object(main.sd, "query_devices", side_effect=query_devices) as query:
                with mock.patch.object(main.sd, "default", fake_default):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        main._resolve_input_device()

        self.assertEqual(main.resolved_input_device, 1)
        self.assertEqual(
            main.resolved_input_device_identity,
            main._device_identity(devices[1]),
        )
        self.assertEqual(query.call_args_list, [mock.call(0), mock.call()])
        self.assertEqual(
            [call.kwargs["device"] for call in check.call_args_list],
            [0, 1],
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

        fake_default = mock.Mock(device=[0, 2])

        def query_devices(index=None):
            return {"name": "Default", "hostapi": 0} if index is not None else devices

        def check_input_settings(**kwargs):
            raise default_error if kwargs["device"] == 0 else fallback_error

        main.resolved_input_device = 99
        with mock.patch.object(
            main.sd, "check_input_settings", side_effect=check_input_settings
        ) as check:
            with mock.patch.object(main.sd, "query_devices", side_effect=query_devices):
                with mock.patch.object(main.sd, "default", fake_default):
                    with self.assertRaisesRegex(RuntimeError, "Error querying device -1"):
                        main._resolve_input_device()

        self.assertIsNone(main.resolved_input_device)
        self.assertEqual(
            [call.kwargs["device"] for call in check.call_args_list],
            [0, 0, 1],
        )

    def test_exclude_devices_skips_the_default_device_entirely(self):
        # sd.default.device[0] resolves (by identity, not index) to the
        # excluded device - must not even attempt the default check, straight
        # to enumeration.
        excluded_info = {"name": "Excluded", "hostapi": 0, "max_input_channels": 1}
        other_info = {"name": "Other microphone", "hostapi": 0, "max_input_channels": 1}
        devices = [excluded_info, other_info]
        fake_default = mock.Mock(device=[0, 2])

        def query_devices(index=None):
            return devices if index is None else devices[index]

        with mock.patch.object(main.sd, "default", fake_default):
            with mock.patch.object(main.sd, "check_input_settings") as check:
                with mock.patch.object(main.sd, "query_devices", side_effect=query_devices):
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        main._resolve_input_device(
                            exclude_devices={main._device_identity(excluded_info)}
                        )

        self.assertEqual(main.resolved_input_device, 1)
        self.assertEqual(
            main.resolved_input_device_identity,
            main._device_identity(other_info),
        )
        # The excluded default must never be format-checked once its own
        # identity is known - only the surviving candidate is checked.
        check.assert_called_once_with(device=1, samplerate=main.SAMPLE_RATE, channels=1)
        emit_diag.assert_called_once_with(
            "MIC_FALLBACK_DEVICE_USED", requested="default", actual=1
        )

    def test_exclude_devices_skips_a_candidate_during_enumeration(self):
        default_error = RuntimeError("Error querying device -1")
        excluded_info = {"name": "First microphone", "hostapi": 0, "max_input_channels": 1}
        other_info = {"name": "Second microphone", "hostapi": 0, "max_input_channels": 1}
        devices = [excluded_info, other_info]
        # Default device (index 1) is NOT the excluded one - this test is
        # about excluding a candidate found only during enumeration, not the
        # default itself (see test_exclude_devices_skips_the_default_device_entirely).
        fake_default = mock.Mock(device=[1, 2])

        def query_devices(index=None):
            return devices if index is None else devices[index]

        check_calls = 0

        def check_input_settings(**kwargs):
            nonlocal check_calls
            check_calls += 1
            if check_calls == 1:
                raise default_error

        with mock.patch.object(main.sd, "default", fake_default):
            with mock.patch.object(
                main.sd, "check_input_settings", side_effect=check_input_settings
            ) as check:
                with mock.patch.object(main.sd, "query_devices", side_effect=query_devices):
                    with mock.patch.object(main, "emit_diag"):
                        main._resolve_input_device(
                            exclude_devices={main._device_identity(excluded_info)}
                        )

        self.assertEqual(main.resolved_input_device, 1)
        self.assertEqual(
            main.resolved_input_device_identity,
            main._device_identity(other_info),
        )
        self.assertEqual(
            [call.kwargs["device"] for call in check.call_args_list],
            [1, 1],
        )

    def test_exclusion_survives_index_churn_between_enumerations(self):
        """The exact bug Codex touchpoint-3 flagged: if exclusion were keyed
        by raw index, a device re-enumerated at a different index between
        calls would slip back in. Identity-based exclusion must not do this
        - the same physical device (by name+hostapi), now at a different
        index, is still skipped."""
        bad_device = {"name": "Bad Bluetooth Mic", "hostapi": 0, "max_input_channels": 1}
        good_device = {"name": "Built-in Mic", "hostapi": 0, "max_input_channels": 1}
        # First enumeration: bad device at index 0, good at index 1.
        # Second enumeration (simulating CoreAudio renumbering): swapped.
        devices_by_call = [
            [bad_device, good_device],
            [good_device, bad_device],
        ]
        call_count = {"n": 0}

        def query_devices():
            devices = devices_by_call[call_count["n"]]
            call_count["n"] += 1
            return devices

        default_error = RuntimeError("no default")

        def check_input_settings(**kwargs):
            return None

        def query_devices_with_default(index=None):
            if index is not None:
                raise default_error
            return query_devices()

        with mock.patch.object(main.sd, "default", mock.Mock(device=[0, 2])):
            with mock.patch.object(main.sd, "check_input_settings", side_effect=check_input_settings):
                with mock.patch.object(main.sd, "query_devices", side_effect=query_devices_with_default):
                    with mock.patch.object(main, "emit_diag"):
                        main._resolve_input_device(
                            exclude_devices={main._device_identity(bad_device)}
                        )
                        first_pick = main.resolved_input_device
                        main._resolve_input_device(
                            exclude_devices={main._device_identity(bad_device)}
                        )
                        second_pick = main.resolved_input_device

        # Both calls must resolve to whichever index good_device happens to
        # be at that time (1, then 0) - never to bad_device's index (0, then 1).
        self.assertEqual(first_pick, 1)
        self.assertEqual(second_pick, 0)


class LiveInputDeviceRecoveryTests(unittest.TestCase):
    """_resolve_live_input_device() - the 2026-09-23 fix for a confirmed
    live bug: a plain re-resolve after digital silence kept landing back on
    the exact same enumerated-but-not-actually-live device, so every press
    after the first failed identically until the app was relaunched."""

    def setUp(self):
        self.saved_resolved_device = main.resolved_input_device
        self.saved_resolved_identity = main.resolved_input_device_identity
        main.resolved_input_device = None
        main.resolved_input_device_identity = None

    def tearDown(self):
        main.resolved_input_device = self.saved_resolved_device
        main.resolved_input_device_identity = self.saved_resolved_identity

    def test_first_candidate_live_resolves_in_one_attempt(self):
        def fake_resolve(exclude_devices=None):
            self.assertEqual(exclude_devices, set())
            main.resolved_input_device = 5
            main.resolved_input_device_identity = ("Built-in Mic", 0)

        with mock.patch.object(main, "_resolve_input_device", side_effect=fake_resolve) as resolve:
            with mock.patch.object(main, "_probe_device_is_live", return_value=True) as probe:
                result = main._resolve_live_input_device()

        self.assertTrue(result)
        self.assertEqual(main.resolved_input_device, 5)
        resolve.assert_called_once_with(exclude_devices=set())
        probe.assert_called_once_with(5)

    def test_silent_candidate_is_excluded_and_next_one_is_probed(self):
        calls = []
        device_2_info = {"name": "Bad Bluetooth Mic", "hostapi": 0}
        device_5_info = {"name": "Built-in Mic", "hostapi": 0}
        device_2_identity = main._device_identity(device_2_info)
        device_5_identity = main._device_identity(device_5_info)

        def fake_resolve(exclude_devices=None):
            calls.append(set(exclude_devices))
            if not exclude_devices:
                main.resolved_input_device = 2
                main.resolved_input_device_identity = device_2_identity
            else:
                main.resolved_input_device = 5
                main.resolved_input_device_identity = device_5_identity

        def fake_probe(device_index):
            return device_index == 5

        with mock.patch.object(main, "_resolve_input_device", side_effect=fake_resolve):
            with mock.patch.object(main, "_probe_device_is_live", side_effect=fake_probe):
                with mock.patch.object(main.sd, "query_devices") as query:
                    result = main._resolve_live_input_device()

        self.assertTrue(result)
        self.assertEqual(main.resolved_input_device, 5)
        self.assertEqual(calls, [set(), {device_2_identity}])
        query.assert_not_called()

    def test_every_candidate_silent_gives_up_after_max_attempts(self):
        seen_excludes = []
        device_infos = {
            1: {"name": "Device 1", "hostapi": 0},
            2: {"name": "Device 2", "hostapi": 0},
            3: {"name": "Device 3", "hostapi": 0},
        }

        def fake_resolve(exclude_devices=None):
            seen_excludes.append(set(exclude_devices))
            device_index = len(seen_excludes)
            main.resolved_input_device = device_index
            main.resolved_input_device_identity = main._device_identity(
                device_infos[device_index]
            )

        with mock.patch.object(main, "_resolve_input_device", side_effect=fake_resolve):
            with mock.patch.object(main, "_probe_device_is_live", return_value=False):
                with mock.patch.object(main.sd, "query_devices") as query:
                    with mock.patch.object(main, "emit_diag") as emit_diag:
                        result = main._resolve_live_input_device(max_attempts=3)

        self.assertFalse(result)
        self.assertEqual(len(seen_excludes), 3)
        # Each attempt excludes every device already proven silent so far -
        # never re-probes the same dead device twice.
        self.assertEqual(
            seen_excludes,
            [
                set(),
                {main._device_identity(device_infos[1])},
                {main._device_identity(device_infos[1]), main._device_identity(device_infos[2])},
            ],
        )
        # On exhaustion, resolved_input_device must NOT be left pointing at
        # the device that was just proven silent (Codex touchpoint-3 finding,
        # 2026-09-23) - it's cleared so the next real start_recording() call
        # passes device=None (sounddevice's own current default) instead of
        # deliberately reopening a known-dead device.
        self.assertIsNone(main.resolved_input_device)
        self.assertIsNone(main.resolved_input_device_identity)
        emit_diag.assert_called_once_with("MIC_LIVE_PROBE_EXHAUSTED", actual=3)
        query.assert_not_called()

    def test_unresolvable_device_stops_immediately_without_probing(self):
        def fake_resolve(exclude_devices=None):
            main.resolved_input_device = None
            main.resolved_input_device_identity = None

        with mock.patch.object(main, "_resolve_input_device", side_effect=fake_resolve):
            with mock.patch.object(main, "_probe_device_is_live") as probe:
                result = main._resolve_live_input_device()

        self.assertFalse(result)
        probe.assert_not_called()

    def test_probe_timeout_aborts_candidate_rotation_and_clears_device(self):
        def fake_resolve(exclude_devices=None):
            main.resolved_input_device = 4
            main.resolved_input_device_identity = ("Blocked Mic", 0)

        with mock.patch.object(main, "_resolve_input_device", side_effect=fake_resolve) as resolve:
            with mock.patch.object(
                main, "_probe_device_is_live", side_effect=main._LiveProbeTimeout
            ) as probe:
                with self.assertRaises(main._LiveProbeTimeout):
                    main._resolve_live_input_device(max_attempts=3)

        resolve.assert_called_once_with(exclude_devices=set())
        probe.assert_called_once_with(4)
        self.assertIsNone(main.resolved_input_device)
        self.assertIsNone(main.resolved_input_device_identity)


class DeviceLiveProbeTests(unittest.TestCase):
    def test_real_signal_is_reported_live(self):
        audio = main.np.zeros(int(main.LIVE_PROBE_DURATION_S * main.SAMPLE_RATE), dtype=main.np.float32)
        audio[0] = 0.5
        with mock.patch.object(main.sd, "rec", return_value=audio) as rec:
            with mock.patch.object(main.sd, "wait"):
                self.assertTrue(main._probe_device_is_live(3))

        rec.assert_called_once_with(
            int(main.LIVE_PROBE_DURATION_S * main.SAMPLE_RATE),
            samplerate=main.SAMPLE_RATE,
            channels=1,
            dtype="float32",
            device=3,
        )

    def test_true_silence_is_reported_not_live(self):
        audio = main.np.zeros(int(main.LIVE_PROBE_DURATION_S * main.SAMPLE_RATE), dtype=main.np.float32)
        with mock.patch.object(main.sd, "rec", return_value=audio):
            with mock.patch.object(main.sd, "wait"):
                self.assertFalse(main._probe_device_is_live(3))

    def test_capture_error_is_reported_not_live(self):
        with mock.patch.object(main.sd, "rec", side_effect=RuntimeError("device gone")):
            with mock.patch.object(main, "emit_diag") as emit_diag:
                self.assertFalse(main._probe_device_is_live(3))

        emit_diag.assert_called_once_with(
            "MIC_LIVE_PROBE_FAILED", actual=3, error_class="RuntimeError"
        )

    def test_hung_capture_times_out_instead_of_blocking_forever(self):
        """Codex touchpoint-3 finding, 2026-09-23: sd.rec()/sd.wait() have no
        timeout of their own, and this runs while stop_recording() holds
        state_lock - a stuck CoreAudio capture must not hang that lock (and
        every other state transition) indefinitely. It requests backend
        recovery rather than moving on to another candidate while the native
        worker may still hold the audio device."""
        release_worker = threading.Event()
        worker_threads_before = set(threading.enumerate())

        def hung_wait():
            release_worker.wait(5)  # released by the test itself, well after the probe's own short timeout

        try:
            with mock.patch.object(main, "LIVE_PROBE_TIMEOUT_S", 0.05):
                with mock.patch.object(main.sd, "rec", return_value=main.np.zeros(1, dtype=main.np.float32)):
                    with mock.patch.object(main.sd, "wait", side_effect=hung_wait):
                        with mock.patch.object(main, "emit_diag") as emit_diag:
                            with mock.patch.object(main, "push_status") as push_status:
                                with mock.patch.object(main, "emit_event") as emit_event:
                                    started = time.monotonic()
                                    with self.assertRaises(main._LiveProbeTimeout):
                                        main._probe_device_is_live(3)
                                    elapsed = time.monotonic() - started
                                    probe_workers = set(threading.enumerate()) - worker_threads_before
                                    self.assertEqual(len(probe_workers), 1)
        finally:
            release_worker.set()  # let the abandoned daemon thread finish before the test exits
            probe_worker = next(iter(probe_workers))
            probe_worker.join(timeout=1.0)
            self.assertFalse(probe_worker.is_alive())

        self.assertLess(elapsed, 1.0)  # bounded by LIVE_PROBE_TIMEOUT_S, not the 5s hang
        emit_diag.assert_called_once_with(
            "MIC_LIVE_PROBE_TIMEOUT", actual=3, timeout_ms=50
        )
        push_status.assert_called_once_with("recovering", main.RECOVERING_STATUS)
        emit_event.assert_called_once_with(
            {"type": "backend_recovery_required", "code": "MIC_LIVE_PROBE_TIMEOUT"}
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
