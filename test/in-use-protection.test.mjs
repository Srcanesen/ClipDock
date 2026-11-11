import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createMediaPrep } from '../dist/media-prep.js';
import { DownloadHistory } from '../dist/history.js';
import { DownloadLedger } from '../dist/download-ledger.js';
import { ManagedRoot } from '../dist/managed-root.js';
import { createEngineHost } from '../dist/engine-host.js';
import { createMainTransferHandlers, serializeMediaPreparation } from '../dist/main-process.js';
import { cleanupWorkspaceAsync, inspectWorkspaceAsync } from '../dist/workspace.js';
import { createHarness } from './helpers/renderer-harness.mjs';
import { mainFixture, download, historyInput } from './helpers/files-main.mjs';

const waitMessage = 'This file is being used by a transfer or conversion. Wait for it to finish.';
const offline = ' This file was sent to DaVinci Resolve. Deleting it takes the clip offline there.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-in-use-')));
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const store = path.join(dir, 'history.json');
  const history = new DownloadHistory(store, root);
  const inUse = new Set();
  const ledger = new DownloadLedger(history, () => inUse.size > 0, () => inUse);
  t.after(async () => { await history.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = name => { const value = path.join(root.providerPath('youtube'), name); fs.writeFileSync(value, 'media'); return value; };
  return { dir, root, store, history, ledger, file, inUse };
}
async function startHost(t, f, preparation) {
  const noopWorker = () => ({ isActive: () => false, isDownloading: () => false, dispose() {}, setSessionDir() {}, setRoot() {}, abortApiRequests() {} });
  const host = createEngineHost({ folder: f.root.verify(), runtimeRoot: f.dir, completion: {}, registerSubtitle() {}, emit() {}, restoreCredential: async () => {}, workers: { youtube: noopWorker, pinterest: noopWorker, pexels: noopWorker, pixabay: noopWorker, mediaPrep: () => serializeMediaPreparation(preparation) } });
  await host.start(Promise.resolve({})); t.after(() => host.dispose()); return host;
}
const descendants = element => [element, ...(element.children ?? []).flatMap(descendants)];
const find = (element, text) => descendants(element).find(child => child.textContent === text);
async function historyHarness(records) {
  const h = createHarness(); h.api.historyList = async () => records;
  await h.fireReady(); h.test.setSurface('library'); await h.flush(); return h;
}
const rowRecord = (id, extra = {}) => ({ id, provider: 'youtube', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', fileName: `${id}.mp4`, title: id, bytes: 5, available: true, cardId: `card-${id}`, ...extra });

test('menu reproduction: measured placement opens down near the top, up only when it fits, and clamps both axes', async () => {
  const h = await historyHarness([rowRecord('first')]);
  const row = h.elements.get('history-list').children[0], more = find(row, 'More');
  const menu = descendants(row).find(child => child.classList?.contains('history-menu'));
  for (const [width, height, trigger, expectedTop, expectedLeft] of [
    [1440, 900, { top: 140, bottom: 170, right: 1400 }, 170, 1190],
    [420, 800, { top: 140, bottom: 170, right: 418 }, 170, 202],
    [420, 800, { top: 700, bottom: 730, right: 120 }, 424, 8],
    [420, 800, { top: 200, bottom: 230, right: 900 }, 230, 202],
  ]) {
    h.window.innerWidth = width; h.window.innerHeight = height;
    more.getBoundingClientRect = () => trigger;
    menu.getBoundingClientRect = () => ({ width: 210, height: 276 });
    more.click();
    assert.equal(menu.style.top, `${expectedTop}px`);
    assert.equal(menu.style.left, `${expectedLeft}px`);
  }
  // Context menu and keyboard activation use the same real row handler.
  row.listeners.contextmenu(); assert.equal(menu.style.top, '230px');
  row.listeners.keydown({ key: 'F10', shiftKey: true }); assert.equal(menu.style.left, '202px');
});

test('scoped deletion reproduction: conversion of A allows unrelated B and refuses media or subtitle paths in use', t => {
  const f = fixture(t), a = f.file('a.mp4'), b = f.file('b.mp4'), srt = f.file('a.srt');
  const recordA = f.history.add({ ...historyInput(a), subtitle: { filePath: srt } }), recordB = f.history.add(historyInput(b));
  f.inUse.add(a);
  assert.equal(f.ledger.deleteHistory(recordB.id).deleted, true);
  assert.throws(() => f.ledger.deleteHistory(recordA.id), { message: waitMessage });
  f.inUse.clear(); f.inUse.add(srt);
  assert.throws(() => f.ledger.deleteHistory(recordA.id), { message: waitMessage });
  const card = f.ledger.reuseHistory(recordA.id).cardId;
  assert.deepEqual(f.ledger.deleteCard(card), { deleted: false, message: waitMessage });
  f.inUse.clear(); assert.equal(f.ledger.deleteCard(card).deleted, true);
  assert.equal(fs.existsSync(a), false); assert.equal(fs.existsSync(srt), false);
});

test('unrecorded queue deletion is scoped and clear History retains its global guard', t => {
  const f = fixture(t), a = f.file('a.mp4'), b = f.file('b.mp4');
  const ca = f.ledger.register({ path: a }, f.root), cb = f.ledger.register({ path: b }, f.root);
  f.history.add(historyInput(a)); f.inUse.add(a);
  assert.equal(f.ledger.deleteCard(cb).deleted, true);
  assert.deepEqual(f.ledger.deleteCard(ca), { deleted: false, message: waitMessage });
  assert.throws(() => f.ledger.clearHistory(), /Wait for active/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'media');
});

test('host tracks outstanding handoffs and FIFO normal/retry preparations through output publication', async t => {
  const f = fixture(t), releases = [], worker = { isActive: () => false, dispose() {}, cancel() {}, prepare: request => new Promise(resolve => releases.push(() => resolve({ filePath: `${request.inputPath}.out.mp4`, fileName: 'out.mp4' }))) };
  const host = await startHost(t, f, worker);
  const transfer = deferred(), commit = deferred();
  const handoff = host.handoff(() => transfer.promise, ['handoff.mp4', 'handoff.srt']);
  assert.deepEqual([...host.mediaPathsInUse()].sort(), ['handoff.mp4', 'handoff.srt']);
  const run = name => host.operation(async () => { const result = await host.prepareMedia({ jobId: name, inputPath: name, source: { path: `${name}-source` }, subtitlePath: `${name}.srt`, profile: 'fast', emit() {} }); await commit.promise; return result; });
  const first = run('normal'), second = run('history-retry'); await tick();
  assert.deepEqual([...host.mediaPathsInUse()].sort(), ['handoff.mp4', 'handoff.srt', 'history-retry', 'history-retry-source', 'history-retry.srt', 'normal', 'normal-source', 'normal.srt']);
  releases.shift()(); await tick();
  assert.equal(host.mediaPathsInUse().has('normal.out.mp4'), true);
  assert.equal(host.mediaPathsInUse().has('history-retry'), true);
  releases.shift()(); await tick();
  assert.equal(host.mediaPathsInUse().has('history-retry.out.mp4'), true);
  transfer.resolve(); await handoff; commit.resolve(); await Promise.all([first, second]);
  assert.deepEqual([...host.mediaPathsInUse()], []);
});

test('findings section 4 reproduction uses the real media preparer while unrelated History deletion succeeds', async t => {
  const f = fixture(t), source = f.file('source.mkv'), unrelated = f.file('unrelated.mp4');
  const sourceRecord = f.history.add(historyInput(source)), other = f.history.add(historyInput(unrelated));
  const entered = deferred(); let release, probes = 0;
  const worker = createMediaPrep({ ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe', spawn: (_binary, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    const finish = () => {
      if (args.includes('-show_streams')) {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ streams: [
          { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '10' },
          { codec_type: 'audio', codec_name: 'aac', duration: '10' },
        ], format: { format_name: ++probes === 1 ? 'matroska,webm' : 'mov,mp4', duration: '10', tags: { major_brand: 'isom' } } })));
      } else fs.writeFileSync(args.at(-1), 'prepared');
      child.emit('close', 0);
    };
    queueMicrotask(() => { if (probes === 0 && args.includes('-show_streams')) { release = finish; entered.resolve(); } else finish(); });
    return child;
  } });
  const host = await startHost(t, f, worker);
  const ledger = new DownloadLedger(f.history, () => host.mediaInUse(), () => host.mediaPathsInUse());
  const work = host.operation(() => host.prepareMedia({ jobId: 'conversion', inputPath: source, allowedRoot: f.root, preserveSource: true, profile: 'fast', emit() {} }));
  await entered.promise;
  try {
    assert.equal(ledger.deleteHistory(other.id).deleted, true);
    assert.throws(() => ledger.deleteHistory(sourceRecord.id), { message: waitMessage });
  } finally { release(); await work; }
  assert.equal(ledger.deleteHistory(sourceRecord.id).deleted, true);
});

