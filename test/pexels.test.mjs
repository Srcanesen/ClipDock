import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';

import {
  PexelsClient,
  parsePexelsPage,
  safePexelsExternal,
  safePexelsUrl,
} from '../dist/pexels.js';

const file = {
  id: '42',
  url: 'https://videos.pexels.com/video-files/42/video.mp4',
  width: 1280,
  height: 720,
  label: 'HD',
  mime: 'video/mp4',
  size: null,
};

function root(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function hangingMediaResponse(signal) {
  let streamController;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new Uint8Array([1, 2, 3]));
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), {once: true});
    },
    pull() {
      return new Promise(() => undefined);
    },
    cancel() {
      streamController = null;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {'content-type': 'video/mp4'},
  });
}

test('Pexels URL and external-link allowlists reject credential, port, host, and protocol tricks', () => {
  assert.ok(safePexelsUrl('https://videos.pexels.com/video.mp4'));
  assert.equal(safePexelsUrl('http://videos.pexels.com/video.mp4'), null);
  assert.equal(safePexelsUrl('https://videos.pexels.com.evil.test/video.mp4'), null);
  assert.equal(safePexelsUrl('https://user:pass@videos.pexels.com/video.mp4'), null);
  assert.equal(safePexelsExternal('https://www.pexels.com/video/42/'), 'https://www.pexels.com/video/42/');
  assert.equal(safePexelsExternal('https://pexels.com/video/42/'), null);
  assert.equal(safePexelsExternal('https://evil.test/video/42/'), null);
});

test('Pexels normalization exposes honest media types and provider file IDs', () => {
  const page = parsePexelsPage({
    total_results: 1,
    photos: [{
      id: 7,
      alt: '  Studio light  ',
      width: 1920,
      height: 1080,
      photographer: 'Creator',
      url: 'https://www.pexels.com/photo/7/',
      src: {
        original: 'https://images.pexels.com/photo/original.jpg?w=1920&h=1080',
        medium: 'https://images.pexels.com/photo/medium.jpg?w=800&h=450',
        small: 'https://evil.test/photo.jpg',
      },
    }],
  }, 'photo', 'studio', 1);
  assert.equal(page.results[0].title, 'Studio light');
  assert.equal(page.results[0].files[0].mime, 'image/jpeg');
  assert.equal(page.results[0].files.some(item => item.url.includes('evil.test')), false);

  const videos = parsePexelsPage({videos: [{
    id: 8,
    title: 'Video',
    video_files: [
      {id: 81, link: file.url, file_type: 'video/mp4', width: 1280, height: 720, quality: 'hd'},
      {id: 82, link: 'https://videos.pexels.com/video-files/82/video.mp4', file_type: 'video/mp4', width: 1280, height: 720, quality: 'hd'},
      {id: 83, link: 'https://videos.pexels.com/video-files/83/video.mp4', file_type: 'video/webm', width: 1920, height: 1080},
    ],
  }]}, 'video', 'clip', 1);
  assert.equal(videos.results[0].files.length, 1);
  assert.equal(videos.results[0].files[0].id, '81');
  assert.equal(videos.results[0].files[0].mime, 'video/mp4');
});

function photoRow(id, thumbnail = `https://images.pexels.com/photos/${id}/medium.jpg`) {
  return {
    id,
    alt: `Photo ${id}`,
    width: 1200,
    height: 800,
    photographer: 'Creator',
    url: `https://www.pexels.com/photo/${id}/`,
    src: {original: `https://images.pexels.com/photos/${id}/original.jpg`, medium: thumbnail},
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
}

function imageResponse() {
  return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {status: 200, headers: {'content-type': 'image/jpeg', 'content-length': '4'}});
}

