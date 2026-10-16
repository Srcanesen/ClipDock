import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function makeFixture(events, { barrierPath, failPath } = {}) {
  let entered = false;
  let enteredResolve;
  const enteredPromise = new Promise((r) => (enteredResolve = r));
  let release;
  const barrier = new Promise((r) => (release = r));
  let released = false;
  const releaseBarrier = () => { if (!released) { released = true; release(); } };

  const previous = { name: 'previous', GetName: async () => 'previous', GetClipList: async () => (events.push('GetClipList:previous'), []) };
  const clipDock = { name: 'ClipDock', GetName: async () => 'ClipDock', GetClipList: async () => (events.push('GetClipList:ClipDock'), []) };
  const root = { GetName: async () => 'Root', GetSubFolderList: async () => (events.push('GetSubFolderList'), [clipDock]), GetClipList: async () => [] };
  let current = previous;

  const mediaPool = {
    GetCurrentFolder: async () => (events.push('GetCurrentFolder'), current),
    GetRootFolder: async () => (events.push('GetRootFolder'), root),
    AddSubFolder: async (_r, n) => (events.push(`AddSubFolder:${n}`), clipDock),
    SetCurrentFolder: async (f) => (events.push(`SetCurrentFolder:${f.name}`), (current = f), true),
    AppendToTimeline: async () => (events.push('AppendToTimeline'), [{ GetStart: async () => 0 }]),
  };
  const project = {
    GetCurrentTimeline: async () => (events.push('GetCurrentTimeline'), { GetUniqueId: () => 'timeline', GetStartFrame: async () => 0, GetStartTimecode: async () => '00:00:00:00', GetCurrentTimecode: async () => '00:00:00:00', GetEndFrame: async () => 100 }),
    GetMediaPool: async () => (events.push('GetMediaPool'), mediaPool),
    GetSetting: async (k) => (events.push(`GetSetting:${k}`), '30'),
  };
  const resolveObj = {
    GetProjectManager: async () => (events.push('GetProjectManager'), { GetCurrentProject: async () => (events.push('GetCurrentProject'), project) }),
    GetMediaStorage: async () => (events.push('GetMediaStorage'), {
      AddItemListToMediaPool: async (paths) => {
        const p = paths[0];
        if (p === barrierPath && !entered) {
          entered = true;
          events.push('barrier-enter');
          enteredResolve();
          await barrier;
          events.push('barrier-released');
        }
        events.push(`AddItemListToMediaPool:${p}`);
        if (p === failPath) return [];
        return [{ GetClipProperty: async (prop) => (prop === 'File Path' ? p : prop === 'Frames' ? '48' : null) }];
      },
    }),
    OpenPage: async () => (events.push('OpenPage:edit'), true),
  };
  const workflow = {
    Initialize: async (id) => (events.push(`Initialize:${id}`), true),
    GetResolve: async () => (events.push('GetResolve'), resolveObj),
  };
  return { transfer: createTransfer(workflow, 'com.clipdock.test'), enteredPromise, releaseBarrier, get entered() { return entered; } };
}

test('shared FIFO: second ClipDock transaction must wait for first import + restore (RED when queue missing)', async () => {
  const events = [];
  const { transfer, enteredPromise, releaseBarrier } = makeFixture(events, { barrierPath: '/tmp/clipdock/clip1.mp4' });

  const p1 = transfer.importToMediaPool('/tmp/clipdock/clip1.mp4', 'clipdock');
  await enteredPromise;
  assert.ok(events.includes('SetCurrentFolder:ClipDock'));
  assert.ok(!events.includes('AddItemListToMediaPool:/tmp/clipdock/clip1.mp4'));

  const p2 = transfer.addToTimeline('/tmp/clipdock/clip2.mp4', 'clipdock', 'end');
  await new Promise((r) => setImmediate(r));
  const initCountBeforeRelease = events.filter((e) => e.startsWith('Initialize:')).length;
  let r1, r2;
  try {
    // captured count before release; barrier settle happens in finally
  } finally {
    releaseBarrier();
    const settled = await Promise.allSettled([p1, p2]);
    r1 = settled[0].status === 'fulfilled' ? settled[0].value : settled[0].reason;
    r2 = settled[1].status === 'fulfilled' ? settled[1].value : settled[1].reason;
  }
  assert.equal(initCountBeforeRelease, 1, `second Initialize must not run before release events=${events.join(' | ')}`);
  assert.equal(r1.ok, true); assert.equal(r1.kind, 'imported');
  assert.equal(r2.ok, true); assert.equal(r2.kind, 'timeline-appended');

  const firstImport = events.indexOf('AddItemListToMediaPool:/tmp/clipdock/clip1.mp4');
  const firstRestore = events.indexOf('SetCurrentFolder:previous');
  const secondInit = events.indexOf('Initialize:com.clipdock.test', events.indexOf('Initialize:com.clipdock.test') + 1);
  assert.ok(firstImport !== -1 && firstRestore !== -1 && secondInit !== -1);
  assert.ok(secondInit > firstImport, `second Initialize must be after first import events=${events.join(' | ')}`);
  assert.ok(secondInit > firstRestore, `second Initialize must be after first restore events=${events.join(' | ')}`);
  assert.ok(events.indexOf('GetCurrentTimeline') > firstRestore);
});

test('queued transfer continues after a controlled first-transfer error', async () => {
  const events = [];
  const { transfer } = makeFixture(events, { failPath: '/tmp/clipdock/fail.mp4' });

  const r1 = await transfer.importToMediaPool('/tmp/clipdock/fail.mp4', 'clipdock');
  assert.equal(r1.ok, false); assert.equal(r1.kind, 'import-failed');

  const r2 = await transfer.importToMediaPool('/tmp/clipdock/good.mp4', 'clipdock');
  assert.equal(r2.ok, true); assert.equal(r2.kind, 'imported');

  const r3 = await transfer.addToTimeline('/tmp/clipdock/good2.mp4', 'clipdock', 'end');
  assert.equal(r3.ok, true); assert.equal(r3.kind, 'timeline-appended');
});
