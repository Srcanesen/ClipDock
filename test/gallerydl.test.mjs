import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chmodSync, lstatSync, readFileSync, renameSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerDownload} from './helpers/provider-job-main.mjs';

import * as gallerydlModule from '../dist/gallerydl.js';
import {
  GalleryDlWorker,
  createPinterestSearchSnapshotStore,
  discoverGalleryDl,
  galleryDlVersionSupported,
  parseGalleryDlJsonl,
  parsePinterestMetadataJsonl,
  parsePinterestSearchJsonl,
} from '../dist/gallerydl.js';
import {validatePinterestSearchQuery, validatePinterestUrl} from '../dist/ytdlp-url.js';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    if (pid !== undefined) this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = [];
  }
  kill(signal) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('close', 143));
    return true;
  }
}

const tempRoot = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const imageBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const videoBytes = () => Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(16)]);

const opaqueFixture = readFileSync(new URL('./fixtures/pinterest-opaque-search.jsonl', import.meta.url), 'utf8');
const opaqueId = 'e1_AfqPShwWJ_9nNp98oMy8EENZLzrcH3zYISwyG7ODp0u4p3s_onow';
const opaqueSource = `https://www.pinterest.com/pin/${opaqueId}/`;
const opaqueMedia = 'https://i.pinimg.com/originals/2b/02/4d/2b024d05a26db6772778b5a9e68f2198.jpg';

test('numeric Pinterest search preserves missing and mismatched counts within the item limit', async t => {
  const root = tempRoot('clipdock-pinterest-numeric-count-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const values = [
    [2, {id: '123', title: 'Without count'}],
    [3, 'https://i.pinimg.com/123.jpg', {id: '123', extension: 'jpg'}],
    [2, {id: '124', title: 'Mismatched count', count: 2}],
    [3, 'https://i.pinimg.com/124.jpg', {id: '124', extension: 'jpg'}],
    [2, {id: '125', title: 'Above limit', count: 51}],
    [3, 'https://i.pinimg.com/125.jpg', {id: '125', extension: 'jpg'}],
  ];
  let calls = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    calls++;
    const child = new FakeChild();
    queueMicrotask(() => {child.stdout.emit('data', values.map(JSON.stringify).join('\n')); child.emit('close', 0);});
    return child;
  }, {sessionDir: root});
  t.after(() => worker.dispose());
  const page = await worker.search('numeric count', 1);
  assert.deepEqual(page.results.map(({id, title, kind}) => ({id, title, kind})), [
    {id: '123', title: 'Without count', kind: 'image'},
    {id: '124', title: 'Mismatched count', kind: 'carousel'},
  ]);
  assert.equal(calls, 1);
});

test('numeric Pinterest metadata accepts idea discriminators in directory and media records', async t => {
  const root = tempRoot('clipdock-pinterest-numeric-idea-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const values = [
    [2, {id: '123', title: 'Numeric idea metadata', count: 1, type: 'idea', subcategory: 'idea', kind: 'idea'}],
    [3, 'https://i.pinimg.com/123.jpg', {id: '123', extension: 'jpg', title: 'Image item', type: 'idea', subcategory: 'idea', kind: 'idea'}],
  ];
  let calls = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    calls++;
    const child = new FakeChild();
    queueMicrotask(() => {child.stdout.emit('data', values.map(JSON.stringify).join('\n')); child.emit('close', 0);});
    return child;
  }, {sessionDir: root});
  t.after(() => worker.dispose());
  const metadata = await worker.metadata('https://www.pinterest.com/pin/123/');
  assert.equal(metadata.pinId, '123');
  assert.equal(metadata.title, 'Numeric idea metadata');
  assert.deepEqual(metadata.items, [{index: 1, kind: 'image', title: 'Image item', creator: null, extension: 'jpg'}]);
  assert.deepEqual(parsePinterestSearchJsonl(values.map(JSON.stringify).join('\n')).map(item => item.id), ['123']);
  assert.equal(calls, 1);
});

