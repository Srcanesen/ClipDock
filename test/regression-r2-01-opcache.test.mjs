import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function makeTransferWithCounter({ failIds = new Set() } = {}) {
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
  const workflow = {
    Initialize: async () => true,
    GetResolve: async () => ({
      GetProjectManager: async () => ({ GetCurrentProject: async () => project }),
      GetMediaStorage: async () => ({
        AddItemListToMediaPool: async (paths) => {
          importCalls += 1;
          const file = paths[0];
          // fail based on opId path containing marker
          if ([...failIds].some(id => file.includes(id))) return [];
          return [{ GetClipProperty: async (p) => (p === 'File Path' ? file : '1') }];
        },
      }),
      OpenPage: async () => true,
    }),
  };
  const transfer = createTransfer(workflow, 'com.clipdock.test');
  return { transfer, getCalls: () => importCalls };
}

test('operationCache bounded to ~128 (oldest evicted, not unbounded)', async () => {
  const { transfer, getCalls } = makeTransferWithCounter();
  const total = 135;
  // 135 unique opIds, each import succeeds
  for (let i = 0; i < total; i++) {
    const r = await transfer.importToMediaPool(`/tmp/file-${i}.mp4`, 'active', `op-${i}`);
    assert.equal(r.kind, 'imported');
  }
  assert.equal(getCalls(), total);
  // Re-invoke the oldest opId with same args should be a miss after eviction (FIFO 128): must re-execute
  // After 135 inserts, oldest 7 should be evicted if bounded at 128.
  const callsBefore = getCalls();
  const retryOldest = await transfer.importToMediaPool('/tmp/file-0.mp4', 'active', 'op-0');
  assert.equal(retryOldest.kind, 'imported');
  assert.equal(getCalls(), callsBefore + 1, 'oldest opId must have been evicted (bounded cache) and re-executed, not deduped');

  // Most recent should still be cached: same args dedupe, no extra import
  const callsBefore2 = getCalls();
  const retryRecent = await transfer.importToMediaPool(`/tmp/file-${total-1}.mp4`, 'active', `op-${total-1}`);
  assert.equal(retryRecent.kind, 'imported');
  assert.equal(getCalls(), callsBefore2, 'most recent opId must still be cached');
});

test('operationCache does not cache rejected promises: retry re-executes', async () => {
  let importCalls = 0;
  let shouldFail = true;
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
  const workflow = {
    Initialize: async () => true,
    GetResolve: async () => ({
      GetProjectManager: async () => ({ GetCurrentProject: async () => project }),
      GetMediaStorage: async () => ({
        AddItemListToMediaPool: async (paths) => {
          importCalls += 1;
          if (shouldFail) return []; // import-failed => still fulfilled transfer result, need true rejection
          return [{ GetClipProperty: async (p) => (p === 'File Path' ? paths[0] : '1') }];
        },
      }),
      OpenPage: async () => true,
    }),
  };
  // Force a true promise rejection via GetResolve throwing on first call
  let firstCall = true;
  const failingWorkflow = {
    Initialize: async () => true,
    GetResolve: async () => {
      if (firstCall) { firstCall = false; throw new Error('bridge down'); }
      return workflow.GetResolve();
    },
  };
  const transfer = createTransfer(failingWorkflow, 'com.clipdock.test');
  const r1 = await transfer.importToMediaPool('/tmp/retry.mp4', 'active', 'op-retry');
  assert.equal(r1.ok, false, 'first attempt should fail (rejected transaction)');
  // Allow cache eviction microtask to run before retry
  await new Promise((r) => setTimeout(r, 0));
  // Now second attempt with same opId should re-execute and succeed (not cached rejection)
  // reset underlying to succeed
  importCalls = 0;
  shouldFail = false;
  const r2 = await transfer.importToMediaPool('/tmp/retry.mp4', 'active', 'op-retry');
  assert.equal(r2.ok, true, 'retry with same opId after rejection must re-execute and succeed, not return cached rejection');
});
