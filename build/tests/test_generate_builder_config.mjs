import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, '..');
const GENERATOR = path.join(BUILD_DIR, 'generate-builder-config.js');

function freshRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2t-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'electron'), { recursive: true });
  // generate-builder-config.js reads electron/package.json's version field
  // for build-info.json (shipped inside the app so it can report its own
  // version at runtime) - a real repo always has this file already.
  fs.writeFileSync(path.join(repoRoot, 'electron', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  // A real git commit, not just a directory - generate-builder-config.js
  // runs `git rev-parse HEAD` for build-info.json/meta.json's gitSha, which
  // returns empty outside an actual repo, silently masking the field in a
  // fixture that was never really a git repo.
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  spawnSync('git', ['add', '-A'], { cwd: repoRoot });
  spawnSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

function run(args) {
  return spawnSync('node', [GENERATOR, ...args], { encoding: 'utf8' });
}

// Windows builds require build-app.ps1 to have already downloaded and
// Authenticode-verified the VC++ Redistributable into build/out/<runId>/redist/
// before generate-builder-config.js runs - these fixtures stand in for that.
function ensureRedistFixture(repoRoot, runId) {
  const redistDir = path.join(repoRoot, 'build', 'out', runId, 'redist');
  fs.mkdirSync(redistDir, { recursive: true });
  fs.writeFileSync(path.join(redistDir, 'vc_redist.x64.exe'), 'fixture');
}

test('V1: generates a valid config+metadata pair for a real run directory', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-1';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(output));
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.appId, 'com.lelitte.ptt');
  assert.ok(config.extraResources[1].from.includes(runId));

  const metaPath = path.join(path.dirname(output), 'electron-builder.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.runId, runId, 'meta.json is the sole run-ID authority');
  assert.equal(meta.backendSource, config.extraResources[1].from);
  assert.equal(meta.outputDir, config.directories.output);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('no temp file is left behind after a successful run (atomic rename)', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-2';
  const runDir = path.join(repoRoot, 'build', 'out', runId);
  fs.mkdirSync(path.join(runDir, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const generatedDir = path.join(runDir, 'generated');
  const output = path.join(generatedDir, 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const leftoverTemp = fs.readdirSync(generatedDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftoverTemp, [], 'no .tmp-<pid> file should survive a successful run');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('unverified uninstall hook is mechanically blocked', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-3';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  const blocked = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'true']);
  assert.equal(blocked.status, 16);
  assert.ok(!fs.existsSync(output), 'blocked hook must not produce a usable builder config');

  const allowed = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(allowed.status, 0, allowed.stderr);
  const withoutHook = JSON.parse(fs.readFileSync(output, 'utf8'));
  // The blocked uninstall hook must never be wired in - but Windows builds
  // always carry the (separate, unblocked) VC++-redist install hook.
  assert.match(withoutHook.nsis.include, /vcredist-install\.nsh$/);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('rejects when the run directory does not exist (exit 10) - stale-metadata/no-op protection', () => {
  const repoRoot = freshRepo();
  const runId = 'never-created';
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 10);
  assert.ok(!fs.existsSync(output), 'must not write anything for a nonexistent run');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('rejects missing required arguments', () => {
  const res = run(['--platform', 'win']);
  assert.equal(res.status, 2);
});

test('rejects an invalid platform value', () => {
  const repoRoot = freshRepo();
  const res = run(['--platform', 'linux', '--arch', 'x64', '--run-id', 'x', '--repo-root', repoRoot, '--output', path.join(repoRoot, 'out.json'), '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 2);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('rejects output outside the active run prescribed generated path', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-4';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  const wrongOutput = path.join(repoRoot, 'build', 'out', runId, 'wrong', 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', wrongOutput, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 2);
  assert.ok(!fs.existsSync(wrongOutput));

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('generated Windows config fixes architecture, icons, and shortcuts', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-5';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.match(config.win.icon, /icon\.ico$/);
  assert.equal(config.nsis.shortcutName, 'PTT');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('generated Mac config explicitly ad-hoc signs the complete app bundle', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-mac-signing';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'mac', '--arch', 'arm64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);

  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.mac.identity, '-', 'must opt in to ad-hoc signing instead of silently skipping signing');
  assert.equal(config.mac.hardenedRuntime, false, 'ad-hoc builds must not enable Team-ID-dependent library validation');
  assert.equal(config.mac.forceCodeSigning, true, 'a signing failure must fail the package build');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('packaged app ships a build-info.json extraResource with version/commit/build-time', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-8';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));

  const buildInfoResource = config.extraResources.find((r) => r.to === 'build-info.json');
  assert.ok(buildInfoResource, 'must ship a build-info.json extraResource so main.js can read it via process.resourcesPath');
  assert.ok(fs.existsSync(buildInfoResource.from), 'the referenced build-info.json must actually exist on disk');

  const buildInfo = JSON.parse(fs.readFileSync(buildInfoResource.from, 'utf8'));
  assert.equal(buildInfo.version, '0.1.0');
  assert.equal(buildInfo.runId, runId);
  assert.equal(buildInfo.platform, 'win');
  assert.equal(buildInfo.arch, 'x64');
  assert.match(buildInfo.gitSha, /^[0-9a-f]{8}$/, 'gitSha should be an 8-char short hash');
  assert.equal(typeof buildInfo.gitDirty, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(buildInfo.builtAt)), 'builtAt should be a valid ISO timestamp');

  const metaPath = path.join(path.dirname(output), 'electron-builder.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(meta.gitSha.startsWith(buildInfo.gitSha), 'build-info.json\'s short sha should be a prefix of meta.json\'s full sha');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('packaged app ships the tray icon as a real extraResource (not extracted from the exe) - Windows uses icon.ico', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-7';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  const iconResource = config.extraResources.find((r) => r.to === 'icons');
  assert.ok(iconResource, 'must ship an "icons" extraResource so main.js can load it via process.resourcesPath at runtime');
  assert.deepEqual(iconResource.filter, ['icon.ico']);
  assert.match(iconResource.from, /electron[\\/]build$/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('packaged app ships the tray icon as a real extraResource - macOS uses icon.png (icon.ico/icon.icns both decode empty on real Electron 43.2.0)', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-icon-mac';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'mac', '--arch', 'arm64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  const iconResource = config.extraResources.find((r) => r.to === 'icons');
  assert.ok(iconResource);
  assert.deepEqual(iconResource.filter, ['icon.png']);
  assert.match(iconResource.from, /electron[\\/]build$/);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('packaged app ships tray, permission-gate, recovery, and supervisor modules on both platforms', () => {
  const runId = 'test-run-supervisor-files';
  for (const platform of ['win', 'mac']) {
    const repoRoot = freshRepo();
    fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
    if (platform === 'win') ensureRedistFixture(repoRoot, runId);
    const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
    const arch = platform === 'win' ? 'x64' : 'arm64';
    const res = run(['--platform', platform, '--arch', arch, '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
    assert.equal(res.status, 0, res.stderr);
    const config = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.ok(config.files.includes('tray-icon-path.js'), `${platform}: files must include tray-icon-path.js`);
    assert.ok(config.files.includes('mac-permission-gate.js'), `${platform}: files must include mac-permission-gate.js`);
    assert.ok(config.files.includes('backend-recovery.js'), `${platform}: files must include backend-recovery.js`);
    assert.ok(config.files.includes('backend-supervisor.js'), `${platform}: files must include backend-supervisor.js`);
    assert.ok(config.files.includes('lifecycle-wiring.js'), `${platform}: files must include lifecycle-wiring.js`);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('packaged app includes the single-instance guard required by main.js', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-single-instance';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'mac', '--arch', 'arm64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(config.files.includes('single-instance-logic.js'));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Kept alongside the prescribed-path test above (Codex's turn-5 diff dropped
// this one when adding that test; retained here since it covers a genuinely
// different behavior - the generator's own code still does atomic
// temp-write-then-rename and losing test coverage for it isn't warranted).
test('interrupted-write simulation: a pre-existing corrupt output is fully replaced, not merged', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-6';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const generatedDir = path.join(repoRoot, 'build', 'out', runId, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const output = path.join(generatedDir, 'electron-builder.json');
  fs.writeFileSync(output, '{not valid json, simulating an interrupted prior write}');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.appId, 'com.lelitte.ptt');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('Windows build ships the VC++ Redistributable and wires its install hook', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-vcredist';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  ensureRedistFixture(repoRoot, runId);
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));

  const redistResource = config.extraResources.find((r) => r.to === 'redist/vc_redist.x64.exe');
  assert.ok(redistResource, 'must ship a redist/vc_redist.x64.exe extraResource so vcredist-install.nsh can install it from $INSTDIR\\resources\\redist');
  assert.ok(fs.existsSync(redistResource.from), 'the referenced vc_redist.x64.exe must actually exist on disk');
  assert.match(config.nsis.include, /vcredist-install\.nsh$/);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('Windows build fails closed when the VC++ Redistributable is missing', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-no-redist';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  // Deliberately no ensureRedistFixture() call - simulates build-app.ps1
  // failing to download/verify the redistributable before this generator runs.
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 12);
  assert.ok(!fs.existsSync(output), 'must not write a builder config that would ship without the redistributable');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('Mac builds do not require or ship the Windows-only VC++ Redistributable', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-mac-no-redist';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'ptt-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'mac', '--arch', 'arm64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.extraResources.find((r) => r.to === 'redist/vc_redist.x64.exe'), undefined);
  assert.equal(config.nsis.include, undefined, 'vcredist-install.nsh is Windows-only');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
