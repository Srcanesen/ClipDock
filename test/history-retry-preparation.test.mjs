import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHarness } from './helpers/renderer-harness.mjs';

const require = createRequire(import.meta.url);
const { DownloadHistory } = require('../dist/history.js');
const { DownloadLedger } = require('../dist/download-ledger.js');
const { createMediaPrep } = require('../dist/media-prep.js');
const mainProcess = require('../dist/main-process.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const metadata = { provider: 'youtube', source, assetId: null, title: 'Retained video', creator: null, profile: 'original', quality: '1080p', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source, selection: null, chapters: [] } };

function fixture(t, { marked = true, mode = 'success', profile = 'fast' } = {}) {
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'clipdock-history-retry-')));
  const managed = path.join(temp, 'media'); mkdirSync(managed);
  const file = path.join(managed, 'retained.webm'); writeFileSync(file, 'original bytes');
  const store = path.join(temp, 'history.json');
  const history = new DownloadHistory(store, managed);
  const record = history.add({ ...metadata, filePath: file, ...(marked ? { preparationFailed: { profile } } : {}) });
  const events = [], calls = [];
  let release;
  const probe = output => JSON.stringify({ streams: [{ codec_type: 'video', codec_name: output ? profile === 'fast' ? 'h264' : 'prores' : 'vp9', pix_fmt: output && profile === 'editing' ? 'yuv422p10le' : 'yuv420p', width: 640, height: 360, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '10' }], format: { duration: '10', format_name: 'mov,mp4', tags: { major_brand: output && profile === 'editing' ? 'qt  ' : 'isom' } } });
  const worker = createMediaPrep({ ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', spawn: (binary, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    calls.push({ binary, args });
    queueMicrotask(() => {
      if (binary.endsWith('ffprobe')) { child.stdout.emit('data', Buffer.from(probe(args.at(-1) !== file))); child.emit('close', 0); return; }
      writeFileSync(args.at(-1), 'prepared bytes');
      child.stderr.emit('data', Buffer.from('out_time_us=4200000\n'));
      const finish = () => { child.stderr.emit('data', Buffer.from(mode === 'failure' ? 'fixture conversion failed' : 'progress=end\n')); child.emit('close', mode === 'failure' ? 1 : 0); };
      if (mode === 'held') release = finish; else finish();
    });
    return child;
  } });
  const ledger = new DownloadLedger(history, () => worker.isActive());
  t.after(async () => { await worker.dispose(); await history.dispose(); rmSync(temp, { recursive: true, force: true }); });
  const controller = () => mainProcess.createHistoryPreparationHandlers({ history, prepareMedia: worker.prepare, cancelMediaPreparation: worker.cancel, replaced: id => ledger.bindHistory(id) });
  return { temp, managed, file, store, history, record, worker, ledger, events, calls, controller, emit: event => events.push(event), release: () => release(), wait: async () => { for (let i = 0; i < 50 && !release; i++) await tick(); assert.equal(typeof release, 'function'); } };
}

test('retry marker round-trips with legacy records; invalid marker is dropped without corrupting the store', async t => {
  const f = fixture(t);
  const legacy = f.history.add({ ...metadata, filePath: f.file });
  const restarted = new DownloadHistory(f.store, f.managed); t.after(() => restarted.dispose());
  assert.deepEqual(restarted.get(f.record.id).preparationFailed, { profile: 'fast' });
  assert.equal(Object.hasOwn(restarted.get(legacy.id), 'preparationFailed'), false);
  for (const invalid of [{ profile: 'original' }, { profile: 'bogus' }, null, 'fast', {}]) {
    const raw = JSON.parse(readFileSync(f.store, 'utf8')); raw.records[0].preparationFailed = invalid; writeFileSync(f.store, JSON.stringify(raw));
    const loaded = new DownloadHistory(f.store, f.managed); t.after(() => loaded.dispose());
    assert.equal(loaded.list().length, 2);
    assert.equal(Object.hasOwn(loaded.get(legacy.id), 'preparationFailed'), false);
    assert.equal(readdirSync(f.temp).some(name => name.includes('.corrupt-')), false);
  }
});

