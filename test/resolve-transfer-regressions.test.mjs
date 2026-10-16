import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function fixture(options = {}) {
  const calls = { imports: [], appends: [], markers: [], colors: [], pathReads: 0 };
  const state = { rate: '30', timecode: '00:00:00:00', startTimecode: '00:00:00:00', start: 108000, itemStart: 108300, ...options };
  const clip = (file) => ({
    GetClipProperty: async (key) => { if (key === 'File Path') { calls.pathReads++; return file; } return key === 'Frames' ? '48' : null; },
    SetClipColor: async (color) => { calls.colors.push(color); return true; },
  });
  let clips = (options.paths ?? []).map(clip);
  const folder = { GetClipList: async () => [...clips] };
  const timeline = {
    GetSetting: async key => key === 'useCustomSettings' ? '1' : state.rate,
    GetStartFrame: async () => state.start,
    GetStartTimecode: async () => state.startTimecode,
    GetCurrentTimecode: async () => state.timecode,
    GetEndFrame: async () => 108299,
    AddMarker: async (...args) => { calls.markers.push(args); return true; },
  };
  const mediaPool = {
    GetCurrentFolder: async () => folder,
    AppendToTimeline: async (args) => {
      calls.appends.push(args);
      if (state.barrier) { const barrier = state.barrier; state.barrier = null; await barrier; }
      return 'appendResult' in state ? state.appendResult : [{ GetStart: async () => state.itemStart }];
    },
  };
  const project = { GetMediaPool: async () => mediaPool, GetCurrentTimeline: async () => timeline, GetSetting: async () => state.rate };
  const resolve = {
    OpenPage: async () => true,
    GetProjectManager: async () => ({ GetCurrentProject: async () => state.project ?? project }),
    GetMediaStorage: async () => ({ AddItemListToMediaPool: async ([file]) => { calls.imports.push(file); const item = clip(file); clips.push(item); return [item]; } }),
  };
  const transfer = createTransfer({ Initialize: async () => true, GetResolve: async () => resolve }, 'test', { platform: state.platform ?? 'linux', takePristine: file => state.fresh?.delete(file) ? () => true : null });
  return { transfer, calls, state, timeline, project, mediaPool, folder, replaceClips: (paths) => { clips = paths.map(clip); } };
}

const automation = { provider: 'youtube', source: 'source', selection: null, chapters: [{ start: 2, end: 3, title: 'Chapter' }] };

for (const placement of ['end', 'playhead']) {
  test(`ENG-5: ${placement} rejects false and malformed append results and permits retry`, async () => {
    for (const appendResult of [false, true, {}, 'ok', 1, [], Array(1), [null], [false], [{}], [{ GetStart: 3 }], [{ GetStart() {} }, null]]) {
      const h = fixture({ appendResult });
      const result = await h.transfer.addToTimeline('/clip.mp4', 'active', placement, automation, 'retry');
      assert.deepEqual([result.ok, result.kind, h.calls.colors, h.calls.markers], [false, 'append-failed', [], []]);
      assert.match(result.message, /Resolve returned no usable appended clips/);
      delete h.state.appendResult;
      assert.equal((await h.transfer.addToTimeline('/clip.mp4', 'active', placement, automation, 'retry')).ok, true);
      assert.equal(h.calls.appends.length, 2);
    }
  });
}

