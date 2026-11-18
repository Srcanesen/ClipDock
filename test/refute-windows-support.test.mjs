import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PexelsCredentialStore } from '../dist/pexels-credential.js';
import { openExclusive, prepareDirectory, publishNoReplace, SafeFsError, writeExclusive } from '../dist/safe-fs.js';
import { assertTestProject, loadClipDock, parseE2eArgs, runE2e } from '../scripts/resolve-smoke/e2e.mjs';
import { ArgError, parseArgs } from '../scripts/resolve-smoke/lib/args.mjs';
import { assertNoResolveRunning, collectProcesses, collectResidue, killWindowsTree, shutdown } from '../scripts/resolve-smoke/lib/spawn.mjs';
import { inventory } from '../scripts/lib/release-artifact.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const host = process.platform;
const winArgs = { platform: 'win32', env: {} };
const dirLink = host === 'win32' ? 'junction' : 'dir';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-refute-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function mockSpawnSync(t, fake) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = fake;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
}

const safeFsError = code => error => error instanceof SafeFsError && error.code === code;

for (const platform of ['native', 'modeled Windows']) {
  test(`Three overlapping saves per provider (${platform})`, { timeout: 5000 }, async t => {
    const root = fixture(t);
    const windows = host === 'win32' || platform === 'modeled Windows';
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    };
    const providers = ['pexels.json', 'pixabay.json'].map(name => ({
      file: path.join(root, name), completed: [], keys: ['A', 'B', 'C'].map(letter => letter.repeat(20) + name.split('.')[0]),
    }));
    for (const { file } of providers) assert.equal(await new PexelsCredentialStore(file, storage).save('Z'.repeat(20)), true);
    if (platform === 'modeled Windows') {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      t.after(() => Object.defineProperty(process, 'platform', descriptor));
    }
    const { writeFile, rename } = fsp;
    let release;
    const written = new Promise(resolve => { release = resolve; });
    const temps = [];
    t.mock.method(fsp, 'writeFile', async (file, ...args) => {
      await writeFile(file, ...args);
      temps.push(file);
      if (temps.length === 6) release();
      await written;
    });
    if (windows) {
      const replacing = new Set();
      t.mock.method(fsp, 'rename', async (from, to) => {
        if (replacing.has(to)) throw Object.assign(new Error('Overlapping Windows replacement'), { code: 'EPERM' });
        replacing.add(to);
        try {
          await new Promise(resolve => setImmediate(resolve));
          await rename(from, to);
        } finally { replacing.delete(to); }
      });
    }
    const outcomes = await Promise.allSettled(providers.flatMap(({ file, keys, completed }) => keys.map(async key => {
      const result = await new PexelsCredentialStore(file, storage).save(key);
      completed.push(key);
      return result;
    })));
    assert.deepEqual(outcomes, Array.from({ length: 6 }, () => ({ status: 'fulfilled', value: true })));
    assert.equal(new Set(temps).size, 6);
    for (const { file, keys, completed } of providers) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { key } = await new PexelsCredentialStore(file, storage).load();
      assert.equal(keys.includes(key), true);
      assert.deepEqual(record, { version: 1, ciphertext: Buffer.from(key).toString('base64') });
      if (windows) assert.equal(key, completed.at(-1));
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['pexels.json', 'pixabay.json']);
  });
}

for (const operation of ['exclusive open', 'publication fallback']) {
  test(`${operation} rejects leaf symlinks`, t => {
    const root = fixture(t);
    const dir = prepareDirectory(path.join(root, 'managed'));
    const source = writeExclusive(dir, 'source', 'new media');
    const directory = fs.mkdirSync(path.join(root, 'outside-dir'), { recursive: true });
    const existing = path.join(root, 'outside-file');
    const missing = path.join(root, 'missing-file');
    fs.writeFileSync(existing, 'original');
    const fallbackCodes = ['EPERM', 'EXDEV'];
    for (const [name, target, type] of [['directory', directory, dirLink], ['existing', existing, 'file'], ['dangling', missing, 'file']]) {
      const leaf = dir.child(name);
      fs.symlinkSync(target, leaf, type);
      if (operation === 'exclusive open') {
        assert.throws(() => fs.closeSync(openExclusive(dir, name).fd), safeFsError('exists'));
      } else {
        for (const code of fallbackCodes) {
          const link = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('Fixture hard-link failure'), { code }); });
          try {
            assert.throws(() => publishNoReplace(source, dir, name), safeFsError('exists'));
            assert.equal(link.mock.callCount(), 1);
          } finally { link.mock.restore(); }
        }
      }
      assert.equal(fs.lstatSync(leaf).isSymbolicLink(), true);
    }
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.readFileSync(source.path, 'utf8'), 'new media');
  });
}

