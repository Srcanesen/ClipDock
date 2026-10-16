import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YtdlpWorker } from '../dist/ytdlp.js';

function child() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { queueMicrotask(() => c.emit('close', 143)); return true; }; return c; }
test('YouTube listing resolves without fetching thumbnails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-immediate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let fetches = 0;
  const worker = new YtdlpWorker('/fixture/yt-dlp', () => { const c = child(); queueMicrotask(() => { c.stdout.emit('data', JSON.stringify({ entries: [{ id: 'dQw4w9WgXcQ', title: 'Immediate' }] })); c.emit('close', 0); }); return c; }, async () => { fetches++; throw new Error('No thumbnail network allowed'); }, { sessionDir: root, ffmpegPath: null });
  const page = await worker.search('clips', 1);
  assert.equal(fetches, 0);
  assert.equal(page.results[0].thumbnailUrl, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
});

const urlFor = id => `https://www.youtube.com/watch?v=${id}`;
function metadataWorker(t, behavior, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-metadata-cache-'));
  const calls = [];
  const worker = new YtdlpWorker('/fixture/yt-dlp', (_binary, args) => {
    const c = child(); const id = new URL(args.at(-1)).searchParams.get('v'); calls.push({id, c});
    behavior(c, id, calls.length); return c;
  }, async () => { throw new Error('metadata must not fetch images'); }, {sessionDir: root, ffmpegPath: null, killGraceMs: 1, ...options});
  t.after(async () => { await worker.dispose(); rmSync(root, {recursive: true, force: true}); });
  return {worker, calls};
}
function finish(c, id, code = 0) { c.stdout.emit('data', JSON.stringify({id, title: `Video ${id}`, formats: [{height: 720}]})); c.emit('close', code); }

test('YouTube metadata joins canonical in-flight calls, clones cache values and expires at 10 minutes', async t => {
  let now = 0;
  const {worker, calls} = metadataWorker(t, () => {}, {now: () => now});
  const first = worker.metadata('https://youtu.be/dQw4w9WgXcQ');
  const second = worker.metadata(urlFor('dQw4w9WgXcQ'));
  assert.equal(calls.length, 1);
  finish(calls[0].c, 'dQw4w9WgXcQ');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.title, 'Video dQw4w9WgXcQ'); assert.equal(b.title, a.title);
  a.heights.push(4320); b.title = 'mutated';
  const cached = await worker.metadata(urlFor('dQw4w9WgXcQ'));
  assert.deepEqual(cached.heights, [720]); assert.equal(cached.title, 'Video dQw4w9WgXcQ'); assert.equal(calls.length, 1);
  now = 600000;
  const expired = worker.metadata(urlFor('dQw4w9WgXcQ'));
  assert.equal(calls.length, 2); finish(calls[1].c, 'dQw4w9WgXcQ');
  assert.equal((await expired).title, 'Video dQw4w9WgXcQ');
});

test('YouTube metadata LRU keeps 30 replies and refreshes on access', async t => {
  const {worker, calls} = metadataWorker(t, (c, id) => queueMicrotask(() => finish(c, id)));
  const id = n => `clip${String(n).padStart(7, '0')}`;
  for (let n = 0; n < 30; n++) await worker.metadata(urlFor(id(n)));
  await worker.metadata(urlFor(id(0)));
  await worker.metadata(urlFor(id(30)));
  assert.equal(calls.length, 31);
  await worker.metadata(urlFor(id(0))); assert.equal(calls.length, 31);
  await worker.metadata(urlFor(id(1))); assert.equal(calls.length, 32);
});

test('YouTube failed prefetch is silent and retried by explicit metadata', async t => {
  const {worker, calls} = metadataWorker(t, (c, id, count) => queueMicrotask(() => finish(c, id, count === 1 ? 1 : 0)));
  await worker.prefetchMetadata(urlFor('aaaaaaaaaaa'));
  assert.equal((await worker.metadata(urlFor('aaaaaaaaaaa'))).id, 'aaaaaaaaaaa');
  assert.equal(calls.length, 2);
});

