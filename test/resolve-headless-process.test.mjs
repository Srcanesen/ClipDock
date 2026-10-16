import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  BoundedBuffer,
  assertNoResolveRunning,
  collectProcesses,
  collectResidue,
  shutdown,
  spawnResolve,
  waitForExit,
} from '../scripts/resolve-smoke/lib/spawn.mjs';

const NODE = process.execPath;

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

test('shutdown escalates graceful -> TERM -> KILL and reports the winning stage', async (t) => {
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

test('assertNoResolveRunning refuses when a Resolve-named process exists', () => {
  assert.deepEqual(assertNoResolveRunning(() => []), { ok: true, pids: [], fuscriptPids: [] });
  assert.deepEqual(assertNoResolveRunning(comm => comm === 'Resolve' ? [42] : []), { ok: false, pids: [42], fuscriptPids: [] });
});

test('collectProcesses finds a live child by exact comm name', async () => {
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const pids = collectProcesses('sleep');
    assert.equal(Array.isArray(pids), true);
    assert.equal(pids.includes(sleeper.pid), true);
  } finally {
    await killAndReap(sleeper);
  }
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
