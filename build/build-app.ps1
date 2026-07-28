# Sole Windows build entry point (build-app.sh is the Mac counterpart, not
# implemented this pass - Decision 7). Every run aborts at the first
# failure. See FINAL_BRIEF.md SS17 for the numbered step list this mirrors.
#
# KNOWN OPEN ISSUE (recorded live, 2026-07-28, i1_claude.md has full
# diagnostics): the packaged app's BACKEND_TIMEOUT path was reproduced
# 100% of the time when the real Electron app (window + IPC + preload)
# spawns the backend, despite the identical spawn() call working correctly
# from a minimal Electron app with no window. Root cause not yet found.
# This build will produce a real installer, but the installed app is NOT
# yet confirmed to actually complete backend startup - do not treat a
# successful build as proof the app works end to end.
#
# NOTE: uses direct node_modules/.bin paths, never `npx` - `npx` itself
# breaks when the repo checkout path contains "&" (reproduced live on this
# machine's own checkout path, unrelated to this script).

param(
    [switch]$IncludeUninstallHook,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ElectronDir = Join-Path $RepoRoot 'electron'

function Fail($ExitCode, $Message) {
    Write-Error $Message
    exit $ExitCode
}

# Step 1: version, git SHA, dirty state.
Push-Location $RepoRoot
try {
    $GitSha = (& git rev-parse HEAD).Trim()
    $GitDirty = [bool](& git status --porcelain)
    $PackageVersion = (Get-Content (Join-Path $ElectronDir 'package.json') | ConvertFrom-Json).version
} finally {
    Pop-Location
}

# Step 2: compute <run-id>, create a new empty build/out/<run-id>/.
$Timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$ShortSha = $GitSha.Substring(0, 7)
$RunId = "$PackageVersion-$Timestamp-$ShortSha"
if ($GitDirty) { $RunId = "$RunId+dirty" }
$RunRoot = Join-Path $RepoRoot "build\out\$RunId"
if (Test-Path $RunRoot) { Fail 10 "run directory already exists: $RunRoot" }
New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
Write-Host "build-app: run $RunId"

# Step 3: validate platform/interpreter architecture (SS10).
$PyArch = (& python -c "import struct; print(struct.calcsize('P')*8)").Trim()
if ($PyArch -ne '64') { Fail 2 "expected a 64-bit Python interpreter, got ${PyArch}-bit" }
$Arch = 'x64'

# Step 4: validate both generated locks.
$RuntimeLock = Join-Path $RepoRoot "build\lock\win-$Arch.txt"
$ToolsLock = Join-Path $RepoRoot "build\lock\build-tools.win-$Arch.txt"
foreach ($lock in @($RuntimeLock, $ToolsLock)) {
    if (-not (Test-Path $lock)) {
        Fail 3 "missing required lock: $lock. Generate with: pip-compile --generate-hashes --allow-unsafe --output-file=$lock <matching .in>"
    }
}
& python (Join-Path $RepoRoot 'build\validate-lock.py') $RuntimeLock $ToolsLock
if ($LASTEXITCODE -ne 0) { Fail 4 'lock validation failed (see output above)' }

# Step 5: npm ci, unconditionally.
Push-Location $ElectronDir
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { Fail 2 'npm ci failed' }
} finally {
    Pop-Location
}

# Step 6-7: generate the Windows icon if absent (electron-builder's own
# conversion from a single source PNG, not a separate icon-builder tool -
# electron-icon-builder was dropped after npm audit found 33 vulnerabilities
# in its dependency tree during this run; see i1_claude.md).
$IconIco = Join-Path $ElectronDir 'build\icon.ico'
$IconSourcePng = Join-Path $ElectronDir 'build\icon.png'
if (-not (Test-Path $IconIco)) {
    if (-not (Test-Path $IconSourcePng)) {
        Fail 6 "no icon.ico and no source icon.png at $IconSourcePng to generate one from - rasterize ui/logo.svg to a 1024x1024 PNG at that path first (not yet automated this run)."
    }
    # electron-builder generates platform icons from a single source image
    # when `build.win.icon`/`build.mac.icon` point at a PNG rather than an
    # already-built .ico/.icns - invoked here standalone via its icon
    # sub-tool rather than as part of a full package pass.
    & (Join-Path $ElectronDir 'node_modules\.bin\electron-builder.cmd') --config.win.icon="$IconSourcePng" --dir --publish=never 2>&1 | Out-Null
}
if (-not (Test-Path $IconIco) -or (Get-Item $IconIco).Length -eq 0) {
    Fail 6 "icon generation did not produce a nonempty $IconIco"
}

