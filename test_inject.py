"""Regression tests for clipboard paste injection."""

import sys
import types
import unittest
from unittest import mock

import inject


class InjectTests(unittest.TestCase):
    def test_macos_attaches_command_flag_to_both_v_events(self):
        quartz = types.ModuleType("Quartz")
        quartz.kCGEventFlagMaskCommand = 1 << 20
        quartz.kCGHIDEventTap = "hid"
        quartz.CGEventCreateKeyboardEvent = mock.Mock(
            side_effect=["v-down", "v-up"]
        )
        quartz.CGEventSetFlags = mock.Mock()
        quartz.CGEventPost = mock.Mock()

        with (
            mock.patch.dict(sys.modules, {"Quartz": quartz}),
            mock.patch.object(inject.platform, "system", return_value="Darwin"),
            mock.patch.object(inject.pyperclip, "paste", return_value="new"),
            mock.patch.object(inject.pyperclip, "copy") as copy,
            mock.patch.object(inject.pyautogui, "hotkey") as hotkey,
            mock.patch.object(inject.time, "sleep"),
        ):
            inject.inject("new")

        self.assertEqual(
            quartz.CGEventCreateKeyboardEvent.call_args_list,
            [
                mock.call(None, 9, True),
                mock.call(None, 9, False),
            ],
        )
        self.assertEqual(
            quartz.CGEventSetFlags.call_args_list,
            [
                mock.call("v-down", quartz.kCGEventFlagMaskCommand),
                mock.call("v-up", quartz.kCGEventFlagMaskCommand),
            ],
        )
        self.assertEqual(
            quartz.CGEventPost.call_args_list,
            [
                mock.call("hid", "v-down"),
                mock.call("hid", "v-up"),
            ],
        )
        self.assertEqual(copy.call_args_list, [mock.call("new")])
        hotkey.assert_not_called()

    def test_macos_never_restores_stale_clipboard_after_posting_paste(self):
        with (
            mock.patch.object(inject.platform, "system", return_value="Darwin"),
            mock.patch.object(inject.pyperclip, "paste", return_value="new"),
            mock.patch.object(inject.pyperclip, "copy") as copy,
            mock.patch.object(inject, "_paste_macos") as paste,
        ):
            inject.inject("new")

        copy.assert_called_once_with("new")
        paste.assert_called_once_with()

    def test_windows_keeps_ctrl_v_path(self):
        with (
            mock.patch.object(inject.platform, "system", return_value="Windows"),
            mock.patch.object(
                inject.pyperclip, "paste", side_effect=["old", "new"]
            ),
            mock.patch.object(inject.pyperclip, "copy") as copy,
            mock.patch.object(inject.pyautogui, "hotkey") as hotkey,
            mock.patch.object(inject.time, "sleep"),
        ):
            inject.inject("new")

        hotkey.assert_called_once_with("ctrl", "v")
        self.assertEqual(copy.call_args_list, [mock.call("new"), mock.call("old")])

    def test_clipboard_copy_is_retried_and_fails_closed(self):
        with (
            mock.patch.object(inject.pyperclip, "paste", return_value="stale"),
            mock.patch.object(inject.pyperclip, "copy") as copy,
            mock.patch.object(inject.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "did not contain"):
                inject._copy_verified("new")

        self.assertEqual(copy.call_count, 3)
        self.assertEqual(sleep.call_count, 3)


if __name__ == "__main__":
    unittest.main()
