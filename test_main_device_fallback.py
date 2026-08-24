"""
Unit tests for main.py's _resolve_whisper_device() - falls a configured CUDA
device back to CPU when no NVIDIA GPU is present, so the same Windows
installer works on non-GPU machines instead of ctranslate2 crashing at
model-load time (confirmed live on a GPU-less machine: 2026-08-24).

Run with: python -m unittest test_main_device_fallback -v
"""

import unittest
from unittest import mock

import main


class ResolveWhisperDeviceTests(unittest.TestCase):
    def test_non_faster_whisper_backend_is_untouched(self):
        cfg = {"backend": "mlx-whisper", "device": "cuda"}
        self.assertEqual(main._resolve_whisper_device(cfg), cfg)

    def test_explicit_cpu_choice_is_never_touched(self):
        cfg = {"backend": "faster-whisper", "device": "cpu", "compute_type": "int8"}
        self.assertEqual(main._resolve_whisper_device(cfg), cfg)

    def test_gpu_present_keeps_cuda(self):
        cfg = {"backend": "faster-whisper", "device": "cuda", "compute_type": "float16"}
        fake_ct2 = mock.Mock()
        fake_ct2.get_cuda_device_count.return_value = 1
        with mock.patch.dict("sys.modules", {"ctranslate2": fake_ct2}):
            result = main._resolve_whisper_device(cfg)
        self.assertEqual(result["device"], "cuda")
        self.assertEqual(result["compute_type"], "float16")

    def test_no_gpu_falls_back_to_cpu_and_remaps_float16(self):
        cfg = {"backend": "faster-whisper", "device": "cuda", "compute_type": "float16"}
        fake_ct2 = mock.Mock()
        fake_ct2.get_cuda_device_count.return_value = 0
        with mock.patch.dict("sys.modules", {"ctranslate2": fake_ct2}):
            result = main._resolve_whisper_device(cfg)
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["compute_type"], "int8")

    def test_no_gpu_keeps_non_float16_compute_type(self):
        cfg = {"backend": "faster-whisper", "device": "cuda", "compute_type": "int8_float16"}
        fake_ct2 = mock.Mock()
        fake_ct2.get_cuda_device_count.return_value = 0
        with mock.patch.dict("sys.modules", {"ctranslate2": fake_ct2}):
            result = main._resolve_whisper_device(cfg)
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["compute_type"], "int8_float16")

    def test_detection_error_is_treated_as_no_gpu(self):
        # Setting a module to None in sys.modules makes the import system
        # raise ImportError for it, without needing a real ctranslate2 absence.
        cfg = {"backend": "faster-whisper", "device": "cuda", "compute_type": "float16"}
        with mock.patch.dict("sys.modules", {"ctranslate2": None}):
            result = main._resolve_whisper_device(cfg)
        self.assertEqual(result["device"], "cpu")

    def test_original_config_dict_is_not_mutated(self):
        cfg = {"backend": "faster-whisper", "device": "cuda", "compute_type": "float16"}
        fake_ct2 = mock.Mock()
        fake_ct2.get_cuda_device_count.return_value = 0
        with mock.patch.dict("sys.modules", {"ctranslate2": fake_ct2}):
            main._resolve_whisper_device(cfg)
        self.assertEqual(cfg["device"], "cuda")


if __name__ == "__main__":
    unittest.main()