# Step 8-9: mandatory test suite - both prerequisites (node_modules, a
# locked pytest venv) must exist before this point.
$VenvDir = Join-Path $RunRoot 'venv'
& python -m venv $VenvDir
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
& $VenvPython -m pip install --quiet --require-hashes -r $ToolsLock
if ($LASTEXITCODE -ne 0) { Fail 2 'build-tool lock install failed' }
& $VenvPython -m pip install --quiet --require-hashes -r $RuntimeLock
if ($LASTEXITCODE -ne 0) { Fail 2 'runtime lock install failed' }

Push-Location $ElectronDir
try {
    & npm test
    if ($LASTEXITCODE -ne 0) { Fail 2 'npm test failed' }
} finally {
    Pop-Location
}
& $VenvPython -m pytest (Join-Path $RepoRoot 'build\tests')
if ($LASTEXITCODE -ne 0) { Fail 2 'pytest failed' }
# pytest only collects .py files - the builder-config generator test is a
# separate node --test invocation, not covered by either npm test
# (electron/tests/ only) or pytest (build/tests/*.py only).
& node --test (Join-Path $RepoRoot 'build\tests\test_generate_builder_config.mjs')
if ($LASTEXITCODE -ne 0) { Fail 2 'generate-builder-config test failed' }

# Step 11: freeze the backend into the active run.
& (Join-Path $RepoRoot 'build\build-backend.ps1') -RunId $RunId -RepoRoot $RepoRoot -VenvPython $VenvPython

# Step 12-13: require the frozen executable, smoke-test stdin/stdout.
$FrozenExe = Join-Path $RunRoot 'backend\push2talk-backend\push2talk-backend.exe'
if (-not (Test-Path $FrozenExe)) { Fail 12 "frozen backend executable missing: $FrozenExe" }
# A closed stdin makes the frozen backend exit cleanly after emitting
# ready+status (confirmed live, I1_findings.md) - PowerShell's `&` call
# operator has no bash-style `< /dev/null`, so stdin is closed explicitly
# via .NET Process instead.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $FrozenExe
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$smokeProc = [System.Diagnostics.Process]::Start($psi)
$smokeProc.StandardInput.Close()
$smokeOut = $smokeProc.StandardOutput.ReadToEnd()
$smokeProc.WaitForExit(10000) | Out-Null
if ($smokeOut -notmatch '"type":\s*"ready"') { Fail 13 'frozen backend did not emit a ready event on a direct stdin/stdout smoke test' }

# Step 14: require all four UI source files.
foreach ($f in @('index.html', 'app.js', 'styles.css', 'logo.svg')) {
    if (-not (Test-Path (Join-Path $RepoRoot "ui\$f"))) { Fail 14 "required UI file missing: ui\$f" }
}

# Step 15-16: generate and re-validate the builder config/metadata.
$GeneratedConfig = Join-Path $RunRoot 'generated\electron-builder.json'
& node (Join-Path $RepoRoot 'build\generate-builder-config.js') `
    --platform win --arch $Arch --run-id $RunId --repo-root $RepoRoot `
    --output $GeneratedConfig --include-uninstall-hook $IncludeUninstallHook.IsPresent.ToString().ToLower()
if ($LASTEXITCODE -ne 0) { Fail 11 'generate-builder-config.js failed' }
$Meta = Get-Content (Join-Path $RunRoot 'generated\electron-builder.meta.json') | ConvertFrom-Json
if ($Meta.runId -ne $RunId) { Fail 11 're-read metadata run ID does not match this invocation' }

# Step 17: run builder --dir with the explicit generated config.
Push-Location $ElectronDir
try {
    & .\node_modules\.bin\electron-builder.cmd --win --dir --config $GeneratedConfig --publish=never
    if ($LASTEXITCODE -ne 0) { Fail 17 'electron-builder --dir failed' }
} finally {
    Pop-Location
}

