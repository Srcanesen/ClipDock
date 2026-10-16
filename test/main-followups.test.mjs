// Deterministic follow-up tests for the Electron-free main-process seams:
// sender-gated sensitive operations, the
// non-blocking startup ordering, and the subtitle companion history contract
// passed through the artifact completion service. Run after `npm run build`;
// tests import the compiled artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {parsePinterestSearchJsonl} from '../dist/gallerydl.js';

import {mainFixture, download, deferred} from './helpers/files-main.mjs';

import {IPC_CHANNELS} from '../dist/shared.js';
import {createArtifactCompletionService, createSensitiveIpcHandler, runStartupSequence} from '../dist/main-process.js';

test('provider events preserve payloads and contain destroyed/stale renderer failures through real IPC', async t => {
  for (const state of ['valid', 'destroyed', 'stale']) {
    const f = await mainFixture(t);
    if (state === 'destroyed') f.event.sender.isDestroyed = () => true;
    if (state === 'stale') f.event.sender.send = () => { throw new Error('stale renderer'); };
    const result = await download(f);
    assert.equal(result.fileName, 'job.mp4');
    assert.equal(typeof result.cardId, 'string');
    assert.deepEqual(f.events.map(({channel, update}) => ({channel, state: update.state, fileName: update.fileName})), state === 'valid'
      ? [{channel: IPC_CHANNELS.youtubeEvent, state: 'completed', fileName: 'job.mp4'}] : []);
  }
});

test('Pinterest preload forwards exactly query/page through main and returns search items without path/raw', async t => {
  const f = await mainFixture(t);
  const worker = f.workers.find(worker => worker.initialRoot.endsWith('/pinterest-search'));
  const calls = [], invocations = [];
  const source = [
    [2, {id: '123', title: 'Cat', count: 1, pinner: {username: 'Creator'}, path: '/private/pin', raw: {secret: true}}],
    [3, 'https://i.pinimg.com/originals/123.jpg', {pin_id: '123', extension: 'jpg', path: '/private/media.jpg', raw: {secret: true}}],
  ].map(value => JSON.stringify(value)).join('\n');
  worker.search = async (...args) => {
    calls.push(args);
    return {query: 'cats', page: 2, pageSize: 10, results: parsePinterestSearchJsonl(source), hasPrevious: true, hasNext: false, totalResults: 11, pageCount: 2};
  };
  let api;
  vm.runInNewContext(fs.readFileSync(new URL('../dist/preload.js', import.meta.url), 'utf8'), {
    exports: {}, require(id) {
      assert.equal(id, 'electron/renderer');
      return {contextBridge: {exposeInMainWorld(name, value) { assert.equal(name, 'clipdockAPI'); api = value; }},
        ipcRenderer: {invoke(...args) { invocations.push(args); return f.invokeRaw(...args); }}};
    },
  });
  const result = await api.searchPinterest('cats', 2, 'must not cross IPC');
  assert.deepEqual(invocations, [['clipdock:search-pinterest', 'cats', 2]]);
  assert.deepEqual(calls, [['cats', 2]]);
  assert.deepEqual(result, {query: 'cats', page: 2, pageSize: 10, results: [{
    id: '123', title: 'Cat', creator: 'Creator', kind: 'image', url: 'https://www.pinterest.com/pin/123/', thumbnailUrl: null,
  }], hasPrevious: true, hasNext: false, totalResults: 11, pageCount: 2});
  assert.deepEqual(Object.keys(result.results[0]).sort(), ['creator', 'id', 'kind', 'thumbnailUrl', 'title', 'url']);
});

