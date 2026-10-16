import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function makeTransfer() {
  let importCalls = 0;
  const calls = [];
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
        calls.push(paths[0]);
        await new Promise(r => setTimeout(r, 5));
        return [{ GetClipProperty: async (p) => (p === 'File Path' ? paths[0] : '1') }];
      },
    }),
    OpenPage: async () => true,
  };
  const workflow = { Initialize: async () => true, GetResolve: async () => resolveObj };
  const transfer = createTransfer(workflow, 'com.clipdock.test');
  return { transfer, getCalls: () => importCalls, getPaths: () => [...calls] };
}

test('same operationId with different filePath executes twice (import)', async () => {
  const { transfer, getCalls } = makeTransfer();
  const opId = 'op-same-id';
  const r1 = await transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  const r2 = await transfer.importToMediaPool('/tmp/b.mp4', 'active', opId);
  assert.equal(r1.kind, 'imported');
  assert.equal(r2.kind, 'imported');
  assert.equal(getCalls(), 2, 'same opId but different filePath must NOT dedupe');
});

test('same operationId with same args dedupes (import)', async () => {
  const { transfer, getCalls } = makeTransfer();
  const opId = 'op-dedupe';
  const p1 = transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  const p2 = transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.kind, 'imported');
  assert.equal(r2.kind, 'imported');
  assert.equal(getCalls(), 1, 'same opId same args must dedupe to single execution');
});

test('same operationId with different targetBin executes twice', async () => {
  const { transfer, getCalls } = makeTransfer();
  const opId = 'op-bin';
  await transfer.importToMediaPool('/tmp/a.mp4', 'active', opId);
  await transfer.importToMediaPool('/tmp/a.mp4', 'clipdock', opId);
  assert.equal(getCalls(), 2, 'different targetBin must not dedupe');
});

test('same operationId with different placement executes twice (addToTimeline)', async () => {
  const { transfer, getCalls } = makeTransfer();
  const opId = 'op-place';
  await transfer.addToTimeline('/tmp/a.mp4', 'active', 'end', undefined, opId);
  await transfer.addToTimeline('/tmp/a.mp4', 'active', 'playhead', undefined, opId);
  assert.equal(getCalls(), 2, 'different placement must not dedupe');
});

test('same operationId same placement dedupes (addToTimeline)', async () => {
  const { transfer, getCalls } = makeTransfer();
  const opId = 'op-place-same';
  const p1 = transfer.addToTimeline('/tmp/a.mp4', 'active', 'end', undefined, opId);
  const p2 = transfer.addToTimeline('/tmp/a.mp4', 'active', 'end', undefined, opId);
  await Promise.all([p1, p2]);
  assert.equal(getCalls(), 1, 'same placement must dedupe');
});
