import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ItemOutputSession, resolveSourceSelection } = require('../dist/renderer-state/item-output-session.js');

const defaults = { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null };
const selection = (provider = 'youtube', kind = 'video') => ({ provider, resultId: 'a', source: 'source-a', title: 'A', channel: null, thumbnailDataUrl: 'data:image/png;base64,AA==', ...(provider === 'pexels' ? { pexelsKind: kind } : {}) });
const identity = (key) => ({ key, resultId: 'a', thumbnailDataUrl: 'data:image/png;base64,AA==' });
const plan = { source: 'a', mode: 'manual', start: '10', end: '20', indices: [], ranges: [] };

for (const target of ['defaults', 'inspector', 'youtube:a']) {
  test(`${target}: edit returns only accepted requested fields for persistence`, () => {
    const session = new ItemOutputSession();
    session.edit('defaults', { profile: 'editing', mediaMode: 'audio' });
    const accepted = session.edit(target, { profile: 'fast', targetBin: 'invalid', quality: '' });
    assert.deepEqual(accepted, { profile: 'fast' });
    assert.deepEqual(session.edit(target, { profile: 'invalid' }), {});
    assert.equal(session.output(target === 'youtube:a' ? target : undefined).profile, 'original');
    accepted.profile = 'editing';
    session.edit(target, { mediaMode: 'video' });
    assert.equal(session.output(target === 'youtube:a' ? target : undefined).profile, 'fast');
  });
}

for (const [name, common, later, expected] of [
  ['a: fallback quality', {}, { quality: '720p' }, { quality: '720p', profile: 'original' }],
  ['b: audio presentation', { profile: 'editing', quality: '720p', mediaMode: 'audio' }, { mediaMode: 'video' }, { quality: '720p', profile: 'editing' }],
]) {
  for (const switchProvider of [false, true]) {
    test(`${name}: bin-only detached edit follows live defaults${switchProvider ? ' after a provider round trip' : ''}`, () => {
      const session = new ItemOutputSession();
      session.edit('defaults', common);
      session.output(undefined, { choices: ['1080p', '720p'] });
      session.edit('inspector', { targetBin: 'clipdock' });
      assert.deepEqual(session.overrides(), { targetBin: 'clipdock' });
      if (switchProvider) session.select({ provider: 'social' });
      session.edit('defaults', later);
      if (switchProvider) session.select({ provider: 'youtube' });
      assert.deepEqual(session.overrides(), { targetBin: 'clipdock' });
      assert.deepEqual(session.output(undefined, { choices: ['1080p', '720p'] }), { ...defaults, ...common, ...later, ...expected, targetBin: 'clipdock' });
    });
  }
}

for (const staged of [false, true]) {
  test(`bin-only ${staged ? 'staged' : 'keyed card'} edit preserves requested audio values and its frozen snapshot`, () => {
    const session = new ItemOutputSession();
    session.edit('defaults', { profile: 'editing', quality: '720p', mediaMode: 'audio' });
    if (staged) session.stage('youtube:a', selection());
    session.select(identity('youtube:a'));
    assert.deepEqual(session.output(), { ...defaults, quality: 'best', mediaMode: 'audio' });
    session.edit('inspector', { targetBin: 'clipdock' });
    assert.deepEqual(session.overrides('youtube:a'), { targetBin: 'clipdock' });
    session.edit('defaults', { profile: 'fast', quality: '1080p', mediaMode: 'video' });
    assert.deepEqual(session.output(), { ...defaults, quality: 'best', mediaMode: 'audio', targetBin: 'clipdock' });
    session.edit('inspector', { mediaMode: 'video' });
    assert.deepEqual(session.output(), { ...defaults, profile: 'editing', quality: '720p', targetBin: 'clipdock' });
  });
}

