import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DownloadQueue, resultKeyFor } = require('../dist/renderer-state/queue-model.js');
const { ItemOutputSession, sourceQualityChoices } = require('../dist/renderer-state/item-output-session.js');
const defaults = { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null };
const youtube = (id = 'a') => ({ id, title: id, channel: 'Creator', duration: 60, heights: [1080, 720], thumbnailUrl: 'thumb', formatSummary: [], chapters: [] });
const pinterest = (count = 2) => ({ pinId: '99', source: 'https://www.pinterest.com/pin/99/', title: 'Pin', creator: 'Creator', thumbnailUrl: 'pin-thumb', kind: count > 1 ? 'carousel' : 'video', items: Array.from({ length: count }, (_, index) => ({ index, kind: index === 0 && count > 1 ? 'image' : 'video', title: `Pin ${index}`, creator: null, extension: index ? 'mp4' : 'jpg' })) });
const file = (id, height, mime = 'video/mp4') => ({ id, height, width: height * 2, label: `${height}p`, size: height, mime, url: `https://pexels.com/${id}` });
const pexels = (kind = 'video') => ({ id: 1, kind, title: 'Stock', creator: 'Artist', creatorUrl: '', sourceUrl: 'https://www.pexels.com/video/1/', duration: 5, width: 1920, height: 1080, thumbnailUrl: 'stock-thumb', previewUrl: null, files: kind === 'video' ? [file('small', 720), file('large', 1080), file('unsupported', 2160, 'video/webm')] : [file('small-photo', 600, 'image/jpeg'), file('original-photo', 3000, 'image/jpeg')] });
function input(provider = 'youtube', metadata = youtube(), overrides = {}) {
  const session = new ItemOutputSession();
  session.select({ provider, kind: metadata.kind });
  session.edit('defaults', { ...defaults, ...overrides });
  const context = 'files' in metadata ? { files: metadata.files, kind: metadata.kind } : 'heights' in metadata ? { choices: sourceQualityChoices(provider, metadata.heights) } : {};
  return { provider, metadata, output: session.output(undefined, context), source: metadata.source ?? '', thumbnailDataUrl: 'card-thumb' };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let id = 0;
  const downloads = [], transfers = [], cancels = [], deletes = [], changes = [];
  const adapter = {
    newId: () => `id-${++id}`,
    download: item => { const pending = deferred(); downloads.push({ item, ...pending }); return pending.promise; },
    cancel: async item => { cancels.push(item.jobId); return true; },
    transfer: async (cardId, bin, action) => { transfers.push([cardId, bin, action]); return { ok: true, message: 'Handed off.' }; },
    deleteFile: async cardId => { deletes.push(cardId); return { deleted: true, message: 'File deleted.' }; },
  };
  const queue = new DownloadQueue(adapter);
  queue.subscribe(change => changes.push({ ...change, status: change.item?.status }));
  return { queue, adapter, downloads, transfers, cancels, deletes, changes };
}
async function complete(f, index = 0) { f.downloads[index].resolve({ cardId: `card-${index}`, fileName: `${index}.mp4` }); await flush(); }

test('result identities retain provider and Pexels kind', () => {
  assert.deepEqual([resultKeyFor('youtube', 'a'), resultKeyFor('social', 'a'), resultKeyFor('pinterest', 'a'), resultKeyFor('pexels', '1'), resultKeyFor('pexels', '1', 'photo')], ['youtube:a', 'social:a', 'pinterest:a', 'pexels:video:1', 'pexels:photo:1']);
});

test('YouTube construction consumes resolved output and preserves metadata, trim and subtitles', () => {
  const f = fixture();
  assert.equal(f.queue.add(input('youtube', youtube(), { profile: 'editing', quality: '720p', subtitles: true, subtitleLanguage: 'tr', intent: 'playhead', targetBin: 'clipdock', selection: { start: 2, end: 8, label: 'Cut' } })).added, 1);
  const item = f.downloads[0].item;
  assert.deepEqual([item.provider, item.videoId, item.url, item.quality, item.profile, item.intent, item.placement, item.targetBin, item.channel, item.thumbnailDataUrl], ['youtube', 'a', 'https://www.youtube.com/watch?v=a', '720p', 'editing', 'playhead', 'playhead', 'clipdock', 'Creator', 'thumb']);
  assert.deepEqual(item.options, { mediaMode: 'video', audioFormat: 'mp3', subtitles: true, subtitleLanguage: 'tr', selection: { start: 2, end: 8, label: 'Custom range' } });
  assert.equal(item.message, 'Downloading…');
});

