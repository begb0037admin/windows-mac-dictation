# Sole Windows build entry point (build-app.sh is the Mac counterpart, not
# implemented this pass - Decision 7). Every run aborts at the first
# failure. See FINAL_BRIEF.md SS17 for the numbered step list this mirrors.
#
# RESOLVED (was an open issue as of turn 1, i1_claude.md has full diagnostics):
# the packaged app's BACKEND_TIMEOUT was root-caused in turn 3 to PyInstaller's
# console=False - fixed to console=True (ptt-backend.win.spec) with
# windowsHide:true at spawn time instead (electron/main.js), matching
# FINAL_BRIEF.md's explicit requirement. Re-verified live: the frozen exe now
# starts correctly from inside a real windowed Electron app.
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

# Turn 5 (Codex, applied by hand turn 6 - the patch itself failed to apply
# mechanically): validates the existing generated config/metadata pair
# in place immediately before every builder invocation, rather than
# regenerating over them - regenerating would silently paper over
# corruption or a stale file instead of failing closed on it.
function Assert-GeneratedPair {
    param(
        [string]$ConfigPath,
        [string]$ExpectedRunId,
        [string]$ExpectedPlatform,
        [string]$ExpectedArch,
        [string]$ExpectedBackendSource,
        [string]$ExpectedOutputDir
    )
    $MetaPath = Join-Path (Split-Path $ConfigPath -Parent) 'electron-builder.meta.json'
    try {
        $Config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
        $Meta = Get-Content -Raw -LiteralPath $MetaPath | ConvertFrom-Json
    } catch {
        Fail 11 "generated builder config/metadata is missing or malformed: $($_.Exception.Message)"
    }

    $ConfigBackend = $Config.extraResources[1].from
    if ($Meta.runId -ne $ExpectedRunId -or
        $Meta.platform -ne $ExpectedPlatform -or
        $Meta.arch -ne $ExpectedArch -or
        $Meta.configPath -ne $ConfigPath -or
        $Meta.backendSource -ne $ExpectedBackendSource -or
        $Meta.outputDir -ne $ExpectedOutputDir -or
        $Meta.includeUninstallHook -ne $false -or
        $ConfigBackend -ne $ExpectedBackendSource -or
        $Config.directories.output -ne $ExpectedOutputDir) {
        Fail 11 'generated builder config/metadata does not describe the active run'
    }
}