test('the TypeScript consumer contract admits a search item and excludes even optional path/raw keys', () => {
  // The shared contract is erased at runtime, so exercise the compiler with a
  // consumer instead of matching its source spelling. Extract catches optional keys too.
  const file = path.resolve('test/pinterest-search-contract.ts');
  const consumer = `import type {PinterestSearchItem} from '../src/shared';
    type NoPrivateKeys<T extends never> = T;
    type PrivateKeys = NoPrivateKeys<Extract<keyof PinterestSearchItem, 'path' | 'raw'>>;
    const item: PinterestSearchItem = {id: '123', title: 'Cat', creator: null, kind: 'image', url: 'https://www.pinterest.com/pin/123/', thumbnailUrl: null};
    export {item};`;
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const {options} = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const compilerOptions = {...options, noEmit: true, rootDir: undefined};
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...args) => path.resolve(name) === file
    ? ts.createSourceFile(name, consumer, languageVersion, true) : getSourceFile(name, languageVersion, ...args);
  const program = ts.createProgram([file, path.resolve('src/electron.d.ts')], compilerOptions, host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('sensitive IPC seam rejects an untrusted sender before any side effect', async () => {
  const calls = [];
  const validEvent = {sender: 'clipdock'};
  const handler = createSensitiveIpcHandler(
    (event) => { calls.push('sender'); if (event !== validEvent) throw new Error('Invalid ClipDock sender.'); },
    async (_event, value) => { calls.push(`op:${value}`); return `done:${value}`; },
  );
  await assert.rejects(() => handler(null, 'secret-input'), /Invalid ClipDock sender/);
  await assert.rejects(() => handler({sender: 'untrusted'}, 'secret-input'), /Invalid ClipDock sender/);
  assert.deepEqual(calls, ['sender', 'sender']); // the operation never ran
  assert.equal(await handler(validEvent, 'bounded-input'), 'done:bounded-input');
  assert.deepEqual(calls, ['sender', 'sender', 'sender', 'op:bounded-input']);
});

test('startup sequence registers handlers and creates the window before background services, returning synchronously', async () => {
  const order = [];
  let backgroundSettled = false;
  runStartupSequence({
    registerHandlers() { order.push('register'); },
    createWindow() { order.push('window'); },
    startBackgroundServices() {
      order.push('background-start');
      void Promise.resolve().then(() => { backgroundSettled = true; });
    },
  });
  // Non-blocking: the sequence returned before the background task settled.
  assert.deepEqual(order, ['register', 'window', 'background-start']);
  assert.equal(backgroundSettled, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backgroundSettled, true);
});

test('Pexels credential IPC waits for restoration while unrelated provider IPC answers', async t => {
  const restored = deferred();
  class Credentials { load() { return restored.promise; } }
  class Pexels {
    setRoot() {} isDownloading() { return false; } dispose() {}
    restoreStatus() {} restoreKey() { return true; }
    status() { return {connected: true, persisted: true, message: 'Connected'}; }
    async validateKey(key) { return key; } setKey(key) { return {key}; }
  }
  const f = await mainFixture(t, {modules: {
    './pexels': {PexelsClient: Pexels},
    './pexels-credential': {MacKeychainPexelsCredentialStore: Credentials, PexelsCredentialStore: Credentials},
  }});
  let answered = false;
  const pending = f.invoke('pexelsKeyStatus').then(value => { answered = true; return value; });
  assert.equal((await f.invoke('loadYoutube', 'url')).id, 'dQw4w9WgXcQ');
  assert.equal(answered, false);
  restored.resolve({key: 'saved'});
  assert.deepEqual(await pending, {connected: true, persisted: true, message: 'Connected'});
});

test('completion carries the subtitle companion through the history input contract', async () => {
  const automation = {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []};
  const historyInput = {
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    filePath: '/tmp/clipdock/clip.mp4',
    assetId: 'dQw4w9WgXcQ',
    title: 'Title',
    creator: 'Channel',
    profile: 'original',
    quality: 'best',
    mediaMode: 'video',
    selection: null,
    automation,
    subtitle: {filePath: '/tmp/clipdock/subtitles/en.srt'},
  };
  const calls = {history: null};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => undefined,
    recordHistory: (input) => { calls.history = input; return {record: {id: 'history-1'}}; },
    registerCard: () => 'card-1',
    emitCompleted: () => undefined,
  });
  await service.completeDownload({jobId: 'job-1', automation, artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4'}, history: historyInput});
  assert.deepEqual(calls.history.subtitle, {filePath: '/tmp/clipdock/subtitles/en.srt'});
  assert.deepEqual(calls.history.subtitle, historyInput.subtitle);
});

test('completion runs provider-validated preparation and binds the prepared artifact everywhere (YouTube variant)', async () => {
  const automation = {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []};
  const subtitle = {cardId: 'sub-1', fileName: 'clip.en.srt'};
  const calls = {refresh: 0, history: [], cards: [], events: [], prepare: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-1'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
    prepareMedia: (request) => { calls.prepare.push(request.profile); return {filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  const result = await service.completeDownload({
    jobId: 'job-1', automation,
    artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4', warning: 'Subtitles were unavailable; the media download is ready.', subtitle},
    prepare: {jobId: 'job-1', inputPath: '/tmp/clipdock/clip.mp4', allowedRoot: '/tmp/clipdock', profile: 'fast', emit: () => undefined},
    history: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: '/tmp/clipdock/clip.mp4', assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'fast', quality: 'best', mediaMode: 'video', selection: null, automation, subtitle: {filePath: '/tmp/clipdock/subtitles/en.srt'}},
  });
  assert.deepEqual(calls.prepare, ['fast']);
  assert.deepEqual(result, {cardId: 'card-1', fileName: 'prepared.mp4', subtitle, warning: 'Subtitles were unavailable; the media download is ready.'});
  assert.deepEqual(calls.history[0], {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: '/tmp/clipdock/prepared.mp4', assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'fast', quality: 'best', mediaMode: 'video', selection: null, automation, subtitle: {filePath: '/tmp/clipdock/subtitles/en.srt'}});
  assert.deepEqual(calls.cards, [{path: '/tmp/clipdock/prepared.mp4', automation, historyId: 'history-1'}]);
  assert.deepEqual(calls.events[0], {jobId: 'job-1', state: 'completed', percent: 100, message: 'Ready for Resolve with a warning.', cardId: 'card-1', fileName: 'prepared.mp4', subtitle, warning: 'Subtitles were unavailable; the media download is ready.'});
});

test('completion propagates preparation failure for editing without fallback or side effects (Social variant)', async () => {
  const prepareError = new Error('Media preparation failed: ffmpeg failed.');
  const automation = {provider: 'social', source: 'https://www.instagram.com/reel/x', selection: null, chapters: []};
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-2'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-2'; },
    prepareMedia: async () => { throw prepareError; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  let result;
  await assert.rejects(
    async () => { result = await service.completeDownload({
      jobId: 'job-2', automation,
      artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4', warning: 'Download warning.'},
      prepare: {jobId: 'job-2', inputPath: '/tmp/clipdock/clip.mp4', allowedRoot: '/tmp/clipdock', profile: 'editing', emit: () => undefined},
      history: {provider: 'social', source: 'https://www.instagram.com/reel/x', filePath: '/tmp/clipdock/clip.mp4', assetId: 'instagram:x', title: 'Title', creator: 'Creator', profile: 'editing', quality: 'best', mediaMode: 'video', selection: null, automation},
    }); },
    (error) => error === prepareError,
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
  assert.equal(calls.history.length, 0);
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.events.length, 0);
});

test('completion propagates preparation cancellation without fallback or side effects (Pexels variant)', async () => {
  const automation = {provider: 'pexels', source: 'https://www.pexels.com/video/1', selection: null, chapters: []};
  const cancelled = new Error('Media preparation cancelled.');
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-3'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-3'; },
    prepareMedia: async () => { throw cancelled; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  await assert.rejects(
    () => service.completeDownload({
      jobId: 'job-3', automation,
      artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4'},
      prepare: {jobId: 'job-3', inputPath: '/tmp/clipdock/clip.mp4', allowedRoot: '/tmp/clipdock', profile: 'fast', emit: () => undefined},
      history: {provider: 'pexels', source: 'https://www.pexels.com/video/1', filePath: '/tmp/clipdock/clip.mp4', assetId: 'video:1', title: 'Title', creator: 'Creator', profile: 'fast', quality: 'HD', mediaMode: 'video', selection: null, automation},
    }),
    (error) => error === cancelled,
  );
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
});

test('completion keeps the provider-declared profile and payload when no preparation applies (Pexels photo variant)', async () => {
  const automation = {provider: 'pexels', source: 'https://www.pexels.com/photo/2', selection: null, chapters: []};
  const calls = {refresh: 0, history: [], cards: [], events: [], prepare: 0};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-4'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-4'; },
    prepareMedia: async () => { calls.prepare += 1; return {filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  const result = await service.completeDownload({
    jobId: 'job-4', automation,
    artifact: {filePath: '/tmp/clipdock/photo.jpg', fileName: 'photo.jpg'},
    history: {provider: 'pexels', source: 'https://www.pexels.com/photo/2', filePath: '/tmp/clipdock/photo.jpg', assetId: 'photo:2', title: 'Photo', creator: 'Creator', profile: 'fast', quality: '2K', mediaMode: 'photo', selection: null, automation},
  });
  assert.deepEqual(result, {cardId: 'card-4', fileName: 'photo.jpg', subtitle: undefined, warning: undefined});
  assert.equal(calls.prepare, 0);
  assert.equal(calls.history[0].profile, 'fast');
  assert.equal(calls.history[0].filePath, '/tmp/clipdock/photo.jpg');
  assert.deepEqual(calls.events[0], {jobId: 'job-4', state: 'completed', percent: 100, message: 'Ready for Resolve.', cardId: 'card-4', fileName: 'photo.jpg', subtitle: undefined, warning: undefined});
});

test('completion orders optional preparation before refresh, history, card, and event side effects', async () => {
  const automation = {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []};
  const order = [];
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { order.push('refresh'); },
    recordHistory: (input) => { order.push('history'); return {record: {id: 'history-5'}}; },
    registerCard: (card) => { order.push('card'); return 'card-5'; },
    prepareMedia: async (request) => { order.push(`prepare:${request.profile}`); return {filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}; },
    emitCompleted: () => { order.push('event'); },
  });
  await service.completeDownload({
    jobId: 'job-5', automation,
    artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4'},
    prepare: {jobId: 'job-5', inputPath: '/tmp/clipdock/clip.mp4', allowedRoot: '/tmp/clipdock', profile: 'fast', emit: () => undefined},
    history: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: '/tmp/clipdock/clip.mp4', assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'fast', quality: 'best', mediaMode: 'video', selection: null, automation},
  });
  assert.deepEqual(order, ['prepare:fast', 'refresh', 'history', 'card', 'event']);
});

test('completion propagates unsafe prepared output for fast without fallback or side effects', async () => {
  const automation = {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []};
  const safe = new Set(['/tmp/clipdock/clip.mp4']);
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: (filePath) => safe.has(filePath),
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-6'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-6'; },
    prepareMedia: async () => ({filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}),
    emitCompleted: (event) => { calls.events.push(event); },
  });
  let result;
  await assert.rejects(
    async () => { result = await service.completeDownload({
      jobId: 'job-6', automation,
      artifact: {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4', warning: 'Download warning.'},
      prepare: {jobId: 'job-6', inputPath: '/tmp/clipdock/clip.mp4', allowedRoot: '/tmp/clipdock', profile: 'fast', emit: () => undefined},
      history: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: '/tmp/clipdock/clip.mp4', assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'fast', quality: 'best', mediaMode: 'video', selection: null, automation},
    }); },
    (error) => error instanceof Error && error.message === 'Prepared file is no longer available.',
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
  assert.equal(calls.history.length, 0);
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.events.length, 0);
});


test('startup captures the managed root before loading legacy managed history', async t => {
  const f = await mainFixture(t, {setup({root, userData}) {
    const filePath = path.join(root, 'youtube', 'legacy.mp4');
    fs.mkdirSync(path.dirname(filePath), {recursive: true}); fs.writeFileSync(filePath, 'legacy media');
    fs.writeFileSync(path.join(userData, 'download-history.json'), JSON.stringify({schemaVersion: 1, records: [{
      id: 'legacy', provider: 'youtube', source: 'https://youtu.be/dQw4w9WgXcQ', managed: true,
      filePath, fileName: 'legacy.mp4', title: 'Legacy clip',
    }]}));
  }});
  const records = await f.invoke('historyList');
  assert.equal(records.length, 1);
  assert.equal(records[0].fileName, 'legacy.mp4');
  assert.equal(records[0].available, true);
  assert.equal((await f.invoke('historyReuse', 'legacy')).fileName, 'legacy.mp4');
});
