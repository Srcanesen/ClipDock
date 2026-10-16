import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('Pexels API and download boundaries', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const pexelsJs = path.join(dist, 'pexels.js');
  const { PexelsClient, parsePexelsPage, safePexelsExternal, safePexelsUrl } = createRequire(import.meta.url)(pexelsJs);
  const caseClients = new Set();
  const createPexelsClient = (...args) => {
    const client = new PexelsClient(...args);
    caseClients.add(client);
    return client;
  };
  const realFetch = globalThis.fetch;
  const TEST_KEY = 'test_key_12345678901234567890';
  const OLD_KEY = 'old_key_12345678901234567890';
  const encoder = new TextEncoder();
  const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const bodyResponse = (chunks, mime, headers = {}, status = 200) => new Response(new ReadableStream({
    pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
  }), { status, headers: { 'content-type': mime, ...headers } });
  const expectReject = async (promise, pattern) => {
    try { await promise; throw new Error('expected rejection'); }
    catch (error) { if (!pattern.test(error.message)) throw error; return error.message; }
  };
  const pexelsTest = async (name, run) => t.test(name, async (caseTest) => {
    caseTest.after(() => {
      globalThis.fetch = realFetch;
      for (const client of caseClients) client.dispose();
      caseClients.clear();
    });
    await run();
  });
  const photoFixture = {
    id: 11, width: 4000, height: 3000, alt: 'Desk', url: 'https://www.pexels.com/photo/desk-11/', photographer: 'Ada',
    photographer_url: 'https://www.pexels.com/@ada/',
    src: { original: 'https://images.pexels.com/photos/11/original.jpeg', medium: 'https://images.pexels.com/photos/11/medium.jpeg?w=800&h=600' },
  };
  const videoFixture = {
    id: 22, width: 1920, height: 1080, duration: 8, url: 'https://www.pexels.com/video/clip-22/', user: { name: 'Lin', url: 'https://www.pexels.com/@lin/' },
    video_files: [
      { id: 2201, link: 'https://videos.pexels.com/video-files/22/a.mp4', width: 640, height: 360, quality: 'sd', file_type: 'video/mp4' },
      { id: 2202, link: 'https://videos.pexels.com/video-files/22/b.mp4', width: 1920, height: 1080, quality: 'hd', file_type: 'video/mp4' },
      { id: 2203, link: 'https://videos.pexels.com/video-files/22/c.mp4', width: 1920, height: 1080, quality: 'hd', file_type: 'video/mp4' },
    ],
  };

  await pexelsTest('URL allowlists reject URL tricks and external links only use www.pexels.com', async () => {
    for (const value of ['http://images.pexels.com/a.jpg', 'https://u:p@images.pexels.com/a.jpg', 'https://images.pexels.com:444/a.jpg', 'https://images.pexels.com/a.jpg#x', 'https://evil.example/a.jpg']) if (safePexelsUrl(value)) throw new Error(`accepted ${value}`);
    for (const value of ['https://pexels.com/photo/1/', 'https://www.pexels.com:444/photo/1/', 'https://www.pexels.com/photo/1/#x', 'https://evil.example/']) if (safePexelsExternal(value)) throw new Error(`accepted ${value}`);
    if (!safePexelsExternal('https://www.pexels.com/photo/1/')) throw new Error('rejected valid external URL');
  });
  await pexelsTest('photo/video normalization is honest, deduplicated, and uses provider file IDs', async () => {
    const photo = parsePexelsPage({ photos: [photoFixture] }, 'photo', 'desk', 1).results[0];
    const video = parsePexelsPage({ videos: [videoFixture] }, 'video', 'clip', 1).results[0];
    if (photo.files[0].width !== 4000 || photo.files[0].height !== 3000 || photo.files[1].width !== 800 || photo.files[1].height !== 600) throw new Error('photo dimensions were not normalized');
    if (video.title !== 'Pexels video 22' || video.files.length !== 2 || video.files[0].id !== '2202' || video.files[1].id !== '2201') throw new Error('video fallback/deduplication/order is wrong');
    if ('filePath' in video || JSON.stringify(video).includes(TEST_KEY)) throw new Error('renderer asset leaked a path/key');
  });
  await pexelsTest('exact API endpoints and Authorization header are used without key leakage', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-api-')); const client = createPexelsClient(rootDir); client.setKey(TEST_KEY); const calls = [];
    globalThis.fetch = async (input, init) => { calls.push([String(input), init]); return String(input).includes('/videos/search') ? jsonResponse({ videos: [] }) : jsonResponse(videoFixture); };
    const asset = await client.load('video', 22); await client.search('video', 'clip', 1); client.dispose();
    if (new URL(calls[0][0]).pathname !== '/videos/videos/22' || new URL(calls[1][0]).pathname !== '/videos/search') throw new Error(`wrong endpoints: ${calls.map((call) => call[0]).join(', ')}`);
    if (calls.some(([url, init]) => url.includes(TEST_KEY) || init.headers.Authorization !== TEST_KEY)) throw new Error('Authorization handling is wrong');
    if (JSON.stringify(asset).includes(TEST_KEY)) throw new Error('key leaked into API result');
  });
  await pexelsTest('API auth/rate errors and thrown fetch errors are safe', async () => {
    for (const [status, pattern] of [[401, /rejected the API key/], [403, /rejected the API key/], [429, /quota reached/]]) {
      const client = createPexelsClient(mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-error-'))); client.setKey(TEST_KEY); globalThis.fetch = async () => jsonResponse({}, status); await expectReject(client.load('photo', 1), pattern); client.dispose();
    }
    const client = createPexelsClient(mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-leak-'))); client.setKey(TEST_KEY); globalThis.fetch = async () => { throw new Error(TEST_KEY); }; const message = await expectReject(client.load('photo', 1), /Pexels request failed/); client.dispose(); if (message.includes(TEST_KEY)) throw new Error('key leaked into error');
  });
  await pexelsTest('API JSON body is stream capped', async () => {
    const client = createPexelsClient(mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-json-'))); client.setKey(TEST_KEY);
    globalThis.fetch = async () => bodyResponse([new Uint8Array(1024 * 1024), new Uint8Array([1])], 'application/json');
    await expectReject(client.load('photo', 1), /API response is too large/); client.dispose();
  });
  await pexelsTest('search and load requests have independent ownership', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-independent-')); const client = new PexelsClient(rootDir); client.setKey(TEST_KEY); let releaseLoad; let releaseSearch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'images.pexels.com') return bodyResponse([encoder.encode('jpeg')], 'image/jpeg');
      if (url.pathname === '/v1/photos/11') return new Promise((resolve, reject) => {
        releaseLoad = () => resolve(jsonResponse(photoFixture));
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      if (url.pathname === '/v1/photos/12') return jsonResponse({ ...photoFixture, id: 12 });
      if (url.searchParams.get('page') === '1') return new Promise((resolve, reject) => {
        releaseSearch = () => resolve(jsonResponse({ photos: [] }));
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      return jsonResponse({ photos: [] });
    };
    try {
      const firstLoad = client.load('photo', 11); const loads = Promise.all([firstLoad, client.load('photo', 12)]); releaseLoad();
      const assets = await loads; if (assets[0].id !== 11 || assets[1].id !== 12) throw new Error('independent detail requests did not both complete');
      const firstSearch = client.search('photo', 'desk', 1); const searches = Promise.all([firstSearch, client.search('photo', 'desk', 2)]); releaseSearch();
      const pages = await searches; if (pages[0].page !== 1 || pages[1].page !== 2) throw new Error('independent search requests did not both complete');
    } finally { client.dispose(); rmSync(rootDir, { recursive: true, force: true }); }
  });
  await pexelsTest('API timeout aborts fetch with a safe error', async () => {
    const client = createPexelsClient(mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-timeout-'))); client.setKey(TEST_KEY); const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args);
    try { globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); await expectReject(client.load('photo', 11), /timed out/); }
    finally { globalThis.setTimeout = realSetTimeout; client.dispose(); }
  });
  await pexelsTest('media MIME, content-length, and streamed-byte caps are enforced', async () => {
    const client = createPexelsClient(mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-media-cap-'))); const file = { id: '1', url: 'https://images.pexels.com/a.jpg', width: 1, height: 1, label: 'Original', mime: 'image/jpeg', size: null }; const emit = () => undefined;
    globalThis.fetch = async () => bodyResponse([encoder.encode('x')], 'text/html'); await expectReject(client.download('mime', file, emit), /unexpected media type/);
    globalThis.fetch = async () => bodyResponse([encoder.encode('x')], 'image/jpeg', { 'content-length': String(20 * 1024 * 1024 + 1) }); await expectReject(client.download('length', file, emit), /size limit/);
    globalThis.fetch = async () => bodyResponse([new Uint8Array(20 * 1024 * 1024), new Uint8Array([1])], 'image/jpeg'); await expectReject(client.download('stream', file, emit), /size limit/); client.dispose();
  });
  await pexelsTest('cancel closes output and removes .part files', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-cancel-')); const client = createPexelsClient(rootDir); const file = { id: '1', url: 'https://videos.pexels.com/a.mp4', width: 1, height: 1, label: '1×1', mime: 'video/mp4', size: null };
    globalThis.fetch = async () => new Response(new ReadableStream({ async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 5)); controller.enqueue(new Uint8Array(64 * 1024)); } }), { headers: { 'content-type': 'video/mp4' } });
    const pending = client.download('cancel-job', file, () => undefined); await new Promise((resolve) => setTimeout(resolve, 20)); if (!client.cancel('cancel-job')) throw new Error('job was not abortable'); await expectReject(pending, /cancelled/); if (readdirSync(rootDir).some((name) => name.endsWith('.part'))) throw new Error('part file survived cancellation'); client.dispose();
  });
  await pexelsTest('write failures clean temp output', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-write-')); const client = createPexelsClient(rootDir); rmSync(rootDir, { recursive: true, force: true }); writeFileSync(rootDir, 'block'); const file = { id: '1', url: 'https://images.pexels.com/a.jpg', width: 1, height: 1, label: 'Original', mime: 'image/jpeg', size: null };
    globalThis.fetch = async () => bodyResponse([encoder.encode('ok')], 'image/jpeg'); await expectReject(client.download('write', file, () => undefined), /download failed/); if (!statSync(rootDir).isFile()) throw new Error('blocking path was not preserved'); client.dispose(); rmSync(rootDir, { recursive: true, force: true });
  });
  await pexelsTest('deleted managed root is recreated before download output', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-root-recreate-')); const client = createPexelsClient(rootDir); rmSync(rootDir, { recursive: true, force: true }); const file = { id: '1', url: 'https://images.pexels.com/a.jpg', width: 1, height: 1, label: 'Original', mime: 'image/jpeg', size: null };
    globalThis.fetch = async () => bodyResponse([encoder.encode('image-bytes')], 'image/jpeg', { 'content-length': '11' });
    const result = await client.download('root-recreate', file, () => undefined);
    if (!existsSync(result.filePath) || (statSync(rootDir).mode & 0o777) !== 0o700) throw new Error('deleted managed root was not recreated privately');
    client.dispose(); rmSync(rootDir, { recursive: true, force: true });
  });
  await pexelsTest('pinned-clock media progress is throttled, monotonic, and forces final completion', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-progress-')); const client = createPexelsClient(rootDir); const file = { id: '1', url: 'https://images.pexels.com/a.jpg', width: 1, height: 1, label: 'Original', mime: 'image/jpeg', size: null };
    const chunks = Array.from({ length: 20 }, () => new Uint8Array([1])); const events = []; const realDateNow = Date.now; Date.now = () => 1_000;
    try {
      globalThis.fetch = async () => bodyResponse(chunks, 'image/jpeg', { 'content-length': '20' });
      const result = await client.download('progress', file, (event) => events.push(event));
      const percents = events.map((event) => event.percent).filter((value) => value !== null);
      if (!existsSync(result.filePath) || events.length > 3 || percents.at(0) !== 0 || percents.at(-1) !== 100 || percents.some((value, index) => index > 0 && value < percents[index - 1])) throw new Error(`progress budget/final state failed: ${JSON.stringify(events)}`);
    } finally { Date.now = realDateNow; client.dispose(); rmSync(rootDir, { recursive: true, force: true }); }
  });
  await pexelsTest('successful download is atomically finalized and survives panel disposal', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-success-')); const client = createPexelsClient(rootDir); const file = { id: '1', url: 'https://images.pexels.com/a.jpg', width: 1, height: 1, label: 'Original', mime: 'image/jpeg', size: null };
    globalThis.fetch = async () => bodyResponse([encoder.encode('image-bytes')], 'image/jpeg', { 'content-length': '11' }); const result = await client.download('success', file, () => undefined); if (!existsSync(result.filePath) || result.filePath.endsWith('.part') || readdirSync(rootDir).some((name) => name.endsWith('.part'))) throw new Error('atomic output failed'); client.dispose(); if (!existsSync(result.filePath)) throw new Error('dispose removed completed media referenced by Resolve'); rmSync(rootDir, { recursive: true, force: true });
  });
  await pexelsTest('clear/dispose remove the session key and abort in-flight work', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-dispose-')); const client = createPexelsClient(rootDir); client.setKey(TEST_KEY);
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); const pending = client.load('photo', 11); client.clearKey(); await expectReject(pending, /cancelled/); if (client.status().connected) throw new Error('clear retained key'); client.setKey(TEST_KEY); client.dispose(); if (client.status().connected) throw new Error('dispose retained key'); rmSync(rootDir, { recursive: true, force: true });
  });
});