# The checked-in hook is explicitly a pre-observation guess (SS16/SS18). It
# must not be usable until a bootstrap installation has established the
# exact Run-key registration and the hook has been rewritten and validated
# against it - blocked here, not left to caller discipline.
if ($IncludeUninstallHook) {
    Fail 16 '-IncludeUninstallHook is blocked: bootstrap registration has not been observed and the checked-in hook is unverified'
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

# Step 6-7 (turn 7 fix - Codex turn-6 review finding 3): generate the
# Windows icon if absent using build/generate-icon.js, a dependency-free
# script scoped to exactly this --output file - not electron-builder's own
# --dir/--publish=never invoked as a side-effecting hack, which silently
# performed a full unscoped packaging build with no --config/--win of its
# own. electron-icon-builder itself was dropped earlier after npm audit
# found 33 vulnerabilities in its dependency tree (see i1_claude.md).
$IconIco = Join-Path $ElectronDir 'build\icon.ico'
$IconSourcePng = Join-Path $ElectronDir 'build\icon.png'
if (-not (Test-Path $IconIco)) {
    if (-not (Test-Path $IconSourcePng)) {
        Fail 6 "no icon.ico and no source icon.png at $IconSourcePng to generate one from - run: node build\rasterize-logo-icon.js"
    }
    & node (Join-Path $RepoRoot 'build\generate-icon.js') --source $IconSourcePng --output $IconIco --format ico
    if ($LASTEXITCODE -ne 0) { Fail 6 'generate-icon.js failed to produce icon.ico' }
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

# Step 12-13: require the frozen executable, smoke-test the real backend
# protocol (turn 5/6: a bare ready-check doesn't prove the stdin command
# channel works - send get_config and require a valid response).
$FrozenExe = Join-Path $RunRoot 'backend\ptt-backend\ptt-backend.exe'
if (-not (Test-Path $FrozenExe)) { Fail 12 "frozen backend executable missing: $FrozenExe" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $FrozenExe
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$smokeProc = [System.Diagnostics.Process]::Start($psi)
$smokeStdoutTask = $smokeProc.StandardOutput.ReadToEndAsync()
$smokeStderrTask = $smokeProc.StandardError.ReadToEndAsync()
$smokeProc.StandardInput.WriteLine('{"cmd":"get_config"}')
$smokeProc.StandardInput.Close()
if (-not $smokeProc.WaitForExit(20000)) {
    Stop-Process -Id $smokeProc.Id -Force -ErrorAction SilentlyContinue
    $smokeProc.WaitForExit(5000) | Out-Null
    Fail 13 "frozen backend did not answer get_config within 20 seconds (pid $($smokeProc.Id))"
}
$smokeOut = $smokeStdoutTask.GetAwaiter().GetResult()
$null = $smokeStderrTask.GetAwaiter().GetResult()
$smokeEvents = @()
foreach ($line in ($smokeOut -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    try {
        $smokeEvents += $line | ConvertFrom-Json
    } catch {
        Fail 13 'frozen backend emitted malformed JSON during get_config smoke test'
    }
}
$ReadyEvent = $smokeEvents | Where-Object { $_.type -eq 'ready' } | Select-Object -First 1
$ConfigEvent = $smokeEvents | Where-Object { $_.type -eq 'config' } | Select-Object -First 1
if (-not $ReadyEvent) { Fail 13 'frozen backend did not emit a ready event' }
if (-not $ConfigEvent -or -not $ConfigEvent.PSObject.Properties['hotkey_raw']) {
    Fail 13 'frozen backend did not return a valid config response to get_config'
}

# Step 14: require all four UI source files.
foreach ($f in @('index.html', 'app.js', 'styles.css', 'logo.svg')) {
    if (-not (Test-Path (Join-Path $RepoRoot "ui\$f"))) { Fail 14 "required UI file missing: ui\$f" }
}

# Step 15-16: generate and re-validate the builder config/metadata.
$GeneratedConfig = Join-Path $RunRoot 'generated\electron-builder.json'
& node (Join-Path $RepoRoot 'build\generate-builder-config.js') `
    --platform win --arch $Arch --run-id $RunId --repo-root $RepoRoot `
    --output $GeneratedConfig --include-uninstall-hook false
if ($LASTEXITCODE -ne 0) { Fail 11 'generate-builder-config.js failed' }
$Meta = Get-Content (Join-Path $RunRoot 'generated\electron-builder.meta.json') | ConvertFrom-Json
if ($Meta.runId -ne $RunId) { Fail 11 're-read metadata run ID does not match this invocation' }

$ExpectedBackendSource = Join-Path $RunRoot 'backend\ptt-backend'
$ExpectedElectronOutput = Join-Path $RunRoot 'electron'

# Step 17: validate the existing pair immediately before builder --dir.
Assert-GeneratedPair $GeneratedConfig $RunId 'win' $Arch $ExpectedBackendSource $ExpectedElectronOutput
Push-Location $ElectronDir
try {
    & .\node_modules\.bin\electron-builder.cmd --win --dir --config $GeneratedConfig --publish=never
    if ($LASTEXITCODE -ne 0) { Fail 17 'electron-builder --dir failed' }
} finally {
    Pop-Location
}

# Step 18-19: discover the unpacked app (SS6.1) via bounded structural
# search - exactly one "PTT.exe" with a sibling resources
# directory - not an assumption that output always has a top-level
# "*-unpacked" directory name.
$AppCandidates = @(Get-ChildItem (Join-Path $RunRoot 'electron') -File -Recurse -Filter 'PTT.exe' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.Directory.FullName 'resources') })
if ($AppCandidates.Count -eq 0) {
    Fail 5 "no structurally valid unpacked PTT.exe found under $RunRoot\electron"
}
if ($AppCandidates.Count -gt 1) {
    Fail 6 "ambiguous unpacked output - found $($AppCandidates.Count) structurally valid application executables"
}
$AppExe = $AppCandidates[0]
$UnpackedDir = $AppExe.Directory.FullName
$ResourcesDir = Join-Path $UnpackedDir 'resources'
$ExpectedUiFiles = @('app.js', 'index.html', 'logo.svg', 'styles.css')
foreach ($required in @('ui\index.html', 'ui\app.js', 'ui\styles.css', 'ui\logo.svg', 'backend\ptt-backend.exe')) {
    if (-not (Test-Path (Join-Path $ResourcesDir $required))) {
        Fail 19 "packaged inventory missing: resources\$required"
    }
}
$ActualUiFiles = @(Get-ChildItem (Join-Path $ResourcesDir 'ui') -File | ForEach-Object { $_.Name } | Sort-Object)
if (($ActualUiFiles -join '|') -ne (($ExpectedUiFiles | Sort-Object) -join '|')) {
    Fail 19 "resources\ui must contain exactly four approved files; found: $($ActualUiFiles -join ', ')"
}

# Step 20-23: launch the unpacked app, human renderer gate, close-and-verify -
# unless -SkipSmokeTest, in which case packaging still proceeds through to a
# real installer (corrected turn 3 - Codex turn-2 finding: this previously
# exited before ever building one). The installer is just marked UNVERIFIED
# and cannot be the artifact used for acceptance (SS17.1).
$SmokeSkipped = $SkipSmokeTest.IsPresent
if (-not $SmokeSkipped) {
    # Turn 5/6: a noninteractive session (CI, scheduled task) cannot answer
    # the y/n gate below - fail closed with a specific exit code rather than
    # hanging on Read-Host, per SS17.1's noninteractive-shell requirement.
    if (-not [Environment]::UserInteractive) {
        Fail 9 'interactive renderer smoke gate is unavailable; rerun interactively or use -SkipSmokeTest to produce an UNVERIFIED artifact'
    }
    $AppProc = Start-Process -FilePath $AppExe.FullName -PassThru
    Start-Sleep -Seconds 3
    # Turn 5/6: scope backend discovery to this specific launch's own child
    # process, not a global process-name lookup - a global lookup could
    # match an unrelated ptt-backend.exe from a different run.
    $BackendProcAtLaunch = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $AppProc.Id -and $_.Name -eq 'ptt-backend.exe' } |
        Select-Object -First 1

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

    # Step 22 equivalent: close and verify stopped before continuing -
    # confirmed exit for both recorded PIDs, not just the app's.
    if ($AppProc -and -not $AppProc.HasExited) { Stop-Process -Id $AppProc.Id -Force -ErrorAction SilentlyContinue }
    if ($BackendProcAtLaunch) { Stop-Process -Id $BackendProcAtLaunch.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if (Get-Process -Id $AppProc.Id -ErrorAction SilentlyContinue) { Fail 11 'SMOKE_APP_DID_NOT_STOP: app process still running after force-termination' }
    if ($BackendProcAtLaunch -and (Get-Process -Id $BackendProcAtLaunch.ProcessId -ErrorAction SilentlyContinue)) {
        Fail 11 'SMOKE_BACKEND_DID_NOT_STOP: recorded backend process still running after force-termination'
    }

    if ($answer -match '^(n|no)$') { Fail 8 'SMOKE_TEST_FAILED: renderer check failed' }
} else {
    Write-Host 'build-app: smoke test skipped (-SkipSmokeTest) - packaging continues, artifact will be marked UNVERIFIED and cannot be used for acceptance.'
    $AppProc = [PSCustomObject]@{ StartTime = Get-Date }
}

# Step 24-26: revalidate the existing pair (do not regenerate over evidence
# of corruption between builder calls - turn 5/6 fix), run NSIS, require the
# installer.
Assert-GeneratedPair $GeneratedConfig $RunId 'win' $Arch $ExpectedBackendSource $ExpectedElectronOutput

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

if ($SmokeSkipped) {
    New-Item -ItemType File -Path (Join-Path $RunRoot 'UNVERIFIED.txt') -Force | Out-Null
}

Write-Host ''
Write-Host "build-app: SUCCESS$(if ($SmokeSkipped) { ' (UNVERIFIED - smoke test skipped, cannot be used for acceptance)' }). run=$RunId installer=$($Installer.FullName)"
Write-Host "config=$GeneratedConfig meta=$(Join-Path $RunRoot 'generated\electron-builder.meta.json')"
Write-Host "backend=$FrozenExe resources=$ResourcesDir arch=$Arch git=$GitSha$(if ($GitDirty) { ' (dirty)' })"
