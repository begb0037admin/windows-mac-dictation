"""Unit tests for the frozen Mac MLX inference build gate."""

import os
import unittest
from unittest import mock

import numpy as np

import main


class MlxBuildSelfTestTests(unittest.TestCase):
    def test_runs_real_transcribe_path_with_synthetic_silence(self):
        whisper_config = {
            "backend": "mlx-whisper",
            "model_size": "small",
            "hf_repo": "mlx-community/whisper-small-mlx",
        }

        with (
            mock.patch.object(main.platform, "system", return_value="Darwin"),
            mock.patch.dict(main.config, {"whisper": whisper_config}),
            mock.patch.object(main, "transcribe", return_value="") as transcribe,
            mock.patch.object(main, "emit_event") as emit_event,
        ):
            main.run_build_self_test_mlx()

        audio, sample_rate, actual_config = transcribe.call_args.args
        self.assertEqual(sample_rate, main.SAMPLE_RATE)
        self.assertIs(actual_config, whisper_config)
        self.assertEqual(audio.dtype, np.float32)
        self.assertEqual(audio.shape, (main.SAMPLE_RATE,))
        self.assertTrue(np.all(audio == 0))
        emit_event.assert_called_once_with({
            "type": "build_self_test",
            "component": "mlx_whisper",
            "ok": True,
            "transcript_length": 0,
            "safety_rejected_silence": False,
        })

    def test_synthetic_silence_safety_rejection_still_proves_inference(self):
        whisper_config = {
            "backend": "mlx-whisper",
            "model_size": "large-v3-turbo",
            "hf_repo": "mlx-community/whisper-large-v3-turbo",
        }

        with (
            mock.patch.object(main.platform, "system", return_value="Darwin"),
            mock.patch.dict(main.config, {"whisper": whisper_config}),
            mock.patch.object(
                main,
                "transcribe",
                side_effect=main.UnreliableTranscriptionError(
                    "probable_no_speech"
                ),
            ),
            mock.patch.object(main, "emit_event") as emit_event,
        ):
            main.run_build_self_test_mlx()

        emit_event.assert_called_once_with({
            "type": "build_self_test",
            "component": "mlx_whisper",
            "ok": True,
            "transcript_length": 0,
            "safety_rejected_silence": True,
        })

    def test_rejects_non_macos_host(self):
        with mock.patch.object(main.platform, "system", return_value="Windows"):
            with self.assertRaisesRegex(RuntimeError, "only valid on macOS"):
                main.run_build_self_test_mlx()

    def test_environment_route_bypasses_microphone_and_tcc_checks(self):
        with (
            mock.patch.dict(os.environ, {"P2T_BUILD_SELF_TEST_MLX": "1"}),
            mock.patch.object(main, "run_build_self_test_mlx") as self_test,
            mock.patch.object(main.sd, "check_input_settings") as mic_check,
            mock.patch.object(main, "check_macos_accessibility") as tcc_check,
        ):
            main.main()

        self_test.assert_called_once_with()
        mic_check.assert_not_called()
        tcc_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