test('Creation rejects path traversal', t => {
  const root = fixture(t);
  const dir = prepareDirectory(path.join(root, 'managed'));
  const source = writeExclusive(dir, 'source', 'new media');
  const outside = path.join(root, 'outside');
  const names = ['../outside', outside, 'nested/../../outside'];
  if (host === 'win32') names.push('..\\outside', 'source:alternate-stream');
  for (const name of names) {
    assert.throws(() => fs.closeSync(openExclusive(dir, name).fd), safeFsError('outside'));
    assert.throws(() => publishNoReplace(source, dir, name), safeFsError('outside'));
  }
  assert.deepEqual(fs.readdirSync(root), ['managed']);
  assert.deepEqual(fs.readdirSync(dir.verify()), ['source']);
});

test('Exclusive open survives a parent symlink swap', t => {
  const root = fixture(t);
  const managed = path.join(root, 'managed');
  const outside = path.join(root, 'outside');
  const dir = prepareDirectory(managed);
  fs.mkdirSync(outside);
  const leaf = dir.child('clip');
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (pathname, options) => {
    const stat = lstat(pathname, options);
    if (pathname === leaf && !stat) {
      fs.renameSync(managed, path.join(root, 'held'));
      fs.symlinkSync(outside, managed, dirLink);
    }
    return stat;
  });
  try { fs.closeSync(openExclusive(dir, 'clip').fd); }
  catch (error) { assert.ok(error instanceof SafeFsError); }
  assert.equal(fs.existsSync(path.join(outside, 'clip')), false, 'Created a file through the swapped parent symlink');
});

const resolveRow = pid => `"rEsOlVe.ExE","${pid}","Console","1","12,468 K"`;
const decoyRow = '"Tools, ""Resolve.exe"".exe","81","Console","1","42 K"';

test('Windows CSV preflight refuses existing processes', async t => {
  const commands = [];
  const blocked = [];
  mockSpawnSync(t, (binary, args) => {
    commands.push([binary, args]);
    return { status: 0, stdout: `${decoyRow}\r\n${resolveRow(42)}\r\n"FuScript.exe","54","Console","1","200 K"\r\n` };
  });
  const stop = operation => () => { blocked.push(operation); throw new Error(`Unexpected ${operation}`); };
  const result = await runE2e(parseArgs([], winArgs), {
    platform: 'win32', assertNoResolveRunning: () => assertNoResolveRunning(name => collectProcesses(name, 'win32')),
    validatePaths: stop('validation'), checkPython: stop('python'), loadClipDock: stop('load'),
    spawnResolve: stop('spawn'), shutdown: stop('shutdown'), runProbe: stop('probe'),
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.report.refusal, { resolveRunningBefore: 1, fuscriptRunningBefore: 1, resolvePids: [42], fuscriptPids: [54] });
  assert.deepEqual(commands, Array.from({ length: 2 }, () => ['tasklist', ['/FO', 'CSV', '/NH']]));
  assert.deepEqual(blocked, []);
});

test('Windows forced shutdown targets its live child', async t => {
  const active = new Set([42, 93]);
  const child = { pid: 93, exitCode: null, signalCode: null };
  const calls = [];
  mockSpawnSync(t, (binary, args) => {
    calls.push([binary, args]);
    if (binary === 'taskkill') active.delete(Number(args[1]));
    return { status: 0 };
  });
  const result = await shutdown(child, {
    platform: 'win32', graceMs: 1, killMs: 1,
    waitFor: async handle => active.has(handle.pid) ? { kind: 'timeout' } : { kind: 'exited', exitCode: 1 },
    signal: () => assert.fail('Unexpected POSIX signal'),
  });
  killWindowsTree({ ...child, pid: 42, exitCode: 0 });
  assert.equal(result.kind, 'killed');
  assert.deepEqual(calls, [['taskkill', ['/PID', '93', '/T', '/F']]]);
  assert.deepEqual([...active], [42]);
});

test('Windows rejects malformed process listings', t => {
  let stdout = `${resolveRow(42)}\r\n${resolveRow(42)}`;
  mockSpawnSync(t, () => ({ status: 0, stdout }));
  const collect = name => collectProcesses(name, 'win32');
  assert.throws(() => assertNoResolveRunning(collect), /invalid process IDs/);
  stdout = `${resolveRow(42)}\r\n"Tools, "unescaped quotes".exe","81","Console","1","42 K"`;
  const result = collectResidue({ collect });
  assert.equal(result.ok, false);
  assert.deepEqual(result.residue, { resolve: -1, fuscript: -1 });
  assert.match(result.error.message, /invalid process data/);
});

test('Linux runners refuse before touching Resolve', async () => {
  const calls = [];
  const stop = operation => () => { calls.push(operation); throw new Error(`Unexpected ${operation}`); };
  const e2e = await runE2e(parseE2eArgs([]), {
    platform: 'linux', assertNoResolveRunning: stop('preflight'), validatePaths: stop('validation'), spawnResolve: stop('spawn'),
  });
  assert.equal(e2e.exitCode, 3);
  assert.match(e2e.report.errors[0].message, /found linux/);
  assert.deepEqual(calls, []);

  const entry = new URL('../scripts/resolve-smoke/run.mjs', import.meta.url);
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = childProcess.spawnSync = () => { throw new Error('Unexpected subprocess'); };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.argv[1] = ${JSON.stringify(fileURLToPath(entry))};
    await import(${JSON.stringify(entry.href)});
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).errors[0].code, 'unsupported-platform');
});

