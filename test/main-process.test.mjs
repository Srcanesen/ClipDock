import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {createPinterestMetadataSnapshotStore, createProviderDownloadHandlers, createSensitiveIpcHandler, isSafeMediaFile, normalizePreviewBounds, registerMainTransferInvokeHandlers, youtubePreviewUrl, YOUTUBE_PREVIEW_REFERRER} from '../dist/main-process.js';

function setup() {
  const registered = new Map();
  const ipc = {handle(channel, listener) { registered.set(channel, listener); }};
  const cards = new Map([['card-1', {path: '/tmp/clipdock/clip.mp4', automation: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []}}]]);
  const validEvent = {sender: 'clipdock'};
  const calls = {sender: 0, resolve: 0, import: [], timeline: []};
  const transfer = {
    importToMediaPool: async (...args) => { calls.import.push(args); return {ok: true, kind: 'imported', importedCount: 1, message: 'imported'}; },
    addToTimeline: async (...args) => { calls.timeline.push(args); return {ok: true, kind: 'timeline-appended', message: 'added'}; },
  };
  const handlers = registerMainTransferInvokeHandlers(ipc, {
    importToMediaPool: 'import',
    addToTimeline: 'timeline',
  }, {
    requireSender(event) { calls.sender += 1; if (event !== validEvent) throw new Error('invalid sender'); },
    resolveCard(cardId) { calls.resolve += 1; return cards.get(cardId) ?? null; },
    transfer,
  });
  return {registered, cards, calls, handlers, validEvent};
}

