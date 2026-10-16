import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-tooling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['scripts', 'src', 'static', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  const plugins = path.join(root, 'plugins');
  const destination = path.join(plugins, 'com.clipdock.app');
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, 'old.js'), 'WORKING OLD PLUGIN');
  const native = path.join(root, 'WorkflowIntegration.node');
  writeFileSync(native, 'HOST NATIVE');
  // Redirect only host path literals in the copied CLI, also allowing these
  // same cases to reproduce against the pre-fix CLI that had no path options.
  for (const file of ['install-plugin.mjs', 'verify-installed-plugin.mjs']) {
    const script = path.join(root, 'scripts', file);
    writeFileSync(script, readFileSync(script, 'utf8')
      .replaceAll('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node', native)
      .replaceAll('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins', plugins));
  }
  const temp = path.join(root, 'tmp'); mkdirSync(temp);
  const run = (script, args = [], env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, env: { ...process.env, TMPDIR: temp, ...env }, encoding: 'utf8' });
  const install = () => run('install-plugin.mjs', [`--destination=${destination}`, `--native-module=${native}`]);
  const verify = () => run('verify-installed-plugin.mjs', [`--destination=${destination}`, `--native-module=${native}`]);
  return { root, destination, native, run, install, verify };
}
const output = (result) => `${result.stdout}\n${result.stderr}`;
function oldPreserved(fx) {
  assert.equal(readFileSync(path.join(fx.destination, 'old.js'), 'utf8'), 'WORKING OLD PLUGIN');
  assert.deepEqual(readdirSync(fx.destination), ['old.js']);
}

test('installer refuses missing native input before replacing a working plugin (TLG-1)', (t) => {
  const fx = fixture(t);
  for (const kind of ['missing', 'empty', 'directory']) {
    rmSync(fx.native, { recursive: true, force: true });
    if (kind === 'empty') writeFileSync(fx.native, '');
    if (kind === 'directory') mkdirSync(fx.native);
    const result = fx.install();
    assert.equal(result.status, 1, output(result));
    oldPreserved(fx);
  }
});

test('installer rejects empty, partial, stale, and modified artifacts (TLG-2)', (t) => {
  for (const kind of ['empty', 'partial', 'stale', 'modified']) {
    const fx = fixture(t);
    if (kind === 'empty') { rmSync(path.join(fx.root, 'dist'), { recursive: true }); mkdirSync(path.join(fx.root, 'dist')); }
    if (kind === 'partial') rmSync(path.join(fx.root, 'dist', 'preload.js'));
    if (kind === 'stale') writeFileSync(path.join(fx.root, 'src', 'main.ts'), '// new unbuilt source');
    if (kind === 'modified') writeFileSync(path.join(fx.root, 'dist', 'main.js'), 'STALE DIST');
    const result = fx.install();
    assert.equal(result.status, 1, `${kind}: ${output(result)}`);
    oldPreserved(fx);
  }
});

test('installer stages the native sidecar and installed verification checks every byte (TLG-1/TLG-3)', (t) => {
  const fx = fixture(t);
  assert.equal(fx.install().status, 0);
  assert.equal(readFileSync(path.join(fx.destination, 'WorkflowIntegration.node'), 'utf8'), 'HOST NATIVE');
  assert.equal(existsSync(path.join(fx.destination, 'old.js')), false);
  const result = fx.verify();
  assert.equal(result.status, 0, output(result));
  writeFileSync(path.join(fx.destination, 'preload.js'), 'WRONG');
  const wrong = fx.verify();
  assert.equal(wrong.status, 1);
  assert.match(output(wrong), /differs: preload.js/);
});

test('installed verifier rejects an empty reference even when installed bytes agree (TLG-3)', (t) => {
  const fx = fixture(t);
  rmSync(path.join(fx.root, 'dist'), { recursive: true }); mkdirSync(path.join(fx.root, 'dist'));
  rmSync(fx.destination, { recursive: true }); mkdirSync(fx.destination);
  cpSync(fx.native, path.join(fx.destination, 'WorkflowIntegration.node'));
  const result = fx.verify();
  assert.equal(result.status, 1, output(result));
});

test('built manifest ID mismatch fails the actual artifact verifier (TLG-4)', (t) => {
  const fx = fixture(t);
  const manifest = path.join(fx.root, 'dist', 'manifest.xml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('com.clipdock.app', 'com.wrong.plugin'));
  const result = fx.run('verify-plugin.mjs');
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /manifest <Id> must be com.clipdock.app/);
});

