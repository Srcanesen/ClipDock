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
  const bundle = '/tmp/DaVinci Resolve.app';
  const binary = `${bundle}/Contents/MacOS/Resolve`;
  assert.equal(resolveBinary(bundle, 'darwin'), binary);
  assert.equal(resolveBinary(`${bundle}/Contents/MacOS`, 'darwin'), binary);
  assert.equal(resolveBinary(binary, 'darwin'), binary);
});

test('scriptLibForBinary and scriptEnv follow the official macOS scripting layout', () => {
  const binary = '/tmp/DaVinci Resolve.app/Contents/MacOS/Resolve';
  const lib = '/tmp/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
  assert.equal(scriptLibForBinary(binary, 'darwin'), lib);
  assert.deepEqual(scriptEnv(binary, '/tmp/Scripting', { PYTHONPATH: '/existing', HOME: '/tmp' }, 'darwin'), {
    PYTHONPATH: '/existing:/tmp/Scripting/Modules',
    HOME: '/tmp',
    RESOLVE_SCRIPT_API: '/tmp/Scripting',
    RESOLVE_SCRIPT_LIB: lib,
  });
});

test('resolveBinary, scriptLibForBinary and scriptEnv follow the official Windows layout', () => {
  const install = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve';
  const binary = `${install}\\Resolve.exe`;
  const scriptApi = 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting';
  const lib = `${install}\\fusionscript.dll`;
  assert.equal(resolveBinary(install, 'win32'), binary);
  assert.equal(resolveBinary(binary, 'win32'), binary);
  assert.equal(scriptLibForBinary(binary, 'win32'), lib);
  assert.deepEqual(scriptEnv(binary, scriptApi, { PYTHONPATH: 'D:\\Existing' }, 'win32'), {
    PYTHONPATH: `D:\\Existing;${scriptApi}\\Modules`,
    RESOLVE_SCRIPT_API: scriptApi,
    RESOLVE_SCRIPT_LIB: lib,
  });
  assert.equal(scriptEnv(binary, scriptApi, {}, 'win32').PYTHONPATH, `${scriptApi}\\Modules`);
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
