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

import glob
import os

block_cipher = None

REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))

# Found on real Apple Silicon (2026-07-30): PyInstaller's static dependency
# scanner missed libjaccl.dylib, a sibling native library libmlx.dylib
# itself depends on via @rpath (`otool -L` confirms it, and it's genuinely
# present in the mlx package's own lib/ directory) - the frozen bundle
# built without this fix was missing it entirely, which would only surface
# as a crash the moment mlx_whisper actually runs Metal inference, not at
# import time or in the lightweight get_config smoke test build-app.sh
# runs. MLX also loads mlx.metallib at runtime; it is Metal shader data, not
# a Mach-O binary, so PyInstaller will not discover it from binary linkage.
# Explicitly bundle both classes of MLX runtime resource.
import mlx
import mlx_whisper
# mlx is a namespace package - __file__ is None, __path__ is the real thing.
MLX_LIB_DIR = os.path.join(list(mlx.__path__)[0], 'lib')
mlx_dylibs = [
    (path, 'mlx/lib')
    for path in glob.glob(os.path.join(MLX_LIB_DIR, '*.dylib'))
]
mlx_metallibs = [
    (path, 'mlx/lib')
    for path in glob.glob(os.path.join(MLX_LIB_DIR, '*.metallib'))
]
if len(mlx_metallibs) != 1:
    raise RuntimeError(
        f'Expected exactly one MLX Metal shader library in {MLX_LIB_DIR}, '
        f'found {len(mlx_metallibs)}'
    )

# mlx-whisper resolves these files relative to its own module at inference
# time. They are package data rather than imports, so Analysis does not
# discover them automatically.
MLX_WHISPER_ASSETS_DIR = os.path.join(
    os.path.dirname(mlx_whisper.__file__), 'assets'
)
mlx_whisper_asset_names = (
    'mel_filters.npz',
    'gpt2.tiktoken',
    'multilingual.tiktoken',
)
mlx_whisper_assets = [
    (os.path.join(MLX_WHISPER_ASSETS_DIR, name), 'mlx_whisper/assets')
    for name in mlx_whisper_asset_names
]
missing_mlx_whisper_assets = [
    path for path, _destination in mlx_whisper_assets
    if not os.path.isfile(path)
]
if missing_mlx_whisper_assets:
    raise RuntimeError(
        f'Missing required mlx-whisper runtime assets: '
        f'{missing_mlx_whisper_assets}'
    )

a = Analysis(
    [
        os.path.join(
            REPO_ROOT,
            'build',
            'push2talk-backend.mac-entry.py',
        )
    ],
    pathex=[REPO_ROOT],
    binaries=mlx_dylibs,
    datas=mlx_metallibs + mlx_whisper_assets,
    hiddenimports=[
        'mlx_whisper',
        # mlx.core imports this dynamically while initializing its native
        # extension, so PyInstaller cannot discover it through static
        # analysis of mlx-whisper's ordinary `import mlx.core`.
        'mlx._reprlib_fix',
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
