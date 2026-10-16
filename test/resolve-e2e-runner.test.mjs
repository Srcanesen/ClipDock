import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { assertTestProject, generateFixtures, guardWorkflowIntegration, importActiveScenario, importDuplicateScenario, loadClipDock, parseE2eArgs, runE2e, waitForProjectManager } from '../scripts/resolve-smoke/e2e.mjs';
import { createPythonBridge } from '../scripts/resolve-smoke/lib/bridge.mjs';
import { fakeBridge, fakeEnvironment } from './helpers/resolve-e2e-fake.mjs';

const api = loadClipDock();

test('real ClipDock transfer over Python bridge passes active and duplicate read-back scenarios', async t => {
  const { bridge, root } = fakeBridge(t);
  const fixture = path.join(root, 'clip één.mp4');
  writeFileSync(fixture, 'fake media');
  const resolve = await bridge.workflowIntegration.GetResolve();
  const pm = await resolve.GetProjectManager();
  const name = 'ClipDock-E2E-runner';
  const project = await pm.CreateProject(name);
  const workflowIntegration = guardWorkflowIntegration(bridge.workflowIntegration, () => assertTestProject(pm, name));
  const transfer = api.createTransfer(workflowIntegration, 'com.clipdock.app', { validatePath: p => api.canonicalMediaPath(p, root, true) });
  const context = { transfer, mediaPool: await project.GetMediaPool(), fixture };
  const active = await importActiveScenario(context);
  assert.equal(active.status, 'pass');
  assert.deepEqual(active.expected, { kind: 'imported', count: 1 });
  assert.equal(active.actual.kind, 'imported');
  assert.equal(active.actual.count, 1);
  const duplicate = await importDuplicateScenario(context);
  assert.equal(duplicate.status, 'pass');
  assert.equal(duplicate.actual.kind, 'already-imported');
  assert.equal(duplicate.actual.count, 1);
  await pm.CreateProject('Other project');
  const rejected = await transfer.importToMediaPool(fixture, 'active');
  assert.equal(rejected.kind, 'import-failed');
  assert.match(rejected.message, /Refusing mutation/);
  const otherPool = await (await pm.GetCurrentProject()).GetMediaPool();
  assert.deepEqual(await (await otherPool.GetCurrentFolder()).GetClipList(), []);
});

test('runner refuses active Resolve before setup or spawn', async () => {
  const result = await runE2e(parseE2eArgs([]), {
    assertNoResolveRunning: () => ({ ok: false, pids: [42] }),
    validatePaths: () => { throw new Error('must not reach setup'); },
    spawnResolve: () => { throw new Error('must never spawn'); },
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.refusal.resolveRunningBefore, 1);
  assert.equal(result.report.errors[0].code, 'resolve-already-running');
});

async function runInjected(t, markers = '1', extra = {}, overrides = {}) {
  const log = [];
  const { root, env } = fakeEnvironment(t, { FAKE_MARKERS: markers, ...extra });
  env.FAKE_LOG = path.join(root, 'calls.log');
  let fixtureRoot;
  const result = await runE2e(parseE2eArgs([]), {
    platform: 'darwin',
    assertNoResolveRunning: () => ({ ok: true, pids: [] }),
    collectProcesses: () => [123],
    validatePaths: () => ({ ok: true }),
    checkPython: () => ({ ok: true }),
    loadClipDock: () => ({ ...api, discoverFfmpeg: () => '/fake/ffmpeg', createMediaPrep: () => ({ prepare: async request => { const filePath = path.join(request.allowedRoot, 'prepared.mp4'); writeFileSync(filePath, 'prepared'); return { filePath, action: 'transcode' }; }, dispose: async () => {} }) }),
    generateFixtures: folder => {
      fixtureRoot = folder;
      const fixture = path.join(folder, 'clip één.mp4'), oddFixture = path.join(folder, 'odd.mkv');
      writeFileSync(fixture, 'media'); writeFileSync(oddFixture, 'odd');
      return { fixture, oddFixture };
    },
    spawnResolve: () => ({ pid: 123, launch: Promise.resolve({ ok: true }), stdout: new EventEmitter(), stderr: new EventEmitter() }),
    createPythonBridge: options => {
      const bridge = createPythonBridge({ ...options, env });
      return { ...bridge, close: async () => { log.push('bridge-close'); await bridge.close(); } };
    },
    runProbe: async () => { log.push('quit'); return { ok: true }; },
    shutdown: async () => { log.push('shutdown'); return { kind: 'graceful' }; },
    collectResidue: () => { log.push('residue'); return { ok: true, residue: { resolve: 0, fuscript: 0 } }; },
    ...overrides,
  });
  return { result, log, env, fixtureRoot };
}

for (const markers of ['0', '1']) {
  test(`injected runner uses real transfer/status, reads scenarios back, and cleans up (markers=${markers})`, async t => {
    const { result, log, env, fixtureRoot } = await runInjected(t, markers);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.equal(result.report.ok, true);
    assert.deepEqual(Object.keys(result.report.checks), ['status', 'import-active', 'import-duplicate', 'import-clipdock-bin', 'timeline-end', 'timeline-automation', 'timeline-playhead', 'media-prep-fast']);
    assert.equal(result.report.checks.status.actual.project, result.report.projectName);
    assert.equal(result.report.checks['timeline-end'].actual.count, 1);
    assert.equal(result.report.checks['timeline-automation'].status, markers === '1' ? 'pass' : 'unavailable');
    assert.deepEqual(result.report.checks['timeline-playhead'].actual, {kind: 'timeline-inserted', count: 3, recordFrame: 25});
    assert.equal(result.report.checks['media-prep-fast'].actual.kind, 'imported');
    assert.equal(existsSync(fixtureRoot), false);
    const calls = readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n');
    assert.deepEqual(calls.slice(-2), ['CloseProject', 'DeleteProject']);
    assert.deepEqual(log, ['bridge-close', 'quit', 'shutdown', 'residue']);
  });
}

test('fixture generation and real media prep fast profile preserve odd dimensions through padding', async t => {
  const ffmpeg = api.discoverFfmpeg();
  if (!ffmpeg) return t.skip('ffmpeg unavailable');
  const ffprobe = api.discoverFfprobe(ffmpeg);
  if (!ffprobe) return t.skip('ffprobe unavailable');
  const { root } = fakeEnvironment(t);
  const { fixture, oddFixture } = generateFixtures(root, ffmpeg);
  assert.equal(path.basename(fixture), 'clip één.mp4');
  const prep = api.createMediaPrep({ ffmpegPath: ffmpeg, conversionTimeoutMs: 30000 });
  t.after(() => prep.dispose());
  const output = await prep.prepare({ jobId: 'e2e_test', inputPath: oddFixture, allowedRoot: root, profile: 'fast', emit: () => {} });
  assert.equal(output.action, 'transcode');
  assert.equal(existsSync(output.filePath), true);
  assert.equal(existsSync(oddFixture), false);
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output.filePath], { encoding: 'utf8' });
  assert.equal(probe.status, 0);
  const video = JSON.parse(probe.stdout).streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 162);
  assert.equal(video.height, 98);
  assert.equal(video.codec_name, 'h264');
});

