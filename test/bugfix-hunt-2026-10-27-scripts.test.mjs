import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = path.join(repo, 'scripts', 'install-plugin.mjs');

function temp(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, 'WorkflowIntegration.node');
  writeFileSync(native, 'HOST NATIVE');
  return { root, native };
}
const install = (destination, native, cwd = repo) => spawnSync(process.execPath, [installer, `--destination=${destination}`, `--native-module=${native}`], { cwd, encoding: 'utf8' });
const output = (result) => `${result.stdout}\n${result.stderr}`;

test('installer refuses an empty --destination instead of replacing the working directory', (t) => {
  const { root, native } = temp(t);
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, 'keep.txt'), 'USER DATA');
  const result = install('', native, cwd);
  assert.equal(result.status, 1, output(result));
  assert.match(result.stderr, /--destination must not be empty/);
  assert.deepEqual(readdirSync(cwd), ['keep.txt']);
});

test('installer refuses the Workflow Integration root and keeps other plugins', (t) => {
  const { root, native } = temp(t);
  const plugins = path.join(root, 'Workflow Integration Plugins');
  mkdirSync(path.join(plugins, 'com.other.plugin'), { recursive: true });
  writeFileSync(path.join(plugins, 'com.other.plugin', 'manifest.xml'), '<Id>com.other.plugin</Id>');
  const result = install(plugins, native);
  assert.equal(result.status, 1, output(result));
  assert.match(result.stderr, /must be named com\.clipdock\.app/);
  assert.deepEqual(readdirSync(plugins), ['com.other.plugin']);
  assert.equal(readFileSync(path.join(plugins, 'com.other.plugin', 'manifest.xml'), 'utf8'), '<Id>com.other.plugin</Id>');
});

test('installer refuses an existing com.clipdock.app folder that is not a ClipDock install', (t) => {
  const { root, native } = temp(t);
  for (const [name, files] of [['data', { 'keep.txt': 'USER DATA' }], ['foreign', { 'manifest.xml': '<Id>com.other.plugin</Id>' }]]) {
    const destination = path.join(root, name, 'com.clipdock.app');
    mkdirSync(destination, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(destination, file), text);
    const result = install(destination, native);
    assert.equal(result.status, 1, `${name}: ${output(result)}`);
    assert.match(result.stderr, /is not empty and holds no ClipDock install/);
    assert.deepEqual(readdirSync(destination), Object.keys(files));
  }
});

test('installer accepts an existing empty com.clipdock.app folder', (t) => {
  const { root, native } = temp(t);
  const destination = path.join(root, 'plugins', 'com.clipdock.app');
  mkdirSync(destination, { recursive: true });
  const result = install(destination, native);
  assert.equal(result.status, 0, output(result));
  assert.equal(readFileSync(path.join(destination, 'WorkflowIntegration.node'), 'utf8'), 'HOST NATIVE');
  assert.match(readFileSync(path.join(destination, 'manifest.xml'), 'utf8'), /<Id>com\.clipdock\.app<\/Id>/);
});