test('required contracts transformation failure does not publish a partial build (TLG-7)', (t) => {
  const fx = fixture(t);
  const before = readFileSync(path.join(fx.root, 'dist', 'renderer.js'), 'utf8');
  // Real tsc emits the colliding output; required CJS conversion then fails.
  writeFileSync(path.join(fx.root, 'src', 'contracts.ts'), 'export const sentinel = 1;');
  // A compiler wrapper creates a directory after tsc to inject the exact I/O fault.
  const preload = path.join(fx.root, 'fault.cjs');
  writeFileSync(preload, `const cp = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
for (const method of ['execFileSync', 'execSync']) { const original = cp[method]; cp[method] = function (...args) { const result = original.apply(this, args); const out = Array.isArray(args[1]) && args[1].includes('--outDir') ? args[1][args[1].indexOf('--outDir') + 1] : path.join(process.cwd(), 'dist'); fs.rmSync(path.join(out, 'contracts.js'), {force:true}); fs.mkdirSync(path.join(out, 'contracts.js')); return result; }; }
`);
  const result = fx.run('build.mjs', [], { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 1, output(result));
  assert.equal(readFileSync(path.join(fx.root, 'dist', 'renderer.js'), 'utf8'), before);
  assert.equal(readdirSync(fx.root).some((name) => name.startsWith('.build-')), false);
});

test('missing renderer dependencies fail the real build rather than being erased (TLG-7)', (t) => {
  const fx = fixture(t);
  const renderer = path.join(fx.root, 'src', 'renderer.ts');
  writeFileSync(renderer, readFileSync(renderer, 'utf8') + '\nconst unsupported = require("./missing-browser-module"); console.log(unsupported);\n');
  const result = fx.run('build.mjs');
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /unresolved CommonJS/);
});

test('artifact verifier removes its fixture namespace on both success and failure (TLG-17)', (t) => {
  const fx = fixture(t);
  const temp = path.join(fx.root, 'isolated-tmp'); mkdirSync(temp);
  for (const kind of ['success', 'late-failure', 'early-failure']) {
    if (kind === 'late-failure') writeFileSync(path.join(fx.root, 'dist', 'pexels.js'), 'throw new Error("controlled late verifier failure");');
    if (kind === 'early-failure') rmSync(path.join(fx.root, 'dist', 'manifest.xml'));
    const result = fx.run('verify-plugin.mjs', [], { TMPDIR: temp });
    assert.equal(result.status, kind === 'success' ? 0 : 1, output(result));
    // TLG-18 owns the credential store's separate default ClipDock mutex path.
    assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('clipdock-')), []);
  }
});

test('every npm command documented in AGENTS exists (TLG-16)', () => {
  const instructions = readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  const scripts = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts;
  for (const match of instructions.matchAll(/npm run ([\w:-]+)/g)) assert.equal(typeof scripts[match[1]], 'string', match[1]);
});

test('preview requests survive a missing artifact and serve it after rebuild (TLG-15)', (t) => {
  const fx = fixture(t);
  const preload = path.join(fx.root, 'preview-request.cjs');
  writeFileSync(preload, `const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
http.createServer = callback => ({ listen() {
  const index = path.join(process.cwd(), 'dist/index.html'); const held = index + '.held';
  const request = () => { const result = {}; callback({url:'/'}, {writeHead(status) { result.status = status; }, end(body) {result.body = body;} }); return result; };
  fs.renameSync(index, held);
  const missing = request();
  fs.renameSync(held, index);
  const ready = request();
  process.stdout.write(JSON.stringify({missing, ready}));
} }); require('node:module').syncBuiltinESMExports();`);
  const result = fx.run('preview.mjs', [], { NODE_OPTIONS: `--require=${preload}` });
  assert.equal(result.status, 0, output(result));
  const responses = JSON.parse(result.stdout);
  assert.equal(responses.missing.status, 503);
  assert.equal(responses.missing.body, 'Preview artifact unavailable; rebuild and retry');
  assert.equal(responses.ready.status, 200);
  assert.match(responses.ready.body, /src="preview.js"/);
});

test('headless orchestrator reports an asynchronous spawn failure without probing (TLG-14)', (t) => {
  const fx = fixture(t);
  const bundle = path.join(fx.root, 'Fake.app');
  mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(bundle, 'Contents/Libraries/Fusion'), { recursive: true });
  writeFileSync(path.join(bundle, 'Contents/MacOS/Resolve'), 'NONEXECUTABLE');
  writeFileSync(path.join(bundle, 'Contents/Libraries/Fusion/fusionscript.so'), 'FAKE');
  const bin = path.join(fx.root, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = fx.run('resolve-smoke/run.mjs', [`--bundle=${bundle}`, `--script-api=${fx.root}`, `--probe=${path.join(fx.root, 'must-not-probe.py')}`], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 3, output(result));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'launch-failed');
  assert.match(report.errors[0].message, /EACCES/);
  assert.equal(report.phases, null);
  assert.doesNotMatch(result.stderr, /Unhandled 'error'/);
});

test('installer CLI restores a crashed upgrade before rejecting missing native input (TLG-6)', (t) => {
  const fx = fixture(t);
  const helper = pathToFileURL(path.join(fx.root, 'scripts/lib/install-files.mjs')).href;
  const code = `import fs from 'node:fs'; import { reconcileDirectoryContents } from ${JSON.stringify(helper)};
    const dest = ${JSON.stringify(fx.destination)};
    reconcileDirectoryContents(${JSON.stringify(path.join(fx.root, 'dist'))}, dest, {...fs, renameSync(from, to) { fs.renameSync(from, to); if (from === dest) process.exit(73); }});`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(crashed.status, 73, output(crashed));
  assert.equal(existsSync(fx.destination), false);
  rmSync(fx.native);
  const result = fx.install();
  assert.equal(result.status, 1, output(result));
  oldPreserved(fx);
  assert.deepEqual(readdirSync(path.dirname(fx.destination)), ['com.clipdock.app']);
});