test('replacePreparedArtifact updates the same id, managed deletion identity, ledger binding and thumbnail cache', async t => {
  const f = fixture(t); const before = f.history.get(f.record.id);
  const oldCard = f.ledger.listHistory()[0].cardId;
  const cache = path.join(f.temp, 'history-thumbnails'); mkdirSync(cache, { recursive: true });
  // Use the real thumbnail cache key so replacement must invalidate the persisted artwork.
  const thumbnail = path.join(cache, `clipdock-history-${createHash('sha256').update(f.record.id).digest('hex')}.jpg`); writeFileSync(thumbnail, 'cached');
  const output = path.join(f.managed, 'retained.resolve.mov'); writeFileSync(output, 'converted');
  const next = f.history.replacePreparedArtifact(f.record.id, { filePath: output, profile: 'editing' });
  assert.equal(next.id, before.id); assert.equal(next.profile, 'editing'); assert.equal(next.fileName, 'retained.resolve.mov'); assert.equal(next.bytes, 9);
  assert.equal(Object.hasOwn(next, 'preparationFailed'), false);
  assert.equal(next.createdAt, before.createdAt); assert.equal(next.available, true);
  assert.equal(existsSync(thumbnail), false);
  const restarted = new DownloadHistory(f.store, f.managed); t.after(() => restarted.dispose());
  assert.equal(restarted.resolve(next.id).path, output);
  const newCard = f.ledger.listHistory()[0].cardId;
  assert.notEqual(newCard, oldCard); assert.equal(f.ledger.resolve(oldCard), null); assert.equal(f.ledger.resolve(newCard).path, output);
  assert.equal(f.ledger.deleteHistory(next.id).deleted, true); assert.equal(existsSync(output), false);
});

test('retry succeeds through real preparation, reports progress and replaces only the retained record', async t => {
  const f = fixture(t); const api = f.controller();
  const result = await api.retryPreparation(f.record.id, f.emit);
  assert.deepEqual(result, { cancelled: false, profile: 'fast' });
  assert.equal(f.history.list().length, 1); assert.equal(f.history.get(f.record.id).profile, 'fast');
  assert.equal(Object.hasOwn(f.history.get(f.record.id), 'preparationFailed'), false);
  assert.equal(existsSync(f.file), false); assert.equal(readFileSync(f.history.resolve(f.record.id).path, 'utf8'), 'prepared bytes');
  assert.deepEqual(f.events.map(event => ({ ...event, percent: Math.round(event.percent) })), [{ id: f.record.id, percent: 0 }, { id: f.record.id, percent: 42 }, { id: f.record.id, percent: 100 }]);
});

test('retry failure removes partial output and leaves source and record byte-for-byte unchanged', async t => {
  const f = fixture(t, { mode: 'failure' }); const before = readFileSync(f.store, 'utf8');
  await assert.rejects(f.controller().retryPreparation(f.record.id), /fixture conversion failed/);
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes'); assert.equal(readFileSync(f.store, 'utf8'), before);
  assert.deepEqual(readdirSync(f.managed), ['retained.webm']);
});

test('retry cancellation removes partial output and preserves source and record', async t => {
  const f = fixture(t, { mode: 'held' }); const before = readFileSync(f.store, 'utf8'); const api = f.controller();
  const pending = api.retryPreparation(f.record.id); await f.wait();
  assert.equal(await api.cancelPreparation(f.record.id), true);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes'); assert.equal(readFileSync(f.store, 'utf8'), before);
  assert.deepEqual(readdirSync(f.managed), ['retained.webm']);
  assert.equal(await api.cancelPreparation(f.record.id), false);
});

test('retry rejects a second call for the same record as busy', async t => {
  const f = fixture(t, { mode: 'held' }); const api = f.controller(); const pending = api.retryPreparation(f.record.id); await f.wait();
  await assert.rejects(api.retryPreparation(f.record.id), /Conversion is already running for this item\./);
  f.release(); assert.deepEqual(await pending, { cancelled: false, profile: 'fast' });
});

test('retry rejects a missing file without changing its record', async t => {
  const f = fixture(t); rmSync(f.file); const before = readFileSync(f.store, 'utf8');
  await assert.rejects(f.controller().retryPreparation(f.record.id), /existing managed file/);
  assert.equal(readFileSync(f.store, 'utf8'), before); assert.equal(f.calls.length, 0);
});

