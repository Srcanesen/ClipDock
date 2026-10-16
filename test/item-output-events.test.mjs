import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const urlA = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const urlB = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
const plain = (value) => JSON.parse(JSON.stringify(value));
const find = (root, predicate) => {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = find(child, predicate);
    if (nested) return nested;
  }
};
function change(h, id, value, type = 'change') {
  const el = typeof id === 'string' ? h.elements.get(id) : id;
  assert.ok(el, id);
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.listeners[type]?.({ target: el, preventDefault() {}, stopPropagation() {} });
}
const pinUrl = (id = '111') => `https://www.pinterest.com/pin/${id}/`;
async function boot({ preferencesInit, pinterestKinds = ['video'] } = {}) {
  const h = createHarness({ eventsOnly: true, preferencesInit });
  h.api.loadYoutube = async (url) => ({ id: new URL(url).searchParams.get('v'), title: 'A', duration: 60, channel: null, thumbnailDataUrl: null, heights: [1080, 720], formatSummary: [], chapters: [] });
  h.api.searchPinterest = async () => ({ query: 'shots', page: 1, pageSize: 10, hasPrevious: false, hasNext: false, totalResults: 1, pageCount: 1, results: [{ id: '111', url: pinUrl(), title: 'Pin', creator: null, kind: pinterestKinds.length > 1 ? 'carousel' : 'video', thumbnailDataUrl: null }] });
  h.api.loadPinterest = async (url) => ({ pinId: new URL(url).pathname.split('/')[2], source: url, title: 'Pin', creator: null, kind: pinterestKinds.length > 1 ? 'carousel' : 'video', thumbnailDataUrl: null, items: pinterestKinds.map((kind, index) => ({ index: index + 1, kind, title: 'Pin', creator: null, extension: kind === 'image' ? 'jpg' : 'mp4' })) });
  h.api.downloadPinterest = (url, itemIndex, profile, jobId) => {
    const entry = { url, itemIndex, profile, jobId };
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    h.downloads.push(entry);
    return promise;
  };
  await h.fireReady();
  return h;
}

async function searchResults(h, name = 'youtube') {
  if (name !== 'youtube') await provider(h, name);
  change(h, 'youtube-search-input', 'shots', 'input');
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  if (name === 'youtube') h.searches.at(-1).entry.resolve(h.page);
  await h.flush();
  assert.ok(h.elements.get('youtube-search-results').children.length);
}
async function openFirstResult(h) {
  find(h.elements.get('youtube-search-results').children[0], (el) => el.dataset.cardAction === 'advanced').click();
  await h.flush();
}

test('preference-bin: a bin-only audio edit preserves the requested profile across restart', async () => {
  const h = await boot();
  await load(h);
  change(h, 'common-profile', 'editing');
  change(h, 'common-media-mode', 'audio');
  h.preferenceWrites.length = 0;
  change(h, 'youtube-target-bin', 'clipdock');
  assert.equal(h.preferences.get('clipdock.output-intent'), 'editing');
  assert.deepEqual(h.preferenceWrites, []);
  const restarted = await boot({ preferencesInit: Object.fromEntries(h.preferences) });
  change(restarted, 'common-media-mode', 'video');
  await load(restarted);
  await assertDownload(restarted, { profile: 'editing' });
});

test('preference-patch: detached profile edits stay local while audio is presented', async () => {
  const h = await boot();
  await load(h);
  change(h, 'common-media-mode', 'audio');
  h.preferenceWrites.length = 0;
  change(h, 'youtube-profile', 'editing');
  assert.equal(h.elements.get('youtube-profile').value, 'original');
  assert.deepEqual(h.preferenceWrites, []);
  change(h, 'youtube-profile', 'bad');
  assert.deepEqual(h.preferenceWrites, []);
  change(h, 'common-target-bin', 'clipdock');
  assert.deepEqual(h.preferenceWrites, [['clipdock.target-bin', 'clipdock']]);
  const restarted = await boot({ preferencesInit: Object.fromEntries(h.preferences) });
  change(restarted, 'common-media-mode', 'video');
  await load(restarted);
  await assertDownload(restarted, { profile: 'original', targetBin: 'clipdock' });
});

