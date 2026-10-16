import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function makeTransferWithCounter() {
  let importCalls = 0;
  let folder = { GetClipList: async () => [] };
  const mediaPool = {
    GetCurrentFolder: async () => folder,
    GetRootFolder: async () => ({ GetSubFolderList: async () => [], GetClipList: async () => [] }),
    AddSubFolder: async () => ({ GetName: async () => 'ClipDock', GetClipList: async () => [] }),
    SetCurrentFolder: async value => { folder = value; return true; },
    AppendToTimeline: async () => [{ GetStart: async () => 0 }],
  };
  const project = {
    GetCurrentTimeline: async () => ({ GetUniqueId: () => 'timeline', GetStartFrame: async () => 0, GetStartTimecode: async () => '00:00:00:00', GetCurrentTimecode: async () => '00:00:00:00', GetEndFrame: async () => 10 }),
    GetMediaPool: async () => mediaPool,
    GetSetting: async () => '30',
  };
  const resolveObj = {
    GetProjectManager: async () => ({ GetCurrentProject: async () => project }),
    GetMediaStorage: async () => ({
      AddItemListToMediaPool: async (paths) => {
        importCalls += 1;
        // delay to simulate in-flight
        await new Promise(r => setTimeout(r, 20));
        return [{ GetClipProperty: async (p) => (p === 'File Path' ? paths[0] : '1') }];
      },
    }),
    OpenPage: async () => true,
  };
  const workflow = {
    Initialize: async () => true,
    GetResolve: async () => resolveObj,
  };
  const transfer = createTransfer(workflow, 'com.clipdock.test');
  return { transfer, getCalls: () => importCalls };
}

test('operationId dedupes in-flight and completed imports, queue stays serial', async () => {
  const { transfer, getCalls } = makeTransferWithCounter();
  const opId = 'op-123';
  const p1 = transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  const p2 = transfer.importToMediaPool('/tmp/a.mp4', 'active', opId); // same path and same opId should dedupe (cache key includes args)
  const p3 = transfer.importToMediaPool('/tmp/b.mp4', 'active'); // different opId, should not dedupe
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.kind, 'imported');
  assert.equal(r2.kind, 'imported');
  assert.equal(r1.message, r2.message);
  assert.equal(getCalls(), 2, 'second call with same operationId and same args must not trigger second import');
  // Completed dedupe: repeat after completed with same args
  const r4 = await transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  assert.equal(r4.kind, 'imported');
  assert.equal(getCalls(), 2, 'completed opId with same args must return cached result without new import');
  // Same opId with different filePath must NOT dedupe (new cache key)
  const r5 = await transfer.importToMediaPool('/tmp/c.mp4', 'active', opId);
  assert.equal(r5.kind, 'imported');
  assert.equal(getCalls(), 3, 'same opId with different filePath must execute fresh');
});

test('addToTimeline operationId dedupes', async () => {
  const { transfer, getCalls } = makeTransferWithCounter();
  const opId = 'op-tl-1';
  const p1 = transfer.addToTimeline('/tmp/a.mp4', 'active', 'end', undefined, opId);
  const p2 = transfer.addToTimeline('/tmp/a.mp4', 'active', 'end', undefined, opId);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.kind, 'timeline-appended');
  assert.equal(r2.kind, 'timeline-appended');
  assert.equal(getCalls(), 1, 'same opId same args must dedupe');
  // Different filePath with same opId must not dedupe
  const r3 = await transfer.addToTimeline('/tmp/b.mp4', 'active', 'end', undefined, opId);
  assert.equal(r3.kind, 'timeline-appended');
  assert.equal(getCalls(), 2, 'same opId different filePath must execute fresh');
});
