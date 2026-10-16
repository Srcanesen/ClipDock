import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const output = require('../dist/renderer-state/output-model.js');
const { ItemOutputSession } = require('../dist/renderer-state/item-output-session.js');
const { transitionSourceSelection, resolveSourceSelection, resolvePexelsRendition, sourceQualityChoices, resolveQualityChoice, normalizeSourceOutput } = output;

const defaults = { profile: 'editing', quality: '720p', mediaMode: 'audio', audioFormat: 'mp3', intent: 'import', targetBin: 'clipdock', subtitles: true, subtitleLanguage: 'tr', selection: null };
const sourceA = { source: 'a', mode: 'chapters', start: '', end: '', indices: [0, 1], ranges: [{ start: 0, end: 10, label: 'Intro' }, { start: 20, end: 30, label: 'End' }] };
const fileSmall = { id: 'small-id', width: 1280, height: 720, label: 'HD', mime: 'video/mp4', size: 1 };
const fileLarge = { id: 'large-id', width: 1920, height: 1080, label: 'FHD', mime: 'video/mp4', size: 2 };

test('RND-3: blank intent is full, but incomplete, reversed, nonfinite and over-duration bounds are invalid', () => {
  const initial = transitionSourceSelection(null, { type: 'source', source: 'a' });
  for (const [start, end] of [['20', '10'], ['0', '101'], ['', '10'], ['0', ''], ['NaN', '10'], ['0', 'Infinity'], ['-1', '10'], ['10', '10']]) {
    const plan = transitionSourceSelection(initial, { type: 'manual', start, end });
    assert.equal(resolveSourceSelection(plan, 'a', 100).status, 'invalid', `${start}/${end}`);
  }
  assert.deepEqual(resolveSourceSelection(transitionSourceSelection(initial, { type: 'manual', start: '', end: '' }), 'a', 100), { status: 'full', selections: [null] });
  assert.deepEqual(resolveSourceSelection(transitionSourceSelection(initial, { type: 'manual', start: '0', end: '10' }), 'a', null), { status: 'valid', selections: [{ start: 0, end: 10, label: 'Custom range' }] });
});

test('RND-2: source changes reset chapters, cues and manual range; source identity guards stale plans', () => {
  assert.deepEqual(transitionSourceSelection(sourceA, { type: 'source', source: 'b' }), { source: 'b', mode: 'full', start: '', end: '', indices: [], ranges: [] });
  assert.deepEqual(resolveSourceSelection(sourceA, 'b', 100), { status: 'full', selections: [null] });
  assert.deepEqual(resolveSourceSelection(sourceA, 'a', 100), { status: 'valid', selections: [{ start: 0, end: 10, label: 'Intro' }, { start: 20, end: 30, label: 'End' }] });
  const manual = transitionSourceSelection(sourceA, { type: 'manual', start: '40', end: '50' });
  assert.deepEqual(manual, { source: 'a', mode: 'manual', start: '40', end: '50', indices: [], ranges: [] });
  assert.deepEqual(resolveSourceSelection(manual, 'a', 100), { status: 'valid', selections: [{ start: 40, end: 50, label: 'Custom range' }] });
  const cues = transitionSourceSelection(sourceA, { type: 'cues', indices: [0, 2], ranges: [{ start: 2, end: 3, label: 'Cue' }, { start: 8, end: 9, label: 'Cue' }] });
  assert.deepEqual(resolveSourceSelection(cues, 'a', 100), { status: 'valid', selections: [{ start: 2, end: 9, label: '2 subtitle cues' }] });
  assert.deepEqual(transitionSourceSelection(cues, { type: 'full', source: 'a' }), { source: 'a', mode: 'full', start: '', end: '', indices: [], ranges: [] });
});

test('RND-2/RND-3: staged snapshots retain chapter intent and invalid manual input without sharing arrays', () => {
  const plan = transitionSourceSelection(sourceA, { type: 'manual', start: '30', end: '20' });
  const session = new ItemOutputSession();
  session.edit('youtube:a', { ...defaults, mediaMode: 'video', selectionPlan: plan });
  const effective = session.output('youtube:a');
  assert.deepEqual(effective.selectionPlan, { source: 'a', mode: 'manual', start: '30', end: '20', indices: [], ranges: [] });
  assert.equal(resolveSourceSelection(effective.selectionPlan, 'a', 100).status, 'invalid');
  const cloned = output.cloneOutputDefaults({ ...defaults, selectionPlan: sourceA });
  cloned.selectionPlan.ranges[0].start = 99;
  assert.equal(sourceA.ranges[0].start, 0);
});

