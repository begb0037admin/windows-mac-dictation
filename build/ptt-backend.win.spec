# PyInstaller spec for the Windows backend, --onedir per Decision 3 (fast
# startup for a push-to-talk tool matters more than a single-file installer).
#
# console=True (corrected turn 3 - was console=False, wrong): FINAL_BRIEF.md
# is explicit that this must be a normal console-subsystem executable, never
# --noconsole/--windowed, because the only backend protocol is stdin/stdout
# and console=False changes the Windows subsystem in a way the brief
# deliberately avoids for that reason. The console window itself is hidden
# at spawn time instead, via windowsHide:true on the Node child_process.spawn
# call in electron/main.js - not by changing the exe's own subsystem.
#
# NVIDIA CUDA DLLs (cublas/cudnn/cuda_nvrtc) are loaded by ctranslate2 at
# runtime via dynamic loading, not a direct Python import PyInstaller's
# static analysis can see - they must be listed explicitly in `binaries` or
# the frozen exe silently falls back to CPU (or fails outright) with no
# error PyInstaller itself would catch. Paths are resolved at spec-eval
# time from the actual installed nvidia-* packages (see I1_findings.md,
# confirmed live on Kevin's machine 2026-07-28), not hardcoded.

import importlib.util
import os
import sys

block_cipher = None

# SPECPATH is PyInstaller's own global for the spec file's containing
# directory (build/), already a directory path - not a file path, so no
# extra os.path.dirname() here (that would go up one level too many).
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))


def _nvidia_dll_dir(pkg_subpath):
    """Resolve <site-packages>/nvidia/<pkg_subpath>/bin from the actually
    installed nvidia-*-cu12 packages, rather than hardcoding a path -
    correct across venvs/machines as long as the lock is installed."""
    spec = importlib.util.find_spec('nvidia')
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError(
            'nvidia package not found in this environment - install the '
            'runtime lock (build/lock/win-x64.txt) before freezing.'
        )
    base = list(spec.submodule_search_locations)[0]
    bin_dir = os.path.join(base, pkg_subpath, 'bin')
    if not os.path.isdir(bin_dir):
        raise RuntimeError(f'expected NVIDIA DLL directory not found: {bin_dir}')
    return bin_dir


def _collect_dlls(bin_dir):
    return [
        (os.path.join(bin_dir, name), '.')
        for name in os.listdir(bin_dir)
        if name.lower().endswith('.dll')
    ]


nvidia_binaries = []
for subpath in ('cublas', 'cudnn', 'cuda_nvrtc'):
    nvidia_binaries.extend(_collect_dlls(_nvidia_dll_dir(subpath)))

a = Analysis(
    [os.path.join(REPO_ROOT, 'main.py')],
    pathex=[REPO_ROOT],
    binaries=nvidia_binaries,
    datas=[],
    hiddenimports=[
        'faster_whisper',
        'ctranslate2',
        'huggingface_hub',
        'tokenizers',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # tkinter is pulled in transitively (not imported by main.py or listed in
    # requirements.txt) and is never used by this console-only backend.
    # Excluded because PyInstaller 6.21.0's tkinter runtime hook cannot
    # locate Python 3.14's zip-packaged Tcl/Tk 9.0 data directory
    # ('//zipfs:/lib/tcl/tcl_library'), which crashes the frozen exe before
    # it can start (FileNotFoundError in pyi_rth__tkinter).
    excludes=['mlx_whisper', 'Quartz', 'tkinter', '_tkinter'],  # Mac-only / unused-GUI, never needed on Windows
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
    name='ptt-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
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
    name='ptt-backend',
)
