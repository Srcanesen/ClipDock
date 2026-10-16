import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';
import { DownloadQueue } from '../dist/renderer-state/queue-model.js';

const automation = { provider: 'youtube', source: 'source', selection: null, chapters: [{ start: 1, end: 2, title: 'One' }, { start: 2, end: 3, title: 'Two' }] };

function fixture({ change = 'timeline', changeAt = 'append', duplicate = true, revokePath = false } = {}) {
  const calls = { imports: [], appends: [], colors: [], markers: [] };
  const state = { project: 'A', timeline: 'A', folder: 'A', trusted: true };
  let changed = false;
  function trigger(point) {
    if (!changed && point === changeAt) {
      changed = true;
      if (revokePath) state.trusted = false;
      else state[change] = 'B';
    }
  }
  const clip = {
    GetClipProperty: key => key === 'Frames' ? '30' : '/clip.mp4',
    SetClipColor(color) { calls.colors.push(color); trigger('color'); return true; },
  };
  const folders = Object.fromEntries(['A', 'B'].map(id => [id, {
    GetUniqueId: () => `folder-${id}`, GetClipList: () => duplicate ? [clip] : [],
  }]));
  const timelines = Object.fromEntries(['A', 'B'].map(id => [id, {
    GetUniqueId: () => `timeline-${id}`, GetStartFrame: () => 0,
    GetStartTimecode: () => '00:00:00:00', GetCurrentTimecode: () => '00:00:10:00',
    GetSetting: key => key === 'useCustomSettings' ? '1' : '30',
    AddMarker(...args) { calls.markers.push({ timeline: id, args }); trigger('marker'); return true; },
  }]));
  const pool = {
    GetCurrentFolder: () => folders[state.folder],
    AppendToTimeline() {
      calls.appends.push({ project: state.project, timeline: state.timeline });
      trigger('append');
      return [{ GetStart() { trigger('item-start'); return 0; } }];
    },
  };
  const projects = Object.fromEntries(['A', 'B'].map(id => [id, {
    GetUniqueId: () => `project-${id}`, GetCurrentTimeline: () => timelines[state.timeline], GetMediaPool: () => pool,
  }]));
  const resolve = {
    GetProjectManager: () => ({ GetCurrentProject: () => projects[state.project] }), OpenPage: () => true,
    GetMediaStorage: () => ({ AddItemListToMediaPool() { calls.imports.push(state.project); trigger('import'); return [clip]; } }),
  };
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'gate', {
    platform: 'linux', validatePath: file => state.trusted ? file : null,
  });
  const restore = () => Object.assign(state, { project: 'A', timeline: 'A', folder: 'A', trusted: true });
  return { transfer, calls, state, restore };
}

for (const placement of ['end', 'playhead']) {
  for (const change of ['project', 'timeline', 'folder']) {
    for (const changeAt of ['append', 'item-start', 'color', 'marker', 'append-without-automation']) {
      test(`committed ${placement}: ${change} change during ${changeAt} warns and preserves retry identity`, async () => {
        const h = fixture({ change, changeAt: changeAt === 'append-without-automation' ? 'append' : changeAt });
        const args = ['/clip.mp4', 'active', placement, changeAt === 'append-without-automation' ? undefined : automation, 'committed'];
        const result = await h.transfer.addToTimeline(...args);
        assert.deepEqual([result.ok, result.kind], [true, placement === 'end' ? 'timeline-appended' : 'timeline-inserted']);
        assert.match(result.message, /destination changed/i);
        assert.doesNotMatch(result.message, /retry/i);
        assert.deepEqual(h.calls.appends, [{ project: 'A', timeline: 'A' }]);
        assert.equal(h.calls.colors.length, ['color', 'marker'].includes(changeAt) ? 1 : 0);
        assert.equal(h.calls.markers.length, changeAt === 'marker' ? 1 : 0);
        h.restore();
        assert.deepEqual(await h.transfer.addToTimeline(...args), result);
        assert.equal(h.calls.appends.length, 1, 'same operation must retain the completed append');
      });
    }
  }
}

for (const change of ['project', 'folder', 'trusted-path']) test(`committed import: ${change} change preserves success and retry identity`, async () => {
  const h = fixture({ change, changeAt: 'import', duplicate: false, revokePath: change === 'trusted-path' });
  const args = ['/clip.mp4', 'active', 'committed-import'];
  const result = await h.transfer.importToMediaPool(...args);
  assert.deepEqual([result.ok, result.kind, result.importedCount, h.calls.imports], [true, 'imported', 1, ['A']]);
  assert.doesNotMatch(result.message, /retry/i);
  h.restore();
  assert.deepEqual(await h.transfer.importToMediaPool(...args), result);
  assert.deepEqual(h.calls.imports, ['A']);
});

test('pending append: destination change after import still aborts the uncommitted append', async () => {
  const h = fixture({ changeAt: 'import', duplicate: false });
  const args = ['/clip.mp4', 'active', 'end', undefined, 'pending-append'];
  const result = await h.transfer.addToTimeline(...args);
  assert.deepEqual([result.ok, result.kind, h.calls.appends], [false, 'destination-changed', []]);
  assert.deepEqual(h.calls.imports, ['A']);
  h.restore();
  assert.equal((await h.transfer.addToTimeline(...args)).kind, 'timeline-appended');
  assert.deepEqual(h.calls.appends, [{ project: 'A', timeline: 'A' }]);
});

for (const placement of ['end', 'playhead']) {
  for (const withAutomation of [false, true]) test(`download queue: committed ${placement} with automation=${withAutomation} never offers a failed-handoff retry`, async () => {
    const h = fixture();
    let id = 0;
    const queue = new DownloadQueue({
      newId: () => `id-${++id}`, download: async () => ({ cardId: 'clip', fileName: 'clip.mp4' }),
      transfer: (_card, bin, action) => h.transfer.addToTimeline('/clip.mp4', bin, action, withAutomation ? automation : undefined),
      cancel: async () => true, deleteFile: async () => ({ deleted: false, message: 'unused' }),
    });
    const settled = new Promise(resolve => queue.subscribe(change => { if (change.settled) resolve(); }));
    queue.add({
      provider: 'youtube', source: 'https://www.youtube.com/watch?v=fake', thumbnailDataUrl: null,
      metadata: { id: 'fake', title: 'Clip', duration: 60, channel: 'Creator', thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: [] },
      output: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'm4a', intent: placement, targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null },
    });
    await settled;
    const item = queue.items[0];
    assert.equal(item.status, 'completed');
    assert.match(item.message, /destination changed/i);
    h.restore();
    // Exercise the same failed-handoff retry decision as the review reproduction.
    if (item.transferError) await queue.transfer(item.queueId, placement);
    assert.deepEqual(h.calls.appends, [{ project: 'A', timeline: 'A' }]);
    assert.equal(item.transferError, undefined);
    assert.doesNotMatch(item.message, /retry/i);
  });
}
