"""
Unit tests for main.py's resolve_hotkey() - covers both keyboard and mouse
button resolution (mouse support added so middle-click etc. can be used as
the push-to-talk hotkey). No mic/GPU needed.

Run with: python -m unittest test_main_hotkey -v
"""

import unittest
from unittest import mock

from pynput import keyboard, mouse

import main


class ResolveHotkeyKeyboardTests(unittest.TestCase):
    def test_named_key_resolves_to_pynput_key(self):
        self.assertEqual(main.resolve_hotkey("ctrl_r"), keyboard.Key.ctrl_r)

    def test_single_character_resolves_to_keycode(self):
        self.assertEqual(main.resolve_hotkey("f"), keyboard.KeyCode.from_char("f"))

    def test_unrecognised_name_raises(self):
        with self.assertRaises(ValueError):
            main.resolve_hotkey("not_a_real_key_name")


class ResolveHotkeyMouseTests(unittest.TestCase):
    def test_mouse_middle_resolves_to_pynput_button(self):
        self.assertEqual(main.resolve_hotkey("mouse_middle"), mouse.Button.middle)

    def test_mouse_left_resolves_to_pynput_button(self):
        self.assertEqual(main.resolve_hotkey("mouse_left"), mouse.Button.left)

    def test_mouse_right_resolves_to_pynput_button(self):
        self.assertEqual(main.resolve_hotkey("mouse_right"), mouse.Button.right)

    def test_resolved_mouse_button_is_detected_as_mouse(self):
        self.assertIsInstance(main.resolve_hotkey("mouse_middle"), mouse.Button)
        self.assertNotIsInstance(main.resolve_hotkey("ctrl_r"), mouse.Button)


class RuntimeHotkeyTests(unittest.TestCase):
    def setUp(self):
        self.saved_state = {
            "HOTKEY_NAME": main.HOTKEY_NAME,
            "HOTKEY": main.HOTKEY,
            "HOTKEY_IS_MOUSE": main.HOTKEY_IS_MOUSE,
            "HOTKEY_DISPLAY": main.HOTKEY_DISPLAY,
            "IDLE_STATUS": main.IDLE_STATUS,
            "hotkey_listener": main.hotkey_listener,
            "config_hotkey": main.config["hotkey"],
        }

    def tearDown(self):
        for name, value in self.saved_state.items():
            if name == "config_hotkey":
                main.config["hotkey"] = value
            else:
                setattr(main, name, value)

    def test_switches_live_listener_and_updates_config_response(self):
        old_listener = mock.Mock()
        new_listener = mock.Mock()
        main.HOTKEY_NAME = "alt_l"
        main.HOTKEY = keyboard.Key.alt_l
        main.HOTKEY_IS_MOUSE = False
        main.HOTKEY_DISPLAY = "Option (left)"
        main.IDLE_STATUS = "Hold Option (left) to record"
        main.hotkey_listener = old_listener
        main.config["hotkey"] = "alt_l"

        def start_new_listener():
            main.hotkey_listener = new_listener
            return new_listener

        with (
            mock.patch.object(main, "run_hotkey_listener", side_effect=start_new_listener),
            mock.patch.object(main, "emit_event") as emit_event,
            mock.patch.object(main, "push_status") as push_status,
        ):
            changed = main.apply_runtime_hotkey("mouse_middle")

        self.assertTrue(changed)
        old_listener.stop.assert_called_once_with()
        old_listener.join.assert_called_once_with()
        self.assertIs(main.hotkey_listener, new_listener)
        self.assertEqual(main.HOTKEY_NAME, "mouse_middle")
        self.assertEqual(main.HOTKEY, mouse.Button.middle)
        self.assertTrue(main.HOTKEY_IS_MOUSE)
        self.assertEqual(main.HOTKEY_DISPLAY, "Middle Mouse Button")
        self.assertEqual(main.IDLE_STATUS, "Hold Middle Mouse Button to record")
        self.assertEqual(main.config["hotkey"], "mouse_middle")
        self.assertEqual(main.get_config_dict()["hotkey_raw"], "mouse_middle")
        emit_event.assert_called_once_with({
            "type": "ready",
            "hotkey_raw": "mouse_middle",
            "hotkey_display": "Middle Mouse Button",
        })
        push_status.assert_called_once_with(
            "idle", "Hold Middle Mouse Button to record"
        )

    def test_same_hotkey_does_not_restart_listener(self):
        listener = mock.Mock()
        main.hotkey_listener = listener

        with mock.patch.object(main, "run_hotkey_listener") as run_listener:
            changed = main.apply_runtime_hotkey(main.HOTKEY_NAME)

        self.assertFalse(changed)
        listener.stop.assert_not_called()
        listener.join.assert_not_called()
        run_listener.assert_not_called()

    def test_invalid_hotkey_leaves_listener_unchanged(self):
        listener = mock.Mock()
        main.hotkey_listener = listener

        with self.assertRaises(ValueError):
            main.apply_runtime_hotkey("not_a_real_key_name")

        self.assertIs(main.hotkey_listener, listener)
        listener.stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
