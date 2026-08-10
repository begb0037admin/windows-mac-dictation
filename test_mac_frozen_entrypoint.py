"""Regression tests for the Mac-only frozen multiprocessing entry point."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parent
MAC_ENTRY = REPO_ROOT / "build" / "ptt-backend.mac-entry.py"
MAC_SPEC = REPO_ROOT / "build" / "ptt-backend.mac.spec"
WINDOWS_SPEC = REPO_ROOT / "build" / "ptt-backend.win.spec"


def load_mac_entry():
    spec = importlib.util.spec_from_file_location("p2t_mac_entry_test", MAC_ENTRY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MacFrozenEntrypointTests(unittest.TestCase):
    def test_freeze_support_runs_before_backend_import_and_main(self):
        events = []
        fake_main = types.ModuleType("main")
        fake_main.main = lambda: events.append("main")
        entry = load_mac_entry()

        with (
            mock.patch.object(
                entry.multiprocessing,
                "freeze_support",
                side_effect=lambda: events.append("freeze_support"),
            ),
            mock.patch.dict(sys.modules, {"main": fake_main}),
        ):
            entry.run()

        self.assertEqual(events, ["freeze_support", "main"])

    def test_only_mac_spec_uses_the_guarded_entrypoint(self):
        mac_spec = MAC_SPEC.read_text(encoding="utf-8")
        windows_spec = WINDOWS_SPEC.read_text(encoding="utf-8")

        self.assertIn("'ptt-backend.mac-entry.py'", mac_spec)
        self.assertIn("[os.path.join(REPO_ROOT, 'main.py')]", windows_spec)
        self.assertNotIn("ptt-backend.mac-entry.py", windows_spec)


if __name__ == "__main__":
    unittest.main()