test('resolved card and Inspector outputs have one construction and duplicate decision', () => {
  const f = fixture();
  const card = input();
  assert.equal(f.queue.add(card).added, 1);
  assert.deepEqual(f.queue.add({ ...input(), source: 'different presentation', thumbnailDataUrl: null }), { added: 0, duplicate: f.queue.items[0].queueId });
  assert.deepEqual(f.queue.items.map(item => [item.videoId, item.quality]), [['a', '1080p']]);
});

test('audio output ignores the hidden video profile in construction and duplicate identity', () => {
  const f = fixture();
  assert.equal(f.queue.add(input('youtube', youtube(), { mediaMode: 'audio', profile: 'editing', quality: '720p', audioFormat: 'wav' })).added, 1);
  assert.deepEqual([f.queue.items[0].profile, f.queue.items[0].quality, f.queue.items[0].options.mediaMode, f.queue.items[0].options.audioFormat], ['original', 'best', 'audio', 'wav']);
  assert.equal(f.queue.add(input('youtube', youtube(), { mediaMode: 'audio', profile: 'fast', audioFormat: 'wav' })).added, 0);
});

test('social construction has its platform, canonical source and video-only options', () => {
  const f = fixture();
  const meta = { ...youtube('social-id'), source: 'https://x.com/user/status/1', platform: 'twitter', thumbnailDataUrl: 'social-thumb' };
  assert.equal(f.queue.add(input('social', meta, { quality: '720p', profile: 'editing', mediaMode: 'audio', subtitles: true })).added, 1);
  const item = f.downloads[0].item;
  assert.deepEqual([item.provider, item.platform, item.url, item.quality, item.profile, item.thumbnailDataUrl], ['social', 'twitter', meta.source, '720p', 'editing', 'social-thumb']);
  assert.deepEqual(item.options, { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' });
});

for (const [kind, quality, expectedId, expectedQuality, expectedProfile] of [
  ['video', '720p', 'small', '720p', 'editing'], ['video', 'large', 'large', '1080p', 'editing'], ['video', 'best', 'large', '1080p', 'editing'], ['photo', '1080p', 'original-photo', 'original', 'original'], ['photo', 'small-photo', 'small-photo', 'original', 'original'],
]) test(`Pexels ${kind} ${quality} chooses the supported rendition and queue label`, () => {
  const f = fixture();
  assert.equal(f.queue.add(input('pexels', pexels(kind), { quality, profile: 'editing' })).added, 1);
  const item = f.downloads[0].item;
  assert.deepEqual([item.pexelsFileId, item.quality, item.profile, item.url], [expectedId, expectedQuality, expectedProfile, 'https://www.pexels.com/video/1/']);
  assert.equal(f.queue.add(input('pexels', pexels(kind), { quality: expectedId, profile: 'editing' })).added, 0);
});

test('unsupported Pexels renditions and empty Pinterest metadata fail before mutation', () => {
  const f = fixture();
  assert.throws(() => f.queue.add(input('pexels', { ...pexels(), files: [] })), /no supported source rendition/);
  assert.throws(() => f.queue.add(input('pinterest', pinterest(0))), /no downloadable Pin items/);
  assert.deepEqual([f.queue.items.length, f.downloads.length], [0, 0]);
});

test('carousel members are FIFO download-only jobs, preserving partial success and independent duplicate detection', async () => {
  const f = fixture();
  assert.equal(f.queue.add(input('pinterest', pinterest(3), { profile: 'editing', intent: 'playhead' })).added, 3);
  assert.deepEqual(f.queue.items.map(item => [item.videoId, item.intent, item.profile, item.quality]), [['99:0', 'download', 'original', 'original'], ['99:1', 'download', 'editing', 'original'], ['99:2', 'download', 'editing', 'original']]);
  assert.equal(new Set(f.queue.items.map(item => item.jobId)).size, 3);
  await complete(f);
  f.downloads[1].reject(new Error('second failed')); await flush();
  await complete(f, 2);
  assert.deepEqual(f.queue.items.map(item => item.status), ['completed', 'failed', 'completed']);
  assert.deepEqual(f.transfers, []);
  assert.equal(f.queue.add(input('pinterest', pinterest(3), { profile: 'editing', intent: 'end' })).added, 1);
});

test('single Pinterest video retains automatic handoff intent', async () => {
  const f = fixture();
  assert.equal(f.queue.add(input('pinterest', pinterest(1), { profile: 'editing', intent: 'end' })).added, 1);
  await complete(f);
  assert.deepEqual(f.transfers, [['card-0', 'active', 'end']]);
  assert.deepEqual([f.queue.items[0].status, f.queue.items[0].profile], ['completed', 'editing']);
});

test('priority batches preserve member order; later priority adds stack after active and do not preempt', async () => {
  const f = fixture();
  f.queue.add(input('youtube', youtube('active'))); f.queue.add(input('youtube', youtube('tail')));
  const activeId = f.queue.activeId;
  assert.equal(f.queue.add(input('pinterest', pinterest(3)), 'after-active').added, 3);
  assert.equal(f.queue.add(input('youtube', youtube('next')), 'after-active').added, 1);
  assert.deepEqual(f.queue.items.map(item => item.videoId), ['active', 'next', '99:0', '99:1', '99:2', 'tail']);
  assert.deepEqual([f.queue.activeId, f.downloads.length], [activeId, 1]);
  await complete(f);
  assert.deepEqual([f.downloads[1].item.videoId, f.queue.activeId], ['next', f.queue.items[1].queueId]);
});

test('chapter expansion deduplicates ranges independently and ignores display labels', () => {
  const f = fixture();
  const selectionPlan = { source: 'a', mode: 'chapters', start: '', end: '', indices: [0, 1], ranges: [{ start: 0, end: 10, label: 'Intro' }, { start: 20, end: 30, label: 'End' }] };
  assert.equal(f.queue.add(input('youtube', youtube(), { selectionPlan })).added, 2);
  assert.deepEqual(f.queue.items.map(item => item.options.selection), selectionPlan.ranges);
  assert.equal(f.queue.add(input('youtube', youtube(), { selection: { start: -0, end: 10, label: 'Renamed' } })).added, 0);
  assert.equal(f.queue.add(input('youtube', youtube(), { selection: { start: 30, end: 40, label: 'Third' } })).added, 1);
});

test('invalid trim is rejected atomically instead of downloading the full source', () => {
  const f = fixture();
  const selectionPlan = { source: 'a', mode: 'manual', start: '20', end: '10', indices: [], ranges: [] };
  assert.throws(() => f.queue.add(input('youtube', youtube(), { selectionPlan })), /In\/Out must be a valid range/);
  assert.deepEqual([f.queue.items.length, f.downloads.length], [0, 0]);
});

test('completed jobs reject normal adds; Download again permits completed history and suppresses active duplicates', async () => {
  const f = fixture(); f.queue.add(input()); await complete(f);
  const id = f.queue.items[0].queueId;
  assert.deepEqual([f.queue.items[0].status, f.queue.items[0].percent, f.queue.items[0].message, f.queue.activeId], ['completed', 100, 'Download complete.', null]);
  assert.equal(f.queue.add(input()).added, 0);
  assert.equal(f.queue.repeat(id, true).added, 1);
  assert.deepEqual([f.downloads.length, f.queue.items[1].cardId], [2, undefined]);
  assert.deepEqual(f.queue.repeat(id, true), { added: 0, duplicate: f.queue.items[1].queueId });
});

test('failed and cancelled jobs permit retry with fresh IDs; retry rejects an existing live fingerprint', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); f.queue.add(input()); const item = f.queue.items[0];
    if (cancelled) { await f.queue.stop(item.queueId); f.queue.event('youtube', { jobId: item.jobId, state: 'cancelled', message: 'Cancelled.', percent: null }); }
    f.downloads[0].reject(new Error('download failed')); await flush();
    assert.deepEqual([item.status, item.message], cancelled ? ['cancelled', 'Cancelled.'] : ['failed', 'download failed']);
    assert.equal(f.queue.repeat(item.queueId).added, 1);
    assert.notEqual(f.queue.items[1].jobId, item.jobId);
    assert.equal(f.queue.repeat(item.queueId).added, 0);
    assert.equal(f.downloads.length, 2);
    assert.deepEqual(f.cancels, cancelled ? [item.jobId] : []);
  }
});

