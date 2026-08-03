#!/usr/bin/env bash
# UNVERIFIED (Decision 7, authored 2026-07-28 without Apple Silicon hardware
# available) - Mac counterpart to build/build-app.ps1. Mirrors its step
# numbering (FINAL_BRIEF.md SS17) as closely as bash/DMG/.app differences
# allow. No NSIS-equivalent uninstall hook exists for a DMG drag-install
# (SS16), so there is no --include-uninstall-hook flag here at all.
#
# Must be run and validated on real Apple Silicon hardware (M1-M13,
# FINAL_BRIEF.md SS20) before any artifact this script produces can be
# treated as anything but UNVERIFIED groundwork - no Mac build has ever
# been attempted. Deliberately avoids `mapfile`/`readarray` (bash 4+,
# stock macOS ships bash 3.2 under /bin/bash for licensing reasons) and
# GNU `timeout` (not present in the BSD userland) - both used portable
# manual equivalents instead so this doesn't fail on a stock Mac shell
# before it even reaches the parts that need real hardware to validate.
set -euo pipefail

SKIP_SMOKE_TEST=0
for arg in "$@"; do
    case "$arg" in
        --skip-smoke-test) SKIP_SMOKE_TEST=1 ;;
        *)
            echo "unrecognized argument: $arg" >&2
            exit 2
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_DIR="$REPO_ROOT/electron"

fail() {
    local code="$1"; shift
    echo "build-app: FAIL($code): $*" >&2
    exit "$code"
}

# Turn 5/6-equivalent (ported from build-app.ps1's Assert-GeneratedPair):
# validate the existing generated config/metadata pair in place immediately
# before every builder invocation, rather than regenerating over them -
# regenerating would silently paper over corruption or a stale file instead
# of failing closed on it.
assert_generated_pair() {
    local config_path="$1" expected_run_id="$2" expected_platform="$3" \
        expected_arch="$4" expected_backend_source="$5" expected_output_dir="$6"
    local meta_path
    meta_path="$(dirname "$config_path")/electron-builder.meta.json"
    if [ ! -f "$config_path" ] || [ ! -f "$meta_path" ]; then
        fail 11 "generated builder config/metadata is missing: $config_path / $meta_path"
    fi
    node -e '
        const fs = require("fs");
        const [configPath, metaPath, runId, platform, arch, backendSource, outputDir] = process.argv.slice(1);
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const configBackend = config.extraResources && config.extraResources[1] && config.extraResources[1].from;
        const ok = meta.runId === runId && meta.platform === platform && meta.arch === arch &&
            meta.configPath === configPath && meta.backendSource === backendSource &&
            meta.outputDir === outputDir && meta.includeUninstallHook === false &&
            configBackend === backendSource && config.directories.output === outputDir;
        if (!ok) { process.exit(1); }
    ' "$config_path" "$meta_path" "$expected_run_id" "$expected_platform" "$expected_arch" \
        "$expected_backend_source" "$expected_output_dir" \
        || fail 11 "generated builder config/metadata does not describe the active run"
}

# TCC grants for Accessibility/Input Monitoring are code-requirement-bound,
# not bundle-ID-only. An app that merely has CFBundleIdentifier set but is
# not a valid signed bundle is evaluated as a raw executable path instead,
# which cannot match the bundle row shown in System Settings. Validate both
# the full seal and the embedded backend immediately after each builder pass
# so an unusable package can never advance to the human permission gate.
assert_mac_signature() {
    local app_bundle="$1"
    local backend_exe="$app_bundle/Contents/Resources/backend/push2talk-backend"
    local app_signing_info

    codesign --verify --deep --strict --verbose=2 "$app_bundle" \
        || fail 19 "packaged app is not a valid consistently signed bundle: $app_bundle"
    codesign --verify --strict --verbose=2 "$backend_exe" \
        || fail 19 "packaged backend is not validly signed: $backend_exe"

    app_signing_info="$(codesign -dvvv "$app_bundle" 2>&1)" \
        || fail 19 "could not inspect packaged app signature: $app_bundle"
    echo "$app_signing_info" | grep -q '^Identifier=com\.lelitte\.push2talk$' \
        || fail 19 "packaged app signature has the wrong identifier"
    echo "$app_signing_info" | grep -q '^Signature=adhoc$' \
        || fail 19 "unsigned internal Mac package must use the explicit ad-hoc signing contract"
}

