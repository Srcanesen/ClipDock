import assert from 'node:assert/strict';
import childProcessTools, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { hasWindowsScriptingConnection, waitForWindowsScriptingServer } from '../scripts/resolve-smoke/lib/windows-scripting.mjs';
import {
  BoundedBuffer,
  assertNoResolveRunning,
  collectProcesses,
  collectResidue,
  parseTasklist,
  shutdown,
  spawnResolve,
  waitForExit,
} from '../scripts/resolve-smoke/lib/spawn.mjs';

const NODE = process.execPath;

function mockScriptingPoll(t, run) {
  const launch = t.mock.method(childProcessTools, 'spawnSync', run);
  syncBuiltinESMExports();
  t.after(() => {
    launch.mock.restore();
    syncBuiltinESMExports();
  });
  return launch;
}

test('Windows scripting readiness queries Established connections owned by the Resolve child', async t => {
  const observations = ['', '42\r\n'];
  mockScriptingPoll(t, (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[3], /Get-NetTCPConnection -OwningProcess 42 -RemoteAddress 127\.0\.0\.1 -RemotePort 1144 -State Established -ErrorAction SilentlyContinue /);
    assert.match(args[3], /-ExpandProperty OwningProcess/);
    assert.equal(options.windowsHide, true);
    // PowerShell emits no row when the only connection has not completed its SYN handshake.
    return { status: 0, stdout: observations.shift() };
  });
  assert.equal(hasWindowsScriptingConnection('\r\n', 42), false);
  assert.equal(hasWindowsScriptingConnection('41\r\n', 42), false);
  assert.equal(hasWindowsScriptingConnection('42\r\n', 42), true);
  const child = { pid: 42, exitCode: null, signalCode: null };
  const remaining = await waitForWindowsScriptingServer(child, 5000);
  assert.deepEqual(observations, []);
  assert.ok(remaining > 0 && remaining < 5000);
  await assert.rejects(waitForWindowsScriptingServer(child, 5, { connected: () => false }),
    /did not connect to its Windows scripting server within 5 ms/);
});

test('Windows scripting readiness retries a timed-out PowerShell poll within its overall deadline', async t => {
  const timedOut = {
    status: null, stdout: '42\r\n', stderr: '',
    error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  };
  const results = [timedOut, { status: 0, stdout: '42\r\n' }];
  const launch = mockScriptingPoll(t, () => results.shift() ?? timedOut);
  const child = { pid: 42, exitCode: null, signalCode: null };
  assert.ok(await waitForWindowsScriptingServer(child, 5000) > 0);
  assert.equal(launch.mock.callCount(), 2);
  await assert.rejects(waitForWindowsScriptingServer(child, 5), {
    message: 'Resolve did not connect to its Windows scripting server within 5 ms',
  });
});