test('YouTube preview seam builds one exact embed URL without renderer-supplied referrer or URL authority', () => {
  assert.equal(YOUTUBE_PREVIEW_REFERRER, 'https://com.clipdock.app/');
  assert.equal(youtubePreviewUrl('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&controls=1&playsinline=1&rel=0');
  assert.equal(youtubePreviewUrl('dQw4w9WgXcQ', 12.9), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&controls=1&playsinline=1&rel=0&start=12');
  for (const input of ['', 'short', 'dQw4w9WgXcQ?x', 'https://youtube.com/watch?v=dQw4w9WgXcQ']) assert.equal(youtubePreviewUrl(input), null);
  for (const start of [null, NaN, Infinity, -1, 604801, '12']) assert.equal(youtubePreviewUrl('dQw4w9WgXcQ', start), null);
});

test('YouTube preview bounds normalize finite DIPs to BrowserWindow content and reject unusable geometry', () => {
  const content = {width: 960, height: 720};
  assert.deepEqual(normalizePreviewBounds({x: 100.4, y: 50.6, width: 640.2, height: 360.2}, content), {x: 100, y: 51, width: 641, height: 360});
  assert.deepEqual(normalizePreviewBounds({x: -20, y: -10, width: 340, height: 200}, content), {x: 0, y: 0, width: 320, height: 190});
  assert.deepEqual(normalizePreviewBounds({x: 800, y: 600, width: 400, height: 300}, content), {x: 800, y: 600, width: 160, height: 120});
  for (const bounds of [{x: 0, y: 0, width: 159, height: 90}, {x: 960, y: 0, width: 200, height: 100}, {x: 0, y: 0, width: NaN, height: 100}, {x: 0, y: 0, width: 200, height: Infinity}, null]) assert.equal(normalizePreviewBounds(bounds, content), null);
});

test('trusted IPC seam validates the sender before any side effect', async () => {
  let calls = 0;
  const validEvent = {};
  const handler = createSensitiveIpcHandler(
    event => { if (event !== validEvent) throw new Error('invalid sender'); },
    async (_event, value) => { calls += 1; return `handled:${value}`; },
  );
  await assert.rejects(() => handler(null, 'secret-input'), /invalid sender/);
  assert.equal(calls, 0);
  assert.equal(await handler(validEvent, 'bounded-input'), 'handled:bounded-input');
  assert.equal(calls, 1);
});

test('main IPC seam validates card/bin inputs and dispatches valid requests', async () => {
  const fixture = setup();
  await assert.rejects(() => fixture.registered.get('import')(null, 'card-1', 'active'), /invalid sender/);
  assert.equal(fixture.calls.resolve, 0);

  const invalidCard = await fixture.registered.get('import')(fixture.validEvent, 'missing', 'active');
  assert.deepEqual(invalidCard, {ok: false, kind: 'invalid-card', message: 'No valid media card selected.'});
  const invalidBin = await fixture.registered.get('import')(fixture.validEvent, 'card-1', 'elsewhere');
  assert.deepEqual(invalidBin, {ok: false, kind: 'bin-error', message: 'Invalid destination bin.'});
  const imported = await fixture.registered.get('import')(fixture.validEvent, 'card-1', 'clipdock');
  assert.equal(imported.ok, true);
  assert.deepEqual(fixture.calls.import, [['/tmp/clipdock/clip.mp4', 'clipdock']]);
});

test('main IPC seam validates timeline placement and preserves card automation', async () => {
  const fixture = setup();
  const invalid = await fixture.registered.get('timeline')(fixture.validEvent, 'card-1', 'active', 'middle');
  assert.deepEqual(invalid, {ok: false, kind: 'playhead-unsupported', message: 'Invalid timeline position.'});
  assert.equal(fixture.calls.timeline.length, 0);

  const result = await fixture.registered.get('timeline')(fixture.validEvent, 'card-1', 'active', 'playhead');
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.calls.timeline, [[
    '/tmp/clipdock/clip.mp4',
    'active',
    'playhead',
    fixture.cards.get('card-1').automation,
  ]]);
});

test('native drag seam is synchronous and never starts a stale-card drag', () => {
  const fixture = setup();
  const started = [];
  fixture.handlers.nativeDragStart(null, 'card-1', file => started.push(file));
  assert.deepEqual(started, []);
  assert.equal(fixture.calls.resolve, 0);

  fixture.handlers.nativeDragStart(fixture.validEvent, 'card-1', file => started.push(file));
  assert.deepEqual(started, ['/tmp/clipdock/clip.mp4']);
  started.length = 0;
  fixture.handlers.nativeDragStart(fixture.validEvent, 'missing', file => started.push(file));
  fixture.handlers.nativeDragStart(fixture.validEvent, 'card-1', file => started.push(file));
  assert.deepEqual(started, ['/tmp/clipdock/clip.mp4']);
});

test('native drag normalizes and deduplicates opaque cards, but rejects an invalid member atomically', () => {
  const fixture = setup();
  fixture.cards.set('card-2', {path: '/tmp/clipdock/second.mp4'});
  const started = [];
  fixture.handlers.nativeDragStart(fixture.validEvent, ['card-1', 'card-2', 'card-1'], filePaths => started.push(filePaths));
  assert.deepEqual(started, [['/tmp/clipdock/clip.mp4', '/tmp/clipdock/second.mp4']]);
  assert.equal(fixture.calls.resolve, 2, 'duplicate cardIds resolve once and preserve order');
  fixture.cards.set('card-3', {path: '/tmp/clipdock/third.mp4'});
  fixture.handlers.nativeDragStart(fixture.validEvent, ['card-1', 'missing', 'card-3'], filePaths => started.push(filePaths));
  assert.deepEqual(started, [['/tmp/clipdock/clip.mp4', '/tmp/clipdock/second.mp4']], 'one invalid card rejects the whole drag');
  assert.equal(fixture.calls.resolve, 5, 'every deduplicated card is revalidated before any drag starts');
  fixture.handlers.nativeDragStart(fixture.validEvent, [], filePaths => started.push(filePaths));
  assert.equal(started.length, 1, 'empty multi-drag is a no-op');
});

test('Pinterest metadata snapshots hit, miss, and evict within the bounded session store', () => {
  const store = createPinterestMetadataSnapshotStore();
  const metadata = (pinId) => ({pinId, source: `https://www.pinterest.com/pin/${pinId}/`, title: pinId, creator: null, kind: 'image', items: [], thumbnailDataUrl: null});
  assert.equal(store.get('1'), null);
  store.remember(metadata('1'));
  assert.equal(store.get('1').pinId, '1');
  store.remember(metadata('2')); store.remember(metadata('3')); store.remember(metadata('4'));
  assert.equal(store.size(), 3);
  assert.equal(store.get('1'), null, 'oldest snapshot is evicted');
  assert.equal(store.get('2').pinId, '2');
  assert.equal(store.get('4').pinId, '4');
  store.remember(metadata('not-a-pin'));
  assert.equal(store.size(), 3, 'non-canonical keys never enter the store');

  const carousel = createPinterestMetadataSnapshotStore();
  let extractions = 0;
  for (const itemIndex of [1, 2, 3]) {
    let hit = carousel.get('9');
    if (!hit) { extractions += 1; hit = metadata('9'); carousel.remember(hit); }
    assert.equal(hit.pinId, '9');
    assert.ok(itemIndex > 0);
  }
  assert.equal(extractions, 1, 'one loaded carousel snapshot serves every queued item');
});

function providerDownloadFixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-provider-dispatch-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const artifact = (name) => {const file = path.join(root, name); writeFileSync(file, 'fixture'); return file;};
  const calls = {metadata: [], downloads: [], prepare: [], history: [], cards: [], events: [], emitted: []};
  const completion = {
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => undefined,
    recordHistory: (input) => { calls.history.push(input); return {record: {id: `history-${calls.history.length}`}}; },
    registerCard: (card) => { calls.cards.push(card); return `card-${calls.cards.length}`; },
    prepareMedia: async (request) => { calls.prepare.push(request); return {filePath: artifact('prepared.resolve.mp4'), fileName: 'prepared.resolve.mp4'}; },
  };
  const metadata = {id: 'yt-1', title: 'YouTube title', duration: 20, channel: 'Channel', chapters: [{start: 0, end: 5, title: 'Intro'}]};
  const socialMetadata = {id: 'social-1', platform: 'instagram', source: 'https://www.instagram.com/reel/abc', title: 'Social title', duration: 10, channel: 'Creator'};
  const pinterestMetadata = {
    pinId: '123', source: 'https://www.pinterest.com/pin/123/', title: 'Pin', creator: 'Pin creator', kind: 'carousel', thumbnailDataUrl: null,
    items: [
      {index: 1, kind: 'image', title: 'Image item', creator: null, extension: 'jpg'},
      {index: 2, kind: 'video', title: 'Video item', creator: 'Video creator', extension: 'mp4'},
    ],
  };
  const pexelsVideo = {id: 7, kind: 'video', title: 'Pexels video', creator: 'Pexels creator', creatorUrl: null, sourceUrl: 'https://www.pexels.com/video/7/', duration: 4, width: 1920, height: 1080, thumbnailDataUrl: null, previewUrl: null, files: [{id: 'video-file', url: 'https://videos.pexels.com/video.mp4', width: 1920, height: 1080, label: 'HD', mime: 'video/mp4', size: null}]};
  const adapters = {
    youtube: {
      worker: {
        metadata: async (...args) => { calls.metadata.push(['youtube', ...args]); return metadata; },
        download: async (...args) => { calls.downloads.push(['youtube', ...args]); return {filePath: artifact('youtube.mp4'), fileName: 'youtube.mp4', subtitlePath: artifact('youtube.en.srt'), subtitleFileName: 'youtube.en.srt'}; },
      },
      emit: (_event, update) => calls.emitted.push(['youtube', update]),
    },
    social: {
      worker: {
        metadataSocial: async (...args) => { calls.metadata.push(['social', ...args]); return socialMetadata; },
        downloadSocial: async (...args) => { calls.downloads.push(['social', ...args]); return {filePath: artifact('social.mp4'), fileName: 'social.mp4'}; },
      },
      emit: (_event, update) => calls.emitted.push(['social', update]),
    },
    pinterest: {
      worker: {
        metadata: async (...args) => { calls.metadata.push(['pinterest', ...args]); return pinterestMetadata; },
        download: async (...args) => { calls.downloads.push(['pinterest', ...args]); const item = args[2]; return {filePath: artifact(`pinterest-${item}.mp4`), fileName: `pinterest-${item}.mp4`, kind: item}; },
      },
      snapshots: {get: () => pinterestMetadata, remember: () => undefined},
      emit: (_event, update) => calls.emitted.push(['pinterest', update]),
    },
    pexels: {
      worker: {
        load: async (kind, id) => { calls.metadata.push(['pexels-load', kind, id]); return kind === 'photo' ? {...pexelsVideo, kind: 'photo', sourceUrl: 'https://www.pexels.com/photo/7/', files: [{id: 'photo-file', url: 'https://images.pexels.com/photo.jpg', width: 100, height: 100, label: 'Original', mime: 'image/jpeg', size: null}]} : pexelsVideo; },
        download: async (...args) => { calls.downloads.push(['pexels', ...args]); return {filePath: artifact('pexels.mp4'), fileName: 'pexels.mp4'}; },
      },
      emit: (_event, update) => calls.emitted.push(['pexels', update]),
    },
    ...overrides,
  };
  const handlers = createProviderDownloadHandlers({
    completion,
    ffprobeAvailable: true, cancelMediaPreparation: () => false,
    registerSubtitle: (_filePath, fileName) => ({cardId: 'subtitle-card', fileName}),
    ...adapters,
  });
  return {calls, handlers};
}

