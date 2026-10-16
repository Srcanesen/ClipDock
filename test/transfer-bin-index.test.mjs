import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';
import { createMainTransferHandlers, SessionTransferCards } from '../dist/main-process.js';

function fixture() {
  const cards = new SessionTransferCards();
  const calls = { paths: [], lists: 0, imports: [], appends: [] };
  const item = file => ({ file, GetClipProperty: async function () { calls.paths.push(this.file); return this.file; } });
  const state = { clips: Array.from({ length: 200 }, (_, i) => item(`/old-${i}.mp4`)), connected: true };
  const folder = { GetClipList: async () => { calls.lists++; return [...state.clips]; } };
  const pool = { GetCurrentFolder: async () => state.folder ?? folder, AppendToTimeline: async clips => { calls.appends.push(clips); return [{ GetStart: () => 0 }]; } };
  const timeline = {};
  const project = { GetMediaPool: () => pool, GetCurrentTimeline: () => timeline };
  const resolve = {
    GetProjectManager: () => ({ GetCurrentProject: () => state.project ?? project }),
    GetMediaStorage: async () => {
      await state.beforeStorage?.();
      return { AddItemListToMediaPool: ([file]) => { calls.imports.push(file); const clip = item(file); state.clips.push(clip); return [clip]; } };
    },
  };
  const transfer = createTransfer({ Initialize: () => state.connected, GetResolve: () => resolve }, 'test', {
    platform: 'linux', takePristine: file => cards.takePristine(file),
  });
  const handlers = createMainTransferHandlers({ requireSender() {}, resolveCard: id => ({ path: id }), transfer, noteNativeDrag: file => cards.noteExposed(file) });
  const fresh = file => { cards.registerDownloadedFile(file); return file; };
  return { calls, state, transfer, handlers, fresh, cards, item, folder, project };
}

for (const action of ['import', 'end']) test(`fresh card ${action}: populated bin has no per-clip reads`, async () => {
  const h = fixture();
  const file = h.fresh('/new.mp4');
  const result = action === 'import' ? await h.handlers.importToMediaPool({}, file, 'active') : await h.handlers.addToTimeline({}, file, 'active', 'end');
  assert.equal(result.kind, action === 'import' ? 'imported' : 'timeline-appended');
  assert.deepEqual(h.calls.paths, []);
  assert.equal(h.calls.lists, 0);
  assert.deepEqual(h.calls.imports, [file]);
  h.calls.paths.length = 0;
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'already-imported');
  assert.deepEqual(h.calls.paths, [file]);
  assert.equal(h.calls.lists, 1);
  assert.deepEqual(h.calls.imports, [file]);
});

test('drag exposure, including another card for the same path, requires a full scan', async () => {
  const h = fixture();
  const file = h.fresh('/new.mp4');
  h.handlers.nativeDragStart({}, file, () => { h.state.clips.push(h.item(file)); });
  h.cards.registerDownloadedFile(file); // Cannot restore pristine state by registering again.
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'already-imported');
  assert.equal(h.calls.paths.length, 201);
  assert.deepEqual(h.calls.imports, []);
});

test('drag while a transfer awaits the host revokes its fresh-file proof', async () => {
  const h = fixture();
  const file = h.fresh('/new.mp4');
  h.state.beforeStorage = () => h.handlers.nativeDragStart({}, file, () => { h.state.clips.push(h.item(file)); });
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'already-imported');
  assert.equal(h.calls.paths.length, 201);
  assert.deepEqual(h.calls.imports, []);
});

for (const change of ['removed', 'relinked', 'project', 'folder', 'quit', 'bridge-failure']) test(`stale remembered item (${change}) falls back to a scan and reuses external duplicate`, async () => {
  const h = fixture();
  const file = h.fresh('/new.mp4');
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'imported');
  const remembered = h.state.clips.at(-1);
  if (change === 'removed') h.state.clips.pop();
  if (change === 'relinked') remembered.file = '/relinked.mp4';
  if (change === 'project') h.state.project = { ...h.project };
  if (change === 'folder') h.state.folder = { ...h.folder };
  if (change === 'quit') h.transfer.noteResolveQuit();
  if (change === 'bridge-failure') {
    h.state.connected = false;
    assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'bridge-error');
    h.state.connected = true;
  }
  const external = h.item(file);
  h.state.clips.push(external);
  h.calls.paths.length = 0;
  assert.equal((await h.transfer.addToTimeline(file, 'active', 'end')).kind, 'timeline-appended');
  assert.ok(h.calls.paths.includes('/old-0.mp4'));
  assert.deepEqual(h.calls.imports, [file]);
  assert.equal(h.calls.appends[0][0], external);
});

test('unknown files scan current paths even when an indexed item was externally relinked', async () => {
  const h = fixture();
  assert.equal((await h.transfer.importToMediaPool('/old-0.mp4', 'active')).kind, 'already-imported');
  h.state.clips[0].file = '/external.mp4';
  assert.equal((await h.transfer.importToMediaPool('/external.mp4', 'active')).kind, 'already-imported');
  assert.deepEqual(h.calls.imports, []);
});

test('an idle repeated transfer of a non-pristine card validates only the remembered item', async () => {
  const h = fixture();
  assert.equal((await h.transfer.importToMediaPool('/existing-card.mp4', 'active')).kind, 'imported');
  const remembered = h.state.clips.at(-1);
  h.calls.paths.length = 0;
  const listsBefore = h.calls.lists;
  assert.equal((await h.transfer.addToTimeline('/existing-card.mp4', 'active', 'end')).kind, 'timeline-appended');
  assert.deepEqual(h.calls.paths, ['/existing-card.mp4']);
  assert.equal(h.calls.lists, listsBefore + 1);
  assert.equal(h.calls.appends[0][0], remembered);
  assert.deepEqual(h.calls.imports, ['/existing-card.mp4']);
});

test('unknown/history files receive no proof and a failed transfer consumes a downloaded file proof', async () => {
  const h = fixture();
  assert.equal(h.cards.takePristine('/history.mp4'), null);
  const file = h.fresh('/new.mp4');
  h.state.connected = false;
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'bridge-error');
  h.state.connected = true;
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'imported');
  assert.equal(h.calls.paths.length, 200);
});

test('transfer before provider publication prevents a later fresh-file grant', async () => {
  const h = fixture();
  const file = '/not-yet-published.mp4';
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'imported');
  h.cards.registerDownloadedFile(file);
  assert.equal(h.cards.takePristine(file), null);
  assert.equal((await h.transfer.importToMediaPool(file, 'active')).kind, 'already-imported');
  assert.deepEqual(h.calls.imports, [file]);
});