test('Windows scripting readiness fails immediately when Get-NetTCPConnection is missing', async t => {
  const message = 'Get-NetTCPConnection is unavailable in Windows PowerShell';
  const launch = mockScriptingPoll(t, (_command, args) => {
    assert.match(args[3], /^if \(-not \(Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue\)\) \{/);
    assert.ok(args[3].includes(`[Console]::Error.WriteLine('${message}'); exit 1`));
    return { status: 1, stdout: '', stderr: `${message}\r\n` };
  });
  const child = { pid: 42, exitCode: null, signalCode: null };
  await assert.rejects(waitForWindowsScriptingServer(child, 5000), {
    message: `Windows scripting connection check failed: ${message}`,
  });
  assert.equal(launch.mock.callCount(), 1);
});

function childProcess(code) {
  return spawn(NODE, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore'] });
}

async function killAndReap(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  await waitForExit(child, 5000);
}

test('BoundedBuffer keeps only the newest bytes within its limit', () => {
  const buf = new BoundedBuffer(10);
  buf.push(Buffer.from('0123456789'));
  assert.equal(buf.toString(), '0123456789');
  buf.push(Buffer.from('abc'));
  assert.equal(buf.toString(), '3456789abc');
  buf.push(Buffer.from('X'.repeat(50)));
  assert.equal(buf.toString().length, 10);
  assert.equal(buf.toString(), 'X'.repeat(10));
  buf.push(Buffer.from('')); // empty chunks are ignored
  assert.equal(buf.toString(), 'X'.repeat(10));
});

test('waitForExit resolves with the exit code or a bounded timeout', async () => {
  const short = childProcess('setTimeout(() => {}, 50)');
  assert.deepEqual(await waitForExit(short, 5000), { kind: 'exited', exitCode: 0, signal: null });

  const long = childProcess('setTimeout(() => {}, 60000)');
  try {
    const result = await waitForExit(long, 150);
    assert.equal(result.kind, 'timeout');
  } finally {
    await killAndReap(long);
  }
});

test('shutdown escalates graceful -> TERM -> KILL and reports the winning stage', { skip: process.platform === 'win32' }, async (t) => {
  // Graceful: the process exits on its own within the grace window.
  const a = childProcess('setTimeout(() => {}, 80)');
  t.after(() => killAndReap(a));
  const ra = await shutdown(a, { graceMs: 5000, termMs: 1000, killMs: 1000 });
  assert.equal(ra.kind, 'graceful');
  assert.equal(ra.exitCode, 0);
  assert.equal(typeof ra.ms, 'number');

  // Terminated: default SIGTERM handling kills the process.
  const b = childProcess('setInterval(() => {}, 1000)');
  t.after(() => killAndReap(b));
  const rb = await shutdown(b, { graceMs: 150, termMs: 3000, killMs: 1000 });
  assert.equal(rb.kind, 'terminated');

  // Killed: SIGTERM is ignored, SIGKILL wins.
  const c = spawn(NODE, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => killAndReap(c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child readiness timeout')), 5000);
    c.stdout.once('data', (chunk) => { clearTimeout(timer); assert.equal(chunk.toString(), 'READY\n'); resolve(); });
    c.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const signals = [];
  const rc = await shutdown(c, { graceMs: 150, termMs: 150, killMs: 3000, signal: (child, signal) => { signals.push(signal); child.kill(signal); } });
  assert.equal(rc.kind, 'killed');
  assert.equal(rc.signal, 'SIGKILL');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  // still-running: an injected always-timeout waitFor reports the ladder survived.
  const d = {};
  const syntheticSignals = [];
  const fakeWaitFor = () => Promise.resolve({ kind: 'timeout' });
  const rd = await shutdown(d, { graceMs: 1, termMs: 1, killMs: 1, waitFor: fakeWaitFor, signal: (_, signal) => syntheticSignals.push(signal) });
  assert.equal(rd.kind, 'still-running');
  assert.deepEqual(syntheticSignals, ['SIGTERM', 'SIGKILL']);
});

test('Windows shutdown uses taskkill for its live child', { skip: process.platform !== 'win32' }, async t => {
  const child = childProcess('setInterval(() => {}, 1000)');
  t.after(() => killAndReap(child));
  const result = await shutdown(child, { graceMs: 150, killMs: 5000 });
  assert.equal(result.kind, 'killed');
  assert.notEqual(child.exitCode, null);
});

test('assertNoResolveRunning refuses when a Resolve-named process exists', () => {
  assert.deepEqual(assertNoResolveRunning(() => []), { ok: true, pids: [], fuscriptPids: [] });
  assert.deepEqual(assertNoResolveRunning(comm => comm === 'Resolve' ? [42] : []), { ok: false, pids: [42], fuscriptPids: [] });
});

test('collectProcesses finds a live child by exact comm name', async () => {
  const windows = process.platform === 'win32';
  const sleeper = windows ? childProcess('setInterval(() => {}, 1000)') : spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const pids = collectProcesses(windows ? path.basename(NODE, '.exe') : 'sleep');
    assert.equal(Array.isArray(pids), true);
    assert.equal(pids.includes(sleeper.pid), true);
  } finally {
    await killAndReap(sleeper);
  }
});

test('tasklist parsing matches exact executable names and fails closed on malformed output', () => {
  const output = [
    '"System Idle Process","0","Services","0","8 K"',
    '"Resolve helper.exe","32","Console","1","1,728 K"',
    '"RESOLVE.EXE","42","Console","1","30,000 K"',
    '"Resolve.exe","43","Services","0","30,000 K"',
    '"fuscript.exe","52","Console","1","4,200 K"',
  ].join('\r\n') + '\r\n';
  assert.deepEqual(parseTasklist(output, 'Resolve.exe'), [42, 43]);
  assert.deepEqual(parseTasklist(output, 'fuscript.exe'), [52]);
  assert.deepEqual(parseTasklist(output, 'other.exe'), []);
  assert.throws(() => parseTasklist('', 'Resolve.exe'), /no process rows/);
  assert.throws(() => parseTasklist(output + '"Resolve.exe","oops"', 'Resolve.exe'), /invalid process data/);
  assert.throws(() => parseTasklist(output.replace('"42"', '"0"'), 'Resolve.exe'), /invalid process IDs/);
});

test('collectResidue reports live Resolve/fuscript counts or a fail-safe error', () => {
  const zero = collectResidue({ collect: () => [] });
  assert.deepEqual(zero, { ok: true, residue: { resolve: 0, fuscript: 0 } });
  const some = collectResidue({ collect: (comm) => (comm === 'Resolve' ? [11, 22] : [33]) });
  assert.deepEqual(some, { ok: true, residue: { resolve: 2, fuscript: 1 } });
});

test('collectResidue failure is fail-safe: never zero, never ok', () => {
  const failed = collectResidue({
    collect: () => {
      throw new Error('pgrep exited with status 2\n on /usr/bin/pgrep');
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.residue, { resolve: -1, fuscript: -1 });
  assert.equal(failed.error.code, 'residue-check-failed');
  assert.equal(failed.error.message.includes('pgrep exited with status 2'), true);
  assert.equal(failed.error.message.includes('\n'), false); // sanitized: single line
});

 test('spawnResolve observes asynchronous launch failure immediately and retains it for shutdown', async () => {
  const child = spawnResolve('/nonexistent/clipdock-test-binary', { env: {} });
  const launch = await child.launch;
  assert.equal(launch.ok, false);
  assert.equal(launch.error.code, 'ENOENT');
  assert.equal((await waitForExit(child, 100)).error.code, 'ENOENT');
  assert.equal((await shutdown(child, { graceMs: 1, termMs: 1, killMs: 1 })).kind, 'error');
});