test('opaque Pinterest search selection loads snapshot metadata and downloads the exact cached image', async t => {
  const root = tempRoot('clipdock-pinterest-opaque-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const calls = [];
  let now = 0;
  const spawn = (_binary, args) => {
    calls.push(args);
    const child = new FakeChild();
    setImmediate(() => {
      if (args.includes('--dump-json')) child.stdout.emit('data', opaqueFixture);
      else {now = 5 * 60 * 1000; writeFileSync(path.join(args[args.indexOf('-D') + 1], 'pinterest.jpg'), imageBytes());}
      child.emit('close', 0);
    });
    return child;
  };
  const searchSnapshots = createPinterestSearchSnapshotStore(() => now);
  const worker = new GalleryDlWorker('/fixture/gallery-dl', spawn, {sessionDir: path.join(root, 'download'), searchSnapshots});
  const searchWorker = new GalleryDlWorker('/fixture/gallery-dl', spawn, {sessionDir: path.join(root, 'search'), searchSnapshots});
  const metadataWorker = new GalleryDlWorker('/fixture/gallery-dl', spawn, {sessionDir: path.join(root, 'metadata'), searchSnapshots});
  t.after(async () => { await worker.dispose(); await searchWorker.dispose(); await metadataWorker.dispose(); });
  const page = await searchWorker.search('ocean', 1);
  assert.deepEqual(page.results.map(({id, title, creator, kind, url}) => ({id, title, creator, kind, url})), [
    {id: opaqueId, title: 'Sanitized image Pin', creator: 'fixture', kind: 'image', url: opaqueSource},
  ]);
  const metadata = await metadataWorker.metadata(opaqueSource);
  assert.equal(metadata.pinId, opaqueId);
  assert.equal(metadata.creator, 'fixture');
  assert.deepEqual(metadata.items, [{index: 1, title: 'Sanitized image Pin', creator: 'fixture', kind: 'image', extension: 'jpg'}]);
  assert.equal(calls.length, 1, 'opaque metadata must never spawn PinResource');
  assert.equal(JSON.stringify({page, metadata}).includes(opaqueMedia), false);
  const result = await worker.download(opaqueSource, 1, 'image', 'opaque-image', () => {});
  assert.equal(result.kind, 'image');
  assert.equal(readFileSync(result.filePath).subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(calls[1].at(-1), opaqueMedia);
  assert.equal(calls[1][calls[1].indexOf('--range') + 1], '1');
  await assert.rejects(worker.download('https://evil.test/injected.jpg', 1, 'image', 'injection', () => {}), /Invalid Pinterest download request/);
  assert.equal(calls.length, 2);
});

test('Pinterest search snapshots are capped at 300 complete groups', () => {
  const snapshots = createPinterestSearchSnapshotStore();
  for (let id = 1; id <= 301; id++) snapshots.set(String(id), {metadata: {pinId: String(id)}, mediaUrls: [`https://i.pinimg.com/${id}.jpg`]});
  assert.equal(snapshots.get('1'), null);
  assert.deepEqual(snapshots.get('301'), {metadata: {pinId: '301'}, mediaUrls: ['https://i.pinimg.com/301.jpg']});
});

test('opaque carousel item 2 downloads its literal cached URL with range 1', async t => {
  const root = tempRoot('clipdock-pinterest-carousel-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const values = opaqueFixture.trim().split('\n').map(JSON.parse);
  values[0][1].count = 2;
  const secondUrl = 'https://i.pinimg.com/originals/second.png?fixture=exact';
  values.push([3, secondUrl, {...values[1][2], extension: 'png', num: 2}]);
  const calls = [];
  const worker = new GalleryDlWorker('/fixture/gallery-dl', (_binary, args) => {
    calls.push(args);
    const child = new FakeChild();
    queueMicrotask(() => {
      if (args.includes('--dump-json')) child.stdout.emit('data', values.map(JSON.stringify).join('\n'));
      else writeFileSync(path.join(args[args.indexOf('-D') + 1], 'pinterest.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      child.emit('close', 0);
    });
    return child;
  }, {sessionDir: root});
  t.after(() => worker.dispose());
  assert.equal((await worker.search('carousel', 1)).results[0].kind, 'carousel');
  assert.deepEqual((await worker.metadata(opaqueSource)).items.map(item => [item.index, item.extension]), [[1, 'jpg'], [2, 'png']]);
  const result = await worker.download(opaqueSource, 2, 'image', 'carousel-two', () => {});
  assert.equal(result.fileName, 'pinterest.png');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1), secondUrl);
  assert.equal(calls[1][calls[1].indexOf('--range') + 1], '1');
  await assert.rejects(worker.download(opaqueSource, 3, 'image', 'absent-item', () => {}), /Pinterest download failed/);
  assert.equal(calls.length, 2);
});

test('opaque snapshots expire, missing handles ask for search, and videos are explicitly unsupported', async t => {
  const root = tempRoot('clipdock-pinterest-expiry-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  let now = 0;
  let calls = 0;
  let output = opaqueFixture;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    calls++;
    const child = new FakeChild();
    queueMicrotask(() => {child.stdout.emit('data', output); child.emit('close', 0);});
    return child;
  }, {sessionDir: root, now: () => now});
  t.after(() => worker.dispose());
  await assert.rejects(worker.metadata(opaqueSource), /Search again/);
  await assert.rejects(worker.download(opaqueSource, 1, 'image', 'missing', () => {}), /Search again/);
  assert.equal(calls, 0);
  await worker.search('expiry', 1);
  now = 5 * 60 * 1000;
  await assert.rejects(worker.metadata(opaqueSource), /Search again/);
  await assert.rejects(worker.download(opaqueSource, 1, 'image', 'expired', () => {}), /Search again/);
  assert.equal(calls, 1, 'expired handles never trigger PinResource or download');
  const values = opaqueFixture.trim().split('\n').map(JSON.parse);
  values[1][1] = 'ytdl:https://v1.pinimg.com/videos/fixture.m3u8';
  values[1][2].extension = 'mp4';
  output = values.map(JSON.stringify).join('\n');
  assert.equal((await worker.search('video', 1)).results[0].kind, 'video');
  assert.equal((await worker.metadata(opaqueSource)).items[0].kind, 'video');
  await assert.rejects(worker.download(opaqueSource, 1, 'video', 'unsupported-video', () => {}), /Video downloads from Pinterest search selections are not supported/);
  assert.equal(calls, 2);
});

test('unusable media returns an uncached compatibility error; Story, promo and genuine empty stay excluded', async t => {
  const root = tempRoot('clipdock-pinterest-compatibility-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const fixture = () => opaqueFixture.trim().split('\n').map(JSON.parse);
  const scenarios = [
    ['unknown identity', values => {values[0][1].id = values[1][2].id = 'future_opaque';}],
    ['incomplete', values => {values[0][1].count = 2;}],
    ['missing count', values => {delete values[0][1].count;}],
    ['unsafe URL', values => {values[1][1] = 'https://evil.test/arbitrary.jpg';}],
    ['unsupported', values => {values[1][2].extension = 'gif';}],
  ];
  let output = '';
  let calls = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    calls++;
    const child = new FakeChild();
    queueMicrotask(() => {child.stdout.emit('data', output); child.emit('close', 0);});
    return child;
  }, {sessionDir: root});
  t.after(() => worker.dispose());
  for (const [query, mutate] of scenarios) {
    const values = fixture(); mutate(values); output = values.map(JSON.stringify).join('\n');
    const before = calls;
    await assert.rejects(worker.search(query, 1), /provider response may have changed/);
    await assert.rejects(worker.search(query, 1), /provider response may have changed/);
    assert.equal(calls, before + 2, 'compatibility errors must not be cached');
    await assert.rejects(worker.metadata(opaqueSource), /Search again/);
  }
  for (const query of ['Story', 'Idea', 'promo', 'empty']) {
    const values = fixture();
    if (query === 'Story') values[0][1].story_pin_data = {pages: []};
    if (query === 'Idea') values[0][1].type = 'idea';
    if (query === 'promo') values[0][1].count = 0;
    output = query === 'empty' ? '' : values.map(JSON.stringify).join('\n');
    const before = calls;
    assert.deepEqual((await worker.search(query, 1)).results, []);
    assert.deepEqual((await worker.search(query, 1)).results, []);
    assert.equal(calls, before + 1);
  }
});

test('opaque original media cannot leak through the thumbnail fallback', async t => {
  const root = tempRoot('clipdock-pinterest-original-thumbnail-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const values = opaqueFixture.trim().split('\n').map(JSON.parse);
  for (const record of [values[0][1], values[1][2]]) record.images = {orig: {url: opaqueMedia}};
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    const child = new FakeChild();
    queueMicrotask(() => {child.stdout.emit('data', values.map(JSON.stringify).join('\n')); child.emit('close', 0);});
    return child;
  }, {sessionDir: root});
  t.after(() => worker.dispose());
  const page = await worker.search('original fallback', 1);
  assert.equal(page.results[0].thumbnailUrl, null);
  const metadata = await worker.metadata(opaqueSource);
  assert.equal(metadata.thumbnailUrl, null);
  assert.equal(JSON.stringify({page, metadata}).includes(opaqueMedia), false);
});

