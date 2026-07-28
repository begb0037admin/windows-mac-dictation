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

test('include-uninstall-hook true adds nsis.include; false omits it', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-3';
  fs.mkdirSync(path.join(repoRoot, 'build', 'out', runId, 'backend', 'push2talk-backend'), { recursive: true });
  const output = path.join(repoRoot, 'build', 'out', runId, 'generated', 'electron-builder.json');

  run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'true']);
  const withHook = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(withHook.nsis.include, 'expected nsis.include to be set');

  run(['--platform', 'win', '--arch', 'x64', '--run-id', runId, '--repo-root', repoRoot, '--output', output, '--include-uninstall-hook', 'false']);
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

test('interrupted-write simulation: a pre-existing corrupt output is fully replaced, not merged', () => {
  const repoRoot = freshRepo();
  const runId = 'test-run-4';
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