assert_mlx_runtime() {
    local app_bundle="$1"
    local metallib="$app_bundle/Contents/Resources/backend/_internal/mlx/lib/mlx.metallib"
    local asset

    if [ ! -s "$metallib" ]; then
        fail 19 "packaged MLX Metal shader library is missing or empty: $metallib"
    fi
    for asset in mel_filters.npz gpt2.tiktoken multilingual.tiktoken; do
        if [ ! -s "$app_bundle/Contents/Resources/backend/_internal/mlx_whisper/assets/$asset" ]; then
            fail 19 "packaged mlx-whisper runtime asset is missing or empty: $asset"
        fi
    done
}

# Step 1: version, git SHA, dirty state.
GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD)"
GIT_DIRTY=0
if [ -n "$(cd "$REPO_ROOT" && git status --porcelain)" ]; then GIT_DIRTY=1; fi
PACKAGE_VERSION="$(node -e "console.log(require('$ELECTRON_DIR/package.json').version)")"

# Step 2: compute <run-id>, create a new empty build/out/<run-id>/.
# BSD `date` (stock macOS) has no %3N milliseconds directive and prints it
# literally rather than erroring, so `||` fallback wouldn't catch it -
# branch on `uname` explicitly instead.
if [ "$(uname -s)" = "Darwin" ]; then
    TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
else
    TIMESTAMP="$(date -u +%Y%m%dT%H%M%S%3NZ)"
fi
SHORT_SHA="${GIT_SHA:0:7}"
RUN_ID="${PACKAGE_VERSION}-${TIMESTAMP}-${SHORT_SHA}"
if [ "$GIT_DIRTY" -eq 1 ]; then RUN_ID="${RUN_ID}+dirty"; fi
RUN_ROOT="$REPO_ROOT/build/out/$RUN_ID"
if [ -e "$RUN_ROOT" ]; then fail 10 "run directory already exists: $RUN_ROOT"; fi
mkdir -p "$RUN_ROOT"
echo "build-app: run $RUN_ID"

# Step 3: validate platform/interpreter architecture (SS10) - must be
# native arm64, never Rosetta-translated x86_64.
PY_MACHINE="$(python3 -c 'import platform; print(platform.machine())')"
if [ "$PY_MACHINE" != "arm64" ]; then
    fail 2 "expected a native arm64 Python interpreter, got '$PY_MACHINE' (Rosetta/x64 Python is out of scope, FINAL_BRIEF.md SS10)"
fi
ARCH="arm64"

# Step 4: validate both generated locks. Do NOT generate mac-arm64.txt /
# build-tools.mac-arm64.txt here - Decision 7 explicitly forbids committing
# generated Mac locks until run on real Apple Silicon.
RUNTIME_LOCK="$REPO_ROOT/build/lock/mac-$ARCH.txt"
TOOLS_LOCK="$REPO_ROOT/build/lock/build-tools.mac-$ARCH.txt"
for lock in "$RUNTIME_LOCK" "$TOOLS_LOCK"; do
    if [ ! -f "$lock" ]; then
        fail 3 "missing required lock: $lock. Generate on real Apple Silicon with: pip-compile --generate-hashes --allow-unsafe --output-file=$lock <matching .in>"
    fi
done
python3 "$REPO_ROOT/build/validate-lock.py" "$RUNTIME_LOCK" "$TOOLS_LOCK" \
    || fail 4 "lock validation failed (see output above)"

