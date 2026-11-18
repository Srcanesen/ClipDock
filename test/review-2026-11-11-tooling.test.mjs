import {pythonExecutablePath} from './helpers/python.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reconcileDirectoryContents } from '../scripts/lib/install-files.mjs';
import { validatePluginArtifact } from '../scripts/lib/completed-build.mjs';
import { createPythonBridge } from '../scripts/resolve-smoke/lib/bridge.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-review-tooling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function artifactFixture(t) {
  const root = temporary(t);
  for (const entry of ['scripts', 'src', 'static', 'dist', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    fs.cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}
function cli(root, script, args = []) {
  return spawnSync(process.execPath, [...args, path.join(root, 'scripts', script)], { cwd: root, encoding: 'utf8', timeout: 10000 });
}

test('torn journal and recovery publications are recoverable, while a live claim wins exclusively', (t) => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'plugin');
  const lock = path.join(root, '.__clipdock_lock_plugin');
  fs.mkdirSync(source); fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'main.js'), 'NEW');
  fs.writeFileSync(path.join(destination, 'main.js'), 'OLD');
  fs.writeFileSync(lock, '{');
  fs.writeFileSync(`${lock}.recovery`, '');
  reconcileDirectoryContents(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'main.js'), 'utf8'), 'NEW');
  assert.deepEqual(fs.readdirSync(root).sort(), ['plugin', 'source']);

  for (const recovering of [false, true]) {
    if (recovering) fs.writeFileSync(lock, '{');
    let injected = false;
    const opened = new Map();
    assert.throws(() => reconcileDirectoryContents(source, destination, { ...fs,
      openSync(file, flags) { const fd = fs.openSync(file, flags); opened.set(fd, file); return fd; },
      writeFileSync(file, data, options) {
        const name = opened.get(file) ?? file;
        if (!injected && String(name).includes('.recovery.') === recovering) {
          injected = true;
          fs.writeFileSync(file, '{', options);
          throw Object.assign(new Error('disk full during owner write'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(file, data, options);
      },
    }), { code: 'ENOSPC' });
    assert.equal(fs.existsSync(`${lock}.recovery`), false);
    assert.equal(fs.existsSync(lock), recovering);
    reconcileDirectoryContents(source, destination);
    assert.equal(fs.readFileSync(path.join(destination, 'main.js'), 'utf8'), 'NEW');
  }

  // A process dying after fsync but before link leaves only an ignored temp.
  for (const recovering of [false, true]) {
    if (recovering) fs.writeFileSync(lock, '{');
    const target = recovering ? `${lock}.recovery` : lock;
    const script = `import fs from 'node:fs';
import { reconcileDirectoryContents } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/lib/install-files.mjs')).href)};
reconcileDirectoryContents(${JSON.stringify(source)}, ${JSON.stringify(destination)}, {...fs,
  linkSync(from, to) { if (to === ${JSON.stringify(target)}) process.exit(73); fs.linkSync(from, to); }
});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 73, result.stderr);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), true);
    reconcileDirectoryContents(source, destination);
    assert.equal(fs.readFileSync(path.join(destination, 'main.js'), 'utf8'), 'NEW');
  }

  let synced = false;
  let wins = 0;
  let refusals = 0;
  reconcileDirectoryContents(source, destination, { ...fs,
    fsyncSync(fd) { fs.fsyncSync(fd); synced = true; },
    linkSync(from, to) {
      assert.equal(synced, true);
      assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).pid, process.pid);
      fs.linkSync(from, to);
      assert.equal(fs.statSync(from).ino, fs.statSync(to).ino);
      if (to === lock) {
        wins++;
        const code = `import { reconcileDirectoryContents } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/lib/install-files.mjs')).href)};
try { reconcileDirectoryContents(${JSON.stringify(source)}, ${JSON.stringify(destination)}); process.stdout.write('WON'); }
catch (error) { process.stdout.write(error.code); }`;
        const competitor = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
        assert.equal(competitor.status, 0, competitor.stderr);
        assert.equal(competitor.stdout, 'INSTALL_BUSY');
        refusals++;
      }
    },
  });
  assert.deepEqual({ wins, refusals }, { wins: 1, refusals: 1 });
});

test('installation normalizes and verifies restrictive staged modes including the native sidecar', { skip: process.platform === 'win32' }, (t) => {
  const root = artifactFixture(t);
  const dist = path.join(root, 'dist');
  const native = path.join(root, 'WorkflowIntegration.node');
  fs.writeFileSync(native, 'NATIVE SIDECAR'); fs.chmodSync(native, 0o700);
  const restrict = directory => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) restrict(file);
      else fs.chmodSync(file, 0o600);
    }
  };
  restrict(dist);
  const destination = path.join(root, 'plugins', 'com.clipdock.app');
  const installer = path.join(root, 'scripts/install-plugin.mjs');
  // Even a broken CLI's default paths are confined to this temporary fixture.
  fs.writeFileSync(installer, fs.readFileSync(installer, 'utf8')
    .replaceAll('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins', path.dirname(destination)));
  const run = extra => spawnSync(process.execPath, [...extra, installer, `--destination=${destination}`, `--native-module=${native}`], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const installed = run([]);
  assert.equal(installed.status, 0, installed.stderr);
  const mode = file => fs.statSync(file).mode & 0o777;
  const verify = directory => {
    assert.equal(mode(directory), 0o755, directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) verify(file);
      else assert.equal(mode(file), entry.name === 'WorkflowIntegration.node' ? 0o755 : 0o644, file);
    }
  };
  verify(destination);
  assert.equal(mode(path.join(dist, 'main.js')), 0o600);
  const generic = path.join(root, 'generic-copy');
  reconcileDirectoryContents(dist, generic);
  assert.equal(mode(path.join(generic, 'main.js')), 0o600);
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'OLD INSTALL');
  const preload = path.join(root, 'chmod-noop.cjs');
  fs.writeFileSync(preload, "require('node:fs').chmodSync = () => {}; require('node:module').syncBuiltinESMExports();");
  const refused = run(['--require', preload]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /mode|permission/i);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'OLD INSTALL');
});

test('bridge fallback exposes persistent IDs across fresh project, timeline and folder wrappers', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'DaVinciResolveScript.py'), `class Handle:
    def __init__(self, identity): self.identity = identity
    def __dir__(self): return []
    def GetUniqueId(self): return self.identity
    def GetCurrentProject(self): return Handle('project-id')
    def GetCurrentTimeline(self): return Handle('timeline-id')
    def GetCurrentFolder(self): return Handle('folder-id')
class Optional:
    def __dir__(self): return []
    def GetName(self): return 'no-id'
class Resolve(Handle):
    def GetMediaPool(self): return Optional()
def scriptapp(name): return Resolve('resolve-id')
`);
  const bridge = createPythonBridge({ python: pythonExecutablePath(), env: { ...process.env, PYTHONPATH: root }, script: path.join(repo, 'scripts/resolve-smoke/bridge.py'), timeoutMs: 3000 });
  t.after(() => bridge.close());
  const resolve = await bridge.workflowIntegration.GetResolve();
  for (const [method, expected] of [['GetCurrentProject', 'project-id'], ['GetCurrentTimeline', 'timeline-id'], ['GetCurrentFolder', 'folder-id']]) {
    const first = await resolve[method]();
    const second = await resolve[method]();
    assert.notEqual(first, second);
    assert.equal(typeof first.GetUniqueId, 'function');
    assert.equal(await first.GetUniqueId(), expected);
    assert.equal(await second.GetUniqueId(), expected);
    assert.equal(first.AddMarker, undefined);
  }
  assert.equal((await resolve.GetMediaPool()).GetUniqueId, undefined);
});

test('preview CLI refuses missing completion records and stale sources before listening', (t) => {
  const root = artifactFixture(t);
  const preload = path.join(root, 'capture.cjs');
  fs.writeFileSync(preload, `const http = require('node:http');
http.createServer = callback => ({listen() {
  callback({url:'/'}, {writeHead(status) {process.stdout.write(String(status));}, end() {}});
}}); require('node:module').syncBuiltinESMExports();`);
  const run = () => cli(root, 'preview.mjs', ['--require', preload]);
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, '200');
  const record = path.join(root, 'dist/.clipdock-build.json');
  const bytes = fs.readFileSync(record);
  fs.rmSync(record);
  const missing = run();
  fs.writeFileSync(record, bytes);
  fs.appendFileSync(path.join(root, 'src/preview.ts'), '\n// changed without rebuilding\n');
  const stale = run();
  for (const result of [missing, stale]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /stale or incomplete dist/);
    assert.match(result.stderr, /npm run build/);
  }
});

test('artifact validation rejects manifest/package version disagreement and the shipped version is aligned', (t) => {
  const root = artifactFixture(t);
  const manifest = path.join(root, 'dist/manifest.xml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/<Version>[^<]+<\/Version>/, '<Version>0.0.0</Version>'));
  assert.throws(() => validatePluginArtifact(path.join(root, 'dist')), /Manifest.*[Vv]ersion.*package/);
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(fs.readFileSync(path.join(root, 'static/manifest.xml'), 'utf8').match(/<Version>([^<]+)<\/Version>/)?.[1], expected);
});