for (const action of ['import', 'playhead', 'end']) test(`${action} transfer overlaps next download and retains the captured bin`, async () => {
  const f = fixture(), pending = deferred();
  f.adapter.transfer = (cardId, bin, action) => { f.transfers.push([cardId, bin, action]); return pending.promise; };
  f.queue.add(input('youtube', youtube('a'), { intent: action, targetBin: 'clipdock' })); f.queue.add(input('youtube', youtube('b')));
  await complete(f);
  assert.deepEqual([f.queue.items[0].status, f.downloads.length, f.queue.activeId], ['transferring', 2, f.queue.items[1].queueId]);
  assert.deepEqual(f.transfers, [['card-0', 'clipdock', action]]);
  pending.resolve({ ok: true, message: 'Added.' }); await flush();
  assert.deepEqual([f.queue.items[0].status, f.queue.items[0].message, f.queue.items[0].transferError], ['completed', 'Added.', undefined]);
});

for (const throws of [false, true]) test(`transfer failure (${throws ? 'rejection' : 'result'}) leaves a completed download and manual fallback can recover`, async () => {
  const f = fixture();
  f.adapter.transfer = async () => { if (throws) throw new Error('Host busy'); return { ok: false, message: 'Host busy' }; };
  f.queue.add(input('youtube', youtube(), { intent: 'import', targetBin: 'clipdock' })); await complete(f);
  const item = f.queue.items[0];
  assert.deepEqual([item.status, item.cardId, item.transferError, item.message], ['completed', 'card-0', 'Host busy', 'Download complete. Host busy']);
  f.adapter.transfer = async (...args) => { f.transfers.push(args); return { ok: true, message: 'Added at playhead.' }; };
  await f.queue.transfer(item.queueId, 'playhead');
  assert.deepEqual([item.transferError, item.message, f.downloads.length, f.transfers], [undefined, 'Added at playhead.', 1, [['card-0', 'clipdock', 'playhead']]]);
});