# Step 5: npm ci, unconditionally.
(cd "$ELECTRON_DIR" && npm ci) || fail 2 "npm ci failed"

# Step 6-7: generate the Mac icon if absent, via the same dependency-free
# build/generate-icon.js used on Windows (no electron-builder side-effect
# invocation, no electron-icon-builder dependency - see build-app.ps1's
# matching step for the full rationale).
ICON_ICNS="$ELECTRON_DIR/build/icon.icns"
ICON_SOURCE_PNG="$ELECTRON_DIR/build/icon.png"
if [ ! -f "$ICON_ICNS" ]; then
    if [ ! -f "$ICON_SOURCE_PNG" ]; then
        fail 6 "no icon.icns and no source icon.png at $ICON_SOURCE_PNG to generate one from"
    fi
    node "$REPO_ROOT/build/generate-icon.js" --source "$ICON_SOURCE_PNG" --output "$ICON_ICNS" --format icns \
        || fail 6 "generate-icon.js failed to produce icon.icns"
fi
if [ ! -s "$ICON_ICNS" ]; then
    fail 6 "icon generation did not produce a nonempty $ICON_ICNS"
fi

# Step 8-9: mandatory test suite - both prerequisites (node_modules, a
# locked pytest venv) must exist before this point.
VENV_DIR="$RUN_ROOT/venv"
python3 -m venv "$VENV_DIR"
VENV_PYTHON="$VENV_DIR/bin/python"
"$VENV_PYTHON" -m pip install --quiet --require-hashes -r "$TOOLS_LOCK" || fail 2 "build-tool lock install failed"
"$VENV_PYTHON" -m pip install --quiet --require-hashes -r "$RUNTIME_LOCK" || fail 2 "runtime lock install failed"

(cd "$ELECTRON_DIR" && npm test) || fail 2 "npm test failed"
"$VENV_PYTHON" -m pytest "$REPO_ROOT/build/tests" || fail 2 "pytest failed"
# pytest only collects .py files - the builder-config/icon generator tests
# are separate node --test invocations, not covered by either npm test
# (electron/tests/ only) or pytest (build/tests/*.py only).
node --test "$REPO_ROOT/build/tests/test_generate_builder_config.mjs" || fail 2 "generate-builder-config test failed"
node --test "$REPO_ROOT/build/tests/test_generate_icon.mjs" || fail 2 "generate-icon test failed"

# Step 11: freeze the backend into the active run.
"$REPO_ROOT/build/build-backend.sh" "$RUN_ID" "$REPO_ROOT" "$VENV_PYTHON"

# Step 12-13: require the frozen executable, smoke-test the real backend
# protocol (mirrors build-app.ps1's get_config smoke test).
FROZEN_EXE="$RUN_ROOT/backend/push2talk-backend/push2talk-backend"
if [ ! -x "$FROZEN_EXE" ]; then fail 12 "frozen backend executable missing or not executable: $FROZEN_EXE"; fi

# MLX can initialize Python multiprocessing shared resources on macOS. Prove
# the frozen entry point diverts the resulting resource-tracker invocation
# instead of recursively starting another complete dictation backend.
"$VENV_PYTHON" "$REPO_ROOT/build/validate-mac-frozen-multiprocessing.py" \
    "$FROZEN_EXE" \
    || fail 12 "frozen backend did not divert the multiprocessing resource tracker"

SMOKE_OUT="$(mktemp)"
SMOKE_ERR="$(mktemp)"
# No GNU `timeout` on stock macOS - poll a background job manually instead.
echo '{"cmd":"get_config"}' | "$FROZEN_EXE" >"$SMOKE_OUT" 2>"$SMOKE_ERR" &
SMOKE_PID=$!
SMOKE_WAITED=0
while kill -0 "$SMOKE_PID" 2>/dev/null && [ "$SMOKE_WAITED" -lt 20 ]; do
    sleep 1
    SMOKE_WAITED=$((SMOKE_WAITED + 1))
