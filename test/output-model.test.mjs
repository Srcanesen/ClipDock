import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  commonDefaults,
  cloneOutputDefaults,
  cloneOutputOverrides,
  outputOverridesFrom,
  resultOptionsId,
  cardQualityLabel,
  cardOutputSummary,
} = require('../dist/renderer-state/output-model.js');

test('commonDefaults has expected shape', () => {
  assert.deepEqual(commonDefaults, {
    profile: 'original',
    quality: 'best',
    mediaMode: 'video',
    audioFormat: 'mp3',
    intent: 'download',
    targetBin: 'active',
    subtitles: false,
    subtitleLanguage: 'en',
    selection: null,
  });
});

test('cloneOutputDefaults deep-copies selection', () => {
  const src = { ...commonDefaults, selection: { start: 1, end: 2, label: 'x' } };
  const cloned = cloneOutputDefaults(src);
  assert.deepEqual(cloned, src);
  assert.notEqual(cloned.selection, src.selection);
  cloned.selection.start = 99;
  assert.equal(src.selection.start, 1);
  // null selection stays null
  assert.equal(cloneOutputDefaults(commonDefaults).selection, null);
});

test('cloneOutputOverrides preserves undefined vs null for selection', () => {
  const withSel = { profile: 'fast', selection: { start: 0, end: 1, label: 'a' } };
  const cloned = cloneOutputOverrides(withSel);
  assert.notEqual(cloned.selection, withSel.selection);
  const empty = {};
  assert.equal(cloneOutputOverrides(empty).selection, undefined);
});

test('outputOverridesFrom is byte-identical JSON comparison', () => {
  const snap = { ...commonDefaults };
  const same = { ...commonDefaults };
  assert.deepEqual(outputOverridesFrom(same, snap), {});
  const diff = { ...commonDefaults, profile: 'fast', quality: '720p' };
  assert.deepEqual(outputOverridesFrom(diff, snap), { profile: 'fast', quality: '720p' });
  // selection diff via JSON
  const withSel = { ...commonDefaults, selection: { start: 0, end: 5, label: 'a' } };
  assert.deepEqual(outputOverridesFrom(withSel, snap), { selection: { start: 0, end: 5, label: 'a' } });
});

test('resultOptionsId sanitizes key', () => {
  assert.equal(resultOptionsId('youtube:abc'), 'result-options-youtube-abc');
  assert.equal(resultOptionsId('pexels:video:1'), 'result-options-pexels-video-1');
  assert.equal(resultOptionsId('a/b c'), 'result-options-a-b-c');
});

test('cardQualityLabel and cardOutputSummary', () => {
  assert.equal(cardQualityLabel('best'), 'Best available');
  assert.equal(cardQualityLabel('original'), 'Original');
  assert.equal(cardQualityLabel('720p'), '720p');
  assert.equal(cardQualityLabel('unknown'), 'Best available');
  const summary = cardOutputSummary({ ...commonDefaults, profile: 'fast', quality: '1080p', intent: 'import', targetBin: 'active' }, false);
  assert.equal(summary, '1080p · Fast · Add to Media Pool · Active bin');
});
