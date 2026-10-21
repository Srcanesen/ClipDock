import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {PixabayClient, parsePixabayPage, safePixabayExternal, safePixabayUrl} from '../dist/pixabay.js';
import {MacKeychainPexelsCredentialStore, PEXELS_CREDENTIAL, PIXABAY_CREDENTIAL} from '../dist/pexels-credential.js';
import {safeHistorySource} from '../dist/history.js';
import {IPC_CHANNELS, PRELOAD_API_METHODS} from '../scripts/lib/contracts.mjs';

const KEY = '12345678-0123456789abcdef0123456789ab';
// Shape from https://pixabay.com/api/docs/ (Search Videos response); `large` is empty when unavailable.
const hit = (id, large = true) => ({
  id, pageURL: `https://pixabay.com/videos/ocean-waves-${id}/`, type: 'film', tags: 'ocean, waves, beach', duration: 12,
  videos: {
    large: large ? {url: `https://cdn.pixabay.com/video/2024/01/01/${id}_large.mp4`, width: 1920, height: 1080, size: 9000000, thumbnail: `https://cdn.pixabay.com/video/2024/01/01/${id}_large.jpg`} : {url: '', width: 0, height: 0, size: 0, thumbnail: ''},
    medium: {url: `https://cdn.pixabay.com/video/2024/01/01/${id}_medium.mp4`, width: 1280, height: 720, size: 4000000, thumbnail: `https://cdn.pixabay.com/video/2024/01/01/${id}_medium.jpg`},
    small: {url: `https://cdn.pixabay.com/video/2024/01/01/${id}_small.mp4`, width: 960, height: 540, size: 2000000, thumbnail: `https://cdn.pixabay.com/video/2024/01/01/${id}_small.jpg`},
    tiny: {url: `https://cdn.pixabay.com/video/2024/01/01/${id}_tiny.mp4`, width: 640, height: 360, size: 900000, thumbnail: `https://cdn.pixabay.com/video/2024/01/01/${id}_tiny.jpg`},
  },
  views: 10, downloads: 5, likes: 1, comments: 0, user_id: 42, user: 'Ada', userImageURL: '',
});
const json = (value, headers = {}) => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json', ...headers}});

function fixture(t, fetch, now = () => 1_000_000) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-pixabay-'));
  const client = new PixabayClient(path.join(root, 'pixabay'), fetch, {now});
  t.after(async () => { await client.dispose(); rmSync(root, {recursive: true, force: true}); });
  client.setKey(KEY, false);
  return {client, directory: path.join(root, 'pixabay')};
}

test('a docs-shaped Pixabay page parses into video assets and drops an empty large rendition', () => {
  const page = parsePixabayPage({total: 40, totalHits: 40, hits: [hit(7, false), hit(8)]}, 'ocean', 1);
  const [first, second] = page.results;
  assert.deepEqual(first.files.map(file => [file.id, file.label, file.size]), [['medium', 'Medium · 1280×720', 4000000], ['small', 'Small · 960×540', 2000000], ['tiny', 'Tiny · 640×360', 900000]]);
  assert.deepEqual(second.files.map(file => file.id), ['large', 'medium', 'small', 'tiny']);
  assert.equal(first.kind, 'video');
  assert.equal(first.title, 'Ocean, waves, beach');
  assert.equal(first.creator, 'Ada');
  assert.equal(first.sourceUrl, 'https://pixabay.com/videos/ocean-waves-7/');
  assert.equal(first.thumbnailUrl, 'https://cdn.pixabay.com/video/2024/01/01/7_small.jpg');
  assert.equal(first.previewUrl, 'https://cdn.pixabay.com/video/2024/01/01/7_small.mp4');
  assert.deepEqual([page.hasPrevious, page.hasNext, page.totalResults], [false, true, 40]);
  assert.equal(parsePixabayPage({totalHits: 500, hits: []}, 'ocean', 34).hasNext, false);
});

