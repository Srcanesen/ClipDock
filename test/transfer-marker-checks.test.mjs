import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

// Counts every Resolve scripting call a chaptered timeline transfer makes.
function host({ switchAtMarker = null, change = 'project' } = {}) {
  const calls = { total: 0, markers: [] };
  const state = { project: 'A', timeline: 'A' };
  const hit = (fn) => (...args) => { calls.total++; return fn(...args); };
  const folder = { GetUniqueId: hit(() => 'folder'), GetClipList: hit(() => []) };
  const clip = { GetClipProperty: hit(() => '/clip.mp4'), SetClipColor: hit(() => true) };
  const timeline = id => ({
    GetUniqueId: hit(() => `timeline-${id}`), GetStartFrame: hit(() => 0), GetSetting: hit(() => '30'),
    AddMarker: hit((...args) => { calls.markers.push({ timeline: id, frame: args[0] }); if (calls.markers.length === switchAtMarker) state[change] = 'B'; return true; }),
  });
  const timelines = { A: timeline('A'), B: timeline('B') };
  const pool = {
    GetCurrentFolder: hit(() => folder),
    AppendToTimeline: hit(() => [{ GetStart: hit(() => 0) }]),
  };
  const project = id => ({ GetUniqueId: hit(() => `project-${id}`), GetMediaPool: hit(() => pool), GetCurrentTimeline: hit(() => timelines[state.timeline]) });
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
const switched = 'Added to the captured timeline. Resolve destination changed after the append. ClipDock color/marker updates may be incomplete.';

test('markers: a 40-chapter append runs one identity pass per marker instead of a full destination check', async () => {
  const { transfer, calls } = host();
  const result = await transfer.addToTimeline('/clip.mp4', 'active', 'end', automation);
  assert.deepEqual([result.ok, result.kind, result.message], [true, 'timeline-appended', 'Added to the active timeline.']);
  assert.equal(calls.markers.length, 40);
  assert.deepEqual(calls.markers.slice(0, 3).map(marker => marker.frame), [0, 30, 60]);
  // A full check per marker made 584 calls; one 7-call identity pass per marker makes 396.
  assert.equal(calls.total, 396);
});

for (const change of ['project', 'timeline']) test(`markers: a ${change} switch during the batch stops marker placement`, async () => {
  const { transfer, calls } = host({ switchAtMarker: 20, change });
  const result = await transfer.addToTimeline('/clip.mp4', 'active', 'end', automation);
  assert.deepEqual([result.ok, result.kind, result.message], [true, 'timeline-appended', switched]);
  assert.equal(calls.markers.length, 20);
  assert.deepEqual(new Set(calls.markers.map(marker => marker.timeline)), new Set(['A']));
});
