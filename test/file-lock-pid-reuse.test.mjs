import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const require = createRequire(import.meta.url);
const now = Date.now(), self = 4000, pid = 54321;
function load({platform = 'darwin', execFileSync = () => '00:00', kill = () => true} = {}) {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(new URL('../dist/file-lock.js', import.meta.url), 'utf8'), {
    module, exports: module.exports,
    process: {pid: self, platform, kill},
    Date: class extends Date {static now() {return now;}},
    require: id => id === 'node:child_process' ? {execFileSync} : id === 'node:os' ? {uptime: () => 3600} : require(id),
  });
  assert.equal(typeof module.exports.probeProcessStart, 'function', 'export the injectable process-start probe');
  return module.exports;
}
function fixture(t, options) {
  const api = load(options);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-pid-reuse-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'writer.lock');
  const owner = JSON.stringify({pid, token: 'crashed-owner', createdAt: now - 10000});
  return {api, file, owner, acquire: probe => api.tryAcquireFileLock(file, 0, probe)};
}

test('a reused live PID that started after lock creation is recovered', t => {
  const {file, owner, acquire} = fixture(t);
  fs.writeFileSync(file, owner);
  const probe = t.mock.fn(ownerPid => {assert.equal(ownerPid, pid); return now - 2000;});
  const acquired = acquire(probe);
  assert.equal(typeof acquired?.release, 'function');
  assert.equal(probe.mock.callCount(), 3, 'recheck under the recovery guard and before unlink');
  const published = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(published).sort(), ['createdAt', 'pid', 'token']);
  assert.equal(published.pid, self);
  acquired.release();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + '.recovery'), false);
});

test('acquisition defaults to the real process-start probe', t => {
  const execFileSync = t.mock.fn(() => '00:02');
  const {file, owner, acquire} = fixture(t, {execFileSync});
  fs.writeFileSync(file, owner);
  const acquired = acquire();
  assert.equal(typeof acquired?.release, 'function');
  assert.equal(execFileSync.mock.callCount(), 3);
  assert.equal(execFileSync.mock.calls[0].arguments[0], 'ps');
  acquired.release();
  assert.equal(fs.existsSync(file), false);
});

for (const [kind, startedAt] of [['before', now - 20000], ['at', now - 10000], ['unknown at', undefined]]) {
  test(`a live PID whose start is ${kind} lock creation keeps blocking`, t => {
    const {file, owner, acquire} = fixture(t);
    fs.writeFileSync(file, owner);
    const probe = t.mock.fn(() => startedAt);
    assert.equal(acquire(probe), null);
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(probe.mock.calls[0].arguments[0], pid);
    assert.equal(fs.readFileSync(file, 'utf8'), owner);
  });
}

for (const state of ['dead', 'free']) {
  test(`the start probe is not called when the PID is ${state}`, t => {
    const {file, owner, acquire} = fixture(t, {kill: () => {throw Object.assign(Error('dead'), {code: 'ESRCH'});}});
    if (state === 'dead') fs.writeFileSync(file, owner);
    const probe = t.mock.fn(() => {throw Error('unexpected start probe');});
    const acquired = acquire(probe);
    assert.equal(typeof acquired?.release, 'function');
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, self);
    acquired.release();
    assert.equal(fs.existsSync(file), false);
  });
}

for (const createdAt of [now - 10000, now - 7200000]) {
  test(`this process keeps its own lock without probing (created ${now - createdAt} ms ago)`, t => {
    const {file, acquire} = fixture(t, {kill: () => {throw Error('unexpected liveness probe');}});
    const owner = JSON.stringify({pid: self, token: 'own-lock', createdAt});
    fs.writeFileSync(file, owner);
    const probe = t.mock.fn(() => now);
    assert.equal(acquire(probe), null);
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), owner);
  });
}

test('a live legacy PID without a creation timestamp keeps blocking without probing', t => {
  const {file, acquire} = fixture(t);
  fs.writeFileSync(file, JSON.stringify(pid));
  const probe = t.mock.fn(() => now);
  assert.equal(acquire(probe), null);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(pid));
});

test('a liveness permission error keeps blocking without probing', t => {
  const {file, owner, acquire} = fixture(t, {kill: () => {throw Object.assign(Error('denied'), {code: 'EPERM'});}});
  fs.writeFileSync(file, owner);
  const probe = t.mock.fn(() => now);
  assert.equal(acquire(probe), null);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), owner);
});

test('recovery preserves the lock when a later start probe cannot confirm PID reuse', t => {
  const {file, owner, acquire} = fixture(t);
  fs.writeFileSync(file, owner);
  let calls = 0;
  const acquired = acquire(() => ++calls === 1 ? now - 2000 : undefined);
  assert.equal(acquired, null);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), owner);
  assert.equal(fs.existsSync(file + '.recovery'), false);
});

test('PID reuse in a crashed recovery guard uses the injected probe too', t => {
  const {file, owner, acquire} = fixture(t);
  fs.writeFileSync(file, owner);
  fs.writeFileSync(file + '.recovery', owner);
  const acquired = acquire(() => now - 2000);
  assert.equal(typeof acquired?.release, 'function');
  assert.equal(fs.existsSync(file + '.recovery'), false);
  assert.equal(fs.existsSync(file + '.recovery.recovery'), false);
  acquired.release();
  assert.equal(fs.existsSync(file), false);
});

for (const platform of ['darwin', 'linux']) {
  for (const [output, elapsedMs] of [['05:07', 307000], ['01:02:03', 3723000], ['2-03:04:05', 183845000]]) {
    test(`${platform} ps parses ${output} with a one-second lower-bound margin`, () => {
      const calls = [];
      const {probeProcessStart} = load({platform, execFileSync: (...args) => {calls.push(args); return `  ${output}\n`;}});
      assert.equal(probeProcessStart(pid), now - elapsedMs - 1000);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'ps');
      assert.deepEqual(Array.from(calls[0][1]), ['-o', 'etime=', '-p', String(pid)]);
      assert.equal(calls[0][2].timeout, 2000);
      assert.equal(calls[0][2].shell, false);
    });
  }
}

test('Windows probes the process start in epoch milliseconds without opening a window', () => {
  const calls = [];
  const {probeProcessStart} = load({platform: 'win32', execFileSync: (...args) => {calls.push(args); return ` ${now - 2000}\r\n`;}});
  assert.equal(probeProcessStart(pid), now - 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell');
  assert.deepEqual(Array.from(calls[0][1]), ['-NoProfile', '-NonInteractive', '-Command', `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`]);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} probe errors, timeouts and invalid output fail closed`, () => {
    for (const output of ['', 'nonsense', 'NaN', 'Infinity', '01:99', '2-03:04']) {
      assert.equal(load({platform, execFileSync: () => output}).probeProcessStart(pid), undefined);
    }
    for (const code of ['ENOENT', 'ETIMEDOUT']) {
      assert.equal(load({platform, execFileSync: () => {throw Object.assign(Error('probe failed'), {code});}}).probeProcessStart(pid), undefined);
    }
  });
}

test('invalid PIDs and unsupported platforms never reach a command line', t => {
  const execFileSync = t.mock.fn(() => '00:00');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const {probeProcessStart} = load({platform, execFileSync});
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', '1; echo unsafe']) {
      assert.equal(probeProcessStart(invalid), undefined);
    }
  }
  assert.equal(load({platform: 'freebsd', execFileSync}).probeProcessStart(pid), undefined);
  assert.equal(execFileSync.mock.callCount(), 0);
});