const validEvent = {sender: {send: () => undefined}};

for (const profile of ['fast', 'original', 'editing']) {
  for (const supplied of [undefined, false, true]) test(`YouTube handler owns preferH264: ${profile}, renderer ${supplied}`, async t => {
    const {handlers, calls} = providerDownloadFixture(t);
    await handlers.youtube(validEvent, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '1080p', profile, 'profile-sort', {
      mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en',
      ...(supplied === undefined ? {} : {preferH264: supplied}),
    });
    assert.equal(calls.downloads.length, 1);
    assert.equal(calls.downloads[0][5].preferH264, profile === 'fast');
  });
}

test('provider download handlers keep trusted-sender validation ahead of all four provider side effects', async t => {
  const fixture = providerDownloadFixture(t);
  const order = [];
  const trustedHandler = (handler) => createSensitiveIpcHandler(
    (event) => { order.push('sender'); if (event !== validEvent) throw new Error('invalid sender'); },
    handler,
  );
  const requests = [
    [trustedHandler(fixture.handlers.youtube), ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', 'original', 'job-y', {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'}]],
    [trustedHandler(fixture.handlers.social), ['https://www.instagram.com/reel/abc', 'best', 'original', 'job-s']],
    [trustedHandler(fixture.handlers.pinterest), ['https://www.pinterest.com/pin/123/', 1, 'original', 'job-p']],
    [trustedHandler(fixture.handlers.pexels), [{kind: 'photo', id: 7}, 'photo-file', 'original', 'job-x']],
  ];
  for (const [handler, args] of requests) await assert.rejects(() => handler({untrusted: true}, ...args), /invalid sender/);
  assert.deepEqual(order, ['sender', 'sender', 'sender', 'sender']);
  assert.deepEqual(fixture.calls.metadata, []);
  assert.deepEqual(fixture.calls.downloads, []);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.history, []);
});