test('progress, preparation and cancellation events notify; wrong providers and late events cannot revive terminal jobs', async () => {
  const f = fixture(); f.queue.add(input()); const item = f.queue.items[0];
  const event = { jobId: item.jobId, state: 'downloading', message: 'Downloading', percent: 140, speedBytesPerSecond: 20, etaSeconds: 900000 };
  f.queue.event('social', event); assert.equal(item.percent, null);
  f.queue.event('youtube', event); assert.deepEqual([item.percent, item.speedBytesPerSecond, item.etaSeconds, f.changes.at(-1).progress], [100, 20, 604800, true]);
  f.queue.event('youtube', { ...event, state: 'processing', percent: NaN });
  assert.deepEqual([item.status, item.percent, item.speedBytesPerSecond, item.etaSeconds], ['preparing', null, null, null]);
  f.queue.event('youtube', { ...event, state: 'cancelled', message: 'Cancelled.' });
  f.downloads[0].reject(new Error('cancelled')); await flush();
  f.queue.event('youtube', event); assert.equal(item.status, 'cancelled');
  assert.deepEqual(f.changes.filter(change => change.settled).map(change => change.status), ['cancelled']);
});

test('card invalidation notifies subscribers and blocks handoff, including repeated invalidation', async () => {
  const f = fixture(); f.queue.add(input()); await complete(f); const item = f.queue.items[0];
  const before = f.changes.length;
  f.queue.invalidateCards(['card-0']); f.queue.invalidateCards(['card-0']);
  assert.deepEqual([item.fileDeleted, f.changes.length - before], [true, 2]);
  await f.queue.transfer(item.queueId, 'import'); assert.deepEqual(f.transfers, []);
  assert.equal(f.queue.repeat(item.queueId, true).added, 1);
  assert.equal(f.queue.items[1].fileDeleted, undefined);
});

