import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashFile, inventory } from '../scripts/lib/release-artifact.mjs';

const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-package-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['scripts', 'src', 'static', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.cpSync(entry, path.join(root, entry), { recursive: true });
  }
  return root;
}

const runPackage = (root, out, env) => spawnSync(process.execPath, [path.join(root, 'scripts', 'package.mjs'), `--out=${out}`], { encoding: 'utf8', env });

test('package zip holds the exact built plugin and install notes, without the Resolve native module', (t) => {
  const root = fixture(t);
  const out = path.join(root, 'out');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // A leftover archive from an earlier run must be replaced, not updated in place.
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, `ClipDock-${version}.zip`), 'not a zip');

  let env;
  if (process.platform === 'win32') {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(system32, 'where.exe'), path.join(bin, 'tar.exe'));
    env = { ...process.env, PATH: [bin, process.env.PATH].join(path.delimiter) };
  }
  const result = runPackage(root, out, env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(fs.readdirSync(out), [`ClipDock-${version}.zip`]);

  const extracted = path.join(root, 'extracted');
  const archive = path.join(out, `ClipDock-${version}.zip`);
  fs.mkdirSync(extracted);
  const unzip = process.platform === 'win32'
    ? spawnSync(path.join(system32, 'tar.exe'), ['-x', '-f', archive, '-C', extracted], { encoding: 'utf8', windowsHide: true })
    : spawnSync('unzip', ['-q', archive, '-d', extracted], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);
  assert.deepEqual(fs.readdirSync(extracted), [`ClipDock-${version}`]);
  const top = path.join(extracted, `ClipDock-${version}`);
  assert.deepEqual(fs.readdirSync(top).sort(), ['INSTALL.txt', 'com.clipdock.app']);

  const dist = path.join(root, 'dist');
  const built = inventory(dist).files;
  const packaged = inventory(path.join(top, 'com.clipdock.app'));
  assert.deepEqual(packaged.problems, []);
  assert.deepEqual(packaged.files, built);
  assert.ok(built.includes('main.js') && built.includes('manifest.xml'));
  for (const file of built) assert.equal(hashFile(path.join(top, 'com.clipdock.app', file)), hashFile(path.join(dist, file)), file);
  assert.equal(packaged.files.includes('WorkflowIntegration.node'), false);
  assert.match(fs.readFileSync(path.join(top, 'INSTALL.txt'), 'utf8'), /sudo cp -R com\.clipdock\.app/);
});

test('package refuses a build that is older than the sources and writes no zip', (t) => {
  const root = fixture(t);
  const out = path.join(root, 'out');
  fs.appendFileSync(path.join(root, 'src', 'main.ts'), '\n// unbuilt change\n');
  const result = runPackage(root, out);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Stale or incomplete build/);
  assert.equal(fs.existsSync(out), false);
});
