"""Unit tests for platform-specific Whisper decoding options."""

import sys
import types
import unittest
from unittest import mock

import numpy as np

import transcribe as transcribe_module


class TranscribeOptionsTests(unittest.TestCase):
    def setUp(self):
        transcribe_module._model = None
        transcribe_module._backend = None

    def tearDown(self):
        transcribe_module._model = None
        transcribe_module._backend = None

    def test_mlx_pins_english_without_unsupported_beam_search(self):
        mlx_transcribe = mock.Mock(
            return_value={"text": " accurate text ", "segments": []}
        )
        fake_mlx = types.SimpleNamespace(transcribe=mlx_transcribe)
        config = {
            "backend": "mlx-whisper",
            "model_size": "large-v3-turbo",
            "hf_repo": "mlx-community/whisper-large-v3-turbo",
            "language": "en",
        }

        with mock.patch.object(
            transcribe_module, "_get_model", return_value=config["hf_repo"]
        ), mock.patch.dict(sys.modules, {"mlx_whisper": fake_mlx}):
            transcribe_module._backend = "mlx-whisper"
            result = transcribe_module.transcribe(
                np.zeros(160, dtype=np.float32), 16000, config
            )

        self.assertEqual(result, "accurate text")
        self.assertEqual(mlx_transcribe.call_args.kwargs["language"], "en")
        self.assertNotIn("beam_size", mlx_transcribe.call_args.kwargs)
        self.assertFalse(
            mlx_transcribe.call_args.kwargs["condition_on_previous_text"]
        )

    def test_faster_whisper_uses_configured_decoding_options(self):
        segment = types.SimpleNamespace(text=" accurate text ")
        model = mock.Mock()
        model.transcribe.return_value = ([segment], object())
        config = {
            "backend": "faster-whisper",
            "model_size": "large-v3-turbo",
            "device": "cuda",
            "compute_type": "float16",
            "language": "en",
            "beam_size": 5,
        }

        with mock.patch.object(transcribe_module, "_get_model", return_value=model):
            transcribe_module._backend = "faster-whisper"
            result = transcribe_module.transcribe(
                np.zeros(160, dtype=np.float32), 16000, config
            )

        self.assertEqual(result, "accurate text")
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "en")
        self.assertEqual(model.transcribe.call_args.kwargs["beam_size"], 5)
        self.assertFalse(
            model.transcribe.call_args.kwargs["condition_on_previous_text"]
        )


class ModelReadyAccessorTests(unittest.TestCase):
    def setUp(self):
        transcribe_module._model = None
        transcribe_module._backend = None

    def tearDown(self):
        transcribe_module._model = None
        transcribe_module._backend = None

    def test_is_model_ready_reflects_model_resolution(self):
        self.assertFalse(transcribe_module.is_model_ready())
        transcribe_module._model = "mlx-community/whisper-large-v3-turbo"
        self.assertTrue(transcribe_module.is_model_ready())

    def test_is_model_ready_is_read_only(self):
        # Calling the accessor must not resolve or load anything.
        with mock.patch.object(transcribe_module, "_get_model") as get_model:
            transcribe_module.is_model_ready()
        get_model.assert_not_called()
        self.assertIsNone(transcribe_module._model)


class TranscriptionSafetyTests(unittest.TestCase):
    def test_detects_an_obvious_phrase_loop(self):
        phrase = "why is it coming back"
        self.assertTrue(
            transcribe_module.has_repetition_loop(
                f"{phrase}? {phrase}? {phrase}?"
            )
        )

    def test_does_not_reject_normal_emphasis(self):
        self.assertFalse(
            transcribe_module.has_repetition_loop(
                "This is very, very important, so please check it carefully."
            )
        )

    def test_rejects_model_reported_probable_no_speech(self):
        with self.assertRaisesRegex(
            transcribe_module.UnreliableTranscriptionError,
            "No reliable speech",
        ):
            transcribe_module._validate_transcription(
                "fabricated sentence",
                [
                    {
                        "no_speech_prob": 0.91,
                        "avg_logprob": -0.2,
                        "compression_ratio": 1.1,
                    }
                ],
                {},
            )

    def test_rejects_low_confidence_output(self):
        with self.assertRaises(transcribe_module.UnreliableTranscriptionError):
            transcribe_module._validate_transcription(
                "uncertain sentence",
                [
                    {
                        "no_speech_prob": 0.1,
                        "avg_logprob": -1.2,
                        "compression_ratio": 1.1,
                    }
                ],
                {},
            )

    def test_rejects_high_compression_output(self):
        with self.assertRaises(transcribe_module.UnreliableTranscriptionError):
            transcribe_module._validate_transcription(
                "the same output over and over",
                [
                    {
                        "no_speech_prob": 0.1,
                        "avg_logprob": -0.2,
                        "compression_ratio": 2.8,
                    }
                ],
                {},
            )

    def test_accepts_healthy_model_metrics(self):
        transcribe_module._validate_transcription(
            "a reliable sentence",
            [
                {
                    "no_speech_prob": 0.05,
                    "avg_logprob": -0.25,
                    "compression_ratio": 1.1,
                }
            ],
            {},
        )


if __name__ == "__main__":
    unittest.main()
