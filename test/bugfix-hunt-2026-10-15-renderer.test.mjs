import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';
import { createFakeDom } from './helpers/fake-dom.mjs';

const fire = (element, type, event = {}) => element.listeners[type]?.({ type, ...event });
const find = (element, predicate) => {
  for (const child of element.children ?? []) {
    if (predicate(child)) return child;
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
};
const rows = (h) => h.elements.get('youtube-search-results').children;
const action = (row, name) => find(row, (e) => e.dataset?.cardAction === name);
const field = (row, name) => find(row, (e) => e.dataset?.field === name);
const metadata = (url, overrides = {}) => ({ id: new URL(url).searchParams.get('v'), title: 'Clip', duration: 200, channel: 'Channel', thumbnailDataUrl: null, heights: [1080, 720], formatSummary: [], chapters: [], ...overrides });
async function boot(overrides = {}) {
  const h = createHarness();
  h.api.loadYoutube = async (url) => metadata(url, overrides);
  await h.fireReady();
  return h;
}
async function search(h) {
  h.elements.get('youtube-search-input').value = 'shots';
  fire(h.elements.get('youtube-search-form'), 'submit');
  await h.flush();
  h.searches.at(-1).entry.resolve(h.page);
  await h.flush();
}
async function open(h, index = 0) {
  fire(find(rows(h)[index], (e) => e.className?.includes('youtube-details')), 'click', { detail: 1 });
  await h.flush();
}
function change(h, id, value) {
  h.elements.get(id).value = value;
  fire(h.elements.get(id), 'change');
}

test('bug 1: typed range text survives input and normalizes only on commit', async () => {
  const h = await boot(); await search(h); await open(h);
  const start = h.elements.get('range-in'), end = h.elements.get('range-out');
  for (const digit of '90') { start.value += digit; fire(start, 'input'); }
  assert.equal(start.value, '90');
  fire(start, 'change'); assert.equal(start.value, '1:30');
  start.value = '0'; fire(start, 'input'); fire(start, 'blur');
  for (const digit of '1:30') { end.value += digit; fire(end, 'input'); }
  assert.equal(end.value, '1:30');
  fire(end, 'keydown', { key: 'Enter' }); assert.equal(end.value, '1:30');
  start.value = '12.5'; fire(start, 'input'); assert.equal(start.value, '12.5');
  fire(start, 'change'); assert.equal(start.value, '0:12.5');
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  assert.equal(h.downloads[0].options.selection.start, 12.5);
  assert.equal(h.downloads[0].options.selection.end, 90);
});

test('bug 2: ruler End and far-right drag stay within fractional durations', async () => {
  for (const duration of [59.5, 125.7]) {
    const h = createHarness();
    const { makeElement } = createFakeDom({ bounds: { width: 600 } });
    for (const id of ['range-ruler', 'range-handle-in', 'range-handle-out', 'range-mode']) h.elements.set(id, makeElement('div', id));
    h.api.loadYoutube = async (url) => metadata(url, { duration });
    await h.fireReady(); await search(h); await open(h);
    fire(h.elements.get('range-handle-out'), 'keydown', { key: 'End' });
    assert.equal(h.elements.get('range-out').value, duration === 59.5 ? '0:59.5' : '2:05.7');
    assert.equal(h.elements.get('range-mode').textContent, 'Custom range');
    fire(h.elements.get('range-ruler'), 'pointerdown', { clientX: 600, target: h.elements.get('range-handle-out'), pointerId: 1 });
    fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
    assert.equal(h.downloads[0].options.selection.end, duration);
  }
});

test('bug 3: full and cleared manual ranges follow later common defaults', async () => {
  const h = await boot(); await search(h); await open(h);
  const start = h.elements.get('range-in');
  start.value = '5'; fire(start, 'input');
  fire(h.elements.get('range-full-btn'), 'click');
  assert.equal(Object.keys(h.test.cardOutputOverrides('youtube:aaaaaaaaaaa')).length, 0);
  start.value = '5'; fire(start, 'input'); start.value = ''; fire(start, 'input');
  assert.equal(Object.keys(h.test.cardOutputOverrides('youtube:aaaaaaaaaaa')).length, 0);
  change(h, 'common-intent', 'import');
  assert.equal(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa').intent, 'import');
  assert.equal(field(rows(h)[0], 'output-source').textContent, 'Common');
});

test('bug 4: URL edits clear visible chapter selection along with range state', async () => {
  const h = await boot({ chapters: [{ start: 0, end: 30, title: 'Intro' }, { start: 30, end: 200, title: 'Main' }] });
  await search(h); await open(h);
  const chapter = h.elements.get('chapter-list').children[1].children[0];
  chapter.checked = true; fire(chapter, 'change');
  assert.equal(h.elements.get('range-in').value, '0:30');
  const url = h.elements.get('youtube-url'), original = url.value;
  url.value += 'x'; fire(url, 'input'); url.value = original; fire(url, 'input');
  assert.equal(h.elements.get('chapter-list').children[1].children[0].checked, false);
  assert.equal(h.elements.get('range-in').value, '');
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  assert.equal(h.downloads[0].options.selection, null);
});

test('bug 5: inspector edits during bulk metadata loading reach queued output', async () => {
  const h = await boot(); await search(h); await open(h);
  fire(h.elements.get('select-all-results-btn'), 'click');
  const pending = [];
  h.api.loadYoutube = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  fire(h.elements.get('enqueue-selected-btn'), 'click'); await h.flush();
  change(h, 'youtube-profile', 'editing'); change(h, 'youtube-intent', 'import');
  assert.equal(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa').profile, 'editing');
  assert.equal(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa').intent, 'import');
  pending[0].resolve(metadata(pending[0].url)); await h.flush();
  pending[1].resolve(metadata(pending[1].url)); await h.flush();
  const queued = h.test.queue().find((item) => item.videoId === 'aaaaaaaaaaa');
  assert.equal(queued.profile, 'editing'); assert.equal(queued.intent, 'import');
});

test('bug 6: card, bulk and inspector resolve the same preferred quality', async () => {
  const h = await boot(); await search(h); await open(h);
  change(h, 'youtube-quality', '720p');
  assert.equal(field(rows(h)[1], 'quality').value, '720p');
  fire(action(rows(h)[1], 'enqueue'), 'click'); await h.flush();
  assert.equal(h.test.queue()[0].quality, '720p');
  await open(h, 1);
  assert.equal(h.elements.get('youtube-quality').value, '720p');
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  assert.equal(h.test.queue().length, 1);
  fire(h.elements.get('select-all-results-btn'), 'click');
  fire(h.elements.get('enqueue-selected-btn'), 'click'); await h.flush();
  assert.equal(h.test.queue().length, 2);
  assert.deepEqual(Array.from(h.test.queue(), (item) => item.quality), ['720p', '720p']);
});

const historyRecord = { id: 'r1', provider: 'youtube', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', project: null, fileName: 'clip.mp4', bytes: 10, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source: '', selection: null, chapters: [] }, createdAt: 1, lastUsedAt: 1, available: true, cardId: 'card-1' };
async function showHistory(h) {
  h.test.setSurface('library'); await h.flush();
  return h.elements.get('history-list');
}
test('bug 7: Library handoff uses common bin rather than inspected item bin', async () => {
  const h = await boot();
  h.api.historyList = async () => [historyRecord];
  h.api.historyReuse = async () => ({ cardId: 'card-1', fileName: 'clip.mp4' });
  await search(h); await open(h); change(h, 'youtube-target-bin', 'clipdock');
  const list = await showHistory(h);
  fire(find(list, (e) => e.dataset?.icon === 'pool'), 'click'); await h.flush();
  assert.equal(h.transfers[0].bin, 'active');
});

test('bug 8: detached inspector edits do not persist common defaults', async () => {
  const h = await boot();
  h.elements.get('youtube-url').value = h.page.results[0].url;
  fire(h.elements.get('load-youtube-btn'), 'click'); await h.flush();
  const before = h.preferenceWrites.length;
  change(h, 'youtube-profile', 'editing'); change(h, 'youtube-target-bin', 'clipdock');
  assert.equal(h.elements.get('youtube-profile').value, 'editing');
  assert.deepEqual(h.preferenceWrites.slice(before), []);
  const restarted = createHarness({ preferencesInit: Object.fromEntries(h.preferences) });
  await restarted.fireReady();
  assert.equal(restarted.elements.get('common-profile').value, 'original');
  assert.equal(restarted.elements.get('common-target-bin').value, 'active');
});

test('bug 9: another download does not lock inspected subtitle language', async () => {
  const h = await boot(); await search(h); await open(h);
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  assert.equal(h.downloads.length, 1);
  await open(h, 1);
  h.elements.get('youtube-subtitles').checked = true;
  fire(h.elements.get('youtube-subtitles'), 'change');
  assert.equal(h.elements.get('youtube-subtitle-language').disabled, false);
  change(h, 'youtube-subtitle-language', 'fr');
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  assert.equal(h.test.queue()[1].options.subtitleLanguage, 'fr');
  assert.equal(h.downloads[0].options.subtitleLanguage, 'en');
});

test('bug 10: stale YouTube and Pexels clicks cannot open an inspector during search', async (t) => {
  for (const provider of ['youtube', 'pexels']) await t.test(provider, async () => {
    const h = createHarness();
    const pages = [], loads = [];
    h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: false, message: '' });
    h.api.loadYoutube = async (url) => { loads.push(url); return metadata(url); };
    await h.fireReady();
    const asset = (id) => ({ id, kind: 'video', title: `P${id}`, creator: 'Creator', creatorUrl: null, sourceUrl: `https://www.pexels.com/video/${id}`, duration: 5, width: 1920, height: 1080, thumbnailDataUrl: null, previewUrl: 'https://example.com/video.mp4', files: [{ id: `f${id}`, url: 'https://example.com/video.mp4', width: 1920, height: 1080, label: '1080p', mime: 'video/mp4', size: 1 }] });
    if (provider === 'pexels') {
      h.api.searchPexels = () => new Promise((resolve) => pages.push(resolve));
      h.api.loadPexels = async (kind, id) => { loads.push(id); return asset(id); };
      fire(h.elements.get('provider-pexels'), 'click');
    }
    h.elements.get('youtube-search-input').value = 'first';
    fire(h.elements.get('youtube-search-form'), 'submit'); await h.flush();
    const resolveSearch = (second = false) => provider === 'youtube'
      ? h.searches.at(-1).entry.resolve(h.page)
      : pages.at(-1)({ query: 'shots', page: 1, pageSize: 10, results: second ? [asset(3)] : [asset(1), asset(2)], hasPrevious: false, hasNext: false, totalResults: second ? 1 : 2 });
    resolveSearch(); await h.flush();
    h.elements.get('youtube-search-input').value = 'second';
    fire(h.elements.get('youtube-search-form'), 'submit'); await h.flush();
    await open(h, 1);
    resolveSearch(true); await h.flush();
    assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'true', provider);
    assert.equal(loads.length, 0, provider);
    assert.equal(h.elements.get('download-youtube-btn').disabled, true, provider);
  });
});

test('bug 11: result actions and accessible names use English', async () => {
  const h = await boot(); await search(h);
  const first = rows(h)[0];
  assert.equal(action(first, 'options').textContent, 'Download options');
  assert.equal(action(first, 'enqueue').textContent, 'Add to queue');
  assert.equal(action(first, 'enqueue').getAttribute('aria-label'), 'Add to queue: A');
  assert.equal(action(first, 'now').textContent, 'Download now');
  assert.equal(action(first, 'now').getAttribute('aria-label'), 'Download now: A');
  fire(action(first, 'enqueue'), 'click'); await h.flush();
  assert.equal(action(rows(h)[1], 'now').textContent, 'Download next');
  assert.equal(action(rows(h)[1], 'now').getAttribute('aria-label'), 'Download next: B');
});

test('bug 12: history deletion invalidates matching session downloads and handoff actions', async () => {
  const h = await boot(); await search(h); await open(h);
  const drags = [];
  h.api.startNativeDrag = (ids) => drags.push(ids);
  h.api.historyList = async () => [historyRecord];
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  h.downloads[0].resolve({ cardId: 'card-1', fileName: 'clip.mp4', subtitle: { cardId: 'subtitle-1', fileName: 'clip.en.srt' } }); await h.flush();
  await open(h, 1); fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  h.downloads[1].resolve({ cardId: 'card-2', fileName: 'other.mp4' }); await h.flush();
  const queueRow = (id) => h.elements.get('youtube-download-queue').children.find((row) => row.dataset.queueId === id);
  const firstId = h.test.queue()[0].queueId, secondId = h.test.queue()[1].queueId;
  const staleRow = queueRow(firstId), staleImport = find(staleRow, (e) => e.dataset?.icon === 'pool');
  let list = await showHistory(h);
  h.api.historyDelete = async () => ({ deleted: true, removed: true });
  fire(find(list, (e) => e.textContent === 'Delete'), 'click'); await h.flush();
  assert.equal(queueRow(firstId).draggable, true, 'absent field preserves existing behavior');
  h.api.historyDelete = async () => ({ deleted: true, removed: true, removedCardIds: ['card-1'] });
  list = h.elements.get('history-list');
  fire(find(list, (e) => e.textContent === 'Delete'), 'click'); await h.flush();
  const deleted = queueRow(firstId);
  assert.equal(field(deleted, 'status').textContent, 'File deleted. Download again to use this item.');
  assert.equal(deleted.draggable, false);
  assert.equal(find(deleted, (e) => e.dataset?.icon === 'pool').disabled, true);
  assert.equal(find(deleted, (e) => e.dataset?.icon === 'tl').disabled, true);
  assert.equal(field(deleted, 'subtitle-artifact').draggable, false);
  assert.equal(field(deleted, 'selection').disabled, true);
  assert.equal(queueRow(secondId).draggable, true);
  fire(staleImport, 'click'); fire(staleRow, 'dragstart', { dataTransfer: { setData() {} } }); await h.flush();
  assert.equal(h.transfers.length, 0); assert.deepEqual(drags, []);
  fire(find(deleted, (e) => e.dataset?.icon === 'dl'), 'click'); await h.flush();
  assert.equal(h.downloads.length, 3);
  h.downloads[2].resolve({ cardId: 'card-3', fileName: 'new.mp4' }); await h.flush();
  assert.equal(queueRow(h.test.queue().at(-1).queueId).draggable, true);
});
