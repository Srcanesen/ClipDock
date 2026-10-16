import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPython, parseProbeOutput, runProbe } from '../scripts/resolve-smoke/lib/probe.mjs';
import { EXIT, buildReport, classifyExit, renderReport, sanitizeError, sanitizeMessage } from '../scripts/resolve-smoke/lib/report.mjs';

test('parseProbeOutput extracts the marked JSON line and ignores chatter', () => {
  const text = 'bootstrap noise\nCLIPDOCK_SMOKE_JSON:{"ok":true,"checks":{"projectManager":true},"readiness":{"pollMs":123},"quitRequested":true}\n';
  const parsed = parseProbeOutput(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks, { projectManager: true });
  assert.deepEqual(parsed.readiness, { pollMs: 123 });
  assert.equal(parsed.quitRequested, true);
  assert.equal(parsed.quitError, null); // absent ownership field defaults to null
  assert.equal(parsed.error, null);
});

test('parseProbeOutput passes through the probe quitError (ownership skip)', () => {
  const parsed = parseProbeOutput(
    'CLIPDOCK_SMOKE_JSON:{"ok":true,"quitRequested":false,"quitError":{"code":"quit-ownership-unproven","message":"pid set (1, 2) does not exactly match harness child pid 3"}}',
  );
  assert.equal(parsed.quitRequested, false);
  assert.equal(parsed.quitError.code, 'quit-ownership-unproven');
  assert.equal(parsed.quitError.message.includes('child pid 3'), true);
});

test('parseProbeOutput reports missing, invalid, and non-object payloads', () => {
  assert.equal(parseProbeOutput('no marker here').error.code, 'probe-output-missing');
  assert.equal(parseProbeOutput('CLIPDOCK_SMOKE_JSON:not json').error.code, 'probe-output-invalid');
  assert.equal(parseProbeOutput('CLIPDOCK_SMOKE_JSON:[1,2]').error.code, 'probe-output-invalid');
  const failed = parseProbeOutput('CLIPDOCK_SMOKE_JSON:{"ok":false,"error":{"code":"connect-timeout","message":"nope"}}');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'connect-timeout');
});

test('checkPython requires Python >= 3.6', () => {
  assert.equal(checkPython('py', { run: () => ({ ok: true, version: 'Python 3.14.6' }) }).ok, true);
  assert.equal(checkPython('py', { run: () => ({ ok: true, version: 'Python 3.6.15' }) }).ok, true);
  assert.equal(checkPython('py', { run: () => ({ ok: true, version: 'Python 3.5.2' }) }).ok, false);
  assert.equal(checkPython('py', { run: () => ({ ok: true, version: 'Python 2.7.18' }) }).ok, false);
  assert.equal(checkPython('py', { run: () => ({ ok: false, version: '' }) }).error.code, 'python-not-found');
  assert.equal(checkPython('py', { run: () => ({ ok: true, version: 'garbage' }) }).error.code, 'python-too-old');
});

test('runProbe spawns a fake probe, captures output, and parses the result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-'));
  try {
    const script = path.join(root, 'fake-probe.py');
    writeFileSync(
      script,
      'import json, sys\n'
      + 'sys.stdout.write("CLIPDOCK_SMOKE_JSON:" + json.dumps({"ok": True, "checks": {"projectManager": True, "projectList": {"ready": True}, "transferApi": {"ok": True}}}) + "\\n")\n',
    );
    const result = await runProbe({ python: 'python3', probeScript: script, env: {}, timeoutMs: 15000, mode: 'probe' });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks, { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } });
    assert.equal(result.error, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbe wires the official env (deadline + quit-only flag) into the probe', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-'));
  try {
    const script = path.join(root, 'env-probe.py');
    writeFileSync(
      script,
      'import json, os, sys\n'
      + 'sys.stdout.write("CLIPDOCK_SMOKE_JSON:" + json.dumps({'
      + '"ok": True, "deadline": os.environ.get("RESOLVE_SMOKE_DEADLINE_MS"),'
      + '"quitOnly": os.environ.get("RESOLVE_SMOKE_QUIT_ONLY")}) + "\\n")\n',
    );
    const result = await runProbe({ python: 'python3', probeScript: script, env: { RESOLVE_SCRIPT_API: '/s' }, timeoutMs: 9000, mode: 'quit-only' });
    assert.equal(result.ok, true);
    assert.equal(result.output.includes('"deadline": "9000"'), true);
    assert.equal(result.output.includes('"quitOnly": "1"'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runProbe kills a hung probe and reports probe-timeout', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-'));
  try {
    const script = path.join(root, 'hung-probe.py');
    writeFileSync(script, 'import time\ntime.sleep(60)\n');
    const fakeWaitFor = () => Promise.resolve({ kind: 'timeout' });
    const result = await runProbe({ python: 'python3', probeScript: script, env: {}, timeoutMs: 5000, mode: 'probe', waitFor: fakeWaitFor });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'probe-timeout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeMessage collapses whitespace and bounds length; sanitizeError bounds code and message', () => {
  assert.equal(sanitizeMessage('a\n b\t c'), 'a b c');
  assert.equal(sanitizeMessage('x'.repeat(500)).length, 200);
  assert.equal(sanitizeMessage(null), '');
  assert.deepEqual(sanitizeError({ code: 'boom', message: '  bad\nthing  ' }), { code: 'boom', message: 'bad thing' });
  assert.equal(sanitizeError(null).code, 'unknown');
  assert.equal(sanitizeError({ code: 'c'.repeat(100), message: 'm' }).code.length, 60);
});

test('buildReport ok requires checks, completed cleanup, and zero residue', () => {
  const base = {
    platform: 'darwin',
    elapsedMs: 42,
    binary: '/b/Resolve',
    scriptApi: '/s',
    python: 'python3',
    resolveRunningBefore: 0,
    phases: { cleanup: { kind: 'graceful', ms: 10 } },
    checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } },
    residue: { resolve: 0, fuscript: 0 },
  };
  assert.equal(buildReport(base).ok, true);
  assert.equal(buildReport({ ...base, error: { code: 'x', message: 'bad' } }).ok, false);
  assert.equal(buildReport({ ...base, phases: { cleanup: { kind: 'still-running' } } }).ok, false);
  assert.equal(buildReport({ ...base, residue: { resolve: 1, fuscript: 0 } }).ok, false);
  assert.equal(buildReport({ ...base, checks: null }).ok, false);
  assert.equal(buildReport({ ...base, phases: { cleanup: { kind: 'terminated' } } }).ok, true); // escalated cleanup still counts
});

