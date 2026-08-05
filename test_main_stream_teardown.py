"""
Unit tests for main.py's CoreAudio stream-teardown recovery: the
RecordingState state machine, bounded_teardown_stream(), and
start_recording()/stop_recording()'s restructured control flow.

Covers acceptance-plan "Required Python cases" 1-10, 12, 14 (case 11,
Darwin AppleEvents diagnostics, lives in test_main_focus.py; case 13 is
Electron-side, in electron/tests/test_recovery_orchestration.mjs).

Run with: python -m unittest test_main_stream_teardown -v
"""

import threading
import time
import unittest
from unittest import mock

import main


class FakeStream:
    """A minimal sd.InputStream stand-in whose start()/stop()/close() are
    each independently controllable - raise, block, or succeed - so every
    branch of bounded_teardown_stream() and start_recording()/
    stop_recording() can be exercised deterministically and fast, without a
    real audio device."""

    def __init__(self, *, start_exc=None, stop_exc=None, close_exc=None,
                 close_block_event=None):
        self.start_exc = start_exc
        self.stop_exc = stop_exc
        self.close_exc = close_exc
        # If set, close() blocks until this Event is set (or forever, for the
        # "hung close" cases - the test itself bounds real wall-clock time by
        # shrinking main.STREAM_TEARDOWN_TIMEOUT_S, not this event).
        self.close_block_event = close_block_event
        self.start_calls = 0
        self.stop_calls = 0
        self.close_calls = 0

    def start(self):
        self.start_calls += 1
        if self.start_exc:
            raise self.start_exc

    def stop(self):
        self.stop_calls += 1
        if self.stop_exc:
            raise self.stop_exc

    def close(self):
        self.close_calls += 1
        if self.close_block_event is not None:
            # Blocks until released, or effectively "hangs" for this test's
            # purposes if never set - bounded from the test's perspective by
            # the (shrunk) STREAM_TEARDOWN_TIMEOUT_S join(), not by this wait.
            self.close_block_event.wait(5.0)
        if self.close_exc:
            raise self.close_exc


class StreamTeardownTestCase(unittest.TestCase):
    """Base fixture: resets the module-level recording state machine before
    and after every test, and patches out real I/O (emit_event, push_status,
    focus capture, live-caption threads) so tests run fast and offline."""

    def setUp(self):
        self.saved_state = {
            "recording_state": main.recording_state,
            "frames": list(main.frames),
            "stream": main.stream,
            "partial_stop_event": main.partial_stop_event,
            "focus_target": main.focus_target,
            "start_cancel_requested": main.start_cancel_requested,
            "STREAM_TEARDOWN_TIMEOUT_S": main.STREAM_TEARDOWN_TIMEOUT_S,
        }
        main.recording_state = main.RecordingState.IDLE
        main.frames = []
        main.stream = None
        main.partial_stop_event = None
        main.focus_target = None
        main.start_cancel_requested = False
        # Real teardown timeout is 3.0s; tests that need a genuinely "hung"
        # close use a small timeout so the timeout path fires in well under
        # a second instead of the real 3s margin.
        main.STREAM_TEARDOWN_TIMEOUT_S = 0.1

        self.emit_event_patcher = mock.patch.object(main, "emit_event")
        self.push_status_patcher = mock.patch.object(main, "push_status")
        self.emit_diag_patcher = mock.patch.object(main, "emit_diag")
        self.focus_patcher = mock.patch.object(main, "capture_focus_target", return_value=None)
        self.live_captions_patcher = mock.patch.object(
            main, "live_partial_transcription_enabled", return_value=False
        )
        self.mock_emit_event = self.emit_event_patcher.start()
        self.mock_push_status = self.push_status_patcher.start()
        self.mock_emit_diag = self.emit_diag_patcher.start()
        self.focus_patcher.start()
        self.live_captions_patcher.start()

    def tearDown(self):
        self.emit_event_patcher.stop()
        self.push_status_patcher.stop()
        self.emit_diag_patcher.stop()
        self.focus_patcher.stop()
        self.live_captions_patcher.stop()
        for name, value in self.saved_state.items():
            setattr(main, name, value)

    def patch_input_stream(self, fake_stream):
        return mock.patch.object(main.sd, "InputStream", return_value=fake_stream)

    def push_status_states(self):
        return [call.args[0] for call in self.mock_push_status.call_args_list]

    def teardown_events(self):
        return [
            call.args[0] for call in self.mock_emit_event.call_args_list
            if call.args[0].get("type") == "stream_teardown"
        ]

    def recovery_events(self):
        return [
            call.args[0] for call in self.mock_emit_event.call_args_list
            if call.args[0].get("type") == "backend_recovery_required"
        ]


