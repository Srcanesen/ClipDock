import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createEngineHost} from '../dist/engine-host.js';
import {ManagedRoot} from '../dist/managed-root.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const engines = {ytdlpPath: '/yt-dlp', galleryDlPath: '/gallery-dl', ffmpegPath: '/ffmpeg', ffprobePath: '/ffprobe', jsRuntime: '/node'};
const metadata = {id: 'dQw4w9WgXcQ', title: 'Clip', channel: 'Creator', duration: 10, chapters: []};
const pin = {pinId: '123', url: 'https://www.pinterest.com/pin/123/', creator: 'Creator', items: [{index: 1, kind: 'image', title: 'Pin'}]};
const asset = {kind: 'video', id: 7, sourceUrl: 'https://www.pexels.com/video/7/', title: 'Clip', files: [{id: '70', label: 'HD'}]};

function fixture(t, {invalidFolder = false, failRole, restoreCredential = async () => {}} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-engine-host-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const folder = path.join(directory, 'managed'), runtimeRoot = path.join(directory, 'runtime');
  if (invalidFolder) fs.writeFileSync(folder, 'keep');
  const workers = new Map(), order = [], events = [], published = [];
  function worker(role, root, discovered) {
    if (role === failRole) throw new Error(`cannot create ${role}`);
    const current = {
      root, discovered, active: false,
      isActive() { return this.active; }, isDownloading() { return this.active; },
      dispose() { order.push(role); }, cancel() { return null; },
      setSessionDir(root) { this.root = root; }, setRoot(root) { this.root = root; },
      search: async (...args) => ({role, args}),
      metadata: async () => role.startsWith('pinterest') ? pin : metadata,
      prefetchMetadata: async url => ({url}),
      metadataSocial: async source => ({...metadata, source, platform: 'instagram'}),
      thumbnailSocial: async url => ({url}), subtitles: async (...args) => ({args}),
      load: async () => asset, abortApiRequests: () => true,
      async download(...args) {
        const jobId = role === 'youtube' || role === 'social' ? args[2] : role === 'pinterest' ? args[3] : args[0];
        const filePath = path.join(this.root, `${jobId}.${role === 'pinterest' ? 'jpg' : 'mp4'}`);
        fs.writeFileSync(filePath, 'media');
        return {filePath, fileName: path.basename(filePath), kind: 'image'};
      },
      async downloadSocial(...args) { return this.download(...args); },
    };
    workers.set(role, current); return current;
  }
  let host;
  host = createEngineHost({
    folder, runtimeRoot,
    workers: {
      youtube: (discovered, root) => worker(path.basename(root), root, discovered),
      pinterest: (discovered, root) => worker(path.basename(root), root, discovered),
      pexels: root => worker('pexels', root),
      mediaPrep: discovered => worker('media-prep', null, discovered),
    },
    completion: {
      isSafeMediaFile: file => host.operationRoot().resolve(file) !== null,
      refreshHistoryProject: async () => {}, recordHistory: input => { published.push(input); return {record: {id: 'history'}}; },
      registerCard: () => 'card', prepareMedia: request => host.prepareMedia(request),
    },
    registerSubtitle: () => { throw new Error('No subtitles in fixture.'); },
    emit: (provider, _event, update) => events.push({provider, ...update}), restoreCredential,
  });
  return {host, workers, order, events, published, folder, directory, start: () => host.start(Promise.resolve(engines))};
}
const event = {sender: {}};
const startDownload = (host, provider, id = 'job') => {
  const handler = host.provider(provider).download;
  if (provider === 'youtube') return handler(event, 'https://youtu.be/dQw4w9WgXcQ', 'best', 'original', id, {mediaMode: 'video', audioFormat: 'wav', subtitles: false, subtitleLanguage: 'en'});
  if (provider === 'social') return handler(event, 'https://www.instagram.com/reel/abc/', 'best', 'original', id);
  if (provider === 'pinterest') return handler(event, pin.url, 1, 'original', id);
  return handler(event, asset, '70', 'original', id);
};

