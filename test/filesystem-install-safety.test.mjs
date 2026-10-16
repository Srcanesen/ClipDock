// Deterministic safety lane for settings and verifier regressions.
// Installer behavior is covered in test/install-plugin.test.mjs.
// Run after `npm run build` with: node --test test/filesystem-install-safety.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { prepareCustomDownloadFolder, DOWNLOAD_FOLDER_MARKER } from '../dist/settings.js';


// --- Bug 1: symlink custom folder must be rejected and must not write marker through target ---
test('safety: symlink custom folder is rejected and writes no marker through target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-safety-symlink-'));
  try {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);

    assert.throws(() => prepareCustomDownloadFolder(link), /usable|symlink|not usable/i, 'symlink folder must be rejected');

    const markerInTarget = path.join(target, DOWNLOAD_FOLDER_MARKER);
    const markerInLink = path.join(link, DOWNLOAD_FOLDER_MARKER);
    assert.equal(fs.existsSync(markerInTarget), false, 'marker must not be written through symlink target');
    assert.equal(fs.existsSync(markerInLink), false, 'marker must not appear via symlink path');
    assert.deepEqual(fs.readdirSync(target), [], 'target must remain empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Execute the unmodified verifier CLI in a disposable Windows-shaped installation.
// The preload substitutes platform only; every file the CLI sees belongs to this fixture.
test('safety: real verify-installed CLI rejects a shipped symlink and accepts matching files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-safety-verify-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join('scripts', 'verify-installed-plugin.mjs'), path.join(root, 'scripts', 'verify-installed-plugin.mjs'));
    // The build record ties dist to these inputs, so the fixture carries them unchanged.
    for (const input of ['src', 'static', 'scripts/lib', 'scripts/build.mjs', 'tsconfig.json', 'package.json', 'package-lock.json']) fs.cpSync(input, path.join(root, input), { recursive: true });
    const dist = path.join(root, 'dist');
    const programData = path.join(root, 'program-data');
    const installed = path.join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Workflow Integration Plugins', 'com.clipdock.app');
    const native = path.join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Workflow Integrations', 'Examples', 'SamplePlugin', 'WorkflowIntegration.node');
    fs.cpSync('dist', dist, { recursive: true });
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.cpSync(dist, installed, { recursive: true });
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, 'fixture native');
    fs.copyFileSync(native, path.join(installed, 'WorkflowIntegration.node'));
    const outside = path.join(root, 'outside.js');
    fs.copyFileSync(path.join(dist, 'renderer.js'), outside);
    fs.rmSync(path.join(installed, 'renderer.js'));
    fs.symlinkSync(outside, path.join(installed, 'renderer.js'));
    const preload = path.join(root, 'platform.mjs');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });");
    const run = () => spawnSync(process.execPath, ['--import', preload, path.join(root, 'scripts', 'verify-installed-plugin.mjs')], { env: { ...process.env, PROGRAMDATA: programData }, encoding: 'utf8', timeout: 5000 });
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /installed artifact contains symbolic link.*renderer\.js/);
    assert.equal(fs.readFileSync(outside, 'utf8'), fs.readFileSync(path.join(dist, 'renderer.js'), 'utf8'));
    fs.rmSync(path.join(installed, 'renderer.js'));
    fs.copyFileSync(path.join(dist, 'renderer.js'), path.join(installed, 'renderer.js'));
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /VERIFY INSTALLED PASSED: \d+ files match dist/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