test('retry rejects an unmarked record and invalid ids without preparing anything', async t => {
  const f = fixture(t, { marked: false }); const api = f.controller();
  await assert.rejects(api.retryPreparation(f.record.id), /no failed conversion/);
  await assert.rejects(api.retryPreparation({ id: f.record.id }), /Invalid history/);
  assert.equal(f.history.get(f.record.id).profile, 'original'); assert.equal(f.calls.length, 0);
});

test('single, bulk and card deletion use the existing safety check while retry runs', async t => {
  const f = fixture(t, { mode: 'held' }); const cardId = f.ledger.listHistory()[0].cardId;
  const api = f.controller(); const pending = api.retryPreparation(f.record.id); await f.wait();
  for (const id of [f.record.id, ...f.history.list().map(record => record.id)]) {
    assert.throws(() => f.ledger.deleteHistory(id), { message: 'Conversion is running for this item. Cancel it first.' });
  }
  assert.equal(f.ledger.deleteCard(cardId).message, 'Conversion is running for this item. Cancel it first.');
  assert.throws(() => f.ledger.clearHistory(), /Conversion is running/);
  await api.cancelPreparation(f.record.id); assert.deepEqual(await pending, { cancelled: true });
  assert.equal(f.ledger.deleteHistory(f.record.id).deleted, true);
});

test('existing preparation disposal cancels History retries on shutdown', async t => {
  const f = fixture(t, { mode: 'held' }); const api = f.controller();
  const pending = api.retryPreparation(f.record.id); await f.wait(); await f.worker.dispose();
  assert.deepEqual(await pending, { cancelled: true }); assert.equal(f.history.get(f.record.id).profile, 'original');
  assert.deepEqual(readdirSync(f.managed), ['retained.webm']);
});

const descend = element => [element, ...(element.children ?? []).flatMap(descend)];
for (const outcome of ['success', 'failure', 'cancel']) test(`renderer retry row: idle, progress across refresh/tab switch, and ${outcome}`, async () => {
  const h = createHarness();
  let record = { ...metadata, id: 'retry-row', fileName: 'retained.webm', bytes: 14, project: null, createdAt: Date.now(), lastUsedAt: Date.now(), available: true, preparationFailed: { profile: 'editing' } };
  let progress, resolve, reject;
  h.api.historyList = async () => [record];
  h.api.onHistoryPreparationProgress = callback => { progress = callback; return () => {}; };
  h.api.historyRetryPreparation = () => new Promise((yes, no) => { resolve = yes; reject = no; });
  h.api.historyCancelPreparation = async () => { resolve({ cancelled: true }); return true; };
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  const all = () => descend(h.elements.get('history-list'));
  const badge = () => all().find(el => el.classList?.contains('history-preparation-badge'));
  const control = () => all().find(el => el.classList?.contains('history-retry-preparation'));
  assert.equal(badge()?.textContent, 'Not converted'); assert.ok(control());
  assert.equal(descend(control()).find(el => el.tagName === 'USE').getAttribute('href'), '#i-retry');
  control().click(); await h.flush(); assert.equal(control().getAttribute('aria-label'), 'Cancel: retained.webm');
  assert.equal(descend(control()).find(el => el.tagName === 'USE').getAttribute('href'), '#i-x');
  progress({ id: 'retry-row', percent: 42 }); assert.equal(badge().textContent, 'Converting… 42%');
  h.elements.get('history-refresh-btn').click(); await h.flush();
  h.test.setSurface('queue'); h.test.setSurface('library'); await h.flush();
  assert.equal(badge().textContent, 'Converting… 42%');
  assert.equal(descend(control()).find(el => el.tagName === 'USE').getAttribute('href'), '#i-x');
  progress({ id: 'retry-row', percent: null }); assert.equal(badge().textContent, 'Converting…');
  if (outcome === 'success') { record = { ...record, profile: 'editing', fileName: 'retained.resolve.mov' }; delete record.preparationFailed; resolve({ cancelled: false, profile: 'editing' }); }
  else if (outcome === 'failure') reject({ message: 'Fixture conversion failed.' });
  else control().click();
  await h.flush();
  assert.equal(h.elements.get('message').textContent, outcome === 'success' ? 'Converted to Edit-ready.' : outcome === 'failure' ? 'Fixture conversion failed. The original is still in History.' : 'Conversion cancelled.');
  assert.equal(badge()?.textContent, outcome === 'success' ? undefined : 'Not converted');
  assert.equal(!!control(), outcome !== 'success');
  if (outcome !== 'success') assert.equal(descend(control()).find(el => el.tagName === 'USE').getAttribute('href'), '#i-retry');
});

