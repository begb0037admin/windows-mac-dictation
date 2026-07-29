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

  // Turn 5 (Codex, applied by hand turn 6 after the patch itself failed to
  // apply mechanically): --output must be exactly the active run's
  // prescribed path, never an arbitrary caller-supplied location.
  const prescribedOutput = path.join(runRootReal, 'generated', 'electron-builder.json');
  if (path.resolve(args.output) !== prescribedOutput) {
    fatal(2, `--output must be the active run's prescribed generated path: ${prescribedOutput}`);
  }

  // The checked-in hook is explicitly a pre-observation guess (SS16/SS18)
  // and must not be usable until a bootstrap install has established the
  // exact Run-key registration and the hook has been rewritten and
  // validated against it - mechanically blocked rather than left to
  // discipline.
  if (args['include-uninstall-hook'] === 'true') {
    fatal(16, 'uninstall hook is blocked until bootstrap installation observation and hook validation are recorded');
  }

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
    // Corrected turn 3 (Codex turn-2 finding): main.js requires() diagnostics.js/
    // login-item-logic.js/fatal-gate.js at runtime - omitting them from the
    // packaged app.asar would make the packaged app fail to launch with
    // MODULE_NOT_FOUND. Every module main.js actually loads must be listed.
    files: ['main.js', 'preload.js', 'package.json', 'diagnostics.js', 'login-item-logic.js', 'fatal-gate.js'],
    extraResources: [
      { from: uiSource, to: 'ui', filter: ['index.html', 'app.js', 'styles.css', 'logo.svg'] },
      { from: backendSource, to: 'backend', filter: ['**/*'] },
      // Tray icon: nativeImage.createFromPath(process.execPath) does NOT
      // extract the icon embedded in the exe on Windows (that's not what
      // the API does - it decodes actual image files), so the packaged
      // app must ship icon.ico as a real resource and load it directly.
      { from: path.join(repoRoot, 'electron', 'build'), to: 'icons', filter: ['icon.ico'] },
    ],
    win: {
      target: args.platform === 'win' ? [{ target: 'nsis', arch: [args.arch] }] : undefined,
      icon: path.join(repoRoot, 'electron', 'build', 'icon.ico'),
    },
    mac: {
      target: args.platform === 'mac' ? [{ target: 'dmg', arch: [args.arch] }] : undefined,
      icon: path.join(repoRoot, 'electron', 'build', 'icon.icns'),
      category: 'public.app-category.productivity',
      // FINAL_BRIEF.md SS4 calls for "microphone and Apple Events" usage
      // descriptions specifically. Accessibility permission (also needed,
      // for paste simulation - see docs on Input Monitoring/Accessibility
      // in SS20 M5) has no Info.plist usage-description key at all on
      // modern macOS - it's granted through a generic System Settings
      // prompt, not a custom string, so there is nothing to put here for
      // it. Apple Events (osascript/System Events automation, also used
      // for paste/focus handling) does require NSAppleEventsUsageDescription.
      extendInfo: {
        NSMicrophoneUsageDescription: 'Push 2 Talk requires microphone access to transcribe speech.',
        NSAppleEventsUsageDescription: 'Push 2 Talk requires Apple Events access to paste transcribed text into other apps.',
      },
    },
    nsis: {
      perMachine: false,
      oneClick: false,
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Push 2 Talk',
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
