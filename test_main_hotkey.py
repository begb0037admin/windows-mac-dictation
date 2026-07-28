"""
Unit tests for main.py's resolve_hotkey() - covers both keyboard and mouse
button resolution (mouse support added so middle-click etc. can be used as
the push-to-talk hotkey). No mic/GPU needed.

Run with: python -m unittest test_main_hotkey -v
"""

import unittest

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


if __name__ == "__main__":
    unittest.main()