done
if kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -9 "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
    fail 13 "frozen backend did not answer get_config within 20 seconds"
fi
wait "$SMOKE_PID" 2>/dev/null || true
if ! grep -q '"type":[[:space:]]*"ready"' "$SMOKE_OUT"; then
    fail 13 "frozen backend did not emit a ready event"
fi
if ! grep -q '"type":[[:space:]]*"config"' "$SMOKE_OUT" || ! grep -q 'hotkey_raw' "$SMOKE_OUT"; then
    fail 13 "frozen backend did not return a valid config response to get_config"
fi
rm -f "$SMOKE_OUT" "$SMOKE_ERR"

# get_config proves the stdio protocol starts, but it never initializes MLX.
# Run real Whisper inference inside the frozen executable so missing Metal
# runtime data (especially mlx.metallib) fails the build, before Electron
# packaging or any installation is attempted.
MLX_SMOKE_OUT="$(mktemp)"
MLX_SMOKE_ERR="$(mktemp)"
P2T_BUILD_SELF_TEST_MLX=1 "$FROZEN_EXE" >"$MLX_SMOKE_OUT" 2>"$MLX_SMOKE_ERR" &
MLX_SMOKE_PID=$!
MLX_SMOKE_WAITED=0
MLX_SMOKE_TIMEOUT=600
while kill -0 "$MLX_SMOKE_PID" 2>/dev/null && [ "$MLX_SMOKE_WAITED" -lt "$MLX_SMOKE_TIMEOUT" ]; do
    sleep 1
    MLX_SMOKE_WAITED=$((MLX_SMOKE_WAITED + 1))
done
if kill -0 "$MLX_SMOKE_PID" 2>/dev/null; then
    kill -9 "$MLX_SMOKE_PID" 2>/dev/null || true
    wait "$MLX_SMOKE_PID" 2>/dev/null || true
    fail 13 "frozen backend did not complete MLX Whisper inference within ${MLX_SMOKE_TIMEOUT} seconds"
fi
MLX_SMOKE_EXIT=0
wait "$MLX_SMOKE_PID" 2>/dev/null || MLX_SMOKE_EXIT=$?
if [ "$MLX_SMOKE_EXIT" -ne 0 ]; then
    tail -n 20 "$MLX_SMOKE_ERR" >&2
    fail 13 "frozen backend MLX Whisper inference exited with code $MLX_SMOKE_EXIT"
fi
if ! grep -q '"type":[[:space:]]*"build_self_test"' "$MLX_SMOKE_OUT" \
    || ! grep -q '"component":[[:space:]]*"mlx_whisper"' "$MLX_SMOKE_OUT" \
    || ! grep -q '"ok":[[:space:]]*true' "$MLX_SMOKE_OUT"; then
    tail -n 20 "$MLX_SMOKE_ERR" >&2
    fail 13 "frozen backend did not report successful MLX Whisper inference"
fi
rm -f "$MLX_SMOKE_OUT" "$MLX_SMOKE_ERR"

# Step 14: require all four UI source files.
for f in index.html app.js styles.css logo.svg; do
    if [ ! -f "$REPO_ROOT/ui/$f" ]; then fail 14 "required UI file missing: ui/$f"; fi
done

# Step 15-16: generate and re-validate the builder config/metadata.
GENERATED_CONFIG="$RUN_ROOT/generated/electron-builder.json"
node "$REPO_ROOT/build/generate-builder-config.js" \
    --platform mac --arch "$ARCH" --run-id "$RUN_ID" --repo-root "$REPO_ROOT" \
    --output "$GENERATED_CONFIG" --include-uninstall-hook false \
    || fail 11 "generate-builder-config.js failed"