test('remove protects the active download; deletion removes only on a successful managed delete', async () => {
  const f = fixture(); f.queue.add(input()); f.queue.add(input('youtube', youtube('b')));
  f.queue.remove(f.queue.items[0].queueId); assert.equal(f.queue.items.length, 2);
  f.queue.remove(f.queue.items[1].queueId); assert.equal(f.queue.items.length, 1);
  await complete(f); const item = f.queue.items[0];
  f.adapter.deleteFile = async () => ({ deleted: false, message: 'Still used.' });
  await f.queue.deleteFile(item.queueId);
  assert.deepEqual([f.queue.items.length, item.actionError, item.transferError, item.deleting], [1, 'Still used.', undefined, false]);
  f.adapter.deleteFile = async id => { f.deletes.push(id); return { deleted: true, message: 'File deleted.' }; };
  await f.queue.deleteFile(item.queueId);
  assert.deepEqual([f.queue.items.length, f.deletes], [0, ['card-0']]);
});

test('unsubscribe ends notifications and a blocked manual handoff records the host reason', async () => {
  const f = fixture(); let notifications = 0;
  const unsubscribe = f.queue.subscribe(() => notifications++);
  f.queue.add(input()); await complete(f); assert.equal(notifications, 3);
  unsubscribe(); const item = f.queue.items[0];
  await f.queue.transfer(item.queueId, 'import', 'Open a project.');
  assert.deepEqual([notifications, item.transferError, item.message, f.transfers], [3, 'Open a project.', 'Open a project.', []]);
});

test('queued, preparing and transferring fingerprints reject duplicate adds', async () => {
  const f = fixture();
  const first = input('youtube', youtube('a'), { intent: 'import' });
  const second = input('youtube', youtube('b'));
  f.queue.add(first); f.queue.add(second);
  assert.equal(f.queue.add(second).added, 0);
  f.queue.event('youtube', { jobId: f.queue.items[0].jobId, state: 'processing', message: 'Preparing', percent: null });
  assert.deepEqual([f.queue.items[0].status, f.queue.add(first).added], ['preparing', 0]);
  const transfer = deferred(); f.adapter.transfer = () => transfer.promise;
  await complete(f);
  assert.deepEqual([f.queue.items[0].status, f.queue.add(first).added], ['transferring', 0]);
  transfer.resolve({ ok: true, message: 'Added.' }); await flush();
});

test('Stop is single-flight; stop and delete failures remain action errors, without handoff failure', async () => {
  const f = fixture(), cancel = deferred();
  f.adapter.cancel = item => { f.cancels.push(item.jobId); return cancel.promise; };
  f.queue.add(input()); const item = f.queue.items[0];
  const stopping = f.queue.stop(item.queueId);
  await f.queue.stop(item.queueId);
  assert.deepEqual([item.stopping, f.cancels], [true, [item.jobId]]);
  cancel.resolve(false); await stopping;
  assert.deepEqual([item.stopping, item.actionError, item.transferError, item.status], [false, 'Could not stop this download. Try again.', undefined, 'downloading']);
  f.adapter.cancel = async () => { throw new Error('Stop unavailable'); };
  await f.queue.stop(item.queueId); assert.equal(item.actionError, 'Stop unavailable');
  await complete(f);
  f.adapter.deleteFile = async () => { throw new Error('Delete unavailable'); };
  await f.queue.deleteFile(item.queueId);
  assert.deepEqual([f.queue.items.length, item.actionError, item.transferError, item.deleting], [1, 'Delete unavailable', undefined, false]);
});