test('YouTube orchestration preserves audio-original behavior, bounded selection, subtitles, and video preparation', async t => {
  const fixture = providerDownloadFixture(t);
  const audio = await fixture.handlers.youtube(validEvent, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', 'editing', 'job-audio', {mediaMode: 'audio', audioFormat: 'mp3', subtitles: true, subtitleLanguage: 'es'});
  assert.equal(audio.subtitle.fileName, 'youtube.en.srt');
  assert.equal(fixture.calls.history[0].profile, 'original');
  assert.equal(fixture.calls.prepare.length, 0, 'audio never enters video preparation');

  await fixture.handlers.youtube(validEvent, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '1080p', 'fast', 'job-video', {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en', selection: {start: 2, end: 8, label: 'Intro range'}});
  const download = fixture.calls.downloads.find(([provider, ...rest]) => provider === 'youtube' && rest[2] === 'job-video');
  assert.deepEqual(download[5].selection, {start: 2, end: 8, label: 'Intro range'});
  assert.equal(fixture.calls.prepare.at(-1).profile, 'fast');
  assert.equal(fixture.calls.history.at(-1).profile, 'fast');
});

test('Social orchestration trusts canonical metadata and keeps Original free of preparation', async t => {
  const fixture = providerDownloadFixture(t);
  const result = await fixture.handlers.social(validEvent, 'https://www.instagram.com/reel/abc?utm_source=share', 'best', 'original', 'job-social');
  assert.equal(result.cardId, 'card-1');
  assert.equal(fixture.calls.metadata[0][1], 'https://www.instagram.com/reel/abc');
  assert.equal(fixture.calls.metadata[0][2].jobId, 'job-social');
  assert.equal(typeof fixture.calls.metadata[0][2].emit, 'function');
  assert.equal(fixture.calls.prepare.length, 0);
  assert.equal(fixture.calls.history[0].source, 'https://www.instagram.com/reel/abc');
  assert.equal(fixture.calls.history[0].profile, 'original');
});

test('Pinterest orchestration uses the session carousel, rejects non-original images, and prepares video items', async t => {
  const fixture = providerDownloadFixture(t);
  await assert.rejects(() => fixture.handlers.pinterest(validEvent, 'https://www.pinterest.com/pin/123/', 1, 'editing', 'job-image'), /Original-only/);
  assert.deepEqual(fixture.calls.downloads, []);
  await fixture.handlers.pinterest(validEvent, 'https://www.pinterest.com/pin/123/', 2, 'editing', 'job-video');
  const download = fixture.calls.downloads.find(([provider]) => provider === 'pinterest');
  assert.equal(download[4], 'job-video');
  assert.equal(fixture.calls.prepare.at(-1).profile, 'editing');
  assert.equal(fixture.calls.history.at(-1).quality, 'original');
  assert.equal(fixture.calls.history.at(-1).mediaMode, 'video');
  assert.equal(fixture.calls.metadata.filter(([provider]) => provider === 'pinterest').length, 0, 'snapshot avoids a second metadata extraction');
});

test('Pexels orchestration reloads authoritative files, keeps photos Original-only, and prepares video renditions', async t => {
  const fixture = providerDownloadFixture(t);
  await assert.rejects(() => fixture.handlers.pexels(validEvent, {kind: 'photo', id: 7, files: [{id: 'stale'}]}, 'photo-file', 'fast', 'job-photo'), /Invalid Pexels media selection/);
  assert.deepEqual(fixture.calls.downloads, []);
  await fixture.handlers.pexels(validEvent, {kind: 'video', id: 7, files: [{id: 'renderer-stale'}]}, 'video-file', 'editing', 'job-pexels');
  assert.deepEqual(fixture.calls.metadata.slice(-1)[0], ['pexels-load', 'video', 7]);
  assert.equal(fixture.calls.downloads.at(-1)[0], 'pexels');
  assert.equal(fixture.calls.downloads.at(-1)[2].id, 'video-file', 'only the authoritative file id is downloaded');
  assert.equal(fixture.calls.prepare.at(-1).profile, 'editing');
  assert.equal(fixture.calls.history.at(-1).profile, 'editing');
});

test('isSafeMediaFile accepts a regular absolute file without a trusted root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-safe-'));
  try {
    const file = path.join(root, 'clip.mp4');
    writeFileSync(file, 'clip');
    assert.equal(isSafeMediaFile(file), true);
    assert.equal(typeof isSafeMediaFile(file), 'boolean');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('isSafeMediaFile rejects relative, missing, and directory paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-safe-'));
  try {
    const file = path.join(root, 'clip.mp4');
    writeFileSync(file, 'clip');
    const relative = path.relative(process.cwd(), file);
    assert.equal(isSafeMediaFile(relative), false);
    assert.equal(isSafeMediaFile(path.join(root, 'missing.mp4')), false);
    assert.equal(isSafeMediaFile(root), false);
    assert.equal(isSafeMediaFile(''), false);
    assert.equal(isSafeMediaFile(null), false);
    assert.equal(isSafeMediaFile(undefined), false);
    assert.equal(isSafeMediaFile(123), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('isSafeMediaFile rejects symlinks and dangling symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-safe-'));
  try {
    const target = path.join(root, 'real.mp4');
    writeFileSync(target, 'real');
    const link = path.join(root, 'link.mp4');
    symlinkSync(target, link);
    assert.equal(isSafeMediaFile(link), false);
    const dangling = path.join(root, 'dangling.mp4');
    symlinkSync(path.join(root, 'no-such.mp4'), dangling);
    assert.equal(isSafeMediaFile(dangling), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('isSafeMediaFile enforces canonical root containment: inside accepted, outside and symlink-escape rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'clipdock-outside-'));
  try {
    const insideFile = path.join(root, 'inside.mp4');
    writeFileSync(insideFile, 'inside');
    assert.equal(isSafeMediaFile(insideFile, root), true);
    const nested = path.join(root, 'sub');
    mkdirSync(nested);
    const nestedFile = path.join(nested, 'nested.mp4');
    writeFileSync(nestedFile, 'nested');
    assert.equal(isSafeMediaFile(nestedFile, root), true);

    const outsideFile = path.join(outside, 'outside.mp4');
    writeFileSync(outsideFile, 'outside');
    assert.equal(isSafeMediaFile(outsideFile, root), false);
    assert.equal(isSafeMediaFile(outsideFile), true, 'dialog external regular files remain accepted when no root is supplied');

    const escapeLink = path.join(root, 'escape.mp4');
    symlinkSync(outsideFile, escapeLink);
    assert.equal(isSafeMediaFile(escapeLink, root), false);
    assert.equal(isSafeMediaFile(escapeLink), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

test('isSafeMediaFile fails closed for malformed or symlinked trusted roots; only undefined omits containment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-safe-'));
  try {
    const file = path.join(root, 'clip.mp4');
    writeFileSync(file, 'clip');
    assert.equal(isSafeMediaFile(file, path.join(root, 'missing-root')), false);
    assert.equal(isSafeMediaFile(file, 'relative/root'), false);
    assert.equal(isSafeMediaFile(file, ''), false);
    assert.equal(isSafeMediaFile(file, null), false, 'an explicitly supplied null root must not disable containment');
    assert.equal(isSafeMediaFile(file, undefined), true);
    const fileRoot = path.join(root, 'file-root.mp4');
    writeFileSync(fileRoot, 'x');
    assert.equal(isSafeMediaFile(file, fileRoot), false, 'root must be a directory');
    const linkedRoot = path.join(tmpdir(), `clipdock-safe-root-${Date.now()}`);
    symlinkSync(root, linkedRoot);
    try {
      assert.equal(isSafeMediaFile(file, linkedRoot), false, 'trusted roots must not be symlinks');
    } finally {
      rmSync(linkedRoot, {force: true});
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('isSafeMediaFile never exposes a filesystem path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-safe-'));
  try {
    const file = path.join(root, 'clip.mp4');
    writeFileSync(file, 'clip');
    const result = isSafeMediaFile(file, root);
    assert.equal(result, true);
    assert.equal(typeof result, 'boolean');
    const rejected = isSafeMediaFile(path.join(root, 'missing.mp4'), root);
    assert.equal(typeof rejected, 'boolean');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('ENG-10/SHL-9: real YouTube preflight cancellation prevents download and completion side effects', async t => {
  const {YtdlpWorker} = await import('../dist/ytdlp.js');
  const {EventEmitter} = await import('node:events');
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-youtube-preflight-'));
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {queueMicrotask(() => child.emit('close', 143)); return true;};
  const worker = new YtdlpWorker('/fixture', () => child, undefined, {sessionDir: root, killGraceMs: 5});
  const fixture = providerDownloadFixture(t, {youtube: {worker, emit: () => {}}});
  let pending;
  try {
    pending = fixture.handlers.youtube(validEvent, 'https://youtu.be/dQw4w9WgXcQ', 'best', 'original', 'preflight', {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'});
    const rejected = assert.rejects(pending, /cancelled/i);
    assert.equal(fixture.handlers.cancel('preflight'), true);
    await rejected;
    assert.deepEqual(fixture.calls.downloads, []);
    assert.deepEqual(fixture.calls.cards, []);
    assert.deepEqual(fixture.calls.history, []);
  } finally {await worker.dispose(); await pending?.catch(() => {}); rmSync(root, {recursive: true, force: true});}
});

test('ENG-10/SHL-9: cancellation stays owned through finalization and cannot register a late result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-youtube-final-cancel-'));
  const file = path.join(root, 'clip.mp4'); writeFileSync(file, 'media');
  let release, entered;
  const waiting = new Promise(resolve => {entered = resolve;});
  // Use the real dispatch/completion APIs with a controlled asynchronous project-refresh boundary.
  const calls = {cards: 0, history: 0, completed: 0};
  const handlers = createProviderDownloadHandlers({
    ffprobeAvailable: true, cancelMediaPreparation: () => false, registerSubtitle: () => {throw new Error('no subtitles');},
    youtube: {worker: {metadata: async () => ({id: 'dQw4w9WgXcQ', title: 'Video', duration: 1, chapters: []}), download: async () => ({filePath: file, fileName: 'clip.mp4'})}, emit: (_event, update) => {if (update.state === 'completed') calls.completed++;}},
    completion: {isSafeMediaFile: () => true, refreshHistoryProject: () => {entered(); return new Promise(resolve => {release = resolve;});}, recordHistory: () => {calls.history++; return {record: null};}, registerCard: () => {calls.cards++; return 'card';}, prepareMedia: async () => {throw new Error('Original must not prepare');}},
    social: {}, pinterest: {}, pexels: {},
  });
  let pending;
  try {
    pending = handlers.youtube(validEvent, 'https://youtu.be/dQw4w9WgXcQ', 'best', 'original', 'finalizing', {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'});
    const rejection = assert.rejects(pending, /cancelled/i);
    await waiting;
    assert.equal(handlers.cancel('finalizing'), true);
    await handlers.shutdown(); await rejection;
    release();
    assert.deepEqual(calls, {cards: 0, history: 0, completed: 0});
    assert.equal(handlers.cancel('finalizing'), false);
    assert.equal(isSafeMediaFile(file), false);
  } finally {release?.(); await pending?.catch(() => {}); rmSync(root, {recursive: true, force: true});}
});


test('Pexels authoritative metadata uses the download job cancellation scope', async t => {
  const {PexelsClient} = await import('../dist/pexels.js');
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-pexels-preflight-'));
  let signal, requests = 0;
  const worker = new PexelsClient(root, async (_url, init) => {
    requests++; signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  worker.setKey('P'.repeat(20), false);
  const fixture = providerDownloadFixture(t, {pexels: {worker, emit: () => {}}});
  t.after(async () => {await worker.dispose(); rmSync(root, {recursive: true, force: true});});
  const pending = fixture.handlers.pexels(validEvent, {kind: 'video', id: 7}, 'video-file', 'original', 'preflight');
  const rejection = assert.rejects(pending, {message: 'Download cancelled.'});
  assert.equal(fixture.handlers.cancel('preflight'), true);
  await rejection;
  assert.equal(requests, 1);
  assert.equal(signal.aborted, true);
  assert.equal(worker.isDownloading(), false);
  assert.deepEqual(fixture.calls.cards, []);
  assert.deepEqual(fixture.calls.history, []);
});