class HealthyStopTests(StreamTeardownTestCase):
    def test_case1_healthy_stop_calls_stop_and_close_once_and_reaches_idle(self):
        fake = FakeStream()
        with self.patch_input_stream(fake):
            main.start_recording()
        self.assertEqual(main.recording_state, main.RecordingState.RECORDING)

        main.stop_recording()

        self.assertEqual(fake.stop_calls, 1)
        self.assertEqual(fake.close_calls, 1)
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        self.assertEqual(self.recovery_events(), [])

    def test_case2_stop_exception_still_calls_close_and_reaches_idle(self):
        fake = FakeStream(stop_exc=RuntimeError("stop boom"))
        with self.patch_input_stream(fake):
            main.start_recording()

        main.stop_recording()

        self.assertEqual(fake.close_calls, 1, "close() must still be attempted after a stop() exception")
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        self.assertEqual(self.recovery_events(), [])

    def test_case3_close_exception_emits_recovery_and_stays_stopping(self):
        fake = FakeStream(close_exc=RuntimeError("close boom"))
        with self.patch_input_stream(fake):
            main.start_recording()

        main.stop_recording()

        self.assertEqual(main.recording_state, main.RecordingState.STOPPING)
        self.assertEqual(len(self.recovery_events()), 1)
        self.assertEqual(self.recovery_events()[0]["code"], "STREAM_CLOSE_ERROR")
        self.assertIn("recovering", self.push_status_states())

    def test_case4_hung_close_returns_within_timeout_margin_emits_recovery_stays_stopping(self):
        block_event = threading.Event()  # never set - close() "hangs"
        fake = FakeStream(close_block_event=block_event)
        with self.patch_input_stream(fake):
            main.start_recording()

        started_at = time.perf_counter()
        main.stop_recording()
        elapsed = time.perf_counter() - started_at

        # Bounded well inside a comfortable margin over the shrunk timeout,
        # never anywhere near the real hang this fixes (2m14s, confirmed
        # live) or even the real 3.0s production constant.
        self.assertLess(elapsed, main.STREAM_TEARDOWN_TIMEOUT_S + 1.0)
        self.assertEqual(main.recording_state, main.RecordingState.STOPPING)
        self.assertEqual(len(self.recovery_events()), 1)
        self.assertEqual(self.recovery_events()[0]["code"], "STREAM_TEARDOWN_TIMEOUT")


class StartFailureTests(StreamTeardownTestCase):
    def test_case5_construction_failure_returns_to_idle_without_attempting_close(self):
        with mock.patch.object(main.sd, "InputStream", side_effect=RuntimeError("no device")):
            main.start_recording()

        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        self.mock_emit_diag.assert_any_call("STREAM_CONSTRUCTION_FAILED", error_class="RuntimeError")

    def test_case6_start_failure_closes_via_helper_and_ends_idle_on_healthy_close(self):
        fake = FakeStream(start_exc=RuntimeError("start boom"))
        with self.patch_input_stream(fake):
            main.start_recording()

        self.assertEqual(fake.close_calls, 1)
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        ops = [e["operation"] for e in self.teardown_events()]
        self.assertIn("start_failure", ops)