GENERATED_RUN_ID="$(node -e "console.log(require('$RUN_ROOT/generated/electron-builder.meta.json').runId)")"
if [ "$GENERATED_RUN_ID" != "$RUN_ID" ]; then fail 11 "re-read metadata run ID does not match this invocation"; fi

EXPECTED_BACKEND_SOURCE="$RUN_ROOT/backend/push2talk-backend"
EXPECTED_ELECTRON_OUTPUT="$RUN_ROOT/electron"

# Step 17: validate the existing pair immediately before builder --dir.
assert_generated_pair "$GENERATED_CONFIG" "$RUN_ID" mac "$ARCH" "$EXPECTED_BACKEND_SOURCE" "$EXPECTED_ELECTRON_OUTPUT"
(cd "$ELECTRON_DIR" && ./node_modules/.bin/electron-builder --mac --dir --config "$GENERATED_CONFIG" --publish=never) \
    || fail 17 "electron-builder --dir failed"

# Step 18-19: discover the unpacked .app (SS6.1/M11) via bounded structural
# search - exactly one "Push 2 Talk.app" with a Contents/Resources
# directory, not an assumption about electron-builder's default output
# directory name.
APP_CANDIDATES=()
while IFS= read -r app; do
    [ -n "$app" ] && [ -d "$app/Contents/Resources" ] && APP_CANDIDATES+=("$app")
done < <(find "$RUN_ROOT/electron" -maxdepth 4 -type d -name 'Push 2 Talk.app' 2>/dev/null)
if [ "${#APP_CANDIDATES[@]}" -eq 0 ]; then
    fail 5 "no structurally valid unpacked Push 2 Talk.app found under $RUN_ROOT/electron"
fi
if [ "${#APP_CANDIDATES[@]}" -gt 1 ]; then
    fail 6 "ambiguous unpacked output - found ${#APP_CANDIDATES[@]} structurally valid application bundles"
fi
APP_BUNDLE="${APP_CANDIDATES[0]}"
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
for required in ui/index.html ui/app.js ui/styles.css ui/logo.svg backend/push2talk-backend backend/_internal/mlx/lib/mlx.metallib backend/_internal/mlx_whisper/assets/mel_filters.npz backend/_internal/mlx_whisper/assets/gpt2.tiktoken backend/_internal/mlx_whisper/assets/multilingual.tiktoken; do
    if [ ! -f "$RESOURCES_DIR/$required" ]; then
        fail 19 "packaged inventory missing: Contents/Resources/$required"
    fi
done
ACTUAL_UI_FILES="$(cd "$RESOURCES_DIR/ui" && ls -1 | sort | tr '\n' '|')"
EXPECTED_UI_FILES="$(printf '%s\n' app.js index.html logo.svg styles.css | sort | tr '\n' '|')"
if [ "$ACTUAL_UI_FILES" != "$EXPECTED_UI_FILES" ]; then
    fail 19 "Contents/Resources/ui must contain exactly four approved files; found: $ACTUAL_UI_FILES"
fi
assert_mac_signature "$APP_BUNDLE"
assert_mlx_runtime "$APP_BUNDLE"

