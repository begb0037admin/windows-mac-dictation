"""Direct tests for main.py's deterministic cleanup sanity guard."""

import unittest

import main


class PlausibleCleanupTests(unittest.TestCase):
    def test_rejects_short_answer_that_echoes_all_raw_words(self):
        self.assertFalse(
            main.is_plausible_cleanup(
                "call john",
                "okay i'll call john for you",
            )
        )

    def test_allows_small_connective_word_additions(self):
        self.assertTrue(
            main.is_plausible_cleanup(
                "send report sarah",
                "Send the report to Sarah.",
            )
        )

    def test_allows_identity_cleanup(self):
        self.assertTrue(
            main.is_plausible_cleanup(
                "Please call John tomorrow.",
                "Please call John tomorrow.",
            )
        )

    def test_allows_filler_removal(self):
        self.assertTrue(
            main.is_plausible_cleanup(
                "um please call John tomorrow",
                "Please call John tomorrow.",
            )
        )

    def test_rejects_invented_content_after_all_filler_input(self):
        self.assertFalse(
            main.is_plausible_cleanup(
                "um uh",
                "Okay, I can help.",
            )
        )

    def test_allows_self_correction_cleanup(self):
        self.assertTrue(
            main.is_plausible_cleanup(
                "call John no wait call Mike",
                "Call Mike.",
            )
        )

    def test_existing_length_guard_still_rejects_generated_content(self):
        self.assertFalse(
            main.is_plausible_cleanup(
                "call John",
                "I can certainly help with that request. " * 4,
            )
        )

    def test_existing_list_guard_still_rejects_generated_structure(self):
        self.assertFalse(
            main.is_plausible_cleanup(
                "buy milk and bread",
                "Shopping list:\n- Milk\n- Bread",
            )
        )

    def test_existing_overlap_guard_still_rejects_unrelated_answer(self):
        self.assertFalse(
            main.is_plausible_cleanup(
                "what is your name",
                "I don't have a personal name.",
            )
        )


if __name__ == "__main__":
    unittest.main()