class CancellationTests(StreamTeardownTestCase):
    def test_case7_release_before_start_never_reaches_recording_ends_idle_on_healthy_close(self):
        release_now = threading.Event()

        def fake_input_stream(**kwargs):
            # Simulate stop_recording() racing in between stream
            # construction and stream.start() - exactly step 6's window.
            main.stop_recording()
            release_now.set()
            return FakeStream()

        with mock.patch.object(main, "capture_focus_target", return_value="SomeApp"):
            with mock.patch.object(main.sd, "InputStream", side_effect=fake_input_stream):
                main.start_recording()

        self.assertTrue(release_now.is_set())
        self.assertNotEqual(main.recording_state, main.RecordingState.RECORDING)
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        ops = [e["operation"] for e in self.teardown_events()]
        self.assertIn("cancelled_start", ops)
        # cancelled_start uses call_stop=False - close() is still attempted
        # by bounded_teardown_stream regardless.

    def test_case8_hung_cancellation_cleanup_requests_recovery_and_stays_stopping(self):
        block_event = threading.Event()  # never set - close() "hangs"

        def fake_input_stream(**kwargs):
            main.stop_recording()
            return FakeStream(close_block_event=block_event)

        with mock.patch.object(main.sd, "InputStream", side_effect=fake_input_stream):
            main.start_recording()

        self.assertEqual(main.recording_state, main.RecordingState.STOPPING)
        self.assertEqual(len(self.recovery_events()), 1)

    def test_case14_release_after_start_succeeded_uses_call_stop_true_ends_idle(self):
        real_stream_holder = {}

        class TrackingFakeStream(FakeStream):
            def start(self):
                super().start()
                # Cancellation arrives strictly after .start() has already
                # succeeded - step 8's window, distinct from case 7's step 6.
                main.stop_recording()

        def fake_input_stream(**kwargs):
            fs = TrackingFakeStream()
            real_stream_holder["stream"] = fs
            return fs

        with mock.patch.object(main.sd, "InputStream", side_effect=fake_input_stream):
            main.start_recording()

        fake = real_stream_holder["stream"]
        self.assertEqual(fake.start_calls, 1)
        self.assertEqual(fake.stop_calls, 1, "call_stop=True: stop() must actually be invoked here")
        self.assertEqual(fake.close_calls, 1)
        self.assertNotEqual(main.recording_state, main.RecordingState.RECORDING)
        self.assertEqual(main.recording_state, main.RecordingState.IDLE)
        ops = [e["operation"] for e in self.teardown_events()]
        self.assertIn("post_start_cancelled", ops)


class SynchronousCallbackTests(StreamTeardownTestCase):
    def test_case9_synchronous_callback_during_start_remains_in_frames(self):
        import numpy as np

        class SyncCallbackStream(FakeStream):
            def start(self):
                super().start()
                # A real InputStream can fire the audio callback
                # synchronously from within start() itself.
                main.audio_callback(np.zeros((10, 1), dtype="float32"), 10, None, None)

        with mock.patch.object(main.sd, "InputStream", return_value=SyncCallbackStream()):
            main.start_recording()

        self.assertEqual(main.recording_state, main.RecordingState.RECORDING)
        self.assertEqual(len(main.frames), 1, "the synchronous callback's frame must be preserved, not dropped")


class DuplicatePressTests(StreamTeardownTestCase):
    def test_case10_new_press_during_stopping_constructs_no_stream_no_focus_capture(self):
        main.recording_state = main.RecordingState.STOPPING

        with mock.patch.object(main.sd, "InputStream") as mock_input_stream:
            with mock.patch.object(main, "capture_focus_target") as mock_capture:
                main.start_recording()

        mock_input_stream.assert_not_called()
        mock_capture.assert_not_called()
        self.assertEqual(main.recording_state, main.RecordingState.STOPPING)
        self.assertIn("stopping", self.push_status_states())

    def test_case12_press_during_initializing_is_a_no_op(self):
        main.recording_state = main.RecordingState.INITIALIZING

        with mock.patch.object(main.sd, "InputStream") as mock_input_stream:
            with mock.patch.object(main, "capture_focus_target") as mock_capture:
                main.start_recording()

        mock_input_stream.assert_not_called()
        mock_capture.assert_not_called()
        self.assertEqual(main.recording_state, main.RecordingState.INITIALIZING)
        self.assertEqual(main.frames, [])


if __name__ == "__main__":
    unittest.main()
