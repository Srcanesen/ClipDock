import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reconcileDirectoryContents } from '../scripts/lib/install-files.mjs';

test('installer refuses a destination containing dist instead of deleting the checkout', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-install-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['scripts', 'src', 'static', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.cpSync(entry, path.join(root, entry), { recursive: true });
  }
  const native = path.join(root, 'WorkflowIntegration.node');
  fs.writeFileSync(native, 'HOST NATIVE');
  const sentinel = path.join(root, 'keep.txt');
  fs.writeFileSync(sentinel, 'CHECKOUT DATA');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-plugin.mjs'), `--destination=${root}`, `--native-module=${native}`], { encoding: 'utf8' });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Source and destination directories must not overlap/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'CHECKOUT DATA');
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'main.js'), 'utf8'), fs.readFileSync('dist/main.js', 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, 'scripts', 'install-plugin.mjs'), 'utf8'), fs.readFileSync('scripts/install-plugin.mjs', 'utf8'));
});

test('directory swap refuses both nested and identical targets without leaving a transaction', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-directory-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'keep.txt'), 'SOURCE DATA');
  for (const destination of [source, root, path.join(source, 'nested')]) {
    assert.throws(() => reconcileDirectoryContents(source, destination), /Source and destination directories must not overlap/);
    assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'SOURCE DATA');
    assert.deepEqual(fs.readdirSync(root), ['source']);
    assert.deepEqual(fs.readdirSync(source), ['keep.txt']);
  }
  // Similar prefixes are distinct folders and must remain usable on repeat runs.
  const destination = path.join(root, 'source-copy');
  reconcileDirectoryContents(source, destination);
  reconcileDirectoryContents(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'SOURCE DATA');
  assert.deepEqual(fs.readdirSync(root).sort(), ['source', 'source-copy']);
});
