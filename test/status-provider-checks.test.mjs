import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('injected WorkflowIntegration status lifecycle', async (t) => {
  const { createStatusProvider } = await import(path.join(dist, 'status-provider.js'));

  // Fake Resolve object graph mirroring the real scripting API surface the provider calls.
  const makeResolve = (o) => ({
    GetVersionString: async () => o.resolveVersion ?? '21.0.3.7',
    GetProjectManager: async () => ({
      GetCurrentProject: async () => (o.project == null ? null : {
        GetName: async () => o.project,
        GetCurrentTimeline: async () => (o.timeline == null ? null : {
          GetName: async () => o.timeline,
        }),
      }),
    }),
  });

  // Fake WorkflowIntegration native module; records calls so we can assert usage.
  const makeWorkflowIntegration = (o = {}) => {
    const calls = [];
    return {
      calls,
      Initialize: async (id) => { calls.push(`Initialize(${id})`); return o.initResult ?? true; },
      GetInfo: () => ({ version: o.moduleVersion ?? '2.0.0-test' }),
      GetResolve: async () => {
        if (o.resolveThrows) throw new Error('native boom');
        return o.resolve ?? null;
      },
    };
  };

  // Shared lifecycle: status and transfer providers must not initialize the native
  // 1. READY FLOW — regression for the live bug: values arrived but Status stayed
  //    "Not connected". Root cause: facts.initialized was never set true after a
  //    successful Initialize. This test fails (bridge.connected === false) on the
  //    buggy collector and passes once the provider records initialization.
  {
    const wi = makeWorkflowIntegration({
      resolve: makeResolve({ resolveVersion: '21.0.3.7', project: 'Demo Project', timeline: 'Main Edit' }),
    });
    const s = await createStatusProvider(wi, 'com.clipdock.app').getStatus();
    expect('provider: ready phase', s.phase, 'ready');
    expect('provider: bridge connected after Initialize', s.bridge.connected, true);
    expect('provider: module version surfaced', s.bridge.moduleVersion, '2.0.0-test');
    expect('provider: resolve version surfaced', s.bridge.resolveVersion, '21.0.3.7');
    expect('provider: project name', s.project.name, 'Demo Project');
    expect('provider: timeline name', s.timeline.name, 'Main Edit');
    expect('provider: ready message', s.message, 'Connected to project "Demo Project" — timeline "Main Edit".');
    expect('provider: Initialize called once with pluginId', wi.calls.join('|'), 'Initialize(com.clipdock.app)');
  }

  // 2. INIT FAILURE — Initialize returns false -> bridge-error with a clear error.
  {
    const s = await createStatusProvider(makeWorkflowIntegration({ initResult: false }), 'com.clipdock.app').getStatus();
    expect('provider: init failure -> bridge-error', s.phase, 'bridge-error');
    expect('provider: init failure not connected', s.bridge.connected, false);
    expect('provider: init failure error', s.bridge.error,
      'WorkflowIntegration.Initialize failed. Is the plugin installed for Resolve Studio?');
  }

  // 3. GetResolve returns null / throws -> bridge-error.
  {
    const noResolve = await createStatusProvider(makeWorkflowIntegration({ resolve: null }), 'com.clipdock.app').getStatus();
    expect('provider: GetResolve null -> bridge-error', noResolve.phase, 'bridge-error');
    expect('provider: GetResolve null error', noResolve.bridge.error, 'GetResolve returned no Resolve object.');

    const threw = await createStatusProvider(makeWorkflowIntegration({ resolveThrows: true }), 'com.clipdock.app').getStatus();
    expect('provider: GetResolve throw -> bridge-error', threw.phase, 'bridge-error');
    assert.equal(Boolean(threw.bridge.error && threw.bridge.error.includes('native boom')), true, `provider: GetResolve throw error message — got ${threw.bridge.error}`);
  }

  // 4. NO PROJECT / NO TIMELINE.
  {
    const noProj = await createStatusProvider(makeWorkflowIntegration({ resolve: makeResolve({ project: null }) }), 'com.clipdock.app').getStatus();
    expect('provider: no project -> no-project', noProj.phase, 'no-project');
    expect('provider: no project message', noProj.message,
      'DaVinci Resolve is connected, but no project is currently open.');

    const noTl = await createStatusProvider(
      makeWorkflowIntegration({ resolve: makeResolve({ project: 'Demo Project', timeline: null }) }),
      'com.clipdock.app').getStatus();
    expect('provider: no timeline -> no-timeline', noTl.phase, 'no-timeline');
    expect('provider: no timeline keeps project name', noTl.project.name, 'Demo Project');
  }

  // 5. RESOLVE QUIT — noteResolveQuit() marks the bridge gone for subsequent calls.
  {
    const p = createStatusProvider(
      makeWorkflowIntegration({ resolve: makeResolve({ project: 'Demo Project', timeline: 'Main Edit' }) }),
      'com.clipdock.app');
    expect('provider: ready before quit', (await p.getStatus()).phase, 'ready');
    p.noteResolveQuit();
    const after = await p.getStatus();
    expect('provider: quit -> bridge-error', after.phase, 'bridge-error');
    expect('provider: quit error mentions shutting down', after.bridge.error,
      'Resolve is shutting down; the bridge is no longer available.');
  }
});
