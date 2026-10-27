import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

// Counts every Resolve scripting call a chaptered timeline transfer makes.
function host({ switchAtMarker = null } = {}) {
  const calls = { total: 0, markers: [] };
  const state = { project: 'A' };
  const hit = (fn) => (...args) => { calls.total++; return fn(...args); };
  const folder = { GetUniqueId: hit(() => 'folder'), GetClipList: hit(() => []) };
  const clip = { GetClipProperty: hit(() => '/clip.mp4'), SetClipColor: hit(() => true) };
  const timeline = {
    GetUniqueId: hit(() => 'timeline'), GetStartFrame: hit(() => 0), GetSetting: hit(() => '30'),
    AddMarker: hit((...args) => { calls.markers.push(args[0]); if (calls.markers.length === switchAtMarker) state.project = 'B'; return true; }),
  };
  const pool = {
    GetCurrentFolder: hit(() => folder),
    AppendToTimeline: hit(() => [{ GetStart: hit(() => 0) }]),
  };
  const project = id => ({ GetUniqueId: hit(() => `project-${id}`), GetMediaPool: hit(() => pool), GetCurrentTimeline: hit(() => timeline) });
  const projects = { A: project('A'), B: project('B') };
  const resolve = {
    GetProjectManager: hit(() => ({ GetCurrentProject: hit(() => projects[state.project]) })),
    GetMediaStorage: hit(() => ({ AddItemListToMediaPool: hit(() => [clip]) })),
  };
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'markers', 'linux');
  return { transfer, calls };
}

const chapters = Array.from({ length: 40 }, (_, index) => ({ start: index, end: index + 1, title: `Chapter ${index + 1}` }));
const automation = { provider: 'youtube', source: 'source', selection: null, chapters };

test('markers: a 40-chapter append checks the destination once before and once after the marker batch', async () => {
  const { transfer, calls } = host();
  const result = await transfer.addToTimeline('/clip.mp4', 'active', 'end', automation);
  assert.deepEqual([result.ok, result.kind, result.message], [true, 'timeline-appended', 'Added to the active timeline.']);
  assert.equal(calls.markers.length, 40);
  assert.deepEqual(calls.markers.slice(0, 3), [0, 30, 60]);
  // Per-marker checks made 584 calls; one check before and one after the batch make 116.
  assert.equal(calls.total, 116);
});

test('markers: a project switch during the marker batch is still reported', async () => {
  const { transfer, calls } = host({ switchAtMarker: 20 });
  const result = await transfer.addToTimeline('/clip.mp4', 'active', 'end', automation);
  assert.deepEqual([result.ok, result.kind], [true, 'timeline-appended']);
  assert.equal(result.message, 'Added to the captured timeline. Resolve destination changed after the append. ClipDock color/marker updates may be incomplete.');
  assert.equal(calls.markers.length, 40);
});