test('successful downloads preserve subtitle and warning artifacts; late provider events do not overwrite completion', async () => {
  const f = fixture(); f.queue.add(input()); const item = f.queue.items[0];
  const subtitle = { cardId: 'srt-card', fileName: 'captions.srt' };
  f.downloads[0].resolve({ cardId: 'card', fileName: 'clip.mp4', subtitle, warning: 'Audio copied.' }); await flush();
  f.queue.event('youtube', { jobId: item.jobId, state: 'failed', percent: null, message: 'Stale failure' });
  assert.deepEqual([item.status, item.cardId, item.fileName, item.subtitle, item.warning, item.message], ['completed', 'card', 'clip.mp4', subtitle, 'Audio copied.', 'Download complete.']);
});

test('different quality fingerprints remain separate downloads for the same source', async () => {
  const f = fixture();
  assert.equal(f.queue.add(input('youtube', youtube(), { quality: '1080p' })).added, 1);
  assert.equal(f.queue.add(input('youtube', youtube(), { quality: '720p' })).added, 1, 'different quality is allowed');
  await complete(f, 0); await complete(f, 1);
  assert.deepEqual(f.downloads.map(({ item }) => item.quality), ['1080p', '720p']);
  assert.deepEqual(f.queue.items.map(item => item.status), ['completed', 'completed']);
});

test('audio mode has a distinct fingerprint with the same quality, profile and audio format', async () => {
  const f = fixture();
  const metadata = { ...youtube(), heights: [] };
  assert.equal(f.queue.add(input('youtube', metadata)).added, 1);
  assert.equal(f.queue.add(input('youtube', metadata, { mediaMode: 'audio' })).added, 1, 'audio mode differs from video');
  await complete(f, 0); await complete(f, 1);
  assert.deepEqual(f.downloads.map(({ item }) => [item.quality, item.profile, item.options.mediaMode, item.options.audioFormat]), [
    ['best', 'original', 'video', 'mp3'], ['best', 'original', 'audio', 'mp3'],
  ]);
  assert.deepEqual(f.queue.items.map(item => item.status), ['completed', 'completed']);
});

test('handoff and managed delete of one card are mutually exclusive', async () => {
  const f = fixture(); f.queue.add(input()); await complete(f); const item = f.queue.items[0];
  const removal = deferred(); f.adapter.deleteFile = id => { f.deletes.push(id); return removal.promise; };
  const deleting = f.queue.deleteFile(item.queueId);
  await f.queue.transfer(item.queueId, 'import');
  assert.deepEqual(f.transfers, [], 'no handoff while the file is being deleted');
  removal.resolve({ deleted: false, message: 'Still used.' }); await deleting;
  const handoff = deferred(); f.adapter.transfer = (...args) => { f.transfers.push(args); return handoff.promise; };
  const transferring = f.queue.transfer(item.queueId, 'import');
  await f.queue.deleteFile(item.queueId);
  assert.deepEqual(f.deletes, ['card-0'], 'no delete while the file is being handed off');
  handoff.resolve({ ok: true, message: 'Added.' }); await transferring;
  assert.deepEqual(f.transfers, [['card-0', 'active', 'import']]);
});

test('a Stop failure never outlives the download it tried to stop', async () => {
  const f = fixture(); f.queue.add(input()); const item = f.queue.items[0];
  f.adapter.cancel = async () => false;
  await f.queue.stop(item.queueId);
  assert.equal(item.actionError, 'Could not stop this download. Try again.');
  await complete(f);
  assert.deepEqual([item.status, item.actionError, item.message], ['completed', undefined, 'Download complete.']);
  f.queue.add(input('youtube', youtube('b'))); const late = f.queue.items[1];
  const cancel = deferred(); f.adapter.cancel = () => cancel.promise;
  const stopping = f.queue.stop(late.queueId);
  await complete(f, 1);
  cancel.resolve(false); await stopping;
  assert.deepEqual([late.status, late.actionError, late.message], ['completed', undefined, 'Download complete.']);
});
