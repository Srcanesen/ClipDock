import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeBridge, fakeEnvironment } from './helpers/resolve-e2e-fake.mjs';

for (const markers of ['0', '1']) {
  test(`bridge preserves callable presence and round-trips handles (AddMarker=${markers})`, async t => {
    const { bridge } = fakeBridge(t, { FAKE_MARKERS: markers });
    assert.equal(await bridge.workflowIntegration.Initialize('com.clipdock.app'), true);
    const resolve = await bridge.workflowIntegration.GetResolve();
    assert.deepEqual(Object.keys(resolve).sort(), ['Echo', 'Explode', 'GetMediaStorage', 'GetProjectManager', 'GetVersionString', 'Hang', 'OpenPage']);
    assert.equal(Object.getPrototypeOf(resolve), Object.prototype);
    assert.equal(resolve.then, undefined);
    assert.equal(await resolve, resolve);
    assert.equal(await resolve.GetVersionString(), 'fake-resolve-21');
    const pm = await resolve.GetProjectManager();
    const project = await pm.CreateProject('ClipDock-E2E-bridge');
    const pool = await project.GetMediaPool();
    const folder = await pool.GetCurrentFolder();
    const child = await pool.AddSubFolder(folder, 'ClipDock');
    assert.equal(await pool.SetCurrentFolder(child), true);
    assert.equal(await pool.GetCurrentFolder(), child);
    assert.equal(await (await pool.GetCurrentFolder()).GetName(), 'ClipDock');
    assert.deepEqual(await folder.GetSubFolderList(), [child]);
    const timeline = await pool.CreateEmptyTimeline('Test');
    assert.equal(typeof timeline.AddMarker, markers === '1' ? 'function' : 'undefined');
    assert.deepEqual(Object.keys(timeline).sort(), [...(markers === '1' ? ['AddMarker'] : []), 'GetCurrentTimecode', 'GetEndFrame', 'GetItemListInTrack', 'GetMarkers', 'GetName', 'GetSetting', 'GetStartFrame', 'GetStartTimecode'].sort());
    assert.equal(await project.SetCurrentTimeline(timeline), true);
    const clips = await (await resolve.GetMediaStorage()).AddItemListToMediaPool(['/tmp/clip één.mp4']);
    assert.equal(clips.length, 1);
    assert.deepEqual(Object.keys(clips[0]).sort(), ['GetClipProperty', 'SetClipColor']);
    assert.equal(await clips[0].GetClipProperty('File Path'), '/tmp/clip één.mp4');
    const echoed = await resolve.Echo({ folder: child, nested: [folder, { clip: clips[0] }], primitive: null });
    assert.equal(echoed.folder, child);
    assert.equal(echoed.nested[1].clip, clips[0]);
    const items = await pool.AppendToTimeline([{ mediaPoolItem: clips[0], recordFrame: 42 }]);
    assert.equal(await items[0].GetStart(), 42);
    await assert.rejects(resolve.Explode(), /fake Python exception/);
    assert.equal(await resolve.GetVersionString(), 'fake-resolve-21');
    await bridge.close();
    await bridge.close();
    await assert.rejects(resolve.GetVersionString(), /closed|exited/);
  });
}

test('empty dir falls back to available interface methods without inventing optional methods', async t => {
  const { bridge } = fakeBridge(t, { FAKE_EMPTY_DIR: '1', FAKE_MARKERS: '0' });
  const resolve = await bridge.workflowIntegration.GetResolve();
  assert.equal(typeof resolve.GetProjectManager, 'function');
  assert.equal(resolve.Explode, undefined);
  const project = await (await resolve.GetProjectManager()).CreateProject('ClipDock-E2E-fallback');
  const timeline = await (await project.GetMediaPool()).CreateEmptyTimeline('Fallback');
  assert.equal(await timeline.GetName(), 'Fallback');
  assert.equal(timeline.AddMarker, undefined);
});

test('requests serialize and a hung call times out and poisons queued work', async t => {
  const { bridge } = fakeBridge(t, {}, 500);
  const resolve = await bridge.workflowIntegration.GetResolve();
  const first = resolve.Hang();
  const queued = resolve.GetVersionString();
  await Promise.all([
    assert.rejects(first, /call Hang timed out after 500 ms/),
    assert.rejects(queued, /call Hang timed out after 500 ms/),
  ]);
  await bridge.close();
  await bridge.close();
});


test('Python release frees only the requested handles and stdout remains NDJSON', t => {
  const { env } = fakeEnvironment(t);
  const script = fileURLToPath(new URL('../scripts/resolve-smoke/bridge.py', import.meta.url));
  const input = [
    { id: 1, op: 'root' },
    { id: 2, op: 'release', handles: [1] },
    { id: 3, op: 'call', handle: 1, method: 'GetVersionString', args: [] },
  ].map(request => JSON.stringify(request)).join('\n') + '\n';
  const result = spawnSync('python3', [script], { env, input, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0);
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.$h, 1);
  assert.equal(responses[0].result.methods.includes('GetVersionString'), true);
  assert.deepEqual(responses[1], { id: 2, result: true });
  assert.deepEqual(responses[2], { id: 3, error: '1' });
  assert.match(result.stderr, /fake bootstrap diagnostic/);
});