test('readiness waits for discovery while independent operations answer; every role gets the discovered engines', async t => {
  const f = fixture(t), discovery = deferred();
  const starting = f.host.start(discovery.promise);
  let settled = false;
  const pending = f.host.provider('youtube').search('cats', 2).then(result => { settled = true; return result; });
  assert.equal(await f.host.run(() => 'status', 'immediate'), 'status');
  assert.equal(f.host.activeRoot().verify(), f.folder);
  assert.equal(settled, false); assert.equal(f.workers.size, 0);
  discovery.resolve(engines); await starting;
  assert.equal(await f.host.ready(), engines);
  assert.deepEqual(await pending, {role: 'youtube-search', args: ['cats', 2]});
  assert.deepEqual([...f.workers.keys()], ['youtube', 'social', 'pinterest', 'pinterest-metadata', 'pinterest-search', 'youtube-search', 'youtube-metadata', 'social-metadata', 'youtube-subtitles', 'media-prep', 'pexels']);
  for (const [role, worker] of f.workers) if (role !== 'pexels') assert.equal(worker.discovered, engines);
  await f.start(); assert.equal(f.workers.size, 11);
  assert.equal(f.host.isBusy(), false);
  f.workers.get('pinterest-search').active = true; assert.equal(f.host.isBusy(), true);
  f.workers.get('pinterest-search').active = false;
  await f.host.dispose(); assert.equal(f.order.length, 11);
});

test('discovery failure is the one startup error for every engine entry point, before workers or folder writes', async t => {
  const f = fixture(t), discovery = deferred();
  const starting = f.host.start(discovery.promise);
  const pending = f.host.provider('pinterest').search('cats', 1);
  const rejected = assert.rejects(pending, {message: 'Download services could not start: discovery failed'});
  discovery.reject(new Error('discovery failed')); await starting; await rejected;
  const error = await f.host.ready().catch(error => error);
  assert.equal(error.message, 'Download services could not start: discovery failed');
  for (const operation of [() => f.host.ready(), () => f.host.provider('youtube').load('url'), () => startDownload(f.host, 'youtube'), () => f.host.credential(() => 'unexpected')]) {
    await assert.rejects(operation(), actual => actual === error);
  }
  assert.equal(await f.host.run(() => 'history', 'immediate'), 'history');
  assert.equal(f.host.error(), error.message); assert.equal(f.workers.size, 0);
  assert.equal(f.host.provider('youtube').cancel('missing'), false);
  await f.host.dispose(); assert.deepEqual(f.order, []);
});

test('a partial worker construction failure is shared and all constructed workers are disposed', async t => {
  const f = fixture(t, {failRole: 'youtube-search'}); await f.start();
  await assert.rejects(f.host.ready(), {message: 'Download services could not start: cannot create youtube-search'});
  await f.host.dispose();
  assert.deepEqual(f.order, ['youtube', 'social', 'pinterest', 'pinterest-metadata', 'pinterest-search']);
});

test('invalid folder recovers through a committed re-point; later transient errors clear only on the captured identity', async t => {
  const f = fixture(t, {invalidFolder: true}); await f.start();
  assert.equal(await f.host.ready(), engines);
  await assert.rejects(startDownload(f.host, 'youtube'), /Choose a usable download folder/);
  assert.equal(fs.readFileSync(f.folder, 'utf8'), 'keep');
  const next = ManagedRoot.prepare(path.join(f.directory, 'next'));
  const persistence = [];
  assert.equal(await f.host.changeFolder(async () => next.verify(), () => next, root => persistence.push(root.verify())), next.verify());
  assert.deepEqual(persistence, [next.verify()]); assert.equal(f.host.error(), undefined);
  for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) assert.equal(f.workers.get(provider).root, next.providerPath(provider));
  const result = await startDownload(f.host, 'youtube'); assert.equal(result.cardId, 'card');
  assert.equal(f.published[0].filePath, path.join(next.verify(), 'youtube', 'job.mp4'));
  const moved = `${next.verify()}.moved`; fs.renameSync(next.verify(), moved);
  assert.equal(f.host.displayedFolder(), path.join(f.directory, 'next'));
  assert.match(f.host.error(), /folder changed/);
  fs.renameSync(moved, path.join(f.directory, 'next'));
  assert.equal((await startDownload(f.host, 'youtube', 'again')).fileName, 'again.mp4');
  assert.equal(f.host.error(), undefined);
});