test('Pexels fallback reads and staging never turn presented rendition or normalisation into overrides', () => {
  const session = new ItemOutputSession();
  const files = [{ id: 'small', height: 720, mime: 'video/mp4' }, { id: 'large', height: 1080, mime: 'video/mp4' }];
  session.select({ provider: 'pexels' });
  assert.equal(session.output(undefined, { files }).quality, 'large');
  session.edit('inspector', { targetBin: 'clipdock' });
  assert.deepEqual(session.overrides(), { targetBin: 'clipdock' });
  session.edit('defaults', { quality: 'small' });
  assert.equal(session.output(undefined, { files }).quality, 'small');
  session.stage('pexels:video:a', selection('pexels'));
  session.select(identity('pexels:video:a'));
  session.edit('inspector', { targetBin: 'clipdock' });
  session.output(undefined, { files: [{ id: 'fallback', height: 480, mime: 'video/mp4' }] });
  assert.deepEqual(session.overrides('pexels:video:a'), { targetBin: 'clipdock' });
  session.unstage();
  assert.deepEqual(session.overrides('pexels:video:a'), { targetBin: 'clipdock' });
  assert.equal(session.output(undefined, { files }).quality, 'small');
});

for (const target of ['defaults', 'inspector', 'youtube:a']) {
  test(`${target}: partial validation, omitted fields and resetting one override`, () => {
    const session = new ItemOutputSession();
    session.edit(target, { profile: 'editing', quality: '720p', targetBin: 'clipdock' });
    session.edit(target, { profile: 'bad', quality: '', targetBin: 'active' });
    const value = target === 'defaults' ? session.defaults : session.output(target === 'inspector' ? undefined : target);
    assert.deepEqual(value, { ...defaults, profile: 'editing', quality: '720p' });
    if (target !== 'defaults') assert.deepEqual(session.overrides(target === 'inspector' ? undefined : target), { profile: 'editing', quality: '720p' });
  });
}

test('invalid range values leave requested fields unchanged without losing valid range intent', () => {
  const session = new ItemOutputSession();
  session.edit('inspector', { selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan, subtitles: true });
  session.edit('inspector', { selection: { start: NaN, end: 5, label: 'Bad' }, selectionPlan: { ...plan, mode: 'unknown' }, subtitles: 'false' });
  assert.deepEqual(session.overrides(), { selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan, subtitles: true });
  assert.deepEqual(session.output(), { ...defaults, selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan, subtitles: true });
});

for (const { name, provider, key, edit, expected } of [
  { name: 'ade2131: provider restoration retains range and output overrides', provider: 'youtube', key: 'youtube:a', edit: { profile: 'editing', quality: '1080p', intent: 'playhead', targetBin: 'clipdock', selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan }, expected: { ...defaults, profile: 'editing', quality: '1080p', intent: 'playhead', targetBin: 'clipdock', selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan } },
  { name: '5c3245f: Pinterest video retains its encoding profile', provider: 'pinterest', key: 'pinterest:a', edit: { profile: 'editing', quality: '720p', subtitles: true }, expected: { ...defaults, profile: 'editing', quality: 'original', audioFormat: 'm4a' } },
  { name: 'Pexels video retains opaque rendition IDs', provider: 'pexels', key: 'pexels:video:a', edit: { profile: 'fast', quality: 'small-id' }, expected: { ...defaults, profile: 'fast', quality: 'small-id', audioFormat: 'm4a' } },
  { name: 'Pexels photo normalizes the profile while retaining its opaque rendition', provider: 'pexels', key: 'pexels:photo:a', edit: { profile: 'editing', quality: 'photo-id' }, expected: { ...defaults, profile: 'original', quality: 'photo-id', audioFormat: 'm4a' } },
  { name: 'social normalizes unsupported audio, subtitle and range controls', provider: 'social', key: 'social:a', edit: { profile: 'fast', quality: '720p', mediaMode: 'audio', subtitles: true, selectionPlan: plan }, expected: { ...defaults, profile: 'fast', quality: '720p', audioFormat: 'm4a' } },
]) {
  test(name + ': stage → edit → switch → unstage → reopen', () => {
    const session = new ItemOutputSession();
    session.select({ provider, kind: key.includes(':photo:') ? 'photo' : 'video' });
    session.stage(key, selection(provider, key.includes(':photo:') ? 'photo' : 'video'));
    session.select(identity(key));
    session.edit('inspector', edit);
    session.select({ provider: provider === 'social' ? 'youtube' : 'social' });
    session.edit('inspector', { profile: 'original', quality: 'best' });
    session.select({ provider, kind: key.includes(':photo:') ? 'photo' : 'video' });
    assert.deepEqual(session.selected, identity(key));
    session.unstage(key);
    session.select(null);
    session.select(identity(key));
    assert.deepEqual(session.output(), expected);
    assert.equal(session.staged.size, 0);
  });
}

