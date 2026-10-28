import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHarness } from './helpers/renderer-harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YtdlpWorker } from '../dist/ytdlp.js';
import { GalleryDlWorker } from '../dist/gallerydl.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('ytdlp search cache stores pristine results; page1→page2→page1 returns page1 thumbnails via copy', async () => {
  const root = tempRoot('clipdock-ytdlp-search-');
  try {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `abc${String(i).padStart(8, '0')}`,
      title: `Video ${i}`,
      channel: `Channel ${i}`,
      duration: 60,
      channel_is_verified: false,
      live_status: 'not_live',
      availability: 'public',
    }));
    const dummySpawn = () => { throw new Error('should not spawn on cache hit'); };
    const fetcher = async () => ({
      ok: true, status: 200, url: 'https://i.ytimg.com/vi/abc00000000/maxresdefault.jpg',
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff]),
    });
    const worker = new YtdlpWorker('/fake/yt-dlp', dummySpawn, fetcher, { sessionDir: root });
    const pristine = entries.slice(0, 12).map(e => ({
      id: e.id,
      title: e.title,
      channel: e.channel,
      duration: 60,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      viewCount: null,
      publishedAt: null,
      channelVerified: false,
    }));
    const key = 'test query';
    const cacheKey = key.toLocaleLowerCase('en-US');
    worker.searchCache.set(cacheKey, { query: key, createdAt: Date.now(), results: pristine });
    assert.equal(worker.searchCache.get(cacheKey).results[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg');
    const page1 = await worker.search(key, 1);
    const cachedAfterPage1 = worker.searchCache.get(cacheKey).results;
    assert.equal(cachedAfterPage1[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg', 'cached results must stay pristine after page1');
    assert.equal(page1.results[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg');
    assert.equal(page1.results.length, 10);
    const page2 = await worker.search(key, 2);
    const cachedAfterPage2 = worker.searchCache.get(cacheKey).results;
    assert.equal(cachedAfterPage2[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg', 'cached must stay pristine after page2');
    assert.equal(page2.results.length, 2);
    const page1Again = await worker.search(key, 1);
    assert.equal(page1Again.results[0].id, page1.results[0].id);
    assert.equal(page1Again.results[0].thumbnailUrl, page1.results[0].thumbnailUrl, 'page1 again must return same thumbnails as first page1');
    assert.notEqual(page1Again.results[0], page1.results[0], 'must be a copy, not same object reference as previous page1');
    assert.notEqual(page1Again.results[0], cachedAfterPage1[0], 'must be copy, not cached object');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gallery-dl search cache stores pristine; thumbnail injection mutates copy', async () => {
  const root = tempRoot('clipdock-gallery-search-');
  try {
    const dummySpawn = () => { throw new Error('should not spawn'); };
    const worker = new GalleryDlWorker('/fake/gallery-dl', dummySpawn, { sessionDir: root, fetcher: async () => ({ ok: true, status: 200, url: 'https://i.pinimg.com/thumb.jpg', headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from([0xff,0xd8,0xff]) }) });
    const results = Array.from({ length: 20 }, (_, i) => ({
      id: String(100 + i),
      title: `Pin ${i}`,
      creator: null,
      kind: 'image',
      url: `https://www.pinterest.com/pin/${100+i}/`,
      thumbnailUrl: null,
    }));
    const thumbnailUrls = new Map(results.map(r => [r.id, `https://i.pinimg.com/${r.id}.jpg`]));
    const key = 'ocean';
    worker.searchCache.set(key, { query: key, createdAt: Date.now(), results, thumbnailUrls, snapshots: [] });
    assert.equal(worker.searchCache.get(key).results[0].thumbnailUrl, null);
    const page1 = await worker.search(key, 1);
    assert.equal(worker.searchCache.get(key).results[0].thumbnailUrl, null, 'gallery cache must stay pristine');
    const page2 = await worker.search(key, 2);
    assert.equal(worker.searchCache.get(key).results[0].thumbnailUrl, null);
    const page1Again = await worker.search(key, 1);
    assert.equal(page1Again.results[0].thumbnailUrl, page1.results[0].thumbnailUrl);
    assert.notEqual(page1Again.results[0], page1.results[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('streamed first page is a copy and successful thirty-result cache serves all three pages', async () => {
  const root = tempRoot('clipdock-ytdlp-stream-');
  const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => true;
  let spawns = 0; const snapshots = [];
  const worker = new YtdlpWorker('/fake/yt-dlp', () => { spawns++; return proc; }, undefined, {sessionDir: root});
  try {
    const entries = Array.from({length: 30}, (_, i) => ({id: `abc${String(i).padStart(8, '0')}`, title: `Video ${i}`}));
    const emit = entries => proc.stdout.emit('data', entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const pending = worker.search('test query', 1, page => snapshots.push(page));
    emit(entries.slice(0, 10));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].results[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg');
    assert.equal(worker.searchCache.get('test query'), null);
    snapshots[0].results[0].thumbnailUrl = null;
    emit(entries.slice(10)); proc.emit('close', 0);
    const first = await pending;
    assert.deepEqual([first.results.length, first.totalResults, first.pageCount], [10, 30, 3]);
    first.results[0].thumbnailUrl = null;
    const second = await worker.search('test query', 2);
    const third = await worker.search('test query', 3);
    const again = await worker.search('test query', 1);
    assert.deepEqual([spawns, second.results.length, second.results[0].id, third.results.length, third.results[0].id, third.hasNext], [1, 10, 'abc00000010', 10, 'abc00000020', false]);
    assert.equal(again.results[0].thumbnailUrl, 'https://i.ytimg.com/vi/abc00000000/mqdefault.jpg');
  } finally { await worker.dispose(); rmSync(root, {recursive: true, force: true}); }
});

const fire = (h, id, type) => h.elements.get(id).listeners[type]?.({preventDefault() {}});
async function searchHarness() {
  const h = createHarness(); const requests = []; let listener; let cancellations = 0;
  const fixtures = h.page.results;
  h.page.results = Array.from({length: 10}, (_, i) => ({...fixtures[i % fixtures.length], id: `search${String(i + 1).padStart(5, '0')}`}));
  h.api.searchYoutube = (query, page, generation) => new Promise((resolve, reject) => requests.push({query, page, generation, resolve, reject}));
  h.api.onYoutubeSearchPage = callback => { listener = callback; return () => { listener = undefined; }; };
  h.api.cancelYoutubeSearch = async () => { cancellations++; return true; };
  await h.fireReady();
  const submit = query => { h.elements.get('youtube-search-input').value = query; fire(h, 'youtube-search-form', 'submit'); return requests.at(-1); };
  const partial = (request, title = 'First result') => listener({generation: request.generation, page: {...h.page, query: request.query, results: h.page.results.map((item, i) => ({...item, title: i === 0 ? title : item.title})), totalResults: null, pageCount: null, hasNext: false}});
  return {h, requests, submit, partial, cancellations: () => cancellations};
}

test('YouTube renders generation-tagged first page early, keeps rows on final reply, then enables Next', async () => {
  const {h, requests, submit, partial} = await searchHarness();
  const request = submit('first query'); partial(request);
  const firstRow = h.elements.get('youtube-search-results').children[0];
  assert.equal(h.elements.get('youtube-search-results').children.length, 10);
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Page 1 · 10 results so far · Collecting more…');
  assert.equal(h.elements.get('youtube-search-next').disabled, true);
  assert.equal(h.elements.get('youtube-search-input').disabled, false);
  request.resolve({...h.page, results: h.page.results.map((item, i) => ({...item, title: i === 0 ? 'First result' : item.title})), totalResults: 30, pageCount: 3, hasNext: true}); await h.flush();
  assert.equal(h.elements.get('youtube-search-results').children[0], firstRow, 'final totals must not reload first-page thumbnails');
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Page 1 of 3 · 30 results');
  assert.equal(h.elements.get('youtube-search-next').disabled, false);
  fire(h, 'youtube-search-next', 'click');
  assert.deepEqual([requests.length, requests[1].query, requests[1].page], [2, 'first query', 2]);
  requests[1].resolve({...h.page, page: 2}); await h.flush();
});

test('typing cancels background YouTube collection and stale partial/final replies cannot overwrite a new search', async () => {
  const {h, submit, partial, cancellations} = await searchHarness();
  const first = submit('first query'); partial(first);
  h.elements.get('youtube-search-input').value = 'second query'; fire(h, 'youtube-search-input', 'input');
  assert.equal(cancellations(), 1);
  assert.equal(h.elements.get('youtube-search-results').children.length, 0);
  const second = submit('second query'); partial(second, 'Current result');
  const row = h.elements.get('youtube-search-results').children[0];
  partial(first, 'Stale result'); first.resolve({...h.page, query: 'first query'}); await h.flush();
  assert.equal(h.elements.get('youtube-search-results').children[0], row);
  assert.equal(row.dataset.resultTitle, 'Current result');
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Page 1 · 10 results so far · Collecting more…');
  second.reject(new Error('Could not search YouTube.')); await h.flush();
  assert.equal(h.elements.get('youtube-search-results').children[0], row);
  assert.equal(h.elements.get('youtube-search-next').disabled, true);
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Could not search YouTube. · Showing 10 results; retry to load more.');
  h.test.renderSearchResults();
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Could not search YouTube. · Showing 10 results; retry to load more.');
});

test('leaving YouTube cancels collection and restored first page reports the interrupted search', async () => {
  const {h, submit, partial, cancellations} = await searchHarness();
  const request = submit('switch query'); partial(request);
  fire(h, 'provider-social', 'click');
  assert.equal(cancellations(), 1);
  partial(request, 'Stale result');
  fire(h, 'provider-youtube', 'click');
  request.resolve({...h.page, totalResults: 30, pageCount: 3, hasNext: true}); await h.flush();
  assert.equal(h.elements.get('youtube-search-results').children.length, 10);
  assert.equal(h.elements.get('youtube-search-results').children[0].dataset.resultTitle, 'First result');
  assert.equal(h.elements.get('youtube-search-status').textContent, 'Search cancelled. · Showing 10 results; retry to load more.');
  assert.equal(h.elements.get('youtube-search-next').disabled, true);
});
