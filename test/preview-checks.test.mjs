import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transpilePreviewAdapter } from '../scripts/lib/preview-adapter.mjs';
import { createFakeDom } from './helpers/fake-dom.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapter = transpilePreviewAdapter(root);
function preview(mode) {
  const dom = createFakeDom(); const elements = new Map(); const events = []; const timers = []; const listeners = {};
  for (const id of ['youtube-search-input', 'youtube-search-form', 'youtube-search-results', 'youtube-quality', 'download-youtube-btn', 'provider-pinterest']) elements.set(id, dom.makeElement('div', id));
  elements.get('youtube-search-form').requestSubmit = () => events.push('search');
  elements.get('download-youtube-btn').listeners.click = () => events.push('download');
  elements.get('provider-pinterest').listeners.click = () => events.push('pinterest');
  for (const index of [0, 1]) { const row = dom.makeElement('button'); row.listeners.click = () => events.push(`result-${index}`); elements.get('youtube-search-results').append(row); }
  const window = { location: { search: `?preview=${mode}` }, addEventListener: (type, callback) => { listeners[type] = callback; } };
  runInNewContext(adapter, { window, document: { getElementById: (id) => elements.get(id) ?? null }, URLSearchParams, Date, Math, setTimeout: (callback, delay) => { timers.push({ callback, delay }); } });
  const flush = async () => { for (let turn = 0; turn < 20; turn += 1) { for (const timer of timers.splice(0)) timer.callback(); await Promise.resolve(); } };
  return { api: window.clipdockAPI, elements, events, timers, listeners, flush };
}

test('ready preview returns 4K, synthetic thumbnails, totals and requested pin state', async () => {
  const f = preview('ready');
  const metadata = await f.api.loadYoutube('url');
  assert.deepEqual(Array.from(metadata.heights), [360, 720, 1080, 1440, 2160]);
  assert.equal(metadata.thumbnailUrl.startsWith('data:image/svg+xml'), true);
  const page = await f.api.searchYoutube('editing workflow', 1);
  assert.deepEqual([page.results.length, page.totalResults, page.pageCount], [10, 23, 3]);
  assert.deepEqual(Object.keys(page.results[0]).sort(), ['channel', 'channelVerified', 'duration', 'id', 'publishedAt', 'thumbnailUrl', 'title', 'url', 'viewCount']);
  assert.deepEqual([await f.api.setAlwaysOnTop(true), await f.api.setAlwaysOnTop(false)], [true, false]);
});

for (const [profile, suffix, states] of [
  ['original', '.mp4', ['downloading', 'completed']],
  ['fast', '.resolve.mp4', ['downloading', 'processing', 'completed']],
  ['editing', '.resolve.mov', ['downloading', 'processing', 'completed']],
]) test(`preview ${profile} download reaches its profile-specific completion`, async () => {
  const f = preview('ready'); const events = []; f.api.onYoutubeEvent((event) => events.push(event.state));
  const pending = f.api.downloadYoutube('url', '2160p', profile, 'job', { mediaMode: 'video', subtitles: false });
  await f.flush(); const result = await pending;
  assert.equal(result.fileName, `Preview video [dQw4w9WgXcQ]${suffix}`);
  assert.deepEqual(events, states);
});

for (const mode of ['loading', 'empty', 'error']) test(`preview ${mode} automatically submits its named search state`, async () => {
  const f = preview(mode); f.listeners.DOMContentLoaded(); await f.flush();
  assert.deepEqual(f.events, ['search']);
  if (mode === 'error') await assert.rejects(f.api.searchYoutube('editing workflow', 1), /Preview fixture: search unavailable/);
  else {
    const pending = f.api.searchYoutube('editing workflow', 1);
    if (mode === 'loading') assert.equal(f.timers[0].delay, 900);
    await f.flush(); const page = await pending;
    assert.equal(page.results.length, mode === 'empty' ? 0 : 10);
    assert.equal(page.pageCount, mode === 'empty' ? 1 : 3);
  }
});

test('queue preview submits and queues two results at 4K', async () => {
  const f = preview('queue'); f.listeners.DOMContentLoaded(); await f.flush();
  assert.deepEqual(f.events, ['search', 'result-0', 'download', 'result-1', 'download']);
  assert.equal(f.elements.get('youtube-quality').value, '2160p');
});

test('Pinterest search preview switches provider, submits, selects and queues a result', async () => {
  const f = preview('pinterest-search'); f.listeners.DOMContentLoaded(); await f.flush();
  assert.deepEqual(f.events, ['pinterest', 'search', 'result-0', 'download']);
  const page = await f.api.searchPinterest('editing workflow', 1);
  assert.equal(page.results.length, 10);
  assert.equal(page.results[0].url.startsWith('https://www.pinterest.com/pin/'), true);
});

test('slow preview delays listing by 2500ms and metadata by 2000ms for each searchable provider', async () => {
  const f = preview('slow');
  for (const [search, load] of [
    [() => f.api.searchYoutube('clips', 1), () => f.api.loadYoutube('url')],
    [() => f.api.searchPexels('video', 'clips', 1), () => f.api.loadPexels('video', 101)],
    [() => f.api.searchPinterest('clips', 1), () => f.api.loadPinterest('https://www.pinterest.com/pin/123456789/')],
  ]) {
    const listing = search(); assert.equal(f.timers[0].delay, 2500); await f.flush();
    const page = await listing; assert.ok(page.results.length > 0);
    const detail = load(); assert.equal(f.timers[0].delay, 2000); await f.flush();
    assert.ok((await detail).title);
  }
});
