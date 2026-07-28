#!/usr/bin/env node
'use strict';

// The only component in this repo that resolves dynamic (per-run) build
// paths into an electron-builder config. electron/package.json stays fully
// static (no <run-id> placeholder) - see FINAL_BRIEF.md SS4 and SS4.1.
// electron-builder.json has no runId field of its own; electron-builder.meta.json
// is the sole run-ID authority (SS4.1 step 9/11).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fatal(code, message) {
  process.stderr.write(`generate-builder-config: FATAL(${code}): ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) fatal(2, `unexpected argument ${tok}`);
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fatal(2, `--${key} requires a value`);
    args[key] = next;
    i++;
  }
  return args;
}

function requireArgs(args, names) {
  for (const name of names) {
    if (!args[name]) fatal(2, `missing required --${name}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireArgs(args, ['platform', 'arch', 'run-id', 'repo-root', 'output', 'include-uninstall-hook']);

  if (!['win', 'mac'].includes(args.platform)) fatal(2, `--platform must be win|mac, got ${args.platform}`);
  if (!/^[a-z0-9]+$/.test(args.arch)) fatal(2, `--arch must be a simple lowercase token, got ${args.arch}`);
  if (!/^[A-Za-z0-9._+-]+$/.test(args['run-id'])) fatal(2, `--run-id contains disallowed characters: ${args['run-id']}`);
  if (!['true', 'false'].includes(args['include-uninstall-hook'])) {
    fatal(2, `--include-uninstall-hook must be true|false, got ${args['include-uninstall-hook']}`);
  }
  if (!path.isAbsolute(args['repo-root'])) fatal(2, '--repo-root must be an absolute path');
  if (!path.isAbsolute(args.output)) fatal(2, '--output must be an absolute path');

  // Step 1: resolve and normalize the repository root and current-run directory.
  const repoRoot = fs.realpathSync(args['repo-root']);
  const runId = args['run-id'];
  const runRoot = path.join(repoRoot, 'build', 'out', runId);
  if (!fs.existsSync(runRoot)) fatal(10, `run directory does not exist: ${runRoot} (build-app.ps1 must create it before calling this)`);
  const runRootReal = fs.realpathSync(runRoot);

  const backendSource = path.join(runRootReal, 'backend', 'push2talk-backend');
  const outputDir = path.join(runRootReal, 'electron');
  const uiSource = path.join(repoRoot, 'ui');

  // Step 2: reject any backend source or builder output path outside build/out/<run-id>/.
  for (const [label, p] of [['backend source', backendSource], ['builder output', outputDir]]) {
    if (p !== runRootReal && !p.startsWith(runRootReal + path.sep)) {
      fatal(2, `${label} must remain beneath ${runRootReal}, got ${p}`);
    }
  }

  const includeHook = args['include-uninstall-hook'] === 'true';

  // Steps 3-6: build the config object.
  const config = {
    appId: 'com.lelitte.push2talk',
    productName: 'Push 2 Talk',
    directories: {
      // electron-builder resolves `output` relative to electron/package.json's
      // directory unless absolute - always pass an absolute path here so this
      // never depends on the caller's cwd.
      output: outputDir,
    },
    files: ['main.js', 'preload.js', 'package.json'],
    extraResources: [
      { from: uiSource, to: 'ui', filter: ['index.html', 'app.js', 'styles.css', 'logo.svg'] },
      { from: backendSource, to: 'backend', filter: ['**/*'] },
    ],
    win: {
      target: args.platform === 'win' ? ['nsis'] : undefined,
    },
    mac: {
      target: args.platform === 'mac' ? ['dmg'] : undefined,
    },
    nsis: {
      perMachine: false,
      oneClick: false,
      allowToChangeInstallationDirectory: false,
    },
  };
  if (args.platform === 'win') delete config.mac; else delete config.win;
  if (includeHook) {
    config.nsis.include = path.join(repoRoot, 'build', 'nsis', 'uninstall-hook.nsh');
  }

  // Step 7: serialize to a same-directory temp file.
  const outDir = path.dirname(args.output);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpConfigPath = `${args.output}.tmp-${process.pid}`;
  const serialized = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmpConfigPath, serialized, 'utf8');

  // Step 8-9: re-read, parse, and assert backend source / output directory match.
  let reread;
  try {
    reread = JSON.parse(fs.readFileSync(tmpConfigPath, 'utf8'));
  } catch (e) {
    fs.unlinkSync(tmpConfigPath); // step 12: remove temp file on handled failure
    fatal(11, `re-read of temporary config failed to parse: ${e.message}`);
  }
  const rereadBackendSource = reread.extraResources && reread.extraResources[1] && reread.extraResources[1].from;
  const rereadOutputDir = reread.directories && reread.directories.output;
  if (rereadBackendSource !== backendSource || rereadOutputDir !== outputDir) {
    fs.unlinkSync(tmpConfigPath); // step 12
    fatal(11, `re-read config does not match the current invocation's backend source/output directory`);
  }

  // Step 10: atomic same-directory rename.
  fs.renameSync(tmpConfigPath, args.output);

  // Step 11: write electron-builder.meta.json through the same temp-and-rename procedure.
  const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const gitDirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() !== '';
  const meta = {
    runId,
    platform: args.platform,
    arch: args.arch,
    gitSha,
    gitDirty,
    configPath: args.output,
    backendSource,
    outputDir,
    includeUninstallHook: includeHook,
    generatedAt: new Date().toISOString(),
  };
  const metaPath = path.join(outDir, 'electron-builder.meta.json');
  const tmpMetaPath = `${metaPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpMetaPath, JSON.stringify(meta, null, 2), 'utf8');
  let rereadMeta;
  try {
    rereadMeta = JSON.parse(fs.readFileSync(tmpMetaPath, 'utf8'));
  } catch (e) {
    fs.unlinkSync(tmpMetaPath); // step 12
    fatal(11, `re-read of temporary metadata failed to parse: ${e.message}`);
  }
  if (rereadMeta.runId !== runId) {
    fs.unlinkSync(tmpMetaPath); // step 12
    fatal(11, 're-read metadata run ID does not match the current invocation');
  }
  fs.renameSync(tmpMetaPath, metaPath);

  process.stdout.write(`generate-builder-config: wrote ${args.output} and ${metaPath} for run ${runId}\n`);
}

main();