test('identity-display: pasting the selected card URL repaints detached controls to match the queued output', async () => {
  const h = await boot();
  await searchResults(h);
  await openFirstResult(h);
  change(h, 'youtube-profile', 'fast');
  change(h, 'youtube-target-bin', 'clipdock');
  change(h, 'youtube-intent', 'import');
  const controls = () => ['profile', 'target-bin', 'intent'].map((field) => h.elements.get(`youtube-${field}`).value);
  assert.deepEqual(controls(), ['fast', 'clipdock', 'import']);
  change(h, 'youtube-url', urlA, 'input');
  const displayed = controls();
  await assertDownload(h);
  const item = h.test.queue()[0];
  assert.deepEqual(displayed, [item.profile, item.targetBin, item.intent]);
  assert.deepEqual(displayed, ['original', 'active', 'download']);
  assert.equal(h.elements.get('download-youtube-btn').textContent, 'Download only');
  change(h, 'youtube-profile', 'editing');
  await openFirstResult(h);
  assert.deepEqual(controls(), ['fast', 'clipdock', 'import'], 'detached edits must not change the keyed card');
});

test('identity-range: pasting another card URL paints the full clip and keeps the detached range for its own source', async () => {
  const h = await boot();
  await load(h);
  change(h, 'range-in', '10', 'input');
  change(h, 'range-out', '20', 'input');
  await searchResults(h);
  find(h.elements.get('youtube-search-results').children[1], (el) => el.dataset.cardAction === 'advanced').click();
  await h.flush();
  change(h, 'youtube-url', urlB, 'input');
  assert.deepEqual(['range-in', 'range-out'].map((id) => h.elements.get(id).value), ['', '']);
  await assertDownload(h, {}, urlB);
  const again = await boot();
  await load(again);
  change(again, 'range-in', '10', 'input');
  change(again, 'range-out', '20', 'input');
  await searchResults(again);
  find(again.elements.get('youtube-search-results').children[1], (el) => el.dataset.cardAction === 'advanced').click();
  await again.flush();
  await load(again, urlA);
  await assertDownload(again, { selection: range });
});

for (const name of ['youtube', 'pinterest']) {
  test(`shared-paste-${name}: form submission detaches edits from the older staged result`, async () => {
    const h = await boot();
    await searchResults(h, name);
    const row = h.elements.get('youtube-search-results').children[0];
    change(h, find(row, (el) => el.dataset.field === 'profile'), 'editing');
    change(h, find(row, (el) => el.dataset.field === 'selection'), true);
    await openFirstResult(h);
    change(h, 'youtube-search-input', name === 'youtube' ? urlB : pinUrl('222'), 'input');
    h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await h.flush();
    change(h, 'youtube-profile', 'fast');
    h.elements.get('enqueue-selected-btn').click();
    await h.flush();
    const item = h.test.queue()[0];
    assert.deepEqual(plain({ url: item.url, profile: item.profile, provider: item.provider }), { url: name === 'youtube' ? urlA : pinUrl(), profile: 'editing', provider: name });
    assert.equal(h.downloads[0].profile, 'editing');
  });
}