test('only Pixabay CDN media and pixabay.com pages pass the allowlists', () => {
  assert.equal(safePixabayUrl('https://cdn.pixabay.com/video/a.mp4')?.hostname, 'cdn.pixabay.com');
  for (const value of ['http://cdn.pixabay.com/a.mp4', 'https://u:p@cdn.pixabay.com/a.mp4', 'https://cdn.pixabay.com:444/a.mp4', 'https://cdn.pixabay.com/a.mp4#x', 'https://pixabay.com/get/a.mp4', 'https://evil.example/a.mp4']) assert.equal(safePixabayUrl(value), null, value);
  assert.equal(safePixabayExternal('https://pixabay.com/videos/x-1/'), 'https://pixabay.com/videos/x-1/');
  assert.equal(safePixabayExternal('https://pixabay.com.evil.example/'), null);
  assert.equal(safeHistorySource('pixabay', 'https://pixabay.com/videos/x-1/'), 'https://pixabay.com/videos/x-1/');
  assert.equal(safeHistorySource('pixabay', 'https://www.pexels.com/video/1/'), null);
  const foreign = hit(9); foreign.videos.medium.url = 'https://evil.example/9.mp4';
  assert.deepEqual(parsePixabayPage({totalHits: 1, hits: [foreign]}, 'ocean', 1).results[0].files.map(file => file.id), ['large', 'small', 'tiny']);
});

test('the key travels only in the query string and never reaches an error, asset or source URL', async t => {
  const calls = [];
  const {client} = fixture(t, async (url, init) => {
    calls.push({url: String(url), init});
    if (calls.length === 1) return json({totalHits: 1, hits: [hit(7)]});
    throw new Error(`connect ECONNREFUSED ${url}`);
  });
  const page = await client.search('video', 'ocean', 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://pixabay.com/api/videos/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {q: 'ocean', page: '1', per_page: '15', key: KEY});
  assert.deepEqual(calls[0].init.headers, {});
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.stringify(page).includes(KEY), false);
  const error = await client.load('video', 8).catch(error => error);
  assert.equal(error.message, 'Pixabay request failed.');
  await assert.rejects(client.search('photo', 'ocean', 1), {message: 'Invalid Pixabay media type.'});
  await assert.rejects(client.load('photo', 7), {message: 'Invalid Pixabay asset.'});
});

test('a 400 means a rejected key only while validating one', async t => {
  const {client} = fixture(t, async () => new Response('[ERROR 400] "Invalid or missing API key"', {status: 400, headers: {'content-type': 'text/html'}}));
  await assert.rejects(client.validateKey(KEY), {message: 'Pixabay rejected the API key.'});
  await assert.rejects(client.search('video', 'ocean', 40), {message: 'Pixabay page must be between 1 and 34.'});
  await assert.rejects(client.search('video', 'ocean', 2), {message: 'Pixabay request failed (400).'});
});

test('the query limit counts characters, not URL-encoded bytes', async t => {
  const queries = [];
  const {client} = fixture(t, async url => { queries.push(new URL(String(url)).searchParams.get('q')); return json({totalHits: 0, hits: []}); });
  const turkish = 'ğüşıöç'.repeat(10);
  assert.equal((await client.search('video', turkish, 1)).totalResults, 0);
  assert.deepEqual(queries, [turkish]);
  await assert.rejects(client.search('video', 'a'.repeat(101), 1), {message: 'Enter 2–100 characters to search Pixabay.'});
  assert.equal(queries.length, 1);
});

