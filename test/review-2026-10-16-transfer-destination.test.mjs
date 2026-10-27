import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function host({ changeAt, change = 'project', wrappers = false, duplicate = false } = {}) {
  const calls = { imports: [], appends: [], markers: [], colors: [], folders: [] };
  const state = { project: 'A', timeline: 'A', folder: 'A' };
  const trigger = point => { if (point === changeAt) state[change] = 'B'; };
  const clip = {
    GetClipProperty(key) { trigger(key === 'Frames' ? 'frames' : 'path'); return key === 'Frames' ? '30' : '/clip.mp4'; },
    SetClipColor(color) { calls.colors.push(color); trigger('color'); return true; },
  };
  const folder = id => ({ GetUniqueId: () => `folder-${id}`, GetClipList() { trigger('scan'); return duplicate ? [clip] : []; } });
  const folders = { A: folder('A'), B: folder('B') };
  const timeline = id => ({
    GetUniqueId: () => `timeline-${id}`, GetStartFrame: () => 0,
    GetStartTimecode: () => '00:00:00:00', GetCurrentTimecode() { trigger('timecode'); return '00:00:10:00'; },
    GetSetting: key => key === 'useCustomSettings' ? '1' : '30',
    AddMarker(...args) { calls.markers.push({ timeline: id, args }); trigger('marker'); return true; },
  });
  const timelines = { A: timeline('A'), B: timeline('B') };
  const pool = {
    GetCurrentFolder: () => wrappers ? folder(state.folder) : folders[state.folder],
    GetRootFolder: () => ({ GetSubFolderList: () => [] }),
    AddSubFolder() { calls.folders.push('create'); return folders.A; },
    SetCurrentFolder() { calls.folders.push('set'); return true; },
    AppendToTimeline(args) {
      calls.appends.push({ project: state.project, timeline: state.timeline, args });
      trigger('append');
      return [{ GetStart() { trigger('item-start'); return 0; } }];
    },
  };
  const project = id => ({
    GetUniqueId: () => `project-${id}`, GetMediaPool() { trigger('pool'); return pool; },
    GetCurrentTimeline: () => wrappers ? timeline(state.timeline) : timelines[state.timeline], GetSetting: () => '30',
  });
  const projects = { A: project('A'), B: project('B') };
  const resolve = {
    GetProjectManager: () => ({ GetCurrentProject: () => wrappers ? project(state.project) : projects[state.project] }),
    OpenPage() { trigger('page'); return true; },
    GetMediaStorage() {
      trigger('storage');
      return { AddItemListToMediaPool() { calls.imports.push(state.project); trigger('import'); return [clip]; } };
    },
  };
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'review', 'linux');
  return { transfer, calls };
}

const automation = { provider: 'youtube', source: 'source', selection: null, chapters: [{ start: 1, end: 2, title: 'One' }, { start: 2, end: 3, title: 'Two' }] };

for (const [action, changeAt, change] of [
  ['import', 'storage', 'project'], ['import', 'scan', 'folder'], ['import', 'pool', 'project'],
  ['end', 'import', 'timeline'], ['end', 'import', 'project'], ['end', 'scan', 'folder'],
  ['playhead', 'timecode', 'timeline'], ['playhead', 'page', 'project'], ['playhead', 'frames', 'folder'],
]) test(`destination: ${action} aborts ${change} change during ${changeAt}`, async () => {
  const { transfer, calls } = host({ changeAt, change });
  const result = action === 'import' ? await transfer.importToMediaPool('/clip.mp4', 'active') : await transfer.addToTimeline('/clip.mp4', 'active', action, automation);
  assert.deepEqual([result.ok, result.kind], [false, 'destination-changed']);
  assert.match(result.message, /destination changed.*retry/i);
  assert.deepEqual(calls.appends, []);
  assert.deepEqual(calls.markers, []);
  assert.deepEqual(calls.imports, changeAt === 'import' || ['timecode', 'page', 'frames'].includes(changeAt) ? ['A'] : []);
});