test('opaque URL grammar is bounded and uses the actual id rather than node or board ids', () => {
  assert.deepEqual(validatePinterestUrl(opaqueSource), {url: opaqueSource, pinId: opaqueId});
  for (const id of ['e1_short', `e1_${'a'.repeat(101)}`, `e2_${'a'.repeat(50)}`, `e1_${'a'.repeat(40)}.jpg`, '811211020320072772/extra']) {
    assert.equal(validatePinterestUrl(`https://www.pinterest.com/pin/${id}/`), null);
  }
  const values = opaqueFixture.trim().split('\n').map(JSON.parse);
  values[0][1].pin_id = values[1][2].pin_id = '811211020320072772';
  assert.equal(parsePinterestSearchJsonl(values.map(JSON.stringify).join('\n'))[0].id, opaqueId);
});

test('Pinterest direct URL validation stays exact and canonical', () => {
  assert.deepEqual(validatePinterestUrl('https://pinterest.com/pin/123456789?utm_source=x'), { url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789' });
  for (const value of [
    'http://www.pinterest.com/pin/123456789/',
    'https://www.pinterest.com/pin/123456789/#fragment',
    'https://www.pinterest.com:443/pin/123456789/',
    'https://user@www.pinterest.com/pin/123456789/',
    'https://pin.it/123456789',
    'https://www.pinterest.com/boards/123456789/',
    'https://www.pinterest.com/pin/123/extra/',
    'https://www.pinterest.com/pin/not-a-number/',
  ]) assert.equal(validatePinterestUrl(value), null, value);
});

test('Pinterest search Slice A validates bounded queries and normalizes safe results', () => {
  assert.equal(validatePinterestSearchQuery('  ocean & waves  '), 'ocean & waves');
  for (const value of [null, 42, '', 'a', '  ', 'a\tb', 'a\u0085b', 'x'.repeat(101)]) assert.equal(validatePinterestSearchQuery(value), null);

  const source = [
    [2, {id: '100', count: 0, type: 'story', story_type: 'featured_boards'}],
    [3, 'https://i.pinimg.com/promo.jpg', {pin_id: '100', extension: 'jpg'}],
    [2, {id: '102', count: 1, title: 'First title', pinner: {username: 'creator'}}],
    [3, 'https://i.pinimg.com/originals/102.jpg', {pin_id: '102', extension: 'jpg', filename: '/tmp/private.jpg', images: {orig: {url: 'https://i.pinimg.com/raw.jpg'}}}],
    [2, {id: '102', count: 1, title: 'Duplicate title'}],
    [3, 'https://i.pinimg.com/originals/102-duplicate.jpg', {pin_id: '102', extension: 'jpg'}],
    [2, {id: '103', count: 2, description: 'Carousel'}],
    [3, 'https://i.pinimg.com/originals/103.jpg', {pin_id: '103', extension: 'jpg'}],
    [3, 'ytdl:https://v1.pinimg.com/videos/103.m3u8', {pin_id: '103', extension: 'mp4'}],
    [2, {id: '104', count: 1}],
    [3, 'https://i.pinimg.com/originals/104.gif', {pin_id: '104', extension: 'gif'}],
  ].map(JSON.stringify).join('\n');
  const items = parsePinterestSearchJsonl(source);
  assert.deepEqual(items.map(({id, kind, title, creator}) => ({id, kind, title, creator})), [
    {id: '102', kind: 'image', title: 'First title', creator: 'creator'},
    {id: '103', kind: 'carousel', title: 'Carousel', creator: null},
  ]);
  assert.equal(JSON.stringify(items).includes('i.pinimg.com'), false);
  assert.equal(JSON.stringify(items).includes('/tmp/private.jpg'), false);
  assert.throws(() => parsePinterestSearchJsonl('[-1, {"message":"login required"}]'), /login required/);
  assert.throws(() => parsePinterestSearchJsonl('[6, "queued"]'), /Queue/);
  assert.throws(() => parsePinterestSearchJsonl('[3]'), /malformed/);
  assert.throws(() => parsePinterestSearchJsonl('[2, {"id":"1"}'), /Could not load|Pinterest/);
  assert.throws(() => parsePinterestSearchJsonl('x'.repeat(4 * 1024 * 1024 + 1)), /too large/);
});

test('Pinterest search silently excludes Story and Idea Pins while retaining supported media', () => {
  const source = [
    [2, {id: '201', count: 1, title: 'Story data', story_pin_data: {pages: []}}],
    [3, 'https://i.pinimg.com/201.jpg', {pin_id: '201', extension: 'jpg'}],
    [2, {id: '202', count: 1, title: 'Story type', type: 'story'}],
    [3, 'https://i.pinimg.com/202.jpg', {pin_id: '202', extension: 'jpg'}],
    [2, {id: '203', count: 1, title: 'Story subcategory', subcategory: 'story'}],
    [3, 'https://i.pinimg.com/203.jpg', {pin_id: '203', extension: 'jpg'}],
    [2, {id: '204', count: 1, title: 'Story kind', kind: 'story'}],
    [3, 'https://i.pinimg.com/204.jpg', {pin_id: '204', extension: 'jpg'}],
    [2, {id: '205', count: 1, title: 'Story media marker'}],
    [3, 'https://i.pinimg.com/205.jpg', {pin_id: '205', extension: 'jpg', type: 'story'}],
    [2, {id: '206', count: 1, title: 'Ordinary image'}],
    [3, 'https://i.pinimg.com/206.jpg', {pin_id: '206', extension: 'jpg'}],
    [2, {id: '207', count: 1, title: 'Ordinary video'}],
    [3, 'https://v.pinimg.com/207.mp4', {pin_id: '207', extension: 'mp4'}],
    [2, {id: '208', count: 2, title: 'Ordinary carousel'}],
    [3, 'https://i.pinimg.com/208-one.jpg', {pin_id: '208', extension: 'jpg'}],
    [3, 'https://i.pinimg.com/208-two.jpg', {pin_id: '208', extension: 'jpg'}],
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parsePinterestSearchJsonl(source).map(({id, kind}) => ({id, kind})), [
    {id: '206', kind: 'image'},
    {id: '207', kind: 'video'},
    {id: '208', kind: 'carousel'},
  ]);
});

test('Pinterest search parser caps deduplicated results at 30', () => {
  const source = [];
  for (let index = 1; index <= 35; index += 1) {
    source.push([2, {id: String(index), count: 1, title: `Pin ${index}`}]);
    source.push([3, `https://i.pinimg.com/${index}.jpg`, {pin_id: String(index), extension: 'jpg'}]);
  }
  const items = parsePinterestSearchJsonl(source.map(JSON.stringify).join('\n'));
  assert.equal(items.length, 30);
  assert.equal(items.at(-1).id, '30');
});

test('GalleryDlWorker.search uses the fixed encoded argv and bounded cache paging', async () => {
  const root = tempRoot('clipdock-gallery-search-');
  const calls = [];
  const fetched = [];
  let now = 0;
  try {
    const feed = [];
    for (let index = 1; index <= 25; index += 1) {
      feed.push([2, {id: String(index), count: 1, title: `Pin ${index}`, pinner: {username: `user-${index}`}, images: {'474x': {url: `https://i.pinimg.com/thumb-${index}.jpg`}}}]);
      feed.push([3, `https://i.pinimg.com/originals/${index}.jpg`, {pin_id: String(index), extension: 'jpg'}]);
    }
    const output = feed.map(JSON.stringify).join('\n');
    const fetcher = async (url) => {
      fetched.push(url);
      return {ok: true, status: 200, url, headers: {get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : name.toLowerCase() === 'content-length' ? String(imageBytes().length) : null}, arrayBuffer: async () => imageBytes()};
    };
    const spawn = (_binary, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.detached, true);
      const child = new FakeChild();
      calls.push(args);
      setImmediate(() => { child.stdout.emit('data', `${output}\n`); child.emit('close', 0); });
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, fetcher, now: () => now});
    const first = await worker.search('  ocean & waves  ', 1);
    assert.deepEqual(calls[0], ['--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--range', '1-60', '--http-timeout', '30', '--retries', '2', '--sleep-request', '0', 'https://www.pinterest.com/search/pins/?q=ocean%20%26%20waves']);
    assert.equal(calls[0].includes('--post-range'), false);
    assert.equal(first.results.length, 10);
    assert.equal(first.results[0].url, 'https://www.pinterest.com/pin/1/');
    assert.equal(first.results[0].thumbnailUrl, 'https://i.pinimg.com/thumb-1.jpg');
    assert.equal(first.totalResults, 25);
    assert.equal(first.pageCount, 3);
    assert.equal(first.hasPrevious, false);
    assert.equal(first.hasNext, true);
    assert.equal(JSON.stringify(first).includes('i.pinimg.com'), true);
    assert.equal(fetched.length, 0);

    const second = await worker.search('OCEAN & WAVES', 2);
    assert.deepEqual(second.results.map((item) => item.id), Array.from({length: 10}, (_, index) => String(index + 11)));
    assert.equal(second.hasPrevious, true);
    assert.equal(second.hasNext, true);
    assert.equal(calls.length, 1, 'page 2 is served from the query cache');
    const third = await worker.search('ocean & waves', 3);
    assert.deepEqual(third.results.map((item) => item.id), ['21', '22', '23', '24', '25']);
    assert.equal(third.hasNext, false);
    assert.equal(calls.length, 1, 'page 3 is served from the query cache');

    now = 4 * 60 * 1000;
    await worker.search('ocean & waves', 1);
    assert.equal(calls.length, 1, 'cache remains valid before five minutes');
    now = 5 * 60 * 1000;
    await worker.search('ocean & waves', 1);
    assert.equal(calls.length, 2, 'cache expires at five minutes');
    await assert.rejects(worker.search('x', 1), /2–100/);
    assert.equal(calls.length, 2, 'invalid query is rejected before spawn');
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('GalleryDlWorker.search returns safe image URLs without thumbnail fetching', async t => {
  const root = tempRoot('clipdock-pinterest-no-images-'); t.after(() => rmSync(root, {recursive: true, force: true}));
  let fetches = 0;
  const spawn = () => { const child = new FakeChild(); queueMicrotask(() => {
    for (const [id, thumbnail] of [['900', 'https://i.pinimg.com/474x/pin.jpg'], ['901', 'https://evil.test/pin.jpg']]) {
      child.stdout.emit('data', JSON.stringify([2, {id, count: 1, title: 'Pin', thumbnail}]) + '\n');
      child.stdout.emit('data', JSON.stringify([3, 'https://i.pinimg.com/originals/' + id + '.jpg', {pin_id: id, extension: 'jpg'}]) + '\n');
    }
    child.emit('close', 0);
  }); return child; };
  const worker = new GalleryDlWorker('/fixture/gallery-dl', spawn, {sessionDir: root, fetcher: async () => {fetches++; return new Promise(() => {});}});
  const page = await worker.search('pins', 1);
  assert.deepEqual(page.results.map(item => item.thumbnailUrl), ['https://i.pinimg.com/474x/pin.jpg', null]);
  assert.equal(fetches, 0);
});

test('GalleryDlWorker.search rejects exit-zero stderr failures without caching while preserving clean empty results', async () => {
  const scenarios = [
    {name: 'empty-error', output: '', stderr: '[pinterest][error] HttpError: 429 Too Many Requests', expected: /Could not search Pinterest/},
    {name: 'partial-login', output: [
      [2, {id: '700', count: 1, title: 'Complete'}],
      [3, 'https://i.pinimg.com/700.jpg', {pin_id: '700', extension: 'jpg'}],
      [2, {id: '701', count: 1, title: 'Interrupted'}],
    ].map(JSON.stringify).join('\n'), stderr: '[pinterest][warning] Login required while extracting results', expected: /private or requires login/},
  ];
  for (const scenario of scenarios) {
    const root = tempRoot(`clipdock-gallery-search-${scenario.name}-`);
    let spawns = 0;
    try {
      const spawn = () => {
        spawns += 1;
        const child = new FakeChild();
        setImmediate(() => {
          if (scenario.output) child.stdout.emit('data', `${scenario.output}\n`);
          child.stderr.emit('data', scenario.stderr);
          child.emit('close', 0);
        });
        return child;
      };
      const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root});
      await assert.rejects(worker.search(`failure ${scenario.name}`, 1), scenario.expected);
      await assert.rejects(worker.search(`failure ${scenario.name}`, 1), scenario.expected);
      assert.equal(spawns, 2, `${scenario.name} must not be cached`);
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }

  const emptyRoot = tempRoot('clipdock-gallery-search-empty-');
  let emptySpawns = 0;
  try {
    const spawn = () => {
      emptySpawns += 1;
      const child = new FakeChild();
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: emptyRoot});
    const page = await worker.search('legitimate empty', 1);
    assert.deepEqual(page.results, []);
    assert.equal(page.totalResults, 0);
    await worker.search('legitimate empty', 1);
    assert.equal(emptySpawns, 1, 'clean empty results remain cacheable');
  } finally { rmSync(emptyRoot, {recursive: true, force: true}); }
});

test('GalleryDlWorker.search timeout, cancellation, dispose, and broken-tool paths clean up jobs', async () => {
  const pendingWorker = (root, options = {}) => {
    let child;
    const spawn = () => { child = new FakeChild(); return child; };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, metadataTimeoutMs: 20, killGraceMs: 5, ...options});
    return {worker, get child() { return child; }};
  };
  const timeoutRoot = tempRoot('clipdock-gallery-search-timeout-');
  try {
    const fixture = pendingWorker(timeoutRoot, {metadataTimeoutMs: 5});
    await assert.rejects(fixture.worker.search('timeout search', 1), /timed out/i);
    assert.deepEqual(readdirSync(timeoutRoot), []);
  } finally { rmSync(timeoutRoot, {recursive: true, force: true}); }

  const disposeRoot = tempRoot('clipdock-gallery-search-dispose-');
  try {
    const fixture = pendingWorker(disposeRoot);
    const pending = fixture.worker.search('dispose search', 1);
    await new Promise((resolve) => setImmediate(resolve));
    fixture.worker.dispose();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(fixture.worker.isActive(), false);
    assert.deepEqual(readdirSync(disposeRoot), []);
  } finally { rmSync(disposeRoot, {recursive: true, force: true}); }

  const brokenRoot = tempRoot('clipdock-gallery-search-broken-');
  try {
    const broken = new GalleryDlWorker('/usr/local/bin/gallery-dl', () => { throw new Error('spawn failed'); }, {sessionDir: brokenRoot});
    await assert.rejects(broken.search('broken search', 1), /Could not search Pinterest/);
    assert.deepEqual(readdirSync(brokenRoot), []);
    await assert.rejects(new GalleryDlWorker(null).search('missing search', 1), /gallery-dl 1\.28\.0/);
  } finally { rmSync(brokenRoot, {recursive: true, force: true}); }
});

