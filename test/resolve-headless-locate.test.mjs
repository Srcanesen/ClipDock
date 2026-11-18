import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pythonInvocation, resolveBinary, scriptEnv, scriptLibForBinary, validatePaths } from '../scripts/resolve-smoke/lib/locate.mjs';

test('Windows Python aliases use the launcher and explicit interpreter paths are preserved', () => {
  const args = ['probe.py'];
  assert.deepEqual(pythonInvocation('PYTHON3.EXE', args, 'win32'), ['py', ['-3', 'probe.py']]);
  for (const interpreter of ['D:\\Python Tools\\python3.exe', './python3', 'D:python3.exe']) {
    assert.deepEqual(pythonInvocation(interpreter, args, 'win32'), [interpreter, args]);
  }
});

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
    const paths = { binary, scriptApi, scriptLib, platform: 'darwin' };
    assert.deepEqual(validatePaths(paths), { ok: true });
    assert.equal(validatePaths({ ...paths, binary: path.join(root, 'missing', 'Resolve') }).error.code, 'bundle-not-found');
    assert.equal(validatePaths({ ...paths, scriptApi: path.join(root, 'no-scripting') }).error.code, 'script-api-not-found');
    assert.equal(validatePaths({ ...paths, scriptLib: path.join(bundle, 'missing.so') }).error.code, 'script-lib-not-found');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows path validation requires fuscript.exe from the same installation', () => {
  const paths = {
    binary: 'D:\\Resolve\\Resolve.exe', scriptApi: 'D:\\Scripting',
    scriptLib: 'D:\\Resolve\\fusionscript.dll', platform: 'win32',
  };
  const files = new Set([paths.binary, paths.scriptLib]);
  const fs = { existsFn: p => p === paths.scriptApi || files.has(p), isFileFn: p => files.has(p) };
  assert.deepEqual(validatePaths(paths, fs), {
    ok: false, error: { code: 'fuscript-not-found', message: 'Resolve scripting helper not found: D:\\Resolve\\fuscript.exe' },
  });
  files.add('D:\\Resolve\\fuscript.exe');
  assert.deepEqual(validatePaths(paths, fs), { ok: true });
});