test('RND-5: opaque IDs take priority; missing IDs and generic heights resolve deterministically', () => {
  assert.deepEqual(resolvePexelsRendition('video', [fileLarge, fileSmall], 'small-id'), fileSmall);
  assert.deepEqual(resolvePexelsRendition('video', [fileSmall, fileLarge], 'best'), fileLarge);
  assert.deepEqual(resolvePexelsRendition('video', [fileSmall, fileLarge], 'missing-id'), fileLarge);
  assert.deepEqual(resolvePexelsRendition('video', [fileSmall, fileLarge], '900p'), fileSmall);
  assert.deepEqual(resolvePexelsRendition('video', [fileSmall, fileLarge], '480p'), fileSmall);
  assert.equal(resolvePexelsRendition('video', [], 'best'), null);
  assert.equal(resolvePexelsRendition('photo', [fileSmall], 'small-id'), null);
  const photo = { ...fileSmall, mime: 'image/jpeg' };
  assert.deepEqual(resolvePexelsRendition('photo', [photo, { ...fileLarge, mime: 'image/jpeg' }], 'small-id'), photo);
  assert.equal(normalizeSourceOutput({ ...defaults, quality: 'small-id' }, 'pexels', true).quality, 'small-id');
});

test('RND-4: defaults resolve only to supported native choices', () => {
  assert.deepEqual(sourceQualityChoices('youtube', [720, 1080, 720, -1, 9999, 720.5]), ['1080p', '720p']);
  assert.deepEqual(sourceQualityChoices('social'), ['best']);
  assert.deepEqual(sourceQualityChoices('pinterest', [1080]), ['original']);
  assert.deepEqual(sourceQualityChoices('pexels', [], [fileSmall, fileLarge]), ['small-id', 'large-id']);
  assert.equal(resolveQualityChoice('best', ['1080p']), '1080p');
  assert.equal(resolveQualityChoice('2160p', ['1080p', '720p']), '1080p');
  assert.equal(resolveQualityChoice('720p', ['1080p', '720p']), '720p');
  assert.equal(resolveQualityChoice('best', ['1080p', '720p'], '720p'), '720p');
  assert.equal(resolveQualityChoice('best', []), '');
});

test('RND-26: provider capabilities normalize summaries and download settings consistently', () => {
  const expected = { profile: 'editing', quality: '720p', mediaMode: 'video', audioFormat: 'm4a', intent: 'import', targetBin: 'clipdock', subtitles: false, subtitleLanguage: 'en', selection: null };
  for (const provider of ['social', 'pexels']) {
    assert.deepEqual(normalizeSourceOutput(defaults, provider), expected);
    const session = new ItemOutputSession();
    session.edit('defaults', defaults);
    const presentation = session.output(`${provider}:video:1`);
    assert.deepEqual(presentation, expected);
    assert.equal(output.cardOutputSummary(presentation), '720p · Edit-ready · Add to Media Pool · ClipDock bin');
  }
  assert.deepEqual(normalizeSourceOutput(defaults, 'pinterest'), { ...expected, quality: 'original' });
  assert.deepEqual(normalizeSourceOutput(defaults, 'pexels', true), { ...expected, profile: 'original', quality: 'original' });
  assert.deepEqual(normalizeSourceOutput(defaults, 'youtube'), { ...defaults, profile: 'original', quality: 'best' });
});

test('RND-2: chapter indices resolve in source order with duplicates and stale indices removed', () => {
  const state = output.selectSourceSegments({ source: 'a', mode: 'full', start: '', end: '', indices: [], ranges: [] }, 'chapters', [{ start: 0, end: 10, title: 'Intro' }, { start: 20, end: 30, title: 'End' }], [1, 0, 1, 99]);
  assert.deepEqual(state, { source: 'a', mode: 'chapters', start: '', end: '', indices: [0, 1], ranges: [{ start: 0, end: 10, label: 'Intro' }, { start: 20, end: 30, label: 'End' }] });
});