test('a 429 cools down for the relative X-RateLimit-Reset seconds', async t => {
  let now = 1_000_000, fetches = 0;
  const {client} = fixture(t, async () => { fetches += 1; return fetches === 1 ? new Response('Too many requests', {status: 429, headers: {'x-ratelimit-reset': '120', 'content-type': 'text/plain'}}) : json({totalHits: 0, hits: []}); }, () => now);
  await assert.rejects(client.search('video', 'ocean', 1), {message: 'Pixabay quota reached. Try again after the provider rate limit resets.'});
  // An absolute reading would fall back to the 60 s default; relative means 120 s.
  now += 90_000;
  await assert.rejects(client.search('video', 'ocean', 1), {message: 'Pixabay quota reached. Try again after the provider rate limit resets.'});
  assert.equal(fetches, 1);
  now += 31_000;
  assert.equal((await client.search('video', 'ocean', 1)).totalResults, 0);
  assert.equal(fetches, 2);
});

test('a repeated search within 24 hours is served from the cache', async t => {
  let now = 1_000_000, fetches = 0;
  const {client} = fixture(t, async () => { fetches += 1; return json({totalHits: 1, hits: [hit(7)]}); }, () => now);
  await client.search('video', 'ocean', 1);
  now += 23 * 60 * 60 * 1000;
  assert.equal((await client.search('video', 'ocean', 1)).results[0].id, 7);
  assert.equal(fetches, 1);
  now += 2 * 60 * 60 * 1000;
  await client.search('video', 'ocean', 1);
  assert.equal(fetches, 2);
});

test('cancelling a Pixabay download removes the partial file', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const {client, directory} = fixture(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024)); started(); },
  }), {status: 200, headers: {'content-type': 'video/mp4'}}));
  const file = parsePixabayPage({totalHits: 1, hits: [hit(7)]}, 'ocean', 1).results[0].files[1];
  const download = client.download('job', file, () => {});
  await ready; await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(readdirSync(directory).length, 0);
  await client.cancel('job');
  await assert.rejects(download, {message: 'Download cancelled.'});
  assert.deepEqual(readdirSync(directory), []);
});

test('the Pixabay Keychain store uses its own service name and lock', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-pixabay-keychain-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const calls = [];
  const codes = [44, 0, 0];
  const spawn = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.chunks = []; child.stdin.write = chunk => { child.stdin.chunks.push(String(chunk)); return true; }; child.stdin.end = () => {}; child.kill = () => true;
    calls.push({args: [...args], child});
    const code = codes.shift();
    queueMicrotask(() => { if (calls.length === 3) child.stdout.emit('data', `${KEY}\n`); child.emit('close', code); });
    return child;
  };
  const store = new MacKeychainPexelsCredentialStore(spawn, path.join(root, 'pixabay.lock'), PIXABAY_CREDENTIAL);
  assert.equal(await store.save(KEY), true);
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'com.clipdock.pixabay', '-a', 'api-key', '-w']);
  assert.equal(calls[1].child.stdin.chunks.join(''), `add-generic-password -U -s com.clipdock.pixabay -a api-key -w ${KEY}\n`);
  assert.equal(path.basename(PIXABAY_CREDENTIAL.lockPath), 'pixabay-keychain.lock');
  assert.equal(path.basename(PEXELS_CREDENTIAL.lockPath), 'pexels-keychain.lock');
  assert.equal(PEXELS_CREDENTIAL.service, 'com.clipdock.pexels');
});

test('the IPC contract carries the Pixabay channels and preload methods', () => {
  assert.equal(IPC_CHANNELS.searchPixabay, 'clipdock:search-pixabay');
  assert.equal(IPC_CHANNELS.setPixabayKey, 'clipdock:set-pixabay-key');
  assert.equal(IPC_CHANNELS.pixabayEvent, 'clipdock:pixabay-event');
  for (const method of ['pixabayKeyStatus', 'setPixabayKey', 'clearPixabayKey', 'searchPixabay', 'loadPixabay', 'downloadPixabay', 'cancelPixabay', 'cancelPixabayRequests', 'onPixabayEvent', 'openPixabayExternal']) assert.ok(PRELOAD_API_METHODS.includes(method), method);
});
