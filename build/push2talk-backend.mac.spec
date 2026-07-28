# PyInstaller spec for the Mac backend, --onedir per Decision 3 (same
# reasoning as the Windows spec: fast startup matters more than a
# single-file installer for a push-to-talk tool).
#
# UNVERIFIED (Decision 7, authored 2026-07-28 without Apple Silicon hardware
# available): mirrors build/push2talk-backend.win.spec's structure, but:
#   - no NVIDIA CUDA DLL bundling - transcribe.py's Mac path uses
#     mlx-whisper (Metal-accelerated), not ctranslate2/faster-whisper, so
#     there is no equivalent dynamic-load DLL problem to solve;
#   - excludes faster_whisper/ctranslate2 (Windows-only per transcribe.py's
#     _load_windows_model / _backend branch) instead of mlx_whisper/Quartz;
#   - `target_arch='arm64'` is set explicitly and must be asserted (not just
#     hoped) by build-app.sh before this spec ever runs - Rosetta/x64 Python
#     is out of scope (FINAL_BRIEF.md SS10) and PyInstaller will silently
#     produce a working x64 binary under Rosetta if the interpreter itself
#     is x64, which is exactly the failure mode to reject upstream of this
#     spec, not inside it.
# `console=True` is kept consistent with the Windows spec for the same
# reason: the only backend protocol is stdin/stdout, and the window (if any)
# is hidden at Electron spawn time, not by changing the executable's own
# subsystem/console behavior.
#
# Must be run and validated on real Apple Silicon hardware (M1-M13,
# FINAL_BRIEF.md SS20) before this spec can be considered anything but a
# best-effort starting point - no Mac build has ever been attempted.

import os

block_cipher = None

REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))

a = Analysis(
    [os.path.join(REPO_ROOT, 'main.py')],
    pathex=[REPO_ROOT],
    binaries=[],
    datas=[],
    hiddenimports=[
        'mlx_whisper',
        'huggingface_hub',
        'tokenizers',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['faster_whisper', 'ctranslate2'],  # Windows-only, never needed on Mac
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='push2talk-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch='arm64',
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='push2talk-backend',
)