for (const profile of ['fast', 'editing']) test(`failed download records the requested ${profile} preparation profile`, async t => {
  const f = fixture(t, { marked: false }); let failed;
  const service = mainProcess.createArtifactCompletionService({
    isSafeMediaFile: () => true, prepareMedia: async () => { throw new Error('Conversion failed.'); },
    recordHistory: input => ({ record: f.history.add(input) }),
    registerCard: () => { assert.fail('Failed conversion must not publish a card.'); },
    emitCompleted: () => { assert.fail('Failed conversion must not publish completion.'); },
    refreshHistoryProject: async () => {},
  });
  await assert.rejects(service.completeDownload({
    jobId: 'retained', automation: metadata.automation,
    artifact: { filePath: f.file, fileName: path.basename(f.file) }, history: { ...metadata, filePath: f.file },
    prepare: { jobId: 'retained', inputPath: f.file, allowedRoot: f.managed, profile, emit() {} },
    job: { owned() {}, onFailure(commit) { failed = commit; }, retain(file) { assert.equal(file, f.file); } },
  }), /Conversion failed/);
  assert.equal(typeof failed, 'function'); failed();
  assert.equal(f.history.list()[0].profile, 'original');
  assert.deepEqual(f.history.list()[0].preparationFailed, { profile });
  assert.equal(existsSync(f.file), true);
});

test('a competing History writer rejects replacement and retry cleans the output while retaining the source', async t => {
  const f = fixture(t, { mode: 'held' }); const api = f.controller(); const before = readFileSync(f.store, 'utf8');
  const pending = api.retryPreparation(f.record.id); const rejected = assert.rejects(pending, /locked by another writer/); await f.wait();
  const { tryAcquireFileLock } = require('../dist/file-lock.js');
  const lock = tryAcquireFileLock(`${f.store}.lock`); assert.ok(lock);
  try { f.release(); await rejected; } finally { lock.release(); }
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes'); assert.equal(readFileSync(f.store, 'utf8'), before);
  assert.deepEqual(readdirSync(f.managed), ['retained.webm']);
});

test('external relinking cannot grant retry authority to a marked record', async t => {
  const f = fixture(t); const external = path.join(f.temp, 'external.mp4'); writeFileSync(external, 'external');
  f.history.relink(f.record.id, external);
  await assert.rejects(f.controller().retryPreparation(f.record.id), /existing managed file/);
  assert.equal(readFileSync(external, 'utf8'), 'external'); assert.equal(f.calls.length, 0);
});

test('the two new registered History IPC handlers reject foreign senders before engine readiness', async t => {
  const { mainFixture, deferred } = await import('./helpers/files-main.mjs');
  const discovery = deferred(); const f = await mainFixture(t, { discovery: discovery.promise });
  const channels = ['clipdock:history-retry-preparation', 'clipdock:history-cancel-preparation'];
  for (const channel of channels) {
    assert.equal(typeof f.handlers.get(channel), 'function');
    for (const event of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.event.sender, senderFrame: null }, { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }]) {
      await assert.rejects(f.invokeEvent(channel, event, 'id'), { message: 'Invalid ClipDock sender.' });
    }
  }
  assert.equal(f.workers.length, 0); assert.deepEqual(f.events, []);
  discovery.resolve({ ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null, jsRuntime: null });
  await tick();
});

test('preload exposes the retry/cancel channels and removable path-free progress subscription', async () => {
  const { runInNewContext } = await import('node:vm');
  let api; const invoked = [], listeners = new Map();
  runInNewContext(readFileSync(new URL('../dist/preload.js', import.meta.url), 'utf8'), {
    exports: {}, require: name => { assert.equal(name, 'electron/renderer'); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => { invoked.push(args); return true; }, on: (channel, listener) => listeners.set(channel, listener), removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); } },
    }; },
  });
  assert.equal(typeof api.historyRetryPreparation, 'function');
  await api.historyRetryPreparation('id'); await api.historyCancelPreparation('id');
  assert.equal(JSON.stringify(invoked), JSON.stringify([['clipdock:history-retry-preparation', 'id'], ['clipdock:history-cancel-preparation', 'id']]));
  let update; const unsubscribe = api.onHistoryPreparationProgress(event => { update = event; });
  listeners.get('clipdock:history-preparation-progress')({}, { id: 'id', percent: null });
  assert.deepEqual(update, { id: 'id', percent: null }); unsubscribe(); assert.equal(listeners.size, 0);
});