// Literal nominal/DF counts at one minute, ten minutes and one hour.
for (const [rate, minute, expected] of [
  ['23.976', '00:01:00:00', [1440, 14400, 86400]],
  ['24', '00:01:00:00', [1440, 14400, 86400]],
  ['25', '00:01:00:00', [1500, 15000, 90000]],
  ['29.97', '00:01:00:00', [1800, 18000, 108000]],
  ['29.97 DF', '00:01:00;02', [1800, 17982, 107892]],
  ['30', '00:01:00:00', [1800, 18000, 108000]],
  ['50', '00:01:00:00', [3000, 30000, 180000]],
  ['59.94', '00:01:00:00', [3600, 36000, 216000]],
  ['59.94 DF', '00:01:00;04', [3600, 35964, 215784]],
  ['60', '00:01:00:00', [3600, 36000, 216000]],
]) {
  test(`ENG-3: ${rate} insertion uses literal minute, ten-minute and hour frame counts`, async () => {
    const df = rate.endsWith('DF');
    const h = fixture({ rate, start: 0, startTimecode: df ? '00:00:00;00' : '00:00:00:00' });
    for (const [index, timecode] of [minute, df ? '00:10:00;00' : '00:10:00:00', df ? '01:00:00;00' : '01:00:00:00'].entries()) {
      h.state.timecode = timecode;
      assert.equal((await h.transfer.addToTimeline('/clip.mp4', 'active', 'playhead')).kind, 'timeline-inserted');
      assert.equal(h.calls.appends[index][0].recordFrame, expected[index]);
      assert.deepEqual([h.calls.appends[index][0].startFrame, h.calls.appends[index][0].endFrame], [0, 47]);
    }
  });
}

test('ENG-3: insertion computes a DF delta from a nonzero timeline timecode', async () => {
  const h = fixture({ rate: '29.97', startTimecode: '01:00:00;00', timecode: '01:10:00;00' });
  assert.equal((await h.transfer.addToTimeline('/clip.mp4', 'active', 'playhead')).ok, true);
  assert.equal(h.calls.appends[0][0].recordFrame, 125982);
});

for (const placement of ['end', 'playhead']) {
  test(`ENG-4: ${placement} markers use the returned item start relative to the timeline`, async () => {
    const h = fixture({ timecode: '00:00:10:00', itemStart: 108450, rate: '29.97 DF' });
    const selected = { ...automation, selection: { start: 10, end: 20, label: 'section' }, chapters: [{ start: 9, title: 'Before' }, { start: 12, title: 'Inside' }, { start: 20, title: 'After' }] };
    assert.equal((await h.transfer.addToTimeline('/clip.mp4', 'active', placement, selected)).ok, true);
    assert.deepEqual(h.calls.markers, [[510, 'Yellow', 'Inside', 'source · original 12.000s', 1]]);
    if (placement === 'playhead') assert.equal(h.calls.appends[0][0].recordFrame, 108300);
  });
}

test('ENG-13: cache pressure preserves every pending operation identity', async () => {
  let release;
  const h = fixture({ barrier: new Promise(resolve => { release = resolve; }) });
  const first = h.transfer.addToTimeline('/first.mp4', 'active', 'end', undefined, 'first');
  const queued = Array.from({ length: 128 }, (_, i) => h.transfer.addToTimeline(`/clip-${i}.mp4`, 'active', 'end', undefined, `op-${i}`));
  const retry = h.transfer.addToTimeline('/first.mp4', 'active', 'end', undefined, 'first');
  release();
  const results = await Promise.all([first, ...queued, retry]);
  assert.equal(retry, first);
  assert.equal(results.filter(result => result.kind === 'timeline-appended').length, 130);
  assert.equal(h.calls.appends.length, 129);
});

test('ENG-14: macOS case alone does not identify the same source file', async () => {
  const h = fixture({ platform: 'darwin', paths: ['/media/clip.mp4'] });
  assert.equal((await h.transfer.addToTimeline('/media/CLIP.mp4', 'active', 'end')).kind, 'timeline-appended');
  assert.deepEqual(h.calls.imports, ['/media/CLIP.mp4']);
  assert.equal(await h.calls.appends[0][0].GetClipProperty('File Path'), '/media/CLIP.mp4');
});

