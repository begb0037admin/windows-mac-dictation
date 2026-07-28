#!/usr/bin/env bash
# UNVERIFIED (Decision 7, authored 2026-07-28 without Apple Silicon hardware
# available) - Mac counterpart to build/build-backend.ps1. Freezes the
# Python backend into build/out/<RunId>/backend/push2talk-backend/ using
# the locked build venv already created and populated by build-app.sh.
# Never installs anything itself - a missing dependency here is a bug in
# the caller's venv setup, not something to paper over silently.
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: build-backend.sh <run-id> <repo-root> <venv-python>" >&2
    exit 2
fi

RUN_ID="$1"
REPO_ROOT="$2"
VENV_PYTHON="$3"

RUN_ROOT="$REPO_ROOT/build/out/$RUN_ID"
BACKEND_OUT="$RUN_ROOT/backend"
WORK_DIR="$BACKEND_OUT/_work"
SPEC_PATH="$REPO_ROOT/build/push2talk-backend.mac.spec"

if [ ! -d "$RUN_ROOT" ]; then
    echo "run directory does not exist: $RUN_ROOT (build-app.sh must create it first)" >&2
    exit 1
fi
if [ ! -f "$SPEC_PATH" ]; then
    echo "spec file not found: $SPEC_PATH" >&2
    exit 1
fi

mkdir -p "$BACKEND_OUT"

"$VENV_PYTHON" -m PyInstaller --noconfirm --distpath "$BACKEND_OUT" --workpath "$WORK_DIR" "$SPEC_PATH"

EXE_PATH="$BACKEND_OUT/push2talk-backend/push2talk-backend"
if [ ! -f "$EXE_PATH" ]; then
    echo "PyInstaller reported success but the expected executable is missing: $EXE_PATH" >&2
    exit 1
fi

echo "build-backend: froze backend to $EXE_PATH"