for (const route of ['youtube paste', 'Pinterest paste', 'social-url input']) {
  test(`d7efa79 / ${route}: one clear detaches all identity fields and protects staged output`, () => {
    const session = new ItemOutputSession();
    session.stage('youtube:a', selection());
    session.select(identity('youtube:a'));
    session.edit('inspector', { profile: 'editing', selectionPlan: plan });
    session.select(null);
    assert.equal(session.selected, null);
    session.edit('inspector', { profile: 'fast', selectionPlan: { ...plan, start: '30', end: '40' } });
    session.unstage('youtube:a');
    session.select(identity('youtube:a'));
    assert.deepEqual(session.output(), { ...defaults, profile: 'editing', selectionPlan: plan });
  });
}

for (const target of ['defaults', 'youtube:a', 'inspector']) {
  test(`${target}: the same raw-control validator rejects invalid enums`, () => {
    const session = new ItemOutputSession();
    session.select(identity('youtube:a'));
    const raw = { profile: 'editing', quality: '1080p', mediaMode: 'video', audioFormat: 'wav', intent: 'import', targetBin: 'clipdock', subtitleLanguage: 'tr', subtitles: true };
    session.edit(target, raw);
    session.edit(target, { profile: 'bad', quality: '', mediaMode: 'bad', audioFormat: 'bad', intent: 'bad', targetBin: 'bad', subtitleLanguage: 'bad' });
    assert.deepEqual(target === 'defaults' ? session.defaults : session.output(), { ...defaults, ...raw });
  });
}

test('capability reads never commit: transient quality, photo and empty choices cannot erase saved output', () => {
  const session = new ItemOutputSession();
  session.stage('youtube:a', selection()); session.select(identity('youtube:a'));
  session.edit('inspector', { profile: 'editing', quality: '1080p', selectionPlan: plan });
  const saved = session.staged.get('youtube:a');
  assert.deepEqual(session.output(undefined, { photo: true, choices: [] }), { ...defaults, profile: 'original', quality: '', selectionPlan: plan });
  assert.equal(session.output(undefined, { choices: ['720p'] }).quality, '720p');
  assert.deepEqual(session.staged.get('youtube:a'), saved);
  assert.deepEqual(session.output(), { ...defaults, profile: 'editing', quality: '1080p', selectionPlan: plan });
});

for (const clearAll of [false, true]) {
  test(`unstage ${clearAll ? 'all' : 'one'} remembers frozen defaults and overrides across later default edits`, () => {
    const session = new ItemOutputSession();
    session.edit('defaults', { profile: 'editing', targetBin: 'clipdock' });
    session.stage('youtube:a', selection());
    session.edit('youtube:a', { quality: '720p' });
    session.edit('defaults', { profile: 'fast', targetBin: 'active' });
    session.unstage(clearAll ? undefined : 'youtube:a');
    session.edit('defaults', { profile: 'original', quality: '1080p' });
    session.stage('youtube:a', selection()); session.select(identity('youtube:a'));
    assert.deepEqual(session.output(), { ...defaults, profile: 'editing', quality: '720p', targetBin: 'clipdock' });
  });
}