test('folder changes roll back adapters and preserve the root on persistence failure', async t => {
  const f = fixture(t); await f.start();
  const next = ManagedRoot.prepare(path.join(f.directory, 'next'));
  await assert.rejects(f.host.changeFolder(async () => next.verify(), () => next, () => { throw new Error('save failed'); }), {message: 'Could not change the download folder: save failed'});
  assert.equal(f.host.activeRoot().verify(), f.folder);
  for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) assert.equal(f.workers.get(provider).root, path.join(f.folder, provider));
  assert.equal((await startDownload(f.host, 'youtube')).fileName, 'job.mp4');
});

for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) {
  test(`${provider} cancel replies synchronously and interrupts the admitted job and waits for cleanup`, async t => {
    const f = fixture(t); await f.start();
    const entered = deferred(), release = deferred(), cancelled = deferred();
    const worker = f.workers.get(provider), originalDownload = worker.download;
    worker.download = async function (...args) { entered.resolve(); await release.promise; return originalDownload.apply(this, args); };
    worker.cancel = () => { cancelled.resolve(); return cancelled.promise; };
    const pending = startDownload(f.host, provider);
    const rejected = assert.rejects(pending, {message: 'Download cancelled.'});
    await entered.promise;
    assert.equal(f.host.isBusy(), true);
    await assert.rejects(f.host.withFolderChange(async () => 'changed'), {message: 'Wait for active downloads or media preparation to finish.'});
    assert.equal(f.host.provider(provider).cancel(null), false);
    assert.equal(f.host.provider(provider).cancel('missing'), false);
    assert.equal(f.host.provider(provider).cancel('job'), true);
    assert.equal(f.host.provider(provider).cancel('job'), false);
    release.resolve(); await rejected;
    assert.deepEqual(f.published, []);
    assert.equal(fs.existsSync(path.join(worker.root, provider === 'pinterest' ? 'job.jpg' : 'job.mp4')), false);
    assert.deepEqual(f.events.filter(update => update.state === 'cancelled').map(({provider, state, message}) => ({provider, state, message})), [{provider, state: 'cancelled', message: 'Download cancelled.'}]);
  });
}

test('provider metadata/search roles and Pinterest snapshots stay independent of download work', async t => {
  const f = fixture(t); await f.start();
  assert.deepEqual(await f.host.provider('pinterest').search('cats', 3), {role: 'pinterest-search', args: ['cats', 3]});
  assert.equal(await f.host.provider('pinterest').load(pin.url), pin);
  f.workers.get('pinterest').metadata = async () => { throw new Error('must use snapshot'); };
  assert.equal((await startDownload(f.host, 'pinterest')).fileName, 'job.jpg');
  assert.equal(await f.host.provider('youtube').load('url'), metadata);
  assert.deepEqual(await f.host.provider('youtube').prefetch('url'), {url: 'url'});
  assert.deepEqual(await f.host.provider('youtube').subtitles('url', 'en'), {args: ['url', 'en']});
  assert.deepEqual(await f.host.provider('social').thumbnail('url'), {url: 'url'});
  assert.deepEqual(await f.host.provider('pexels').search('video', 'cats', 1), {role: 'pexels', args: ['video', 'cats', 1]});
  assert.equal(await f.host.provider('pexels').load('video', 7), asset);
  assert.equal(await f.host.provider('pexels').abortRequests(), true);
});