for (const kinds of [['video'], ['image', 'video']]) {
  test(`keyed-pin-${kinds.length === 1 ? 'video' : 'carousel'}: metadata preserves card Edit-ready with common Original`, async () => {
    const h = await boot({ pinterestKinds: kinds });
    await searchResults(h, 'pinterest');
    const row = h.elements.get('youtube-search-results').children[0];
    change(h, find(row, (el) => el.dataset.field === 'profile'), 'editing');
    assert.equal(h.elements.get('common-profile').value, 'original');
    await openFirstResult(h);
    h.elements.get('download-youtube-btn').click();
    await h.flush();
    assert.deepEqual(Array.from(h.test.queue(), (item) => item.profile), kinds.map((kind) => kind === 'image' ? 'original' : 'editing'));
    for (let index = 0; index < kinds.length; index += 1) {
      assert.equal(h.downloads[index].profile, kinds[index] === 'image' ? 'original' : 'editing');
      h.downloads[index].resolve({ cardId: `pin-${index}`, fileName: `${index}.mp4` });
      await h.flush();
    }
  });
}
async function load(h, url = urlA) {
  change(h, 'youtube-url', url, 'input');
  h.elements.get('load-youtube-btn').click();
  await h.flush();
  assert.equal(h.elements.get('youtube-title').textContent, 'A');
}
async function provider(h, name) {
  h.elements.get(`provider-${name}`).click();
  await h.flush();
}
const expected = { profile: 'original', quality: '1080p', mediaMode: 'video', audioFormat: 'mp3', subtitles: false, subtitleLanguage: 'en', selection: null, targetBin: 'active', intent: 'download' };
const range = { start: 10, end: 20, label: 'Custom range' };
const cases = [
  ['a', async (h) => { await load(h); change(h, 'youtube-target-bin', 'clipdock'); await provider(h, 'social'); change(h, 'common-quality', '720p'); await provider(h, 'youtube'); }, { quality: '720p', targetBin: 'clipdock' }],
  ['a2', async (h) => { await load(h); change(h, 'youtube-target-bin', 'clipdock'); change(h, 'common-quality', '720p'); }, { quality: '720p', targetBin: 'clipdock' }],
  ['b', async (h) => { await load(h); change(h, 'common-profile', 'editing'); change(h, 'common-quality', '720p'); change(h, 'common-media-mode', 'audio'); change(h, 'youtube-target-bin', 'clipdock'); change(h, 'common-media-mode', 'video'); }, { profile: 'editing', quality: '720p', targetBin: 'clipdock' }],
  ['r1a', async (h) => { await load(h); change(h, 'youtube-profile', 'editing'); change(h, 'youtube-target-bin', 'clipdock'); change(h, 'youtube-intent', 'import'); h.elements.get('load-youtube-btn').click(); await h.flush(); }, { profile: 'editing', targetBin: 'clipdock', intent: 'import' }],
  ['r1b', async (h) => { await load(h); change(h, 'youtube-media-mode', 'audio'); change(h, 'youtube-audio-format', 'wav'); change(h, 'youtube-subtitles', true); change(h, 'youtube-subtitle-language', 'tr'); h.elements.get('load-youtube-btn').click(); await h.flush(); }, { quality: 'best', mediaMode: 'audio', audioFormat: 'wav', subtitles: true, subtitleLanguage: 'tr' }],
  ['r2', async (h) => { await load(h); await provider(h, 'social'); change(h, 'common-profile', 'editing'); change(h, 'common-target-bin', 'clipdock'); await provider(h, 'youtube'); }, { profile: 'editing', targetBin: 'clipdock' }],
  ['r2partial', async (h) => { await load(h); change(h, 'youtube-target-bin', 'clipdock'); await provider(h, 'social'); change(h, 'common-profile', 'editing'); change(h, 'common-audio-format', 'wav'); await provider(h, 'youtube'); }, { profile: 'editing', targetBin: 'clipdock', audioFormat: 'wav' }],
  ['rangeSame', async (h) => { await load(h); change(h, 'range-in', '10', 'input'); change(h, 'range-out', '20', 'input'); change(h, 'youtube-profile', 'editing'); await load(h); }, { profile: 'editing', selection: range }],
  ['rangeNew', async (h) => { await load(h); change(h, 'range-in', '10', 'input'); change(h, 'range-out', '20', 'input'); change(h, 'youtube-profile', 'editing'); await load(h, urlB); }, { profile: 'editing' }],
];

async function assertDownload(h, patch = {}, url = urlA) {
  h.elements.get('download-youtube-btn').click();
  await h.flush();
  assert.equal(h.downloads.length, 1);
  const wanted = { ...expected, ...patch };
  const request = h.downloads[0];
  assert.deepEqual(plain({ url: request.url, quality: request.quality, profile: request.profile, options: request.options }), {
    url, quality: wanted.quality, profile: wanted.profile,
    options: { mediaMode: wanted.mediaMode, audioFormat: wanted.audioFormat, subtitles: wanted.subtitles, subtitleLanguage: wanted.subtitleLanguage, selection: wanted.selection },
  });
  const item = h.test.queue()[0];
  assert.deepEqual(plain({ url: item.url, quality: item.quality, profile: item.profile, ...item.options, targetBin: item.targetBin, intent: item.intent }), { url, ...wanted });
}

for (const [name, sequence, patch] of cases) {
  test(`${name}: DOM edits produce the requested download and queue output`, async () => {
    const h = await boot();
    await sequence(h);
    await assertDownload(h, patch, name === 'rangeNew' ? urlB : urlA);
  });
}

test('keyed: a bin-only inspector edit names only the bin override', async () => {
  const h = await boot();
  change(h, 'youtube-search-input', 'shots', 'input');
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page);
  await h.flush();
  find(h.elements.get('youtube-search-results').children[0], (el) => el.dataset.cardAction === 'advanced').click();
  await h.flush();
  change(h, 'youtube-target-bin', 'clipdock');
  change(h, 'common-quality', '720p');
  const row = h.elements.get('youtube-search-results').children[0];
  assert.equal(row.dataset.override, 'true');
  assert.equal(find(row, (el) => el.dataset.field === 'output-source').title, 'Overrides: Target bin');
  await assertDownload(h, { quality: '720p', targetBin: 'clipdock' });
});