# Step 18-19: discover the unpacked app (SS6.1), verify inventory.
$UnpackedCandidates = Get-ChildItem (Join-Path $RunRoot 'electron') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*-unpacked' }
if ($UnpackedCandidates.Count -eq 0) { Fail 5 "no *-unpacked directory found under $RunRoot\electron" }
if ($UnpackedCandidates.Count -gt 1) { Fail 6 "ambiguous unpacked output - multiple *-unpacked directories: $($UnpackedCandidates.Name -join ', ')" }
$UnpackedDir = $UnpackedCandidates[0].FullName
$ResourcesDir = Join-Path $UnpackedDir 'resources'
foreach ($required in @('ui\index.html', 'backend\push2talk-backend.exe')) {
    if (-not (Test-Path (Join-Path $ResourcesDir $required))) {
        Fail 19 "packaged inventory missing: resources\$required"
    }
}

if ($SkipSmokeTest) {
    New-Item -ItemType File -Path (Join-Path $RunRoot 'UNVERIFIED.txt') -Force | Out-Null
    Write-Host 'build-app: smoke test skipped (-SkipSmokeTest) - UNVERIFIED.txt written. This artifact cannot be the one Kevin installs for acceptance.'
    exit 0
}

# Step 20-23: launch the unpacked app, human renderer gate, close-and-verify.
$AppExe = Get-ChildItem $UnpackedDir -Filter '*.exe' | Where-Object { $_.Name -ne 'push2talk-backend.exe' } | Select-Object -First 1
if (-not $AppExe) { Fail 19 "no application executable found in $UnpackedDir" }
$AppProc = Start-Process -FilePath $AppExe.FullName -PassThru
Start-Sleep -Seconds 3
$BackendProcAtLaunch = Get-Process push2talk-backend -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host ''
Write-Host 'Check the running app now:'
Write-Host '  - Aurora/neumorphic UI rendered'
Write-Host '  - logo visible'
Write-Host '  - no ERR_FILE_NOT_FOUND'
$attempts = 0
$answer = $null
while ($attempts -lt 3) {
    $answer = Read-Host 'Did the packaged renderer pass all three checks? [y/n]'
    if ($answer -match '^(y|yes|n|no)$') { break }
    $attempts++
}
if ($attempts -ge 3 -or -not $answer) { Fail 7 'no valid y/n answer after 3 attempts' }

# Step 22 equivalent: close and verify stopped before continuing.
if ($AppProc -and -not $AppProc.HasExited) { Stop-Process -Id $AppProc.Id -Force -ErrorAction SilentlyContinue }
if ($BackendProcAtLaunch) { Stop-Process -Id $BackendProcAtLaunch.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Get-Process -Id $AppProc.Id -ErrorAction SilentlyContinue) { Fail 11 'SMOKE_APP_DID_NOT_STOP: app process still running after force-termination' }

if ($answer -match '^(n|no)$') { Fail 8 'SMOKE_TEST_FAILED: renderer check failed' }

# Step 24-26: revalidate config, run NSIS, require the installer.
& node (Join-Path $RepoRoot 'build\generate-builder-config.js') `
    --platform win --arch $Arch --run-id $RunId --repo-root $RepoRoot `
    --output $GeneratedConfig --include-uninstall-hook $IncludeUninstallHook.IsPresent.ToString().ToLower() | Out-Null

Push-Location $ElectronDir
try {
    $before = Get-ChildItem (Join-Path $RunRoot 'electron') -Filter '*.exe' -ErrorAction SilentlyContinue
    & .\node_modules\.bin\electron-builder.cmd --win nsis --config $GeneratedConfig --publish=never
    if ($LASTEXITCODE -ne 0) { Fail 17 'electron-builder nsis failed' }
} finally {
    Pop-Location
}
$Installer = Get-ChildItem (Join-Path $RunRoot 'electron') -Filter '*Setup*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.CreationTime -ge $AppProc.StartTime }
if (-not $Installer -or $Installer.Count -ne 1) { Fail 24 'expected exactly one installer artifact created after this run began' }

Write-Host ''
Write-Host "build-app: SUCCESS. run=$RunId installer=$($Installer.FullName)"
Write-Host "config=$GeneratedConfig meta=$(Join-Path $RunRoot 'generated\electron-builder.meta.json')"
Write-Host "backend=$FrozenExe resources=$ResourcesDir arch=$Arch git=$GitSha$(if ($GitDirty) { ' (dirty)' })"