test('credential restoration blocks only credential reads and mutations', async t => {
  const restored = deferred(); const f = fixture(t, {restoreCredential: () => restored.promise}); await f.start();
  let read = false;
  const pending = f.host.credential(() => { read = true; return 'connected'; });
  assert.deepEqual(await f.host.provider('youtube').search('cats', 1), {role: 'youtube-search', args: ['cats', 1]});
  assert.equal(read, false);
  restored.resolve(); assert.equal(await pending, 'connected'); assert.equal(read, true);
});

test('dispose initiates workers in role order, waits for workers and native handoffs, and rejects subsequent operations', async t => {
  const f = fixture(t); await f.start();
  const workerRelease = deferred(), handoffRelease = deferred();
  f.workers.get('youtube').dispose = () => { f.order.push('youtube'); return workerRelease.promise; };
  const handoff = f.host.handoff(() => handoffRelease.promise); await tick();
  assert.equal(f.host.mediaInUse(), true);
  const pending = f.host.dispose(); let disposed = false; pending.then(() => { disposed = true; });
  assert.equal(f.host.dispose(), pending);
  assert.deepEqual(f.order, ['youtube', 'social', 'pinterest', 'pinterest-metadata', 'pinterest-search', 'youtube-search', 'youtube-metadata', 'social-metadata', 'youtube-subtitles', 'pexels', 'media-prep']);
  for (const operation of [() => f.host.ready(), () => f.host.run(() => 'status', 'immediate'), () => f.host.provider('pinterest').search('cats', 1), () => startDownload(f.host, 'youtube'), () => f.host.handoff(() => 'transfer')]) {
    await assert.rejects(operation(), {message: 'Download services are shutting down.'});
  }
  await assert.rejects(f.host.changeFolder(async () => 'next', () => { throw new Error('must not prepare'); }), {message: 'Wait for active downloads or media preparation to finish.'});
  assert.equal(disposed, false); workerRelease.resolve(); await tick(); assert.equal(disposed, false);
  handoffRelease.resolve('imported'); assert.equal(await handoff, 'imported'); await pending;
  assert.equal(disposed, true); assert.equal(f.host.mediaInUse(), false);
  await assert.rejects(f.host.changeFolder(async () => 'next', () => { throw new Error('must not prepare'); }), {message: 'Download services are shutting down.'});
});

test('quit during discovery constructs no workers; an unstarted second instance disposes without discovery', async t => {
  const f = fixture(t), discovery = deferred();
  const starting = f.host.start(discovery.promise); const pending = f.host.dispose();
  let done = false; pending.then(() => { done = true; }); await tick(); assert.equal(done, false);
  discovery.resolve(engines); await starting; await pending;
  assert.equal(done, true); assert.equal(f.workers.size, 0);
  await assert.rejects(f.host.ready(), {message: 'Download services are shutting down.'});
  const second = fixture(t); await second.host.dispose();
  assert.equal(second.workers.size, 0); assert.deepEqual(second.order, []);
  await assert.rejects(second.host.ready(), {message: 'Download services are shutting down.'});
});


test('an admitted operation retains its captured root across awaits even when current-root validation fails', async t => {
  const f = fixture(t); await f.start();
  const captured = f.host.activeRoot(), entered = deferred(), release = deferred();
  let observed;
  f.workers.get('youtube').metadata = async () => {
    entered.resolve(); await release.promise;
    observed = f.host.operationRoot();
    throw new Error('metadata stopped after root observation');
  };
  const pending = startDownload(f.host, 'youtube');
  const rejected = assert.rejects(pending, {message: 'metadata stopped after root observation'});
  await entered.promise;
  fs.renameSync(f.folder, `${f.folder}.moved`);
  assert.throws(() => f.host.activeRoot(), {message: 'The download folder changed or became unavailable. Choose the download folder again to restore access.'});
  release.resolve(); await rejected;
  assert.equal(observed, captured);
  assert.deepEqual(f.published, []);
});
