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

test('V1: generates a valid config+metadata pair for a real run directory', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-1';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(output));
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.appId, 'com.lelitte.push2talk');
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
  fs.mkdirSync(path.join(runDir, 'backend', 'push2talk-backend'), { recursive: true });
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
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  const blocked = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'true']);
  assert.equal(blocked.status, 16);
  assert.ok(!fs.existsSync(output), 'blocked hook must not produce a usable builder config');

  const allowed = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(allowed.status, 0, allowed.stderr);
  const withoutHook = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(withoutHook.nsis.include, undefined);

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
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const wrongOutput = path.join(repoRoot, 'build', 'out', runId, 'wrong', 'electron-builder.json');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', wrongOutput, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 2);
  assert.ok(!fs.existsSync(wrongOutput));

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('generated Windows config fixes architecture, icons, and shortcuts', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-5';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');
  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.match(config.win.icon, /icon\.ico$/);
  assert.equal(config.nsis.shortcutName, 'Push 2 Talk');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('generated Mac config explicitly ad-hoc signs the complete app bundle', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-mac-signing';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
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
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
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

test('packaged app ships the tray icon as a real extraResource (not extracted from the exe)', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-7';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
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

test('packaged app includes the single-instance guard required by main.js', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-single-instance';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
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
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const generatedDir = path.join(repoRoot, 'build', 'out', runId, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const output = path.join(generatedDir, 'electron-builder.json');
  fs.writeFileSync(output, '{not valid json, simulating an interrupted prior write}');

  const res = run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.appId, 'com.lelitte.push2talk');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