test('ENG-14: macOS aliases of the same filesystem identity reuse the source', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-resolve-identity-'));
  try {
    const original = path.join(root, 'clip.mp4');
    const alias = path.join(root, 'alias.mp4');
    writeFileSync(original, 'media');
    symlinkSync(original, alias);
    const h = fixture({ platform: 'darwin', paths: [original] });
    assert.equal((await h.transfer.importToMediaPool(alias, 'active')).kind, 'already-imported');
    assert.deepEqual(h.calls.imports, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ENG-21: queued fresh imports skip scans and observe external membership changes', async () => {
  const h = fixture({ paths: Array.from({ length: 250 }, (_, i) => `/old-${i}.mp4`), fresh: new Set(['/a.mp4', '/b.mp4', '/c.mp4']) });
  const results = await Promise.all(['/a.mp4', '/b.mp4', '/c.mp4', '/a.mp4'].map(file => h.transfer.importToMediaPool(file, 'active')));
  assert.deepEqual(results.map(result => result.kind), ['imported', 'imported', 'imported', 'already-imported']);
  assert.deepEqual(h.calls.imports, ['/a.mp4', '/b.mp4', '/c.mp4']);
  assert.equal(h.calls.pathReads, 1, 'only the remembered duplicate is read');
  h.replaceClips(['/external.mp4']);
  const external = await h.transfer.importToMediaPool('/external.mp4', 'active');
  assert.equal(external.kind, 'already-imported');
  assert.equal((await h.transfer.importToMediaPool('/a.mp4', 'active')).kind, 'imported');
});

test('ENG-21: membership is rechecked during a batch, including additions and removals', async () => {
  const h = fixture({ paths: ['/old.mp4'] });
  let visits = 0;
  h.mediaPool.GetCurrentFolder = async () => {
    if (++visits === 1) h.replaceClips(['/external.mp4']);
    return h.folder;
  };
  const first = await h.transfer.importToMediaPool('/new.mp4', 'active');
  h.replaceClips(['/external.mp4']);
  const results = [first, ...await Promise.all(['/external.mp4', '/new.mp4'].map(file => h.transfer.importToMediaPool(file, 'active')))];
  assert.deepEqual(results.map(result => result.kind), ['imported', 'already-imported', 'imported']);
  assert.deepEqual(h.calls.imports, ['/new.mp4', '/new.mp4']);
});

test('ENG-21: project and folder changes refresh cached paths within a queued batch', async () => {
  for (const change of ['project', 'folder']) {
    const h = fixture({ paths: ['/old.mp4'] });
    const other = { GetClipList: h.folder.GetClipList };
    let activeFolder = h.folder;
    h.mediaPool.GetCurrentFolder = async () => activeFolder;
    const results = [await h.transfer.importToMediaPool('/new.mp4', 'active')];
    if (change === 'project') h.state.project = { ...h.project };
    else activeFolder = other;
    results.push(await h.transfer.importToMediaPool('/another.mp4', 'active'));
    results.push(await h.transfer.importToMediaPool('/third.mp4', 'active'));
    assert.deepEqual(results.map(result => result.kind), ['imported', 'imported', 'imported']);
    assert.ok(h.calls.pathReads >= 3, `${change} must refresh existing paths`);
  }
});

test('ENG-21: cached duplicate hits are revalidated after a Resolve relink', async () => {
  const h = fixture();
  let filePath = '/old.mp4';
  const relinked = { GetClipProperty: async () => filePath };
  h.folder.GetClipList = async () => [relinked];
  const first = await h.transfer.importToMediaPool('/other.mp4', 'active');
  filePath = '/relinked.mp4';
  const results = [first, await h.transfer.importToMediaPool('/old.mp4', 'active')];
  assert.deepEqual(results.map(result => result.kind), ['imported', 'imported']);
  assert.deepEqual(h.calls.imports, ['/other.mp4', '/old.mp4']);
});

test('ENG-4: unreadable or invalid returned item starts warn without placing guessed markers', async () => {
  for (const getStart of [async () => null, async () => false, async () => '', async () => { throw new Error('API timeout'); }]) {
    const h = fixture({ appendResult: [{ GetStart: getStart }] });
    const result = await h.transfer.addToTimeline('/clip.mp4', 'active', 'end', automation);
    assert.equal(result.kind, 'timeline-appended');
    assert.match(result.message, /markers unavailable/);
    assert.deepEqual(h.calls.markers, []);
  }
});
