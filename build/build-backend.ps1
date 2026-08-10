# Freezes the Python backend into build/out/<RunId>/backend/ptt-backend/
# using the locked build venv already created and populated by build-app.ps1
# (steps 8-9). Never installs anything itself - a missing dependency here is
# a bug in the caller's venv setup, not something to paper over silently.
#
# NOTE (build-app.ps1 risk, recorded 2026-07-28 during live testing): a
# PyInstaller COLLECT step failed with FileNotFoundError on a long DLL path
# when run from a deeply nested checkout (observed on this machine's own
# .targets/ clone path, well past Windows' 260-char MAX_PATH). build-app.ps1
# must either run from a short checkout path or require Windows long-path
# support enabled (`git config --system core.longpaths true` plus the
# LongPathsEnabled registry policy) - this is a real constraint, not a
# hypothetical one, confirmed by reproducing the failure live.

param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$VenvPython
)

$ErrorActionPreference = 'Stop'

$runRoot = Join-Path $RepoRoot "build\out\$RunId"
$backendOut = Join-Path $runRoot 'backend'
$workDir = Join-Path $backendOut '_work'
$specPath = Join-Path $RepoRoot 'build\ptt-backend.win.spec'

if (-not (Test-Path $runRoot)) {
    throw "run directory does not exist: $runRoot (build-app.ps1 must create it first)"
}
if (-not (Test-Path $specPath)) {
    throw "spec file not found: $specPath"
}

New-Item -ItemType Directory -Force -Path $backendOut | Out-Null

& $VenvPython -m PyInstaller --noconfirm --distpath $backendOut --workpath $workDir $specPath
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller exited with code $LASTEXITCODE"
}

$exePath = Join-Path $backendOut 'ptt-backend\ptt-backend.exe'
if (-not (Test-Path $exePath)) {
    throw "PyInstaller reported success but the expected executable is missing: $exePath"
}

Write-Host "build-backend: froze backend to $exePath"
