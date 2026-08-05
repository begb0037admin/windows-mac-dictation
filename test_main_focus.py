"""
Unit tests for main.py's macOS AppleEvents focus capture/restore hardening
(capture_focus_target()/restore_focus_target()'s Darwin branches):
check=True conversion of a nonzero osascript exit into a structured
FOCUS_CAPTURE_FAILED/FOCUS_RESTORE_FAILED diagnostic, never raised to the
caller and never blocking dictation.

Covers acceptance-plan "Required Python cases" case 11.

Run with: python -m unittest test_main_focus -v
"""

import subprocess
import unittest
from unittest import mock

import main


class DarwinFocusCaptureTests(unittest.TestCase):
    def setUp(self):
        self.platform_patcher = mock.patch.object(main.platform, "system", return_value="Darwin")
        self.platform_patcher.start()
        self.emit_diag_patcher = mock.patch.object(main, "emit_diag")
        self.mock_emit_diag = self.emit_diag_patcher.start()

    def tearDown(self):
        self.platform_patcher.stop()
        self.emit_diag_patcher.stop()

    def test_permission_denial_emits_focus_capture_failed_and_returns_none_without_raising(self):
        denied = subprocess.CalledProcessError(1, ["osascript"])
        with mock.patch.object(main.subprocess, "run", side_effect=denied):
            result = main.capture_focus_target()

        self.assertIsNone(result)
        self.mock_emit_diag.assert_called_once_with(
            "FOCUS_CAPTURE_FAILED", error_class="CalledProcessError"
        )

    def test_timeout_emits_focus_capture_failed_without_raising(self):
        timeout = subprocess.TimeoutExpired(cmd=["osascript"], timeout=2)
        with mock.patch.object(main.subprocess, "run", side_effect=timeout):
            result = main.capture_focus_target()

        self.assertIsNone(result)
        self.mock_emit_diag.assert_called_once_with(
            "FOCUS_CAPTURE_FAILED", error_class="TimeoutExpired"
        )

    def test_healthy_capture_emits_no_diagnostic(self):
        completed = mock.Mock(stdout="Notes\n")
        with mock.patch.object(main.subprocess, "run", return_value=completed) as mock_run:
            result = main.capture_focus_target()

        self.assertEqual(result, "Notes")
        self.mock_emit_diag.assert_not_called()
        # check=True must actually be passed through, not just documented.
        self.assertTrue(mock_run.call_args.kwargs.get("check"))


class DarwinFocusRestoreTests(unittest.TestCase):
    def setUp(self):
        self.platform_patcher = mock.patch.object(main.platform, "system", return_value="Darwin")
        self.platform_patcher.start()
        self.emit_diag_patcher = mock.patch.object(main, "emit_diag")
        self.mock_emit_diag = self.emit_diag_patcher.start()

    def tearDown(self):
        self.platform_patcher.stop()
        self.emit_diag_patcher.stop()

    def test_permission_denial_emits_focus_restore_failed_without_raising(self):
        denied = subprocess.CalledProcessError(1, ["osascript"])
        with mock.patch.object(main.subprocess, "run", side_effect=denied):
            main.restore_focus_target("Teams")  # must not raise

        self.mock_emit_diag.assert_called_once_with(
            "FOCUS_RESTORE_FAILED", error_class="CalledProcessError"
        )

    def test_healthy_restore_emits_no_diagnostic(self):
        with mock.patch.object(main.subprocess, "run", return_value=mock.Mock()) as mock_run:
            main.restore_focus_target("Notes")

        self.mock_emit_diag.assert_not_called()
        self.assertTrue(mock_run.call_args.kwargs.get("check"))

    def test_no_target_is_a_no_op(self):
        with mock.patch.object(main.subprocess, "run") as mock_run:
            main.restore_focus_target(None)

        mock_run.assert_not_called()
        self.mock_emit_diag.assert_not_called()


if __name__ == "__main__":
    unittest.main()