for (const placement of ['end', 'playhead']) {
  for (const changeAt of ['append', 'item-start', 'color', 'marker']) test(`destination: ${placement} stops automation after timeline change during ${changeAt}`, async () => {
    const { transfer, calls } = host({ changeAt, change: 'timeline' });
    const result = await transfer.addToTimeline('/clip.mp4', 'active', placement, automation);
    assert.deepEqual([result.ok, result.kind], [true, placement === 'end' ? 'timeline-appended' : 'timeline-inserted']);
    assert.match(result.message, /destination changed.*updates may be incomplete/i);
    assert.doesNotMatch(result.message, /retry/i);
    assert.equal(calls.appends.length, 1);
    assert.equal(calls.colors.length, ['color', 'marker'].includes(changeAt) ? 1 : 0);
    assert.equal(calls.markers.length, changeAt === 'marker' ? 1 : 0);
  });
}

test('destination: duplicate reuse does not report success after a project change', async () => {
  const { transfer, calls } = host({ changeAt: 'path', duplicate: true });
  const result = await transfer.importToMediaPool('/clip.mp4', 'active');
  assert.deepEqual([result.ok, result.kind, calls.imports], [false, 'destination-changed', []]);
});

test('destination: stable unique IDs accept refreshed bridge wrappers', async () => {
  const { transfer, calls } = host({ wrappers: true });
  assert.equal((await transfer.addToTimeline('/clip.mp4', 'active', 'playhead', automation)).kind, 'timeline-inserted');
  assert.equal(calls.appends[0].args[0].recordFrame, 300);
  assert.deepEqual(calls.markers.map(marker => marker.args[0]), [30, 60]);
});

for (const changeAt of ['lookup', 'import', null]) test(`destination: ClipDock folder mutations respect changes during ${changeAt ?? 'no change'}`, async () => {
  const previous = { GetUniqueId: () => 'previous' };
  const selected = { GetUniqueId: () => 'user-selected' };
  const target = { GetUniqueId: () => 'clipdock', GetClipList: () => [] };
  let current = previous;
  const calls = { imports: 0, creates: 0, sets: [] };
  const pool = {
    GetCurrentFolder: () => current,
    GetRootFolder: () => ({ GetSubFolderList() { if (changeAt === 'lookup') current = selected; return []; } }),
    AddSubFolder() { calls.creates++; return target; },
    SetCurrentFolder(folder) { current = folder; calls.sets.push(folder); return true; },
  };
  const project = { GetMediaPool: () => pool };
  const resolve = {
    GetProjectManager: () => ({ GetCurrentProject: () => project }),
    GetMediaStorage: () => ({ AddItemListToMediaPool() { calls.imports++; if (changeAt === 'import') current = selected; return [{}]; } }),
  };
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'review', 'linux');
  const result = await transfer.importToMediaPool('/clip.mp4', 'clipdock');
  assert.deepEqual([result.ok, result.kind], changeAt === 'lookup' ? [false, 'destination-changed'] : [true, 'imported']);
  if (changeAt === 'import') {
    assert.match(result.message, /destination changed after the import/i);
    assert.doesNotMatch(result.message, /retry/i);
  }
  assert.equal(current, changeAt ? selected : previous);
  assert.deepEqual(calls, changeAt === 'lookup' ? { imports: 0, creates: 0, sets: [] } : { imports: 1, creates: 1, sets: changeAt ? [target] : [target, previous] });
});

test('destination: a project is required before the global import handoff', async () => {
  let imports = 0;
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => ({
    GetProjectManager: () => ({ GetCurrentProject: () => null }),
    GetMediaStorage: () => ({ AddItemListToMediaPool() { imports++; return [{}]; } }),
  }) }, 'review');
  assert.deepEqual([(await transfer.importToMediaPool('/clip.mp4', 'active')).kind, imports], ['no-project', 0]);
});
