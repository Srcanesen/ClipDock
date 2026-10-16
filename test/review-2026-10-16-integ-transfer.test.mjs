import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTransfer} from '../dist/transfer.js';
import {fakeBridge} from './helpers/resolve-e2e-fake.mjs';

for (const change of [null, 'folder', 'project', 'scan']) {
  test(`ClipDock creation selects its bin while guarding ${change ?? 'the owned transition'}`, async () => {
    const previous = {GetUniqueId: () => 'previous'};
    const user = {GetUniqueId: () => 'user'};
    const target = {GetUniqueId: () => 'target', GetClipList() {
      if (change === 'scan') current = user;
      return [];
    }};
    let current = previous, imports = 0;
    const sets = [];
    const pool = {
      GetCurrentFolder: () => current,
      GetRootFolder: () => ({GetSubFolderList: () => []}),
      AddSubFolder() {
        current = change === 'folder' ? user : target;
        if (change === 'project') project = other;
        return target;
      },
      SetCurrentFolder(folder) {sets.push(folder); current = folder; return true;},
    };
    const other = {GetUniqueId: () => 'other'};
    let project = {GetUniqueId: () => 'original', GetMediaPool: () => pool};
    const resolve = {
      GetProjectManager: () => ({GetCurrentProject: () => project}),
      GetMediaStorage: () => ({AddItemListToMediaPool() {imports++; return [{}];}}),
    };
    const transfer = createTransfer({Initialize: () => true, GetResolve: () => resolve}, 'integ', 'linux');
    const result = await transfer.importToMediaPool('/clip.mp4', 'clipdock');
    assert.deepEqual([result.kind, imports], change ? ['destination-changed', 0] : ['imported', 1]);
    if (!change) {
      assert.equal(result.importedCount, 1);
      assert.equal(current, previous);
      assert.deepEqual(sets, [target, previous]);
    } else if (change !== 'scan') assert.deepEqual(sets, []);
  });
}

test('Resolve E2E fake selects the folder returned by AddSubFolder', async t => {
  const {bridge} = fakeBridge(t);
  const resolve = await bridge.workflowIntegration.GetResolve();
  const pm = await resolve.GetProjectManager();
  const project = await pm.CreateProject('ClipDock-E2E-fake-transition');
  const pool = await project.GetMediaPool();
  const folder = await pool.AddSubFolder(await pool.GetRootFolder(), 'ClipDock');
  assert.equal(await pool.GetCurrentFolder(), folder);
});