test('Windows args preserve spaces and equals', () => {
  const bundle = 'D:\\Program Files\\Resolve=Studio';
  const python = 'D:\\Python Tools\\python.exe';
  const config = parseArgs([`--bundle=${bundle}`, '--python', python, '--windows-interactive', '--kill-wait-ms=250'], winArgs);
  assert.deepEqual([config.bundle, config.python, config.windowsInteractive, config.killWaitMs], [bundle, python, true, 250]);
  assert.throws(() => parseArgs(['--windows-interactive=false'], winArgs), ArgError);
});

test('Windows args reject a flag as a path operand', () => {
  assert.throws(() => parseArgs(['--python', '--windows-interactive'], winArgs), ArgError);
});

test('E2E project guard requires the prefix and exact name', async () => {
  const pm = { GetCurrentProject: async () => ({ GetName: async () => 'ClipDock-E2E-other-run' }) };
  await assert.rejects(assertTestProject(pm, 'personal-project'), /Unsafe test project name/);
  await assert.rejects(assertTestProject(pm, 'ClipDock-E2E-this-run'), /current project "ClipDock-E2E-other-run"/);
  assert.equal(await assertTestProject(pm, 'ClipDock-E2E-other-run'), undefined);
});

test('E2E rejects dist built from different sources', t => {
  const root = fixture(t);
  for (const entry of ['src', 'static', 'scripts', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
  }
  assert.equal(typeof loadClipDock(root).createTransfer, 'function');
  fs.appendFileSync(path.join(root, 'src', 'main.ts'), '\n// Simulate sources edited after build.\n');
  assert.throws(() => loadClipDock(root), /Refusing stale or incomplete dist\/: Stale or incomplete build/);
});

test('Release ZIP layout matches on native and Windows branches', t => {
  const root = fixture(t);
  const entry = new URL('../scripts/package.mjs', import.meta.url);
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const top = `ClipDock-${version}`;
  const expected = [`${top}/INSTALL.txt`, ...inventory(path.join(repo, 'dist')).files.map(file => `${top}/com.clipdock.app/${file}`)].sort();
  const windowsTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tar = host === 'win32' ? windowsTar : '/usr/bin/tar';
  for (const platform of new Set([host, 'win32'])) {
    const out = path.join(root, `${platform} archive path`);
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      const exec = childProcess.execFileSync;
      childProcess.execFileSync = (binary, args, options) => {
        assert.equal(binary, ${JSON.stringify(platform === 'win32' ? windowsTar : 'zip')});
        return exec(binary === ${JSON.stringify(windowsTar)} ? ${JSON.stringify(tar)} : binary, args, options);
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      process.argv.push(${JSON.stringify(`--out=${out}`)});
      await import(${JSON.stringify(entry.href)});
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(result.status, 0, result.stderr);
    const listing = childProcess.spawnSync(tar, ['-tf', path.join(out, `${top}.zip`)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/).filter(name => !name.endsWith('/')).sort(), expected);
  }
});