test('classifyExit: residue collector failure exits cleanup-failed, never 0', () => {
  // The exact regression: probe ok + cleanup ok + pgrep failure must exit 6,
  // never exit 0 with a report whose ok is false.
  const failure = classifyExit({
    probe: { ok: true, checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } }, quitError: null },
    cleanup: { kind: 'graceful', ms: 10 },
    residue: { resolve: -1, fuscript: -1 },
    residueError: { code: 'residue-check-failed', message: 'pgrep failed' },
  });
  assert.equal(failure.exitCode, EXIT.CLEANUP_FAILED);
  assert.equal(failure.error.code, 'residue-check-failed');
  const report = buildReport({
    platform: 'darwin',
    elapsedMs: 1,
    binary: '/b',
    scriptApi: '/s',
    python: 'py',
    resolveRunningBefore: 0,
    phases: { cleanup: { kind: 'graceful', ms: 10 } },
    checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } },
    residue: { resolve: -1, fuscript: -1 },
    error: failure.error,
  });
  assert.equal(report.ok, false);
  assert.equal(EXIT.CLEANUP_FAILED, 6);
});

test('classifyExit: quit-ownership-unproven exits probe-failed with the sanitized error', () => {
  const failure = classifyExit({
    probe: {
      ok: true,
      checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } },
      quitRequested: false,
      quitError: { code: 'quit-ownership-unproven', message: 'pid set (1, 2) does not exactly match harness child pid 3' },
    },
    cleanup: { kind: 'graceful', ms: 10 },
    residue: { resolve: 0, fuscript: 0 },
    residueError: null,
  });
  assert.equal(failure.exitCode, EXIT.PROBE_FAILED);
  assert.equal(failure.error.code, 'quit-ownership-unproven');
  assert.deepEqual(sanitizeError(failure.error), failure.error); // report-safe
});

test('classifyExit: ok only with checks + completed cleanup + zero residue + no quitError', () => {
  const okBase = {
    probe: { ok: true, checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } }, quitError: null },
    cleanup: { kind: 'graceful', ms: 10 },
    residue: { resolve: 0, fuscript: 0 },
    residueError: null,
  };
  assert.equal(classifyExit(okBase), null);
  assert.equal(classifyExit({ ...okBase, probe: { ok: false, error: { code: 'connect-timeout' } } }).exitCode, EXIT.PROBE_FAILED);
  assert.equal(classifyExit({ ...okBase, cleanup: { kind: 'still-running' } }).exitCode, EXIT.CLEANUP_FAILED);
  assert.equal(classifyExit({ ...okBase, residue: { resolve: 1, fuscript: 0 } }).exitCode, EXIT.CLEANUP_FAILED);
  assert.equal(classifyExit({ ...okBase, cleanup: { kind: 'error', error: new Error('EACCES') } }).exitCode, EXIT.ENVIRONMENT);
  assert.equal(classifyExit({ ...okBase, probe: { ok: true, checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } }, quitError: { code: 'quit-ownership-unproven', message: 'x' } } }).exitCode, EXIT.PROBE_FAILED);
});

test('renderReport emits one bounded JSON line and respects pretty mode', () => {
  const report = buildReport({
    platform: 'darwin', elapsedMs: 1, binary: '/b', scriptApi: '/s', python: 'py',
    resolveRunningBefore: 0, phases: { cleanup: { kind: 'killed', ms: 2 } },
    checks: { projectManager: true, projectList: { ready: true }, transferApi: { ok: true } }, residue: { resolve: 0, fuscript: 0 }, error: null,
  });
  assert.equal(renderReport(report).trimEnd().split('\n').length, 1);
  assert.equal(renderReport(report, true).includes('\n  '), true);
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.ENVIRONMENT, 3);
  assert.equal(EXIT.REFUSED, 4);
  assert.equal(EXIT.PROBE_FAILED, 5);
  assert.equal(EXIT.CLEANUP_FAILED, 6);
});

test('normal-mode null, missing, or failed checks cannot produce a successful exit or report', () => {
  for (const checks of [null, undefined, {}, { projectManager: true }, { projectManager: true, projectList: { ready: true }, transferApi: { ok: false } }]) {
    const cleanup = { kind: 'graceful' };
    const residue = { resolve: 0, fuscript: 0 };
    assert.equal(classifyExit({ probe: { ok: true, checks }, cleanup, residue }).exitCode, EXIT.PROBE_FAILED);
    assert.equal(buildReport({ checks, phases: { cleanup }, residue }).ok, false);
  }
});