test('reads and returned stages cannot mutate session snapshots, overrides or identity', () => {
  const session = new ItemOutputSession();
  const stage = session.stage('youtube:a', selection());
  session.select(identity('youtube:a')); session.edit('inspector', { selectionPlan: plan });
  stage.snapshot.profile = 'fast';
  session.defaults.profile = 'fast'; session.selected.key = 'other';
  session.output().selectionPlan.start = '99';
  session.staged.get('youtube:a').overrides.selectionPlan.start = '99';
  session.overrides('youtube:a').selectionPlan.start = '99';
  assert.deepEqual(session.output(), { ...defaults, selectionPlan: plan });
  assert.deepEqual(session.selected, identity('youtube:a'));
});

for (const [start, end, status] of [['-2', '-1', 'invalid'], ['1.01', '1.04', 'valid'], ['20', '10', 'invalid'], ['', '10', 'invalid']]) {
  test(`range plan ${start}/${end} survives switching and reopening as data`, () => {
    const session = new ItemOutputSession();
    session.stage('youtube:a', selection()); session.select(identity('youtube:a'));
    session.edit('inspector', { selectionPlan: { ...plan, start, end } });
    session.select({ provider: 'social' }); session.select({ provider: 'youtube' });
    session.unstage(); session.select(identity('youtube:a'));
    assert.deepEqual(session.output().selectionPlan, { ...plan, start, end });
    assert.equal(resolveSourceSelection(session.output().selectionPlan, 'a', 60).status, status);
  });
}

test('source drafts and Pexels kinds restore independently; disconnect clears only Pexels identities', () => {
  const session = new ItemOutputSession();
  session.edit('inspector', { profile: 'editing', selectionPlan: plan });
  session.select({ provider: 'pexels', kind: 'video' }); session.select(identity('pexels:video:a'));
  session.edit('inspector', { quality: 'video-id' });
  session.select({ provider: 'pexels', kind: 'photo' }); session.select(identity('pexels:photo:a'));
  session.edit('inspector', { quality: 'photo-id' });
  session.select({ provider: 'pexels', kind: 'video' });
  assert.equal(session.output().quality, 'video-id');
  session.select({ provider: 'youtube' });
  assert.equal(session.selected, null);
  assert.deepEqual(session.output(), { ...defaults, profile: 'editing', selectionPlan: plan });
  session.select({ clear: 'pexels' }); session.select({ provider: 'pexels', kind: 'photo' });
  assert.equal(session.selected, null);
  assert.deepEqual(session.output(), { ...defaults, quality: 'original', audioFormat: 'm4a' });
});

test('inline enqueue can capture a stage without adding it to the staged selection', () => {
  const session = new ItemOutputSession();
  session.edit('youtube:a', { profile: 'fast' });
  const captured = session.stage('youtube:a', selection(), false);
  session.edit('youtube:a', { profile: 'editing' });
  assert.deepEqual(captured.overrides, { profile: 'fast' });
  assert.equal(session.staged.size, 0);
  assert.equal(session.output('youtube:a').profile, 'editing');
});

test('user quality preference survives new sources, while unsupported fallback reads never change it', () => {
  const session = new ItemOutputSession();
  session.edit('inspector', { quality: '720p' });
  session.select(null);
  assert.equal(session.output(undefined, { choices: ['2160p', '1080p', '720p'] }).quality, '720p');
  assert.equal(session.output(undefined, { choices: ['2160p', '1080p'] }).quality, '2160p');
  session.select(null);
  assert.equal(session.output(undefined, { choices: ['2160p', '720p'] }).quality, '720p');
});