test('e2e CLI parses its optional URL and help without launching Resolve', () => {
  assert.equal(parseE2eArgs(['--download-url=https://www.youtube.com/watch?v=abcdefghijk']).downloadUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.throws(() => parseE2eArgs(['--download-url=file:///tmp/a']), /http/);
  assert.throws(() => parseE2eArgs(['--probe=x']), /only supported/);
  const result = spawnSync(process.execPath, ['scripts/resolve-smoke/e2e.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--download-url/);
  assert.match(result.stdout, /Exit codes/);
  assert.equal(result.stderr, '');
});


test('failed checks exit 5 and still close/delete the project and remove fixtures', async t => {
  const { result, env, fixtureRoot, log } = await runInjected(t, '1', { FAKE_IMPORT_FAIL: '1' });
  assert.equal(result.exitCode, 5);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.checks['import-active'].status, 'fail');
  assert.equal(result.report.checks['import-active'].actual.count, 0);
  assert.deepEqual(readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').slice(-2), ['CloseProject', 'DeleteProject']);
  assert.equal(existsSync(fixtureRoot), false);
  assert.deepEqual(log, ['bridge-close', 'quit', 'shutdown', 'residue']);
});

test('failed close prevents deletion and exits 6 while other cleanup continues', async t => {
  const { result, env, fixtureRoot, log } = await runInjected(t, '1', { FAKE_CLOSE_FAIL: '1' });
  assert.equal(result.exitCode, 6);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.errors.some(error => error.code === 'project-close-failed'), true);
  assert.equal(result.report.errors.some(error => error.code === 'project-delete-failed'), true);
  assert.equal(readFileSync(env.FAKE_LOG, 'utf8').includes('DeleteProject'), false);
  assert.equal(existsSync(fixtureRoot), false);
  assert.deepEqual(log, ['bridge-close', 'quit', 'shutdown', 'residue']);
});

test('unknown residue exits 6 even when scenarios and project cleanup pass', async t => {
  const { result, fixtureRoot } = await runInjected(t, '1', {}, { collectResidue: () => ({ ok: false, residue: { resolve: -1, fuscript: -1 }, error: { message: 'pgrep failed' } }) });
  assert.equal(result.exitCode, 6);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.errors.some(error => error.code === 'residue-check-failed'), true);
  assert.equal(existsSync(fixtureRoot), false);
});

test('setup errors exit 3 and readiness is bounded even when the API never answers', async () => {
  const result = await runE2e(parseE2eArgs([]), {
    assertNoResolveRunning: () => ({ ok: true, pids: [] }),
    platform: 'darwin',
    validatePaths: () => ({ ok: false, error: { message: 'fake missing scripting library' } }),
    spawnResolve: () => { throw new Error('must never spawn'); },
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.report.errors[0].message, /fake missing scripting library/);
  await assert.rejects(waitForProjectManager({ workflowIntegration: { GetResolve: () => new Promise(() => {}) } }, 40), /readiness timed out after 40 ms/);
});


test('a rejected project creation exits setup-failed without attempting close/delete', async t => {
  const { result, fixtureRoot, env, log } = await runInjected(t, '1', { FAKE_CREATE_FAIL: '1' });
  assert.equal(result.exitCode, 3);
  assert.equal(result.report.errors[0].code, 'setup-failed');
  assert.match(result.report.errors[0].message, /CreateProject returned no project/);
  assert.equal(existsSync(fixtureRoot), false);
  assert.deepEqual(readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n'), ['CreateProject']);
  assert.deepEqual(log, ['bridge-close', 'quit', 'shutdown', 'residue']);
});
