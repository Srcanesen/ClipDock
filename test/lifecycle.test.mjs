// Deterministic tests for the ClipDock bridge/lifecycle seams (src/lifecycle.ts):
//   - Official SetAPITimeout(10) init ordering: it runs AFTER the first
//     successful Initialize, exactly once, and a false/throw is a controlled
//     visible failure — never a silent success.
//   - The SINGLE idempotent shutdown contract: ResolveQuit notifies the renderer
//     BEFORE starting app.quit, and duplicate quit callbacks start it only once.
// Run after `npm run build`; tests import the compiled artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { test } from 'node:test';

import { createShutdownCoordinator, createTimeoutAwareLifecycle } from '../dist/lifecycle.js';

import { mainFixture } from './helpers/files-main.mjs';
import { IPC_CHANNELS } from '../dist/shared.js';

function recordingBridge({ initResult = true, timeoutResult = true } = {}) {
  const calls = [];
  const inner = {
    Initialize: (pluginId) => { calls.push(`init:${pluginId}`); return Promise.resolve(initResult); },
    GetInfo: () => ({ version: '2.0.0' }),
    GetResolve: () => Promise.resolve({ name: 'Resolve' }),
  };
  let timeoutBehavior = timeoutResult;
  const native = {
    SetAPITimeout: (seconds) => {
      calls.push(`timeout:${seconds}`);
      return typeof timeoutBehavior === 'function' ? timeoutBehavior() : timeoutBehavior;
    },
    set timeoutResult(next) { timeoutBehavior = next; },
  };
  return { calls, inner, native };
}

