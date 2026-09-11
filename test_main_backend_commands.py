"""
Unit tests for main.py's handle_command() stdin-command dispatch, in
particular the touch-trigger commands (start_recording/stop_recording)
added 2026-09-11 so the UI (tap/double-tap on the pill) can drive
recording the same way the physical hotkey does. No mic/GPU needed -
start_recording/stop_recording are mocked, never actually invoked.

Run with: python -m unittest test_main_backend_commands -v
"""

import threading
import unittest
from unittest import mock

import main


class HandleCommandRecordingTests(unittest.TestCase):
    @mock.patch("main.start_recording")
    def test_start_recording_command_calls_start_recording(self, mock_start):
        main.handle_command({"cmd": "start_recording"})
        mock_start.assert_called_once_with()

    @mock.patch("main.stop_recording")
    def test_stop_recording_command_calls_stop_recording_off_main_thread(self, mock_stop):
        # stop_recording() blocks on stream teardown/transcription kickoff
        # (same reason on_release() spawns a thread) - assert it runs on a
        # different thread, then wait for it so the mock call is visible.
        calling_threads = []

        def record_thread(*_args, **_kwargs):
            calling_threads.append(threading.current_thread())

        mock_stop.side_effect = record_thread

        main.handle_command({"cmd": "stop_recording"})

        # Give the spawned daemon thread a moment to run.
        for thread in threading.enumerate():
            if thread is not threading.main_thread() and thread.name.startswith("Thread"):
                thread.join(timeout=1)

        mock_stop.assert_called_once_with()
        self.assertEqual(len(calling_threads), 1)
        self.assertIsNot(calling_threads[0], threading.main_thread())


class HandleCommandExistingRoutesUntouchedTests(unittest.TestCase):
    """The new elif branches must not have disturbed the existing routes."""

    @mock.patch("main.emit_event")
    @mock.patch("main.get_config_dict", return_value={"type": "config"})
    def test_get_config_still_routes(self, mock_get_config, mock_emit):
        main.handle_command({"cmd": "get_config"})
        mock_emit.assert_called_once_with({"type": "config"})

    @mock.patch("main.cmd_save_config")
    def test_save_config_still_routes(self, mock_save):
        main.handle_command({"cmd": "save_config", "data": {"theme": "dark"}})
        mock_save.assert_called_once_with({"theme": "dark"})

    def test_unknown_command_is_a_silent_noop(self):
        # Must not raise - handle_command() logs to stderr and returns.
        main.handle_command({"cmd": "not_a_real_command"})


if __name__ == "__main__":
    unittest.main()