test('YouTube explicit B completes during hanging prefetch A; explicit A joins and extra prefetches are dropped', {timeout: 2000}, async t => {
  const {worker, calls} = metadataWorker(t, (c, id) => { if (id === 'bbbbbbbbbbb') queueMicrotask(() => finish(c, id)); });
  const prefetch = worker.prefetchMetadata(urlFor('aaaaaaaaaaa'));
  await worker.prefetchMetadata(urlFor('ccccccccccc'));
  const same = worker.metadata(urlFor('aaaaaaaaaaa'));
  assert.equal(calls.length, 1);
  const other = await worker.metadata(urlFor('bbbbbbbbbbb'));
  assert.equal(other.title, 'Video bbbbbbbbbbb'); assert.equal(calls.length, 2);
  finish(calls[0].c, 'aaaaaaaaaaa'); await prefetch;
  assert.equal((await same).id, 'aaaaaaaaaaa');
  assert.equal((await worker.metadata(urlFor('aaaaaaaaaaa'))).id, 'aaaaaaaaaaa'); assert.equal(calls.length, 2);
});

import {readFileSync} from 'node:fs';
import {youtubeThumbnail} from '../dist/ytdlp.js';
import {runInNewContext} from 'node:vm';

test('YouTube image selection prefers adequate allowlisted sizes and rejects host/protocol tricks', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(youtubeThumbnail({thumbnails: [{width: 480, url: 'https://i.ytimg.com/480.jpg'}, {width: 320, url: 'https://i.ytimg.com/320.jpg'}, {width: 120, url: 'https://i.ytimg.com/120.jpg'}]}, id), 'https://i.ytimg.com/320.jpg');
  assert.equal(youtubeThumbnail({thumbnails: [{width: 320, url: 'https://evil.test/320.jpg'}]}, id), null);
  for (const thumbnail of ['https://i.ytimg.com.evil.test/x', 'http://i.ytimg.com/x', 'https://user@i.ytimg.com/x']) assert.equal(youtubeThumbnail({thumbnail}, id), null);
});

test('image CSP permits exactly self, data and the three provider image hosts', () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.deepEqual(policy.split(';').map(x => x.trim()).filter(x => x.startsWith('img-src ')), ["img-src 'self' data: https://i.ytimg.com https://images.pexels.com https://i.pinimg.com"]);
});

test('renderer prefetch waits 300 ms and cancels on leave, blur and result replacement', async () => {
  const timers = new Map(); let next = 0; const calls = [];
  const context = {window: {addEventListener() {}, setTimeout(fn, ms) {timers.set(++next, {fn, ms}); return next;}, clearTimeout(id) {timers.delete(id);}, clipdockAPI: {prefetchYoutube: async url => calls.push(url)}}, document: {}, console};
  runInNewContext(readFileSync(new URL('../dist/renderer.js', import.meta.url), 'utf8'), context);
  const listeners = {}; context.wireMetadataPrefetch({addEventListener: (name, fn) => {listeners[name] = fn;}}, urlFor('aaaaaaaaaaa'));
  listeners.mouseenter(); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 300); assert.deepEqual(calls, []);
  listeners.mouseleave(); assert.equal(timers.size, 0);
  listeners.focusin(); listeners.focusout(); assert.equal(timers.size, 0);
  listeners.focusin(); const timer = [...timers.values()][0]; timers.clear(); timer.fn(); await Promise.resolve();
  assert.deepEqual(calls, [urlFor('aaaaaaaaaaa')]);
  listeners.mouseenter(); context.clearMetadataPrefetchTimers(); assert.equal(timers.size, 0);
});

import {createFakeDom} from './helpers/fake-dom.mjs';
test('result images load lazily and asynchronously, then remove failed images in favor of the local fallback', () => {
  const {makeElement} = createFakeDom();
  const context = {window: {addEventListener() {}}, document: {createElement: makeElement}, console};
  runInNewContext(readFileSync(new URL('../dist/renderer.js', import.meta.url), 'utf8'), context);
  const target = makeElement('span');
  context.appendResultThumbnail(target, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', 'Clip');
  const image = target.children[0];
  assert.equal(image.src, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(image.loading, 'lazy'); assert.equal(image.decoding, 'async');
  assert.equal(image.className, 'thumbnail-pending');
  const play = makeElement('button'); play.textContent = 'Play'; target.append(play);
  image.listeners.error();
  assert.equal(target.children.includes(image), false);
  assert.equal(target.children.includes(play), true);
  assert.equal(target.children.at(-1).textContent, 'Thumbnail unavailable');
  assert.equal(target.getAttribute('aria-label'), 'Thumbnail unavailable for Clip');
});