# Step 20-23: launch the unpacked app, human renderer gate, close-and-verify
# (M12) - unless --skip-smoke-test, in which case packaging still proceeds
# through to a real DMG. The DMG is just marked UNVERIFIED and cannot be
# the artifact used for acceptance (SS17.1).
if [ "$SKIP_SMOKE_TEST" -eq 0 ]; then
    # A noninteractive shell (CI, launchd) cannot answer the y/n gate below -
    # fail closed with a specific exit code rather than hanging on `read`.
    if [ ! -t 0 ]; then
        fail 9 "interactive renderer smoke gate is unavailable; rerun interactively or pass --skip-smoke-test to produce an UNVERIFIED artifact"
    fi
    open "$APP_BUNDLE"
    sleep 3
    APP_PID="$(pgrep -f "Push 2 Talk.app/Contents/MacOS/Push 2 Talk" | head -n1 || true)"
    BACKEND_PID="$(pgrep -f "$RUN_ROOT/electron.*push2talk-backend" | head -n1 || true)"

    echo ""
    echo "Check the running app now:"
    echo "  - Aurora/neumorphic UI rendered"
    echo "  - logo visible"
    echo "  - no ERR_FILE_NOT_FOUND"
    ANSWER=""
    for _ in 1 2 3; do
        read -r -p "Did the packaged renderer pass all three checks? [y/n]: " ANSWER || true
        case "$ANSWER" in
            [Yy]|[Yy][Ee][Ss]|[Nn]|[Nn][Oo]) break ;;
            *) ANSWER="" ;;
        esac
    done
    if [ -z "$ANSWER" ]; then fail 7 "no valid y/n answer after 3 attempts"; fi

    # Step 22 equivalent: close and verify stopped before continuing -
    # confirmed exit for both recorded PIDs, not just the app's.
    [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null || true
    [ -n "$BACKEND_PID" ] && kill -9 "$BACKEND_PID" 2>/dev/null || true
    sleep 2
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        fail 11 "SMOKE_APP_DID_NOT_STOP: app process still running after force-termination"
    fi
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        fail 11 "SMOKE_BACKEND_DID_NOT_STOP: recorded backend process still running after force-termination"
    fi

    case "$ANSWER" in [Nn]|[Nn][Oo]) fail 8 "SMOKE_TEST_FAILED: renderer check failed" ;; esac
else
    echo "build-app: smoke test skipped (--skip-smoke-test) - packaging continues, artifact will be marked UNVERIFIED and cannot be used for acceptance."
fi

# Step 24-26: revalidate the existing pair (do not regenerate over evidence
# of corruption between builder calls), run the DMG build, require the
# installer.
assert_generated_pair "$GENERATED_CONFIG" "$RUN_ID" mac "$ARCH" "$EXPECTED_BACKEND_SOURCE" "$EXPECTED_ELECTRON_OUTPUT"
(cd "$ELECTRON_DIR" && ./node_modules/.bin/electron-builder --mac dmg --config "$GENERATED_CONFIG" --publish=never) \
    || fail 17 "electron-builder dmg failed"
assert_mac_signature "$APP_BUNDLE"
assert_mlx_runtime "$APP_BUNDLE"

# $RUN_ROOT was created fresh by this invocation (step 2 above aborts if it
# already exists), so any *.dmg found under it now was necessarily produced
# by this run - no separate creation-time filter is needed.
DMG_CANDIDATES=()
while IFS= read -r dmg; do
    [ -n "$dmg" ] && DMG_CANDIDATES+=("$dmg")
done < <(find "$RUN_ROOT/electron" -maxdepth 2 -type f -name '*.dmg' 2>/dev/null)
if [ "${#DMG_CANDIDATES[@]}" -ne 1 ]; then
    fail 24 "expected exactly one DMG artifact created after this run began, found ${#DMG_CANDIDATES[@]}"
fi
DMG_PATH="${DMG_CANDIDATES[0]}"

if [ "$SKIP_SMOKE_TEST" -eq 1 ]; then
    : > "$RUN_ROOT/UNVERIFIED.txt"
fi

echo ""
if [ "$SKIP_SMOKE_TEST" -eq 1 ]; then
    echo "build-app: SUCCESS (UNVERIFIED - smoke test skipped, cannot be used for acceptance). run=$RUN_ID dmg=$DMG_PATH"
else
    echo "build-app: SUCCESS. run=$RUN_ID dmg=$DMG_PATH"
fi
echo "config=$GENERATED_CONFIG meta=$RUN_ROOT/generated/electron-builder.meta.json"
echo "backend=$FROZEN_EXE resources=$RESOURCES_DIR arch=$ARCH git=$GIT_SHA$([ "$GIT_DIRTY" -eq 1 ] && echo ' (dirty)')"
