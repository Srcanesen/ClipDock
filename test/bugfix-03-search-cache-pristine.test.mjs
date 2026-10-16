import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    worker.searchCache.set(key, { query: key, createdAt: Date.now(), results, thumbnailUrls });
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