test('Resolve use persists with its first timestamp, upgrades drag, and exposes only a boolean', t => {
  const f = fixture(t), media = f.file('sent.mp4'), record = f.history.add(historyInput(media));
  assert.equal(record.sentToResolve, false);
  f.history.noteResolveUse(media, 'drag');
  const first = JSON.parse(fs.readFileSync(f.store)).records[0].resolveUse;
  assert.equal(first.via, 'drag'); assert.equal(typeof first.at, 'number');
  f.history.noteResolveUse(media, 'timeline'); f.history.noteResolveUse(media, 'drag');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.store)).records[0].resolveUse, { at: first.at, via: 'timeline' });
  const reloaded = new DownloadHistory(f.store, f.root); t.after(() => reloaded.dispose());
  assert.equal(reloaded.get(record.id).sentToResolve, true);
  assert.equal('resolveUse' in reloaded.get(record.id), false);
  reloaded.noteResolveUse(media, 'drag');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.store)).records[0].resolveUse, { at: first.at, via: 'timeline' });
});

test('loader drops invalid Resolve use and accepts legacy History', t => {
  const f = fixture(t), record = f.history.add(historyInput(f.file('sent.mp4')));
  for (const resolveUse of [undefined, null, { at: 'bad', via: 'import' }, { at: -1, via: 'drag' }, { at: 1, via: 'other' }, { at: 1, via: 'import' }]) {
    const data = JSON.parse(fs.readFileSync(f.store)); data.records[0].resolveUse = resolveUse; fs.writeFileSync(f.store, JSON.stringify(data));
    const reloaded = new DownloadHistory(f.store, f.root); t.after(() => reloaded.dispose());
    assert.equal(reloaded.get(record.id).sentToResolve, resolveUse?.via === 'import' && resolveUse?.at === 1);
    reloaded.reuse(record.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store)).records[0].resolveUse, resolveUse?.at === 1 && resolveUse?.via === 'import' ? resolveUse : undefined);
  }
});

