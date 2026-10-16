import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadClipDock, runScenarios } from '../scripts/resolve-smoke/e2e.mjs';
import { fakeBridge } from './helpers/resolve-e2e-fake.mjs';

async function scenarios(t, mutate = source => source) {
  const { bridge, root } = fakeBridge(t);
  const module = path.join(root, 'DaVinciResolveScript.py');
  writeFileSync(module, mutate(readFileSync(module, 'utf8')));
  const api = loadClipDock();
  const resolve = await bridge.workflowIntegration.GetResolve();
  const pm = await resolve.GetProjectManager();
  const projectName = 'ClipDock-E2E-placement';
  const project = await pm.CreateProject(projectName);
  const mediaPool = await project.GetMediaPool();
  const timeline = await mediaPool.CreateEmptyTimeline('placement');
  await project.SetCurrentTimeline(timeline);
  const fixture = path.join(root, 'clip.mp4'), oddFixture = path.join(root, 'prepared.mp4');
  writeFileSync(fixture, 'media'); writeFileSync(oddFixture, 'prepared');
  const transfer = api.createTransfer(bridge.workflowIntegration, 'com.clipdock.app', { validatePath: p => api.canonicalMediaPath(p, root, true) });
  return runScenarios({
    api: { ...api, createMediaPrep: () => ({ prepare: async () => ({ filePath: oddFixture, action: 'transcode' }), dispose: async () => {} }) },
    workflowIntegration: bridge.workflowIntegration, transfer, mediaPool, timeline,
    fixture, oddFixture, fixtureRoot: root, projectName,
  });
}

test('placement gate reports literal end and playhead frames read back through Resolve bridge', async t => {
  // Read-back order must not be confused with insertion order.
  const checks = await scenarios(t, s => s.replace('return self.items', 'return list(reversed(self.items))'));
  assert.equal(checks['timeline-end'].status, 'pass');
  assert.equal(checks['timeline-end'].expected.recordFrame, 0);
  assert.equal(checks['timeline-end'].actual.recordFrame, 0);
  assert.equal(checks['timeline-automation'].actual.recordFrame, 75);
  assert.equal(checks['timeline-playhead'].status, 'pass');
  assert.equal(checks['timeline-playhead'].expected.recordFrame, 25);
  assert.equal(checks['timeline-playhead'].actual.recordFrame, 25);
});

test('placement gate fails when Resolve ignores recordFrame despite successful transfer result', async t => {
  const checks = await scenarios(t, s => s.replace("start = clips[0]['recordFrame']", 'start = timeline.GetEndFrame()'));
  assert.equal(checks['timeline-playhead'].status, 'fail');
  assert.equal(checks['timeline-playhead'].actual.kind, 'timeline-inserted');
  assert.equal(checks['timeline-playhead'].expected.recordFrame, 25);
  assert.equal(checks['timeline-playhead'].actual.recordFrame, 150);
});

test('placement gate fails when end append succeeds at the wrong frame', async t => {
  const checks = await scenarios(t, s => s.replace('start = timeline.GetEndFrame()', 'start = 999'));
  assert.equal(checks['timeline-end'].status, 'fail');
  assert.equal(checks['timeline-end'].actual.kind, 'timeline-appended');
  assert.equal(checks['timeline-end'].expected.recordFrame, 0);
  assert.equal(checks['timeline-end'].actual.recordFrame, 999);
  assert.equal(checks['timeline-automation'].status, 'fail');
});
