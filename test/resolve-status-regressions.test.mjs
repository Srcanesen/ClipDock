import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusProvider } from '../dist/status-provider.js';
import { createSharedWorkflowIntegration } from '../dist/workflow-integration.js';
import { createTimeoutAwareLifecycle } from '../dist/lifecycle.js';

function fixture() {
  const timeline = { GetName: async () => 'Timeline' };
  const project = { GetName: async () => 'Project', GetCurrentTimeline: async () => timeline };
  const manager = { GetCurrentProject: async () => project };
  const resolve = { GetVersionString: async () => '21', GetProjectManager: async () => manager };
  const workflow = { Initialize: async () => true, GetInfo: () => ({ version: '2' }), GetResolve: async () => resolve };
  return { timeline, project, manager, resolve, workflow };
}

test('SHL-13: status preserves timeout setup failure through the shared lifecycle and can recover', async () => {
  const h = fixture();
  const shared = createSharedWorkflowIntegration(h.workflow);
  let timeoutOk = false;
  const lifecycle = createTimeoutAwareLifecycle(shared, { SetAPITimeout: () => timeoutOk }, 10);
  const provider = createStatusProvider(lifecycle, 'test');
  const failed = await provider.getStatus();
  assert.equal(failed.phase, 'bridge-error');
  assert.equal(failed.bridge.connected, false);
  assert.match(failed.message, /SetAPITimeout\(10\) returned false/);
  assert.equal(failed.bridge.error, failed.message);
  timeoutOk = true;
  assert.equal((await provider.getStatus()).phase, 'ready');
});

for (const [object, method] of [['workflow', 'GetResolve'], ['resolve', 'GetProjectManager'], ['manager', 'GetCurrentProject'], ['project', 'GetName'], ['project', 'GetCurrentTimeline'], ['timeline', 'GetName']]) {
  test(`SHL-13: ${object}.${method} failure is a bridge error, not a missing object`, async () => {
    const h = fixture();
    h[object][method] = async () => { throw new Error('API timeout'); };
    const status = await createStatusProvider(h.workflow, 'test').getStatus();
    assert.equal(status.phase, 'bridge-error');
    assert.equal(status.bridge.connected, false);
    assert.match(status.message, /API timeout/);
    assert.equal(status.message, status.bridge.error);
    assert.match(status.refreshHint, /bridge/);
  });
}

test('SHL-13: legitimate null project/timeline retain their distinct status phases', async () => {
  const h = fixture();
  h.manager.GetCurrentProject = async () => null;
  const provider = createStatusProvider(h.workflow, 'test');
  assert.equal((await provider.getStatus()).phase, 'no-project');
  h.manager.GetCurrentProject = async () => h.project;
  h.project.GetCurrentTimeline = async () => null;
  const status = await provider.getStatus();
  assert.deepEqual([status.phase, status.bridge.connected, status.bridge.error], ['no-timeline', true, null]);
});

test('SHL-16: ten concurrent status requests share one traversal and refresh after settlement', async () => {
  const h = fixture();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0;
  h.workflow.GetResolve = async () => { calls++; await barrier; return h.resolve; };
  const provider = createStatusProvider(h.workflow, 'test');
  const pending = Array.from({ length: 10 }, () => provider.getStatus());
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(results.map(status => status.phase), Array(10).fill('ready'));
  h.project.GetName = async () => 'New project';
  assert.equal((await provider.getStatus()).project.name, 'New project');
  assert.equal(calls, 2);
});

test('SHL-16: a coalesced failed request clears for retry; quit wins over an in-flight snapshot', async () => {
  const h = fixture();
  h.workflow.GetResolve = async () => { throw 'API timeout'; };
  const provider = createStatusProvider(h.workflow, 'test');
  const failed = await Promise.all([provider.getStatus(), provider.getStatus()]);
  assert.deepEqual(failed.map(status => status.phase), ['bridge-error', 'bridge-error']);
  let release;
  h.workflow.GetResolve = () => new Promise(resolve => { release = () => resolve(h.resolve); });
  const pending = provider.getStatus();
  await new Promise(resolve => setImmediate(resolve));
  provider.noteResolveQuit();
  release();
  const status = await pending;
  assert.deepEqual([status.phase, status.bridge.connected, status.project.loaded], ['bridge-error', false, false]);
  assert.match(status.message, /shutting down/);
});
