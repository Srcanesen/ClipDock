import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-native-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['src', 'static', 'scripts/lib', 'scripts/build.mjs', 'scripts/verify-installed-plugin.mjs', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.cpSync(entry, path.join(root, entry), { recursive: true });
  }
  const installed = path.join(root, 'plugins', 'com.clipdock.app');
  fs.cpSync(path.join(root, 'dist'), installed, { recursive: true });
  const native = path.join(root, 'WorkflowIntegration.node');
  return { root, installed, native };
}

for (const kind of ['empty', 'symlink']) {
  test(`installed CLI rejects a ${kind} native reference even when installed bytes match`, (t) => {
    const { root, installed, native } = fixture(t);
    const installedNative = path.join(installed, 'WorkflowIntegration.node');
    if (kind === 'empty') { fs.writeFileSync(native, ''); fs.writeFileSync(installedNative, ''); }
    else {
      const outside = path.join(root, 'other-native.node');
      fs.writeFileSync(outside, 'HOST NATIVE');
      fs.symlinkSync(outside, native);
      fs.copyFileSync(outside, installedNative);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-installed-plugin.mjs'), `--destination=${installed}`, `--native-module=${native}`], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Required WorkflowIntegration.node is missing or invalid/);
    // Replacing the invalid reference with a real, nonempty file restores success.
    fs.rmSync(native);
    fs.writeFileSync(native, 'HOST NATIVE');
    fs.copyFileSync(native, installedNative);
    const valid = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-installed-plugin.mjs'), `--destination=${installed}`, `--native-module=${native}`], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /native module matches Resolve/);
  });
}
