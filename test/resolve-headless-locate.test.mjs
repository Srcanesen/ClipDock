import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveBinary, scriptEnv, scriptLibForBinary, validatePaths } from '../scripts/resolve-smoke/lib/locate.mjs';

function fakeBundle(root) {
  const bundle = path.join(root, 'DaVinci Resolve.app');
  const macos = path.join(bundle, 'Contents', 'MacOS');
  const fusion = path.join(bundle, 'Contents', 'Libraries', 'Fusion');
  mkdirSync(macos, { recursive: true });
  mkdirSync(fusion, { recursive: true });
  writeFileSync(path.join(macos, 'Resolve'), 'binary');
  writeFileSync(path.join(fusion, 'fusionscript.so'), 'lib');
  return { bundle, binary: path.join(macos, 'Resolve') };
}

test('resolveBinary accepts the .app bundle, Contents/MacOS, or the binary itself', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-locate-'));
  try {
    const { bundle, binary } = fakeBundle(root);
    assert.equal(resolveBinary(bundle), binary);
    assert.equal(resolveBinary(path.join(bundle, 'Contents', 'MacOS')), binary); // Contents/MacOS
    assert.equal(resolveBinary(binary), binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scriptLibForBinary and scriptEnv follow the official macOS scripting layout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-locate-'));
  try {
    const { bundle, binary } = fakeBundle(root);
    const scriptApi = path.join(root, 'Scripting');
    mkdirSync(scriptApi, { recursive: true });
    assert.equal(scriptLibForBinary(binary), path.join(bundle, 'Contents', 'Libraries', 'Fusion', 'fusionscript.so'));
    const env = scriptEnv(binary, scriptApi, { PYTHONPATH: '/existing', HOME: '/tmp' });
    assert.equal(env.RESOLVE_SCRIPT_API, scriptApi);
    assert.equal(env.RESOLVE_SCRIPT_LIB, path.join(bundle, 'Contents', 'Libraries', 'Fusion', 'fusionscript.so'));
    const parts = env.PYTHONPATH.split(path.delimiter);
    assert.equal(parts[0], '/existing'); // existing PYTHONPATH preserved first
    assert.equal(parts.includes(path.join(scriptApi, 'Modules')), true); // official Modules dir appended
    assert.equal(env.HOME, '/tmp'); // base env preserved
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scriptEnv works with no pre-existing PYTHONPATH', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-locate-'));
  try {
    const { binary } = fakeBundle(root);
    const scriptApi = path.join(root, 'Scripting');
    const env = scriptEnv(binary, scriptApi, {});
    assert.equal(env.PYTHONPATH, path.join(scriptApi, 'Modules'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validatePaths accepts a complete environment and reports each missing piece', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-locate-'));
  try {
    const { bundle, binary } = fakeBundle(root);
    const scriptApi = path.join(root, 'Scripting');
    mkdirSync(scriptApi, { recursive: true });
    const scriptLib = path.join(bundle, 'Contents', 'Libraries', 'Fusion', 'fusionscript.so');
    assert.deepEqual(validatePaths({ binary, scriptApi, scriptLib }), { ok: true });
    assert.equal(validatePaths({ binary: path.join(root, 'missing', 'Resolve'), scriptApi, scriptLib }).error.code, 'bundle-not-found');
    assert.equal(validatePaths({ binary, scriptApi: path.join(root, 'no-scripting'), scriptLib }).error.code, 'script-api-not-found');
    assert.equal(validatePaths({ binary, scriptApi, scriptLib: path.join(bundle, 'missing.so') }).error.code, 'script-lib-not-found');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
