import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { assertNoResolveRunning, collectProcesses } from '../scripts/resolve-smoke/lib/spawn.mjs';
import { parseE2eArgs, runE2e } from '../scripts/resolve-smoke/e2e.mjs';

for (const [resolve, fuscript] of [[[], [4242]], [[11], [22]], [[], []]]) {
  test(`preflight accounts for both exact process names (${resolve}/${fuscript})`, () => {
    const calls = [];
    const result = assertNoResolveRunning(comm => {
      calls.push(comm);
      return comm === 'Resolve' ? resolve : comm === 'fuscript' ? fuscript : [];
    });
    assert.deepEqual(calls, ['Resolve', 'fuscript']);
    assert.deepEqual(result, { ok: resolve.length + fuscript.length === 0, pids: resolve, fuscriptPids: fuscript });
  });
}

test('unknown fuscript state propagates rather than admitting a launch', () => {
  assert.throws(() => assertNoResolveRunning(comm => {
    if (comm === 'fuscript') throw new Error('pgrep failed');
    return [];
  }), /pgrep failed/);
});

test('E2E refuses fuscript before setup and reports both process sets', async () => {
  let setup = 0, spawned = 0;
  const result = await runE2e(parseE2eArgs([]), {
    assertNoResolveRunning: () => assertNoResolveRunning(comm => comm === 'fuscript' ? [4242] : []),
    validatePaths: () => { setup++; throw new Error('unexpected setup'); },
    spawnResolve: () => { spawned++; throw new Error('unexpected spawn'); },
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.report.ok, false);
  assert.equal(setup, 0); assert.equal(spawned, 0);
  assert.deepEqual(result.report.refusal, { resolveRunningBefore: 0, fuscriptRunningBefore: 1, resolvePids: [], fuscriptPids: [4242] });
  assert.match(result.report.errors[0].message, /Resolve.*none.*fuscript.*4242/);
});


test('default preflight uses exact pgrep names and rejects malformed successful output', t => {
  const original = childProcess.spawnSync;
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  const calls = [];
  let output = '4242\n';
  childProcess.spawnSync = (binary, args) => {
    calls.push([binary, args]);
    return args[1] === 'Resolve' ? { status: 1, stdout: '' } : { status: 0, stdout: output };
  };
  syncBuiltinESMExports();
  assert.deepEqual(assertNoResolveRunning(), { ok: false, pids: [], fuscriptPids: [4242] });
  assert.deepEqual(calls, [['pgrep', ['-x', 'Resolve']], ['pgrep', ['-x', 'fuscript']]]);
  for (output of ['', 'not-a-pid\n', '0\n', '1.5\n']) assert.throws(() => collectProcesses('fuscript'), /invalid process IDs/);
});