for (const outcome of ['success', 'cancel', 'shutdown']) test(`registered main History retry dispatch: ${outcome}`, async t => {
  const { mainFixture, historyInput } = await import('./helpers/files-main.mjs');
  const { ProviderJobCancelledError } = require('../dist/provider-job.js');
  let request, finish, fail, running = false, cancelledJob;
  const cancel = jobId => {
    cancelledJob = jobId; running = false; fail(new ProviderJobCancelledError('Media preparation cancelled.')); return Promise.resolve();
  };
  const f = await mainFixture(t, { modules: { './media-prep': { createMediaPrep: () => ({
    isActive: () => running,
    prepare: value => { request = value; running = true; value.emit({ jobId: value.jobId, state: 'processing', percent: 42, message: 'Preparing for Resolve…' }); return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); },
    cancel, dispose: () => running ? cancel(request.jobId) : undefined,
  }) } } });
  const file = path.join(f.root, 'retained.webm'); writeFileSync(file, 'original bytes');
  const record = f.controls.history.add({ ...historyInput(file), preparationFailed: { profile: 'fast' } });
  const pending = f.invoke('historyRetryPreparation', record.id);
  for (let i = 0; i < 20 && !request; i++) await tick();
  assert.equal(request?.inputPath, file); assert.equal(request?.profile, 'fast'); assert.equal(request?.preserveSource, true);
  assert.equal(JSON.stringify(f.events), JSON.stringify([{ channel: 'clipdock:history-preparation-progress', update: { id: record.id, percent: 42 } }]));
  if (outcome === 'success') {
    const output = path.join(f.root, 'retained.resolve.mp4'); writeFileSync(output, 'prepared bytes'); running = false;
    finish({ filePath: output, fileName: path.basename(output), action: 'transcode' });
    assert.equal(JSON.stringify(await pending), JSON.stringify({ cancelled: false, profile: 'fast' }));
    const records = await f.invoke('historyList');
    assert.equal(records[0].id, record.id); assert.equal(records[0].fileName, 'retained.resolve.mp4'); assert.equal(records[0].preparationFailed, undefined); assert.ok(records[0].cardId);
    assert.equal(existsSync(file), false);
  } else {
    if (outcome === 'cancel') assert.equal(await f.invoke('historyCancelPreparation', record.id), true);
    else f.quit();
    assert.equal(JSON.stringify(await pending), JSON.stringify({ cancelled: true }));
    assert.equal(cancelledJob, request.jobId); assert.equal(readFileSync(file, 'utf8'), 'original bytes');
    assert.deepEqual(f.controls.history.get(record.id).preparationFailed, { profile: 'fast' });
    if (outcome === 'shutdown') { for (let i = 0; i < 20 && !f.lifecycle.completedQuits; i++) await tick(); assert.equal(f.lifecycle.completedQuits, 1); }
  }
});

test('prepared replacement rebinds all active source aliases with the prepared path, profile and ownership', async t => {
  const f = fixture(t, { profile: 'editing' });
  const oldDrag = f.ledger.listHistory()[0].cardId;
  const reused = f.ledger.reuseHistory(f.record.id);
  const root = f.history.resolve(f.record.id).trustedRoot;
  const alias = f.ledger.register({ path: f.file }, root);
  const external = f.ledger.registerExternal(f.file);
  assert.deepEqual(await f.controller().retryPreparation(f.record.id), { cancelled: false, profile: 'editing' });
  const prepared = f.history.resolve(f.record.id).path;
  assert.equal(prepared, path.join(f.managed, 'retained.resolve.mov'));
  for (const id of [reused.cardId, alias, external]) {
    const card = f.ledger.resolve(id);
    assert.equal(card?.path, prepared); assert.equal(card?.profile, 'editing');
  }
  assert.equal(f.ledger.resolve(alias).ownedMedia.path, prepared);
  assert.equal(f.ledger.resolve(external).trustedRoot, undefined);
  assert.equal(f.ledger.resolve(external).ownedMedia, undefined);
  assert.deepEqual(f.ledger.protectedPaths(), [prepared]);
  assert.equal(f.ledger.resolve(oldDrag), null);
});

