"""
Unit tests for main.py's clean_stdin_line() - the defensive UTF-8 BOM strip
found necessary via build-app.ps1's own smoke test (a .NET
Process.StandardInput redirected pipe can prepend a BOM to the first write,
even when the caller's own bytes have none). No mic/GPU/hotkey needed.

Run with: python -m unittest test_main_stdin -v
"""

import unittest

import main


class CleanStdinLineTests(unittest.TestCase):
    def test_strips_leading_bom(self):
        self.assertEqual(main.clean_stdin_line("﻿{\"cmd\":\"get_config\"}"), '{"cmd":"get_config"}')

    def test_strips_bom_and_surrounding_whitespace(self):
        self.assertEqual(main.clean_stdin_line("﻿  {\"cmd\":\"get_config\"}  \n"), '{"cmd":"get_config"}')

    def test_no_bom_is_a_no_op_besides_trimming(self):
        self.assertEqual(main.clean_stdin_line('{"cmd":"get_config"}\n'), '{"cmd":"get_config"}')

    def test_bom_only_line_becomes_empty(self):
        self.assertEqual(main.clean_stdin_line("﻿\n"), "")

    def test_blank_line_stays_empty(self):
        self.assertEqual(main.clean_stdin_line("   \n"), "")


if __name__ == "__main__":
    unittest.main()