test('Pexels search returns every row without thumbnail fetching', async () => {
  const directory = root('clipdock-pexels-thumb-concurrency-');
  let active = 0;
  let maximum = 0;
  try {
    const client = new PexelsClient(directory, async (url) => {
      if (url.toString().includes('api.pexels.com')) return jsonResponse({total_results: 15, photos: Array.from({length: 15}, (_, index) => photoRow(index + 1))});
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return imageResponse();
    });
    client.restoreKey('P'.repeat(20), true, 'Connected');
    const page = await client.search('photo', 'studio', 1);
    assert.equal(page.results.length, 15);
    assert.equal(maximum, 0);
    assert.equal(page.results[0].thumbnailUrl, 'https://images.pexels.com/photos/1/medium.jpg');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Pexels search and load never fetch thumbnails', async () => {
  const directory = root('clipdock-pexels-thumb-reuse-');
  let thumbnailFetches = 0;
  const row = photoRow(1);
  try {
    const client = new PexelsClient(directory, async (url) => {
      const value = url.toString();
      if (value.includes('/v1/search') || value.includes('/v1/photos/1')) return jsonResponse(value.includes('/v1/search') ? {total_results: 1, photos: [row]} : row);
      thumbnailFetches += 1;
      return imageResponse();
    });
    client.restoreKey('P'.repeat(20), true, 'Connected');
    await client.search('photo', 'studio', 1);
    await client.search('photo', 'studio', 1);
    await client.load('photo', 1);
    assert.equal(thumbnailFetches, 0);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Pexels search rejects foreign and video thumbnail hosts', async t => {
  const directory = root('clipdock-pexels-image-policy-'); t.after(() => rmSync(directory, {recursive: true, force: true}));
  const client = new PexelsClient(directory, async () => jsonResponse({photos: [photoRow(1, 'https://evil.test/a.jpg'), photoRow(2, 'https://videos.pexels.com/a.jpg')]}));
  client.restoreKey('P'.repeat(20), true, 'Connected');
  assert.deepEqual((await client.search('photo', 'studio', 1)).results.map(item => item.thumbnailUrl), [null, null]);
});

test('Pexels cancellation removes partial output', async () => {
  const directory = root('clipdock-pexels-cancel-');
  const events = [];
  try {
    const client = new PexelsClient(directory, async (_url, init) => hangingMediaResponse(init.signal));
    const pending = client.download('job-cancel', file, event => events.push(event));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.isDownloading(), true);
    assert.equal(client.cancel('job-cancel') instanceof Promise, true);
    await assert.rejects(pending, /Download cancelled/);
    assert.equal(client.isDownloading(), false);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.part')), false);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.mp4')), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Pexels dispose aborts active work but never removes a completed provider file', async () => {
  const directory = root('clipdock-pexels-dispose-');
  try {
    const client = new PexelsClient(directory, async (url, init) => {
      if (url.toString().includes('active')) return hangingMediaResponse(init.signal);
      return new Response(Buffer.from('complete-media'), {status: 200, headers: {'content-type': 'video/mp4', 'content-length': '13'}});
    });
    client.restoreKey('P'.repeat(20), true, 'Connected');
    const completed = await client.download('job-complete', {...file, url: 'https://videos.pexels.com/complete.mp4'}, () => undefined);
    assert.equal(readdirSync(directory).includes(path.basename(completed.filePath)), true);
    await client.dispose();
    assert.equal(client.status().connected, false);
    assert.equal(readdirSync(directory).includes(path.basename(completed.filePath)), true);

    await assert.rejects(client.download('after-dispose', file, () => undefined), {message: 'Pexels client is shut down.'});
    const activeClient = new PexelsClient(directory, async (_url, init) => hangingMediaResponse(init.signal));
    const pending = activeClient.download('job-active', {...file, url: 'https://videos.pexels.com/active.mp4'}, () => undefined);
    await new Promise(resolve => setImmediate(resolve));
    const rejection = assert.rejects(pending, /Download cancelled/);
    await activeClient.dispose();
    await rejection;
    assert.equal(activeClient.isDownloading(), false);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.part')), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const operation of ['API', 'download']) {
  test(`Pexels disposal awaits the ${operation} request and its late response body`, async t => {
    const directory = root('clipdock-pexels-await-request-');
    let respond, finishBody, signal, bodiesCancelled = 0;
    const responseReady = new Promise(resolve => {respond = resolve;});
    const bodyEnded = new Promise(resolve => {finishBody = resolve;});
    const client = new PexelsClient(directory, async (_url, init) => {signal = init.signal; return responseReady;});
    t.after(async () => {await client.dispose(); rmSync(directory, {recursive: true, force: true});});
    client.setKey('P'.repeat(20), false);
    const pending = operation === 'API' ? client.load('photo', 7) : client.download('await-request', file, () => undefined);
    const rejection = assert.rejects(pending, {message: operation === 'API' ? 'Pexels request cancelled.' : 'Download cancelled.'});
    let disposed = false;
    const disposing = client.dispose().then(() => {disposed = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(disposed, false);
    respond(new Response(new ReadableStream({cancel() {bodiesCancelled++; return bodyEnded;}})));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bodiesCancelled, 1);
    assert.equal(disposed, false);
    finishBody(); await Promise.all([disposing, rejection]);
    assert.equal(disposed, true);
    assert.equal(client.status().connected, false);
    assert.deepEqual(readdirSync(directory), []);
  });
}


test('Pexels duplicate IPC admission during media download preserves the original cancellation scope', async t => {
  const f = await providerIpcFixture(t, 'pexels', {holdDownload: true, holdTermination: true});
  let pending;
  try {
    pending = f.start(); const rejection = assert.rejects(pending, {message: 'Download cancelled.'});
    await f.downloadEntered.promise;
    assert.equal(f.workers.pexels.isDownloading(), true);
    const before = f.events();
    await assert.rejects(f.start(), {name: 'Error', message: 'Provider job job is already active.'});
    assert.deepEqual(f.events(), before, 'rejected duplicate sends no progress or terminal event');
    assert.deepEqual(f.requests, {metadata: 1, media: 1});
    assert.equal(await f.cancel('missing'), false);
    assert.equal(await f.cancel('job'), true);
    assert.equal(await f.cancel('job'), false);
    f.releaseDownload.resolve(); await rejection;
    assert.deepEqual(f.events(), [
      {state: 'downloading', message: 'Downloading from Pexels…', percent: 0},
      {state: 'cancelled', message: 'Download cancelled.', percent: null},
    ]);
    assert.equal(f.workers.pexels.isDownloading(), false);
    assert.equal((await f.api.workspaceStatus()).fileCount, 0);
    assert.equal(await f.cancel('job'), false);
  } finally {await f.stop(); await pending?.catch(() => {});}
});