test('GalleryDlWorker returns a fixed truthful error for direct Story metadata', async () => {
  const root = tempRoot('clipdock-gallery-story-');
  try {
    const spawn = (_binary, _args) => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', `${JSON.stringify([2, {id: '123456789', count: 1, title: 'Story', story_pin_data: {pages: []}}])}\n${JSON.stringify([3, 'https://i.pinimg.com/story.jpg', {pin_id: '123456789', extension: 'jpg'}])}\n`);
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root});
    await assert.rejects(worker.metadata('https://www.pinterest.com/pin/123456789/'), (error) => {
      assert.equal(error.message, 'Pinterest Story Pins are not supported.');
      return true;
    });
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('Pinterest direct metadata sanitizes URL and path-shaped display text only', () => {
  const url = 'https://private.example/secret';
  const fileUrl = 'file:///Users/alice/secret.mov';
  const posixPath = '/Users/alice/secret.mov';
  const windowsPath = String.raw`C:\\Users\\alice\\secret.mov`;
  const source = [
    [2, {id: '123456789', count: 1, title: `Pin ${url} ${fileUrl} ${posixPath} ${windowsPath}`, creator: `Creator ${url} ${posixPath} ${windowsPath}`}],
    [3, 'https://example.invalid/item.jpg', {pin_id: '123456789', extension: 'jpg', title: `Item ${url} ${fileUrl} ${posixPath} ${windowsPath}`, creator: `Author ${url} ${posixPath} ${windowsPath}`}],
  ].map(JSON.stringify).join('\n');
  const metadata = parsePinterestMetadataJsonl(source, {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'});
  const display = [metadata.title, metadata.creator, metadata.items[0].title, metadata.items[0].creator].join(' ');
  for (const secret of [url, fileUrl, posixPath, windowsPath]) assert.equal(display.includes(secret), false, secret);
  assert.match(display, /\[url\]/);
  assert.match(display, /\[path\]/);
  assert.equal(metadata.source, 'https://www.pinterest.com/pin/123456789/');
  assert.equal(metadata.pinId, '123456789');
  assert.equal(metadata.items[0].extension, 'jpg');
  assert.equal(metadata.items[0].kind, 'image');
});

test('GalleryDlWorker rejects fatal metadata stderr at exit zero before thumbnails while allowing benign warnings', async () => {
  const output = [
    [2, {id: '123456789', count: 1, title: 'Pin'}],
    [3, 'https://example.invalid/item.jpg', {pin_id: '123456789', extension: 'jpg', thumbnail: 'https://i.pinimg.com/thumb.jpg'}],
  ].map(JSON.stringify).join('\n');
  for (const scenario of [
    {stderr: '[pinterest][error] HttpError: 429 Too Many Requests', rejects: true},
    {stderr: '[pinterest][warning] Falling back to the public representation', rejects: false},
    {stderr: '', rejects: false},
  ]) {
    const root = tempRoot('clipdock-gallery-metadata-stderr-');
    let fetches = 0;
    try {
      const spawn = () => {
        const child = new FakeChild();
        setImmediate(() => {
          child.stdout.emit('data', `${output}\n`);
          if (scenario.stderr) child.stderr.emit('data', scenario.stderr);
          child.emit('close', 0);
        });
        return child;
      };
      const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {
        sessionDir: root,
        fetcher: async (url) => ({ok: true, status: 200, url, headers: {get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : name.toLowerCase() === 'content-length' ? String(imageBytes().length) : null}, arrayBuffer: async () => { fetches += 1; return imageBytes(); }}),
      });
      if (scenario.rejects) {
        await assert.rejects(worker.metadata('https://www.pinterest.com/pin/123456789/'), /Could not load this Pinterest Pin/);
        assert.equal(fetches, 0, 'fatal metadata stderr must prevent thumbnail fetch');
      } else {
        const metadata = await worker.metadata('https://www.pinterest.com/pin/123456789/');
        assert.equal(metadata.items[0].kind, 'image');
        assert.equal(fetches, 0);
      }
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }
});

test('GalleryDlWorker rejects pin.it redirects outside Pinterest before spawning gallery-dl', async () => {
  let spawned = false;
  const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', () => { spawned = true; throw new Error('must not spawn'); }, {
    fetcher: async (url) => ({ok: false, status: 302, url, headers: {get: () => 'https://evil.example/pin/123456789/'}, arrayBuffer: async () => new ArrayBuffer(0)}),
  });
  await assert.rejects(worker.metadata('https://pin.it/AbC123'), /redirect was rejected/);
  assert.equal(spawned, false);
});

test('gallery-dl discovery enforces the 1.28.0 floor and bounded probe result', () => {
  const root = tempRoot('clipdock-gallery-discovery-');
  try {
    const binary = path.join(root, 'gallery-dl');
    writeFileSync(binary, '#!/bin/sh\nprintf "gallery-dl 1.28.0\\n"\n');
    chmodSync(binary, 0o755);
    assert.equal(discoverGalleryDl({CLIPDOCK_GALLERYDL_PATH: binary, PATH: ''}, 'linux', [], () => ({code: 0, text: 'gallery-dl 1.28.0'})), binary);
    assert.equal(discoverGalleryDl({CLIPDOCK_GALLERYDL_PATH: binary, PATH: ''}, 'linux', [], () => ({code: 0, text: 'gallery-dl 1.27.9'})), null);
    assert.equal(galleryDlVersionSupported('gallery-dl 1.28.0'), true);
    assert.equal(galleryDlVersionSupported('gallery-dl 1.27.99'), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('gallery-dl discovery shares one successful version probe for the process lifetime', () => {
  const root = tempRoot('clipdock-gallery-probe-cache-');
  try {
    const binary = path.join(root, 'gallery-dl');
    writeFileSync(binary, '#!/bin/sh\nprintf "gallery-dl 1.32.9\\n"\n');
    chmodSync(binary, 0o755);
    let probes = 0;
    const probe = () => { probes += 1; return {code: 0, text: 'gallery-dl 1.32.9'}; };
    const env = {CLIPDOCK_GALLERYDL_PATH: binary, PATH: ''};
    assert.equal(discoverGalleryDl(env, 'linux', [], probe), binary);
    assert.equal(discoverGalleryDl(env, 'linux', [], probe), binary);
    assert.equal(discoverGalleryDl(env, 'linux', [], probe), binary);
    assert.equal(probes, 3, 'version probe success cache was removed so binary replacement is detected (each discover re-probes)');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('gallery-dl discovery does not cache failed version probes', () => {
  const root = tempRoot('clipdock-gallery-probe-retry-');
  try {
    const binary = path.join(root, 'gallery-dl');
    writeFileSync(binary, '#!/bin/sh\nprintf "gallery-dl 1.32.9\\n"\n');
    chmodSync(binary, 0o755);
    let probes = 0;
    const probe = () => { probes += 1; return probes === 1 ? {code: 1, text: 'temporary failure'} : {code: 0, text: 'gallery-dl 1.32.9'}; };
    const env = {CLIPDOCK_GALLERYDL_PATH: binary, PATH: ''};
    assert.equal(discoverGalleryDl(env, 'linux', [], probe), null);
    assert.equal(discoverGalleryDl(env, 'linux', [], probe), binary, 'a later successful probe discovers a repaired binary');
    assert.equal(probes, 2);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('JSONL parser rejects [-1] even when gallery-dl exits successfully and normalizes a mixed carousel atomically', () => {
  assert.throws(() => parseGalleryDlJsonl('[-1, "login required"]'), /login required/);
  const source = [
    JSON.stringify([2, {id: '123456789', title: 'Pin', count: 2, images: {orig: {url: 'https://i.pinimg.example/original.jpg'}}}]),
    JSON.stringify([3, 'https://i.pinimg.example/one.jpg', {pin_id: '123456789', extension: 'jpg', title: 'One'}]),
    JSON.stringify([3, 'https://v.pinimg.example/two.mp4', {pin_id: '123456789', extension: 'mp4', title: 'Two'}]),
  ].join('\n');
  const metadata = parsePinterestMetadataJsonl(source, {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'});
  assert.equal(metadata.kind, 'carousel');
  assert.deepEqual(metadata.items.map((item) => [item.index, item.kind]), [[1, 'image'], [2, 'video']]);
  assert.equal(metadata.thumbnailUrl, null);
  assert.throws(() => parsePinterestMetadataJsonl(`${source.replace('count":2', 'count":3')}\n${JSON.stringify([3, 'https://example.invalid/bad.zip', {pin_id: '123456789', extension: 'zip'}])}`, {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'}), /unsupported|malformed/);
  assert.throws(() => parsePinterestMetadataJsonl(source.replaceAll('123456789', '999'), {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'}), /did not match/);
  assert.throws(() => parsePinterestMetadataJsonl(`${source}\n${JSON.stringify([6, 'https://www.pinterest.com/pin/999/', {id: '999'}])}`, {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'}), /Queue/);
  assert.throws(() => parsePinterestMetadataJsonl(source.replace('count":2', 'count":51'), {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'}), /50-item limit/);
  assert.equal(JSON.stringify(metadata).includes('pinimg'), false, 'CDN URLs stay in main-process parsing only');
});

test('Pinterest metadata normalization consumes one bounded JSONL value set without reparsing text', () => {
  const valid = {url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789'};
  const source = [
    JSON.stringify([2, {id: '123456789', title: 'Pin', count: 2}]),
    JSON.stringify([3, 'https://i.pinimg.example/one.jpg', {pin_id: '123456789', extension: 'jpg', title: 'One'}]),
    JSON.stringify([3, 'https://v.pinimg.example/two.mp4', {pin_id: '123456789', extension: 'mp4', title: 'Two'}]),
  ].join('\n');
  const values = parseGalleryDlJsonl(source);
  assert.equal(typeof gallerydlModule.parsePinterestMetadataValues, 'function', 'metadata parser must expose the already-parsed value seam');
  const metadata = gallerydlModule.parsePinterestMetadataValues(values, valid);
  assert.equal(metadata.kind, 'carousel');
  assert.deepEqual(metadata.items.map((item) => [item.index, item.kind]), [[1, 'image'], [2, 'video']]);
  assert.equal(JSON.stringify(metadata).includes('pinimg'), false, 'parsed provider URLs never cross the metadata seam');
});

test('GalleryDlWorker safely resolves pin.it, returns an allowlisted thumbnail URL, and uses fixed download argv', async () => {
  const root = tempRoot('clipdock-gallery-worker-');
  const calls = [];
  const fetched = [];
  try {
    const fetcher = async (url) => {
      fetched.push(url);
      if (url === 'https://pin.it/AbC123') return {ok: false, status: 308, url, headers: {get: (name) => name.toLowerCase() === 'location' ? 'https://api.pinterest.com/url_shortener/AbC123/redirect/' : null}, arrayBuffer: async () => new ArrayBuffer(0)};
      if (url === 'https://api.pinterest.com/url_shortener/AbC123/redirect/') return {ok: false, status: 302, url, headers: {get: (name) => name.toLowerCase() === 'location' ? 'https://www.pinterest.com/pin/123456789/sent/?invite_code=ignored' : null}, arrayBuffer: async () => new ArrayBuffer(0)};
      if (url === 'https://i.pinimg.com/thumb.jpg') return {ok: true, status: 200, url, headers: {get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : name.toLowerCase() === 'content-length' ? String(imageBytes().length) : null}, arrayBuffer: async () => imageBytes()};
      throw new Error(`Unexpected fetch ${url}`);
    };
    const spawn = (_binary, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.detached, true);
      const child = new FakeChild();
      calls.push(args);
      const directory = args.includes('-D') ? args[args.indexOf('-D') + 1] : null;
      setImmediate(() => {
        if (directory) {
          mkdirSync(directory, {recursive: true});
          const filename = args[args.indexOf('--range') + 1] === '2' ? 'pinterest.mp4' : 'pinterest.jpg';
          const output = path.join(directory, filename);
          writeFileSync(output, filename.endsWith('.mp4') ? videoBytes() : imageBytes());
          child.stdout.emit('data', `${output}\n`);
        } else {
          child.stdout.emit('data', `${JSON.stringify([2, {id: '123456789', title: 'Pin', count: 2}])}\n${JSON.stringify([3, 'https://example.invalid/one.jpg', {pin_id: '123456789', extension: 'jpg', title: 'One', thumbnail: 'https://i.pinimg.com/thumb.jpg'}])}\n${JSON.stringify([3, 'https://example.invalid/two.mp4', {pin_id: '123456789', extension: 'mp4', title: 'Two'}])}\n`);
        }
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, fetcher});
    const metadata = await worker.metadata('https://pin.it/AbC123');
    assert.equal(metadata.source, 'https://www.pinterest.com/pin/123456789/');
    assert.equal(metadata.items.length, 2);
    assert.equal(metadata.thumbnailUrl, 'https://i.pinimg.com/thumb.jpg');
    assert.deepEqual(fetched, ['https://pin.it/AbC123', 'https://api.pinterest.com/url_shortener/AbC123/redirect/']);
    const events = [];
    const artifact = await worker.download(metadata.source, 2, 'video', 'job-1', (event) => events.push(event));
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.fileName, 'pinterest.mp4');
    assert.deepEqual(calls[0], ['--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--post-range', '1', '--range', '1-50', '--http-timeout', '30', '--retries', '2', '--sleep-request', '0', metadata.source]);
    assert.deepEqual(calls[1], ['--config-ignore', '-D', calls[1][2], '-f', 'pinterest.{extension}', '--post-range', '1', '--range', '2', '--filesize-max', '2G', '--no-mtime', '--http-timeout', '30', '--retries', '2', '--sleep-request', '0', metadata.source]);
    assert.equal(calls[1].includes('--dump-json'), false, 'download mode must not disable downloads');
    assert.equal(readdirSync(root).length, 1, 'successful media remains available to completion/history');
    assert.equal(events.at(-1).percent, 100);
    rmSync(path.dirname(artifact.filePath), {recursive: true, force: true});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('GalleryDlWorker prepends the verified FFmpeg directory to the child PATH under a Resolve-like PATH', async () => {
  const root = tempRoot('clipdock-gallery-ffmpeg-path-');
  const savedPath = process.env.PATH;
  const captured = [];
  try {
    // Simulate a Finder-launched Resolve: no Homebrew directories on PATH.
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const ffmpegDir = path.join(root, 'ffmpeg-dir');
    mkdirSync(ffmpegDir, {recursive: true});
    const ffmpegPath = path.join(ffmpegDir, 'ffmpeg');
    writeFileSync(ffmpegPath, '#!/bin/sh\nexit 0\n');
    chmodSync(ffmpegPath, 0o755);
    const spawn = (_binary, args, options) => {
      captured.push({args, env: options.env});
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', `${JSON.stringify([2, {id: '123456789', title: 'Pin', count: 1}])}\n${JSON.stringify([3, 'https://example.invalid/one.jpg', {pin_id: '123456789', extension: 'jpg', title: 'One'}])}\n`);
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, ffmpegPath});
    await worker.metadata('https://www.pinterest.com/pin/123456789/');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].env.PATH, `${ffmpegDir}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`, 'child PATH must start with the verified FFmpeg directory');
    assert.equal(process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'process.env must not be mutated');

    // A null ffmpegPath leaves the inherited PATH untouched.
    captured.length = 0;
    const bare = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, ffmpegPath: null});
    await bare.metadata('https://www.pinterest.com/pin/123456789/');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].env, undefined, 'null ffmpegPath must not override the child env');
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    rmSync(root, {recursive: true, force: true});
  }
});

test('GalleryDlWorker rejects missing tools and an exit-zero missing yt-dlp module', async () => {
  const missing = new GalleryDlWorker(null);
  await assert.rejects(missing.metadata('https://www.pinterest.com/pin/123456789/'), /gallery-dl 1\.28\.0/);

  const root = tempRoot('clipdock-gallery-ytdlp-');
  try {
    const spawn = (_binary, args) => {
      const child = new FakeChild();
      const directory = args[args.indexOf('-D') + 1];
      setImmediate(() => {
        writeFileSync(path.join(directory, 'pinterest.mp4'), videoBytes());
        child.stderr.emit('data', "ModuleNotFoundError: No module named 'yt_dlp'");
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root});
    await assert.rejects(worker.download('https://www.pinterest.com/pin/123456789/', 1, 'video', 'job-ytdlp', () => undefined), /yt-dlp Python module/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('GalleryDlWorker rejects malformed, oversized, multiple, symlink, and nested output', async () => {
  for (const scenario of ['signature', 'size', 'multiple', 'symlink', 'nested']) {
    const root = tempRoot(`clipdock-gallery-${scenario}-`);
    const outside = path.join(root, 'outside.jpg');
    try {
      const spawn = (_binary, args) => {
        const child = new FakeChild();
        const directory = args[args.indexOf('-D') + 1];
        setImmediate(() => {
          const output = scenario === 'nested' ? path.join(directory, 'nested') : directory;
          mkdirSync(output, {recursive: true});
          const media = path.join(output, 'pinterest.jpg');
          if (scenario === 'symlink') { writeFileSync(outside, imageBytes()); symlinkSync(outside, media); }
          else {
            writeFileSync(media, scenario === 'signature' ? Buffer.from('not an image') : imageBytes());
            if (scenario === 'size') truncateSync(media, 20 * 1024 * 1024 + 1);
            if (scenario === 'multiple') writeFileSync(path.join(directory, 'extra.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));
          }
          child.emit('close', 0);
        });
        return child;
      };
      const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root});
      await assert.rejects(worker.download('https://www.pinterest.com/pin/123456789/', 1, 'image', `job-${scenario}`, () => undefined), scenario === 'size' ? {message: 'This image exceeds ClipDock’s 20 MB download limit.'} : /Pinterest/);
      assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('download-')), [], scenario);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }
});

test('GalleryDlWorker uses taskkill /T /F immediately for Windows process-tree cancellation', async () => {
  const root = tempRoot('clipdock-gallery-windows-cancel-');
  const taskkills = [];
  let child;
  try {
    const spawn = (_binary, args) => {
      child = new FakeChild(2468);
      const directory = args[args.indexOf('-D') + 1];
      mkdirSync(directory, {recursive: true});
      return child;
    };
    const processSpawn = (binary, args, options) => {
      taskkills.push([binary, args, options]);
      const killer = new FakeChild();
      queueMicrotask(() => { child.emit('close', 1); killer.emit('close', 0); });
      return killer;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, platform: 'win32', processSpawn, killGraceMs: 5});
    const pending = worker.download('https://www.pinterest.com/pin/123456789/', 1, 'image', 'windows-cancel', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.cancel('windows-cancel') instanceof Promise, true);
    await assert.rejects(pending, /cancelled/i);
    assert.deepEqual(taskkills[0], ['taskkill', ['/PID', '2468', '/T', '/F'], {shell: false}]);
    assert.deepEqual(child.killed, []);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('GalleryDlWorker cancels the process tree and removes partial job residue', async () => {
  const root = tempRoot('clipdock-gallery-cancel-');
  let child;
  try {
    const spawn = (_binary, args) => {
      child = new FakeChild();
      const directory = args[args.indexOf('-D') + 1];
      mkdirSync(directory, {recursive: true});
      writeFileSync(path.join(directory, 'partial.jpg.part'), 'partial');
      return child;
    };
    const worker = new GalleryDlWorker('/usr/local/bin/gallery-dl', spawn, {sessionDir: root, killGraceMs: 5});
    const pending = worker.download('https://www.pinterest.com/pin/123456789/', 1, 'image', 'cancel-1', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.cancel('cancel-1') instanceof Promise, true);
    await assert.rejects(pending, /cancelled/i);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root), []);

    const disposing = worker.download('https://www.pinterest.com/pin/123456789/', 1, 'image', 'dispose-1', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    worker.dispose();
    await assert.rejects(disposing, /cancelled/i);
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('GalleryDlWorker metadata replies without waiting on image I/O', async t => {
  const root = tempRoot('clipdock-pin-metadata-immediate-'); t.after(() => rmSync(root, {recursive: true, force: true}));
  let fetches = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    const child = new FakeChild(); queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify([2, {id: '123456789', count: 1}]) + '\n' + JSON.stringify([3, 'https://i.pinimg.com/one.jpg', {pin_id: '123456789', extension: 'jpg', thumbnail: 'https://i.pinimg.com/thumb.jpg'}]) + '\n'); child.emit('close', 0);
    }); return child;
  }, {sessionDir: root, fetcher: async () => {fetches++; return new Promise(() => {});}});
  const result = await worker.metadata('https://www.pinterest.com/pin/123456789/');
  assert.equal(result.thumbnailUrl, 'https://i.pinimg.com/thumb.jpg'); assert.equal(fetches, 0);
  await worker.dispose(); assert.equal(worker.isActive(), false);
});

test('gallery-dl cancellation preserves a replacement of its private job directory', async t => {
  const root = tempRoot('clipdock-gallery-directory-swap-');
  const moved = path.join(root, 'moved-job');
  let directory, spawns = 0, cancellation;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {spawns++; throw new Error('Unexpected spawn');}, {sessionDir: root});
  t.after(async () => {await worker.dispose(); rmSync(root, {recursive: true, force: true});});
  await assert.rejects(providerDownload(worker, {provider: 'pinterest', url: 'https://www.pinterest.com/pin/123/', jobId: 'job', emit: event => {
    if (event.message !== 'Downloading from Pinterest (progress unavailable)…') return;
    directory = path.join(root, readdirSync(root).find(name => name.startsWith('download-')));
    const owned = lstatSync(directory);
    renameSync(directory, moved);
    mkdirSync(directory);
    assert.notEqual(lstatSync(directory).ino, owned.ino);
    writeFileSync(path.join(directory, 'user-media.mov'), 'irreplaceable user media');
    cancellation = worker.cancel('job');
  }}), {message: 'Download cancelled.'});
  assert.notEqual(cancellation, null); await cancellation;
  assert.equal(spawns, 0);
  assert.equal(readFileSync(path.join(directory, 'user-media.mov'), 'utf8'), 'irreplaceable user media');
  assert.equal(lstatSync(moved).isDirectory(), true);
  assert.equal(worker.isActive(), false);
});


test('GalleryDlWorker uncached search explicitly cancels its child and cleans the job', async t => {
  const root = tempRoot('clipdock-gallery-search-cancel-');
  let child, calls = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {
    calls++; child = new FakeChild();
    return child;
  }, {sessionDir: root, metadataTimeoutMs: 5000, killGraceMs: 5});
  t.after(async () => {await worker.dispose(); rmSync(root, {recursive: true, force: true});});
  const pending = worker.search('uncached ocean', 1);
  const rejection = assert.rejects(pending, {message: 'Pinterest search cancelled.'});
  assert.equal(calls, 1);
  assert.equal(worker.isActive(), true);
  await worker.cancel(); await rejection;
  assert.deepEqual(child.killed, ['SIGTERM']);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(worker.isActive(), false);
});
