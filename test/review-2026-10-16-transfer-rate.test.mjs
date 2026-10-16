import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function host({ timelineRate = '30', projectRate = '24', inherits = '1', timecode = '00:00:10:00', noTimelineSettings = false, throws = false } = {}) {
  const calls = { appends: [], markers: [], projectRates: 0 };
  const clip = { GetClipProperty: key => key === 'Frames' ? '30' : '/clip.mp4', SetClipColor: () => true };
  const timeline = {
    GetStartFrame: () => 0, GetStartTimecode: () => '00:00:00:00', GetCurrentTimecode: () => timecode,
    AddMarker(...args) { calls.markers.push(args); return true; },
    ...(!noTimelineSettings ? { GetSetting(key) { if (throws) throw new Error('timeline settings unavailable'); return key === 'useCustomSettings' ? inherits : timelineRate; } } : {}),
  };
  const folder = { GetClipList: () => [clip] };
  const pool = { GetCurrentFolder: () => folder, AppendToTimeline(args) { calls.appends.push(args); return [{ GetStart: () => 0 }]; } };
  const project = { GetMediaPool: () => pool, GetCurrentTimeline: () => timeline, GetSetting() { calls.projectRates++; return projectRate; } };
  const transfer = createTransfer({ Initialize: () => true, GetResolve: () => ({
    GetProjectManager: () => ({ GetCurrentProject: () => project }), OpenPage: () => true,
  }) }, 'review', 'linux');
  return { transfer, calls };
}
const automation = { provider: 'youtube', source: 'source', selection: null, chapters: [{ start: 2, end: 3, title: 'Chapter' }] };

for (const [placement, timecode, recordFrame] of [['end', '00:00:10:00', null], ['playhead', '00:00:10:00', 300], ['playhead', '00:00:10:29', 329]]) {
  test(`timeline rate: custom 30 fps ${placement} at ${timecode} overrides project 24 fps`, async () => {
    const { transfer, calls } = host({ timecode });
    const result = await transfer.addToTimeline('/clip.mp4', 'active', placement, automation);
    assert.equal(result.kind, placement === 'end' ? 'timeline-appended' : 'timeline-inserted');
    if (recordFrame !== null) assert.equal(calls.appends[0][0].recordFrame, recordFrame);
    assert.deepEqual(calls.markers, [[60, 'Sand', 'Chapter', 'source · original 2.000s', 1]]);
    assert.equal(calls.projectRates, 0);
  });
}

for (const inherits of ['0', 0, false]) test(`timeline rate: explicitly inherited settings (${JSON.stringify(inherits)}) allow project fallback`, async () => {
  const { transfer, calls } = host({ timelineRate: '', inherits });
  assert.equal((await transfer.addToTimeline('/clip.mp4', 'active', 'playhead', automation)).kind, 'timeline-inserted');
  assert.equal(calls.appends[0][0].recordFrame, 240);
  assert.equal(calls.markers[0][0], 48);
  assert.ok(calls.projectRates > 0);
});

for (const options of [
  { timelineRate: null }, { timelineRate: 'invalid' }, { timelineRate: '0' }, { timelineRate: '241' },
  { timelineRate: '', inherits: null }, { noTimelineSettings: true }, { throws: true },
  { timelineRate: '', inherits: '0', projectRate: 'invalid' },
]) {
  for (const placement of ['end', 'playhead']) test(`timeline rate: ${placement} does not guess an unreadable rate ${JSON.stringify(options)}`, async () => {
    const { transfer, calls } = host(options);
    const result = await transfer.addToTimeline('/clip.mp4', 'active', placement, automation);
    assert.deepEqual(calls.markers, []);
    if (placement === 'playhead') {
      assert.deepEqual([result.ok, result.kind, calls.appends], [false, 'playhead-unsupported', []]);
    } else {
      assert.equal(result.kind, 'timeline-appended');
      assert.match(result.message, /markers unavailable/);
      assert.equal(calls.appends.length, 1);
    }
  });
}