test('successful import/timeline IPC marks History; failed handoffs do not', async t => {
  const f = await mainFixture(t); const result = await download(f);
  const invokeTransfer = async channel => f.invoke(channel, result.cardId, 'active', 'end');
  assert.equal((await f.invoke('historyList'))[0].sentToResolve, false);
  const imported = await invokeTransfer('importToMediaPool'); assert.equal(imported.ok, true);
  assert.equal((await f.invoke('historyList'))[0].sentToResolve, true);
  assert.equal((await invokeTransfer('addToTimeline')).ok, true);
  let noted = 0;
  const handlers = createMainTransferHandlers({ requireSender() {}, resolveCard: () => ({ path: 'clip.mp4' }), transfer: { importToMediaPool: async () => ({ ok: false, message: 'failed' }) }, noteResolveUse: () => { noted++; } });
  await handlers.importToMediaPool({}, 'card', 'active'); assert.equal(noted, 0);
});

test('native History drag reproduction promotes its passive card and protects media plus subtitle for the session', async t => {
  const f = fixture(t), media = f.file('drag.mp4'), subtitle = f.file('drag.srt');
  const record = f.history.add({ ...historyInput(media), subtitle: { filePath: subtitle } });
  const card = f.ledger.listHistory()[0].cardId;
  assert.deepEqual(f.ledger.protectedPaths(), []);
  const handlers = createMainTransferHandlers({ requireSender() {}, resolveCard: id => f.ledger.resolve(id), transfer: {}, noteNativeDrag() {}, noteResolveUse: (id, via) => f.ledger.noteResolveUse(id, via) });
  handlers.nativeDragStart({}, card, file => { assert.equal(file, media); assert.deepEqual(new Set(f.ledger.protectedPaths()), new Set([media, subtitle])); });
  assert.equal(f.history.get(record.id).sentToResolve, true);
  assert.equal(f.ledger.resolve(card).passive, false);
  assert.equal((await inspectWorkspaceAsync(f.root, f.ledger.cleanupProtectedPaths())).cleanupFileCount, 0);
  assert.notEqual(f.ledger.listHistory()[0].cardId, card);
  assert.equal(f.ledger.clearHistory(), 1);
  assert.equal(f.ledger.resolve(card).historyId, undefined);
  assert.deepEqual(new Set(f.ledger.protectedPaths()), new Set([media, subtitle]));
});