for (const [name, edit, expected] of [
  ['audio/WAV', { mediaMode: 'audio', audioFormat: 'wav', subtitles: true, subtitleLanguage: 'tr', targetBin: 'clipdock', intent: 'playhead' }, { ...defaults, mediaMode: 'audio', audioFormat: 'wav', subtitles: true, subtitleLanguage: 'tr', targetBin: 'clipdock', intent: 'playhead' }],
  ['video profile/bin/handoff', { profile: 'editing', targetBin: 'clipdock', intent: 'import' }, { ...defaults, profile: 'editing', targetBin: 'clipdock', intent: 'import' }],
]) {
  test(`gate: clearing identity and reloading a pasted source preserves its detached ${name} edits`, () => {
    const session = new ItemOutputSession();
    session.select(null);
    session.edit('inspector', edit);
    // A paste/load button clears identity; the YouTube loader clears it again.
    session.select(null); session.select(null);
    assert.equal(session.selected, null);
    assert.deepEqual(session.output(), expected);
  });
}

for (const [provider, kind] of [['youtube', 'video'], ['social', 'video'], ['pinterest', 'video'], ['pexels', 'video'], ['pexels', 'photo']]) {
  test(`gate: an untouched saved ${provider}/${kind} draft follows common defaults after switching back`, () => {
    const session = new ItemOutputSession();
    session.select({ provider, kind });
    session.output(); // Loading metadata only reads the draft.
    session.select({ provider: provider === 'social' ? 'youtube' : 'social' });
    session.edit('defaults', { profile: 'editing', targetBin: 'clipdock', intent: 'end', quality: '720p', audioFormat: 'wav', subtitles: true, subtitleLanguage: 'tr' });
    session.select({ provider, kind });
    assert.deepEqual(session.output(), {
      ...defaults, profile: kind === 'photo' ? 'original' : 'editing', targetBin: 'clipdock', intent: 'end',
      quality: kind === 'photo' || provider === 'pinterest' ? 'original' : '720p',
      audioFormat: provider === 'youtube' ? 'wav' : 'm4a', subtitles: provider === 'youtube', subtitleLanguage: provider === 'youtube' ? 'tr' : 'en',
    });
  });
}

for (const switchAway of [false, true]) {
  test(`gate: ${switchAway ? 'saved' : 'active'} detached edits survive common changes while untouched fields follow them`, () => {
    const session = new ItemOutputSession();
    session.edit('inspector', { intent: 'playhead', audioFormat: 'wav' });
    if (switchAway) session.select({ provider: 'social' });
    session.edit('defaults', { profile: 'editing', targetBin: 'clipdock', quality: '720p', intent: 'import', audioFormat: 'm4a' });
    if (switchAway) session.select({ provider: 'youtube' });
    assert.deepEqual(session.output(), { ...defaults, profile: 'editing', targetBin: 'clipdock', quality: '720p', intent: 'playhead', audioFormat: 'wav' });
  });
}

test('gate: selecting and editing a staged result cannot replace the detached draft with its frozen defaults', () => {
  const session = new ItemOutputSession();
  session.edit('inspector', { audioFormat: 'wav' });
  session.stage('youtube:a', selection()); session.select(identity('youtube:a'));
  session.edit('inspector', { intent: 'playhead' });
  session.edit('defaults', { profile: 'editing', targetBin: 'clipdock' });
  session.select(null);
  assert.deepEqual(session.output(), { ...defaults, profile: 'editing', targetBin: 'clipdock', audioFormat: 'wav' });
  assert.deepEqual(session.output('youtube:a'), { ...defaults, intent: 'playhead' });
});

for (const source of ['a', 'b']) {
  test(`gate: detached range intent ${source === 'a' ? 'survives reloading its video' : 'clears for another video'} while output edits survive`, () => {
    const session = new ItemOutputSession();
    session.edit('inspector', { profile: 'editing', selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan });
    session.select(null);
    session.select({ source });
    assert.equal(session.selected, null);
    assert.deepEqual(session.output(), source === 'a'
      ? { ...defaults, profile: 'editing', selection: { start: 10, end: 20, label: 'Custom range' }, selectionPlan: plan }
      : { ...defaults, profile: 'editing' });
  });
}