test('ordinary relinking keeps active source cards bound to the original artifact', async t => {
  const f = fixture(t); const reused = f.ledger.reuseHistory(f.record.id);
  const other = path.join(f.managed, 'selected.mp4'); writeFileSync(other, 'selected');
  f.history.relink(f.record.id, other); f.ledger.bindHistory(f.record.id);
  assert.equal(f.ledger.resolve(reused.cardId).path, f.file);
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes');
});

test('retry shutdown marks published work cancelled synchronously, drains cleanup, and refuses new retries', async t => {
  const f = fixture(t); let published, release;
  const reached = new Promise(resolve => { published = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const api = mainProcess.createHistoryPreparationHandlers({
    history: f.history,
    prepareMedia: async request => { const prepared = await f.worker.prepare(request); published(); await gate; return prepared; },
    cancelMediaPreparation: f.worker.cancel,
    replaced: id => f.ledger.bindHistory(id),
  });
  const before = readFileSync(f.store, 'utf8'); const pending = api.retryPreparation(f.record.id); await reached;
  let stopped = false;
  const shutdown = api.shutdown(); shutdown.then(() => { stopped = true; });
  assert.equal(api.shutdown(), shutdown);
  await tick(); assert.equal(stopped, false);
  await assert.rejects(api.retryPreparation(f.record.id), error => { assert.equal(error.kind, 'disposed'); return true; });
  release(); assert.deepEqual(await pending, { cancelled: true }); await shutdown;
  assert.equal(stopped, true); assert.equal(readFileSync(f.store, 'utf8'), before);
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes'); assert.deepEqual(readdirSync(f.managed), ['retained.webm']);
});

test('a direct retry refreshes active and passive card profiles without deleting the source', async t => {
  const f = fixture(t); const passive = f.ledger.listHistory()[0].cardId;
  assert.equal(f.ledger.resolve(passive).profile, 'original');
  const reused = f.ledger.reuseHistory(f.record.id);
  const api = mainProcess.createHistoryPreparationHandlers({ history: f.history,
    prepareMedia: async () => ({ filePath: f.file, fileName: path.basename(f.file), action: 'direct' }),
    cancelMediaPreparation: f.worker.cancel, replaced: id => f.ledger.bindHistory(id),
  });
  assert.deepEqual(await api.retryPreparation(f.record.id), { cancelled: false, profile: 'fast' });
  assert.equal(f.ledger.resolve(reused.cardId).profile, 'fast');
  assert.equal(f.ledger.resolve(f.ledger.listHistory()[0].cardId).profile, 'fast');
  assert.equal(readFileSync(f.file, 'utf8'), 'original bytes');
});

test('main retry updates a file-dialog card even before History has ever been listed', async t => {
  const { mainFixture, historyInput } = await import('./helpers/files-main.mjs');
  let output;
  const f = await mainFixture(t, { modules: { './media-prep': { createMediaPrep: () => ({
    isActive: () => false, dispose() {}, cancel: () => null,
    prepare: async request => {
      assert.equal(request.preserveSource, true);
      output = path.join(path.dirname(request.inputPath), 'retained.resolve.mp4'); writeFileSync(output, 'prepared bytes');
      return { filePath: output, fileName: path.basename(output), action: 'transcode' };
    },
  }) } } });
  const source = path.join(f.root, 'retained.webm'); writeFileSync(source, 'original bytes');
  const record = f.controls.history.add({ ...historyInput(source), preparationFailed: { profile: 'fast' } });
  f.controls.dialog = async () => ({ canceled: false, filePaths: [source] });
  const selected = await f.invoke('selectFile'); assert.equal(selected.canceled, false);
  const transferred = []; f.controls.transfer = async file => { transferred.push(file); return { ok: true, kind: 'imported' }; };
  assert.equal(JSON.stringify(await f.invoke('historyRetryPreparation', record.id)), JSON.stringify({ cancelled: false, profile: 'fast' }));
  assert.equal((await f.invoke('importToMediaPool', selected.cardId, 'active')).ok, true);
  assert.deepEqual(transferred, [output]); assert.equal(existsSync(source), false);
});