test('sent files remain explicitly deletable from History and queue', t => {
  const f = fixture(t);
  for (const surface of ['history', 'queue']) {
    const media = f.file(`${surface}.mp4`), record = f.history.add(historyInput(media));
    f.history.noteResolveUse(media, 'import');
    const result = surface === 'history' ? f.ledger.deleteHistory(record.id) : f.ledger.deleteCard(f.ledger.reuseHistory(record.id).cardId);
    assert.equal(result.deleted, true); assert.equal(fs.existsSync(media), false);
  }
});

test('single History and queue confirmations append the exact offline warning; bulk counts sent selections', async () => {
  const h = await historyHarness([rowRecord('sent', { sentToResolve: true }), rowRecord('plain')]);
  const confirms = []; h.window.confirm = text => { confirms.push(text); return false; };
  find(h.elements.get('history-list').children[0], 'Delete').click(); await h.flush();
  assert.equal(confirms[0], 'Remove sent.mp4 from history? A ClipDock-managed file is deleted only when it is safe and no other record uses it.' + offline);
  h.test.deleteQueueFile({ queueId: 'finished', status: 'completed', cardId: 'card-sent', sentToResolve: true }); await h.flush();
  assert.equal(confirms[1], 'Only a safe ClipDock-managed file will be deleted from your computer. This action cannot be undone. Continue?' + offline);
  const all = h.elements.get('history-select-all'); all.checked = true; all.listeners.change();
  h.elements.get('history-delete-selected-btn').click();
  assert.ok(h.elements.get('history-delete-summary').textContent.endsWith(' 1 of these was sent to DaVinci Resolve. Deleting its file takes that clip offline there.'));
  const plural = await historyHarness([rowRecord('sent-a', { sentToResolve: true }), rowRecord('sent-b', { sentToResolve: true }), rowRecord('plain')]);
  const selectAll = plural.elements.get('history-select-all'); selectAll.checked = true; selectAll.listeners.change();
  plural.elements.get('history-delete-selected-btn').click();
  assert.ok(plural.elements.get('history-delete-summary').textContent.endsWith(' 2 of these were sent to DaVinci Resolve. Deleting their files takes those clips offline there.'));
});

test('bulk deletion applies in-use refusal per record and continues with unrelated records', async t => {
  const f = fixture(t), media = f.file('busy.mp4'), other = f.file('idle.mp4');
  const busy = f.history.add(historyInput(media)), idle = f.history.add(historyInput(other)); f.inUse.add(media);
  const h = await historyHarness(f.ledger.listHistory()); h.api.historyDelete = async id => f.ledger.deleteHistory(id);
  const all = h.elements.get('history-select-all'); all.checked = true; all.listeners.change();
  h.elements.get('history-delete-selected-btn').click(); h.elements.get('history-delete-confirm').click(); await h.flush();
  assert.equal(f.history.get(busy.id).available, true); assert.equal(f.history.get(idle.id), null);
  assert.equal(fs.existsSync(other), false); assert.match(h.elements.get('message').textContent, /1 deleted/);
});

test('cleanup excludes persisted Resolve-use files and companions from candidates after restart', async t => {
  const f = fixture(t), media = f.file('sent.mp4'), subtitle = f.file('sent.srt'), other = f.file('old.mp4');
  f.history.add({ ...historyInput(media), subtitle: { filePath: subtitle } }); f.history.add(historyInput(other));
  f.history.noteResolveUse(media, 'drag');
  const reloaded = new DownloadHistory(f.store, f.root); t.after(() => reloaded.dispose());
  const ledger = new DownloadLedger(reloaded, () => false, () => new Set());
  assert.equal((await inspectWorkspaceAsync(f.root, ledger.cleanupProtectedPaths())).cleanupFileCount, 1);
  assert.equal((await cleanupWorkspaceAsync(f.root, ledger.cleanupProtectedPaths())).deletedFileCount, 1);
  assert.equal(fs.existsSync(media), true); assert.equal(fs.existsSync(subtitle), true); assert.equal(fs.existsSync(other), false);
});