test('SetAPITimeout(10) runs exactly once, AFTER the first successful Initialize, and the lifecycle resolves true', async () => {
  const { calls, inner, native } = recordingBridge();
  const wf = createTimeoutAwareLifecycle(inner, native, 10);

  assert.equal(await wf.Initialize('com.clipdock.app'), true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10']); // strict order: init first, timeout second

  // Already applied: a second Initialize never re-runs SetAPITimeout.
  assert.equal(await wf.Initialize('com.clipdock.app'), true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10']);

  // GetInfo/GetResolve pass through untouched.
  assert.deepEqual(wf.GetInfo(), { version: '2.0.0' });
  assert.deepEqual(await wf.GetResolve(), { name: 'Resolve' });
});

test('a failed Initialize (Resolve not ready) never calls SetAPITimeout; the next pass retries the full sequence', async () => {
  let ready = false;
  const calls = [];
  const inner = {
    Initialize: (pluginId) => { calls.push(`init:${pluginId}`); return Promise.resolve(ready); },
    GetInfo: () => null,
    GetResolve: () => null,
  };
  const native = { SetAPITimeout: (seconds) => { calls.push(`timeout:${seconds}`); return true; } };
  const wf = createTimeoutAwareLifecycle(inner, native, 10);

  assert.equal(await wf.Initialize('com.clipdock.app'), false);
  assert.deepEqual(calls, ['init:com.clipdock.app']); // no timeout call before success

  ready = true;
  assert.equal(await wf.Initialize('com.clipdock.app'), true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'init:com.clipdock.app', 'timeout:10']);
});

test('SetAPITimeout returning false is a controlled visible failure (never silent success) and can recover on retry', async () => {
  const { calls, inner, native } = recordingBridge({ timeoutResult: false });
  const wf = createTimeoutAwareLifecycle(inner, native, 10);

  await assert.rejects(() => wf.Initialize('com.clipdock.app'), /SetAPITimeout\(10\) returned false/);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10']);

  // The failure is retryable: once the timeout can be applied, Initialize succeeds.
  native.timeoutResult = true;
  assert.equal(await wf.Initialize('com.clipdock.app'), true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10', 'init:com.clipdock.app', 'timeout:10']);
  assert.equal(await wf.Initialize('com.clipdock.app'), true); // applied: no further calls
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10', 'init:com.clipdock.app', 'timeout:10']);
});

test('SetAPITimeout throwing is a controlled visible failure and can recover on retry', async () => {
  const { calls, inner, native } = recordingBridge({ timeoutResult: () => { throw new Error('native boom'); } });
  const wf = createTimeoutAwareLifecycle(inner, native, 10);

  await assert.rejects(() => wf.Initialize('com.clipdock.app'), /SetAPITimeout\(10\) threw: native boom/);

  native.timeoutResult = true;
  assert.equal(await wf.Initialize('com.clipdock.app'), true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10', 'init:com.clipdock.app', 'timeout:10']);
});

test('concurrent Initialize callers share one init + SetAPITimeout sequence', async () => {
  const { calls, inner, native } = recordingBridge();
  const wf = createTimeoutAwareLifecycle(inner, native, 10);

  const [a, b] = await Promise.all([
    wf.Initialize('com.clipdock.app'),
    wf.Initialize('com.clipdock.app'),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(calls, ['init:com.clipdock.app', 'timeout:10']); // single sequence
});

function shutdownHarness({ notifyThrows = false, quitThrows = false } = {}) {
  const order = [];
  const deps = {
    notifyRenderer: (reason) => {
      order.push(`notify:${reason}`);
      if (notifyThrows) throw new Error('notify failed');
    },
    requestQuit: () => {
      order.push('app.quit');
      if (quitThrows) throw new Error('quit failed');
    },
  };
  const coordinator = createShutdownCoordinator(deps);
  return { coordinator, deps, order };
}

test('ResolveQuit notifies the renderer BEFORE app.quit, and double quit events start it once', () => {
  const h = shutdownHarness();

  h.coordinator.beginShutdown('resolve-quit');
  h.coordinator.beginShutdown('resolve-quit'); // second ResolveQuit: no-op
  h.coordinator.beginShutdown('window-quit');  // window close after ResolveQuit: no-op

  assert.deepEqual(h.order, ['notify:resolve-quit', 'app.quit']);
  assert.equal(h.coordinator.shuttingDown, true);

  // Post-shutdown quit events cannot notify or start another app.quit.
  h.coordinator.beginShutdown('resolve-quit');
  h.coordinator.beginShutdown('window-quit');
  assert.deepEqual(h.order, ['notify:resolve-quit', 'app.quit']);
});

test('normal window quit keeps the existing app.quit flow without a renderer notification', () => {
  const h = shutdownHarness();

  h.coordinator.beginShutdown('window-quit');
  assert.deepEqual(h.order, []); // window-quit does not start another app.quit
  assert.equal(h.coordinator.shuttingDown, true);

  // A later ResolveQuit (e.g. Resolve quits while the panel is closing) is a no-op.
  h.coordinator.beginShutdown('resolve-quit');
  assert.deepEqual(h.order, []);
});

test('a throwing renderer notification still leaves the single app.quit request', () => {
  const h = shutdownHarness({ notifyThrows: true });
  h.coordinator.beginShutdown('resolve-quit');
  assert.deepEqual(h.order, ['notify:resolve-quit', 'app.quit']);
});

test('a throwing app.quit request is not retried by a duplicate ResolveQuit callback', () => {
  const h = shutdownHarness({ quitThrows: true });
  h.coordinator.beginShutdown('resolve-quit');
  h.coordinator.beginShutdown('resolve-quit');
  assert.deepEqual(h.order, ['notify:resolve-quit', 'app.quit']);
});

test('main wires timeout initialization into status and sends ResolveQuit before one awaited cleanup', async t => {
  const f = await mainFixture(t, {realStatus: true});
  const order = [];
  f.controls.nativeResolve = {GetVersionString: () => '21.0', GetProjectManager: () => ({GetCurrentProject: () => null})};
  f.controls.nativeInitialize = async () => { order.push('initialize'); return true; };
  f.controls.nativeTimeout = seconds => { order.push(`timeout:${seconds}`); return true; };
  assert.equal((await f.invoke('getStatus')).bridge.connected, true);
  assert.deepEqual(order, ['initialize', 'timeout:10']);
  let quitStatus;
  f.event.sender.send = channel => { order.push(channel); assert.equal(f.lifecycle.quitRequests, 0); quitStatus = f.invoke('getStatus'); };
  const callback = f.callbacks.get('ResolveQuit');
  assert.equal(typeof callback, 'function');
  callback(); callback();
  const disconnected = await quitStatus;
  assert.equal(disconnected.bridge.connected, false);
  assert.equal(disconnected.bridge.error, 'Resolve is shutting down; the bridge is no longer available.');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['initialize', 'timeout:10', IPC_CHANNELS.resolveQuit]);
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.lifecycle.completedQuits, 1);
});

test('main window close detaches and closes the preview before requesting normal shutdown', async t => {
  const f = await mainFixture(t);
  assert.equal(await f.invoke('openYoutubePreview', 'dQw4w9WgXcQ', 0, {x: 10, y: 10, width: 320, height: 180}), true);
  assert.equal(f.previews.length, 1);
  const preview = f.previews[0], observations = [];
  assert.equal(preview.closed, false);
  assert.equal(f.windows[0].children.has(preview), true);
  f.controls.onQuit = () => observations.push({closed: preview.closed, attached: f.windows[0].children.has(preview)});
  f.windows[0].handlers.get('close')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observations, [{closed: true, attached: false}, {closed: true, attached: false}]);
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.lifecycle.completedQuits, 1);
  assert.deepEqual(f.events, []);
});

test('main transfer uses timeout-aware initialization before native handoffs and recovers after timeout failure', async t => {
  const f = await mainFixture(t, {realTransfer: true}), calls = [];
  const clip = path.join(f.dir, 'clip.mp4'); fs.writeFileSync(clip, 'media');
  f.controls.dialog = async () => ({canceled: false, filePaths: [clip]});
  const {cardId} = await f.invoke('selectFile');
  f.controls.nativeInitialize = async () => { calls.push('initialize'); return true; };
  f.controls.nativeTimeout = seconds => { calls.push(`timeout:${seconds}:failed`); return false; };
  const project = {GetMediaPool: () => ({GetCurrentFolder: () => null})};
  f.controls.nativeResolve = {
    GetProjectManager: async () => ({GetCurrentProject: () => project}),
    GetMediaStorage: async () => ({AddItemListToMediaPool: async paths => { calls.push(paths); return [{}]; }}),
  };
  assert.deepEqual(await f.invoke('importToMediaPool', cardId, 'active'), {
    ok: false, kind: 'bridge-error', message: 'Resolve bridge call failed: WorkflowIntegration initialized, but SetAPITimeout(10) returned false..',
  });
  assert.deepEqual(calls, ['initialize', 'timeout:10:failed']);
  f.controls.nativeTimeout = seconds => { calls.push(`timeout:${seconds}:ok`); return true; };
  assert.deepEqual(await f.invoke('importToMediaPool', cardId, 'active'), {
    ok: true, kind: 'imported', importedCount: 1, message: 'Imported 1 clip to the Media Pool.',
  });
  assert.deepEqual(calls, ['initialize', 'timeout:10:failed', 'timeout:10:ok', [clip]]);
});

test('main has no forced-exit references that bypass awaited shutdown', () => {
  // Structural guard: exercised lifecycle paths cannot prove the absence of a
  // forced exit in an unexercised Electron callback. Inspect bindings, not formatting.
  const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const forced = [];
  const visit = node => {
    const member = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
    if (member && ['app', 'process'].includes(node.expression.getText(source)) && ['exit', 'reallyExit', 'abort'].includes(member)) forced.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(forced, []);
});
