// Adversarial release contracts, written without consulting the three feature suites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {PendingArtifacts} from '../dist/pending-artifacts.js';
import {createEngineHost} from '../dist/engine-host.js';
import {createHistoryPreparationHandlers, createMainTransferHandlers, createProviderDownloadHandlers, recoverPendingArtifacts, resolveMainProcessCard, serializeMediaPreparation} from '../dist/main-process.js';
import {ProviderJobCancelledError} from '../dist/provider-job.js';
import {claimDownloadFolder} from '../dist/settings.js';
import {cleanupWorkspace, inspectWorkspace} from '../dist/workspace.js';
import {deferred, historyInput, mainFixture} from './helpers/files-main.mjs';
import {createHarness} from './helpers/renderer-harness.mjs';

const IN_USE = 'This file is being used by a transfer or conversion. Wait for it to finish.';
function emptyRoot(folder) {
  fs.mkdirSync(folder, {recursive: true}); return ManagedRoot.capture(folder);
}
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-034-refute-')));
  const root = ManagedRoot.prepare(path.join(dir, 'active'));
  const store = path.join(dir, 'data', 'history.json'), journalFile = path.join(dir, 'data', 'pending-artifacts.json');
  const history = new DownloadHistory(store, root), pending = new PendingArtifacts(journalFile);
  const ledger = new DownloadLedger(history, () => false, () => new Set());
  const file = (name, bytes = 'source', folder = root.verify()) => {
    const target = path.join(folder, name); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes); return target;
  };
  const open = (active = root, defaultFolder) => {
    const h = new DownloadHistory(store, active, undefined, undefined, defaultFolder); t.after(() => h.dispose()); return h;
  };
  const disk = () => JSON.parse(fs.readFileSync(store, 'utf8'));
  t.after(async () => { await history.dispose(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, root, store, journalFile, history, pending, ledger, file, open, disk};
}
const downloadEntry = (f, file, extra = {}) => ({id: 'download-crash', kind: 'download', path: file, trustedRoot: f.root.verify(), record: historyInput(file), ...extra});
const retryEntry = (id, source, output, entryId = 'retry-crash') => ({id: entryId, kind: 'retry', historyId: id, sourcePath: source, outputPath: output});
function replay(f, history = f.history) {
  recoverPendingArtifacts(history, new PendingArtifacts(f.journalFile));
  return new PendingArtifacts(f.journalFile).list();
}
function retryHandlers(f, overrides = {}) {
  return createHistoryPreparationHandlers({history: f.history, pendingArtifacts: f.pending,
    prepareMedia: async () => { const filePath = f.file('converted.mp4', 'converted'); return {filePath, fileName: 'converted.mp4'}; },
    cancelMediaPreparation: () => null, protectedPaths: () => f.ledger.protectedPaths(),
    replaced: (id, preparedId) => f.ledger.bindHistory(id, preparedId), ...overrides});
}

for (const mode of ['unmarked', 'directory marker', 'wrong marker', 'symlink marker', 'symlink root', 'nested unmarked']) {
  test(`A: ${mode} provenance stays external for delete and retry`, async t => {
    const f = fixture(t), other = emptyRoot(path.join(f.dir, 'former'));
    if (mode === 'nested unmarked') claimDownloadFolder(other);
    let folder = mode === 'nested unmarked' ? path.join(other.verify(), 'nested') : other.verify();
    fs.mkdirSync(folder, {recursive: true});
    if (mode === 'directory marker') fs.mkdirSync(path.join(folder, '.clipdock-owned'));
    if (mode === 'wrong marker') fs.writeFileSync(path.join(folder, '.clipdock-owned'), 'ClipDock');
    if (mode === 'symlink marker') {
      const marker = f.file('marker', 'ClipDock managed download folder\n', f.dir);
      fs.symlinkSync(marker, path.join(folder, '.clipdock-owned'));
    }
    const media = f.file('former.mkv', 'keep', folder);
    const record = f.history.add({...historyInput(media), preparationFailed: {profile: 'fast'}});
    const stored = f.disk(); stored.records[0].managed = true; stored.records[0].trustedRoot = folder;
    if (mode === 'symlink root') {
      const alias = path.join(f.dir, 'alias'); fs.symlinkSync(folder, alias);
      stored.records[0].trustedRoot = alias; stored.records[0].filePath = path.join(alias, 'former.mkv');
    }
    fs.writeFileSync(f.store, JSON.stringify(stored)); const before = fs.readFileSync(f.store, 'utf8');
    const h = f.open(); assert.equal(fs.readFileSync(f.store, 'utf8'), before, 'startup must not rewrite provenance');
    assert.equal(h.resolve(record.id)?.trustedRoot, undefined);
    let prepared = 0;
    await assert.rejects(retryHandlers({...f, history: h}, {prepareMedia: async () => { prepared++; }}).retryPreparation(record.id), /existing managed file/);
    assert.equal(prepared, 0); assert.equal(fs.readFileSync(f.store, 'utf8'), before);
    assert.equal(h.delete(record.id, []).deleted, false); assert.equal(fs.readFileSync(media, 'utf8'), 'keep');
  });
}
for (const mode of ['active', 'default', 'marked', 'marked nested']) {
  test(`A: ${mode} root admits deletion after restart`, t => {
    const f = fixture(t), former = emptyRoot(path.join(f.dir, 'former'));
    let folder = mode === 'active' ? f.root.verify() : former.verify();
    if (mode === 'marked nested') { folder = path.join(folder, 'nested'); fs.mkdirSync(folder); }
    if (mode.startsWith('marked')) claimDownloadFolder(ManagedRoot.capture(folder));
    const media = f.file('clip.mp4', 'owned', folder), record = f.history.add(historyInput(media));
    const stored = f.disk(); stored.records[0].managed = true; stored.records[0].trustedRoot = folder; fs.writeFileSync(f.store, JSON.stringify(stored));
    const h = f.open(f.root, mode === 'default' ? folder : undefined);
    assert.equal(h.resolve(record.id)?.trustedRoot?.verify(), folder);
    assert.equal(h.delete(record.id, []).deleted, true); assert.equal(fs.existsSync(media), false);
  });
}
test('A: a root absent at startup stays external until a later session after it returns', t => {
  const f = fixture(t), former = emptyRoot(path.join(f.dir, 'former')); claimDownloadFolder(former);
  const media = f.file('clip.mkv', 'keep', former.verify()); const r = f.history.add(historyInput(media));
  const data = f.disk(); data.records[0].managed = true; data.records[0].trustedRoot = former.verify(); fs.writeFileSync(f.store, JSON.stringify(data));
  const folder = former.verify(), away = `${folder}.away`; fs.renameSync(folder, away);
  const h = f.open(), before = fs.readFileSync(f.store, 'utf8'); fs.renameSync(away, folder);
  assert.equal(h.resolve(r.id)?.trustedRoot, undefined); h.reuse(r.id);
  assert.equal(f.disk().records[0].trustedRoot, folder, 'an unrelated save retains stored provenance');
  const restarted = f.open(); assert.equal(restarted.resolve(r.id)?.trustedRoot?.verify(), folder);
  assert.ok(before.includes(folder)); assert.equal(h.delete(r.id, []).deleted, false); assert.equal(fs.existsSync(media), true);
});
test('A: a captured root that vanishes and returns with the same identity remains usable', t => {
  const f = fixture(t), media = f.file('clip.mp4'), r = f.history.add(historyInput(media));
  const folder = f.root.verify(); fs.renameSync(folder, `${folder}.away`); assert.equal(f.history.resolve(r.id), null);
  fs.renameSync(`${folder}.away`, folder); assert.equal(f.history.resolve(r.id)?.path, media);
  assert.equal(f.history.delete(r.id, []).deleted, true);
});
test('A: replacing an absent root at the same path never grants deletion authority', t => {
  const f = fixture(t), media = f.file('clip.mp4'), r = f.history.add(historyInput(media)), folder = f.root.verify();
  fs.renameSync(folder, `${folder}.away`); fs.mkdirSync(folder); f.file('clip.mp4', 'replacement', folder);
  assert.equal(f.history.resolve(r.id), null); assert.equal(f.history.delete(r.id, []).deleted, false);
  assert.equal(fs.readFileSync(media, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(path.join(`${folder}.away`, 'clip.mp4'), 'utf8'), 'source');
});

for (const state of ['source before preparation', 'prepared before history', 'history committed', 'file missing']) {
  test(`B: download crash at ${state} recovers once and drains the journal`, t => {
    const f = fixture(t), source = f.file('source.mkv'); let entry = downloadEntry(f, source, {requestedProfile: 'fast'});
    if (state === 'prepared before history') entry = {...entry, path: f.file('prepared.mp4', 'ready'), requestedProfile: undefined, record: {...entry.record, profile: 'fast'}};
    if (state === 'history committed') f.history.add(historyInput(source));
    if (state === 'file missing') fs.unlinkSync(source);
    f.pending.put(entry); assert.deepEqual(replay(f), []);
    assert.equal(f.history.list().length, state === 'file missing' ? 0 : 1);
    if (state !== 'file missing') {
      const r = f.history.list()[0]; assert.equal(f.history.resolve(r.id)?.path, entry.path);
      assert.equal(r.profile, state === 'prepared before history' ? 'fast' : 'original');
      assert.deepEqual(r.preparationFailed, state === 'source before preparation' ? {profile: 'fast'} : undefined);
    }
    assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, state === 'file missing' ? 0 : 1);
  });
}
for (const kind of ['download', 'retry rollback', 'retry finish']) {
  test(`B: ${kind} recovery cannot touch a file outside the admitted root`, t => {
    const f = fixture(t), outside = f.file('outside.mp4', 'precious', f.dir), source = f.file('source.mkv');
    if (kind === 'download') f.pending.put(downloadEntry(f, outside));
    else {
      const r = f.history.add(historyInput(source));
      f.pending.put(kind === 'retry rollback' ? retryEntry(r.id, source, outside) : retryEntry(r.id, outside, source));
    }
    assert.deepEqual(replay(f), []); assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
    assert.equal(f.history.list().length, kind === 'download' ? 0 : 1);
  });
}
test('B: a download journal cannot admit an arbitrary unmarked trustedRoot', t => {
  const f = fixture(t), folder = path.join(f.dir, 'unowned'); fs.mkdirSync(folder);
  const media = f.file('clip.mp4', 'precious', folder); f.pending.put(downloadEntry(f, media, {trustedRoot: folder}));
  assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, 0); assert.equal(fs.readFileSync(media, 'utf8'), 'precious');
});
test('B: recovery rejects a symlinked descendant even inside an admitted root', t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  const media = f.file('clip.mp4', 'precious', outside), link = path.join(f.root.verify(), 'alias'); fs.symlinkSync(outside, link);
  f.pending.put(downloadEntry(f, path.join(link, 'clip.mp4'))); assert.deepEqual(replay(f), []);
  assert.equal(f.history.list().length, 0); assert.equal(fs.readFileSync(media, 'utf8'), 'precious');
});
test('B: duplicate download paths yield one record, including across a second recovery', t => {
  const f = fixture(t), media = f.file('clip.mp4');
  f.pending.put(downloadEntry(f, media)); f.pending.put(downloadEntry(f, media, {id: 'second'}));
  assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, 1);
  assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, 1);
});
for (const committed of [false, true]) {
  test(`B: retry crash ${committed ? 'after' : 'before'} History commit ${committed ? 'finishes' : 'rolls back'} safely`, t => {
    const f = fixture(t), source = f.file('source.mkv'), output = f.file('output.mp4', 'converted');
    const r = f.history.add({...historyInput(source), preparationFailed: {profile: 'fast'}});
    if (committed) assert.equal(f.history.replacePreparedArtifact(r.id, {filePath: output, profile: 'fast'}).id, r.id);
    f.pending.put(retryEntry(r.id, source, output)); assert.deepEqual(replay(f), []);
    assert.equal(fs.existsSync(source), !committed); assert.equal(fs.existsSync(output), committed);
    assert.equal(f.history.resolve(r.id)?.path, committed ? output : source); assert.deepEqual(replay(f), []);
  });
}
for (const committed of [false, true]) {
  test(`B: retry journal after ${committed ? 'source' : 'output'} removal drains duplicate entries idempotently`, t => {
    const f = fixture(t), source = f.file('source.mkv'), output = f.file('output.mp4');
    const r = f.history.add(historyInput(committed ? output : source)); fs.unlinkSync(committed ? source : output);
    f.pending.put(retryEntry(r.id, source, output)); f.pending.put(retryEntry(r.id, source, output, 'duplicate'));
    assert.deepEqual(replay(f), []); assert.deepEqual(replay(f), []);
    assert.equal(f.history.resolve(r.id)?.path, committed ? output : source); assert.equal(fs.readFileSync(committed ? output : source, 'utf8'), 'source');
  });
}
test('B: an already deleted download is not resurrected by its stale journal', t => {
  const f = fixture(t), media = f.file('clip.mp4'), r = f.history.add(historyInput(media)); f.pending.put(downloadEntry(f, media));
  assert.equal(f.history.delete(r.id, []).deleted, true); assert.deepEqual(replay(f), []);
  assert.equal(f.history.list().length, 0); assert.equal(fs.existsSync(media), false);
});
test('B: retry recovery preserves an output referenced by a second record', t => {
  const f = fixture(t), source = f.file('source.mkv'), output = f.file('output.mp4');
  const original = f.history.add(historyInput(source)), other = f.history.add(historyInput(output));
  f.pending.put(retryEntry(original.id, source, output)); assert.deepEqual(replay(f), []);
  assert.equal(fs.existsSync(output), true); assert.equal(f.history.get(other.id).available, true);
});
test('B: deleting a retry record before recovery never resurrects it or deletes an unrelated file', t => {
  const f = fixture(t), source = f.file('source.mkv'), output = f.file('output.mp4');
  const r = f.history.add(historyInput(source)); f.pending.put(retryEntry(r.id, source, output)); f.history.delete(r.id, [source]);
  assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, 0);
  assert.equal(fs.existsSync(source), true); assert.equal(fs.existsSync(output), true);
});
test('B: a corrupt journal is quarantined and subsequent entries remain writable', t => {
  const f = fixture(t); fs.writeFileSync(f.journalFile, '{broken'); const pending = new PendingArtifacts(f.journalFile);
  assert.deepEqual(pending.list(), []); assert.ok(fs.readdirSync(path.dirname(f.journalFile)).some(name => name.startsWith('pending-artifacts.json.corrupt-')));
  pending.put(downloadEntry(f, f.file('clip.mp4'))); assert.deepEqual(replay(f), []); assert.equal(f.history.list().length, 1);
});
test('B: one failed recovery commit does not prevent another entry or startup', t => {
  const f = fixture(t), first = f.file('first.mp4'), second = f.file('second.mp4');
  f.pending.put(downloadEntry(f, first)); f.pending.put(downloadEntry(f, second, {id: 'second'}));
  const add = f.history.addRecovered.bind(f.history);
  t.mock.method(f.history, 'addRecovered', (input, root) => { if (input.filePath === first) throw new Error('injected commit failure'); return add(input, root); });
  assert.deepEqual(replay(f).map(e => e.id), ['download-crash']); assert.equal(f.history.list().length, 1);
  assert.equal(f.history.resolve(f.history.list()[0].id)?.path, second); assert.equal(fs.existsSync(first), true);
});
test('B: actual main startup recovers before serving History IPC', async t => {
  const f = await mainFixture(t, {setup({root, userData}) {
    fs.mkdirSync(root, {recursive: true}); const media = path.join(root, 'crashed.mkv'); fs.writeFileSync(media, 'source');
    new PendingArtifacts(path.join(userData, 'pending-artifacts.json')).put({id: 'boot', kind: 'download', path: media, trustedRoot: root, record: historyInput(media), requestedProfile: 'editing'});
  }});
  const records = await f.invoke('historyList'); assert.equal(records.length, 1); assert.deepEqual(records[0].preparationFailed, {profile: 'editing'});
  assert.deepEqual(new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list(), []); f.quit();
});

function providerFixture(t, mode) {
  const f = fixture(t), entered = deferred(), release = deferred(); let downloaded;
  const handlers = createProviderDownloadHandlers({ffprobeAvailable: true, cancelMediaPreparation: () => {release.resolve(); return null;}, registerSubtitle: () => ({cardId: 'subtitle'}),
    youtube: {emit() {}, worker: {metadata: async () => ({id: 'dQw4w9WgXcQ', title: 'Clip', channel: 'Creator', duration: 10, chapters: []}), cancel() {release.resolve();},
      download: async () => { downloaded = f.file('download.mkv'); return {filePath: downloaded, fileName: 'download.mkv'}; }}},
    completion: {pendingArtifacts: f.pending, artifactRoot: () => f.root, isSafeMediaFile: file => f.root.resolve(file) === file,
      prepareMedia: async request => {
        entered.resolve(); await release.promise;
        if (mode === 'conversion failure') throw new Error('injected conversion failure');
        if (mode === 'conversion cancel') throw new ProviderJobCancelledError('cancelled');
        const filePath = f.file('prepared.mp4', 'prepared'); return {filePath, fileName: 'prepared.mp4'};
      },
      refreshHistoryProject: async () => { if (mode !== 'conversion failure' && mode !== 'conversion cancel') { entered.resolve(); await release.promise; } },
      recordHistory: input => {
        if (mode === 'prepared') {
          const [entry] = new PendingArtifacts(f.journalFile).list(); assert.equal(entry.path, input.filePath); assert.equal(entry.record.profile, 'fast'); assert.equal(entry.requestedProfile, undefined);
        }
        return mode === 'history failure' ? {record: null, warning: 'History write failed'} : f.ledger.record(input);
      },
      registerCard: card => f.ledger.register(card, f.root),
    }});
  t.after(() => handlers.shutdown());
  const start = () => handlers.youtube({sender: {}}, historyInput('').source, 'best', mode.startsWith('conversion') || mode === 'prepared' ? 'fast' : 'original', 'flow', {mediaMode: 'video', audioFormat: 'wav', subtitles: false, subtitleLanguage: 'en'});
  return {...f, handlers, entered, release, start, downloaded: () => downloaded};
}
for (const mode of ['original', 'prepared', 'conversion failure', 'conversion cancel', 'host wait cancel', 'history failure', 'journal write failure']) {
  test(`B: ${mode} download leaves no journal after settling`, async t => {
    const f = providerFixture(t, mode);
    if (mode === 'journal write failure') t.mock.method(f.pending, 'put', () => {throw new Error('injected journal ENOSPC');});
    const work = f.start(); const settled = work.then(value => ({value}), error => ({error})); await f.entered.promise;
    if (mode !== 'journal write failure') {
      const entries = new PendingArtifacts(f.journalFile).list(); assert.equal(entries.length, 1, 'registered file is journaled before History commit');
      assert.equal(entries[0].path, f.downloaded());
    }
    if (mode === 'host wait cancel') f.handlers.cancel('flow');
    f.release.resolve(); const result = await settled;
    if (mode.includes('cancel') || mode === 'conversion failure') assert.ok(result.error);
    else assert.equal(typeof result.value?.cardId, 'string');
    assert.deepEqual(new PendingArtifacts(f.journalFile).list(), []);
    if (mode === 'journal write failure') assert.equal(f.history.list().length, 1);
  });
}
for (const state of ['success', 'commit failure', 'cancel after output']) {
  test(`B: retry ${state} journals output through commit and drains on settlement`, async t => {
    const f = fixture(t), source = f.file('source.mkv'), r = f.history.add({...historyInput(source), preparationFailed: {profile: 'fast'}});
    const entered = deferred(), release = deferred(); let output, observed;
    const replace = f.history.replacePreparedArtifact.bind(f.history);
    t.mock.method(f.history, 'replacePreparedArtifact', (...args) => {
      observed = new PendingArtifacts(f.journalFile).list(); if (state === 'commit failure') throw new Error('commit failed'); return replace(...args);
    });
    const handlers = retryHandlers(f, {prepareMedia: async () => { output = f.file('converted.mp4'); entered.resolve(); await release.promise; return {filePath: output, fileName: 'converted.mp4'}; }});
    const work = handlers.retryPreparation(r.id).then(value => ({value}), error => ({error})); await entered.promise;
    if (state === 'cancel after output') await handlers.cancelPreparation(r.id);
    release.resolve(); const result = await work;
    if (state === 'commit failure') assert.match(result.error.message, /commit failed/);
    else assert.equal(result.value.cancelled, state === 'cancel after output');
    if (state !== 'cancel after output') { assert.equal(observed.length, 1); assert.equal(observed[0].sourcePath, source); assert.equal(observed[0].outputPath, output); }
    assert.deepEqual(new PendingArtifacts(f.journalFile).list(), []); assert.equal(fs.existsSync(output), state === 'success');
    assert.equal(fs.existsSync(source), state !== 'success');
  });
}

async function scopedHost(t, f) {
  const gates = new Map(), started = [];
  const worker = () => ({isActive: () => false, isDownloading: () => false, dispose() {}, cancel() {}, setRoot() {}, setSessionDir() {}});
  const raw = {...worker(), prepare: request => {started.push(request.jobId); const gate = deferred(); gates.set(request.jobId, gate); return gate.promise;}};
  const prep = serializeMediaPreparation(raw);
  const host = createEngineHost({folder: f.root.verify(), runtimeRoot: path.join(f.dir, 'runtime'), workers: {youtube: worker, pinterest: worker, pexels: worker, pixabay: worker, mediaPrep: () => prep}, completion: {}, registerSubtitle() {}, emit() {}, restoreCredential: async () => {}});
  await host.start(Promise.resolve({})); t.after(() => host.dispose());
  const ledger = new DownloadLedger(f.history, () => host.mediaInUse(), () => host.mediaPathsInUse());
  return {host, ledger, gates, started, cancelPreparation: id => prep.cancel(id)};
}
for (const target of ['history', 'queue', 'unrecorded']) {
  test(`C: waiting preparation blocks only the matching ${target} file including subtitles`, async t => {
    const f = fixture(t), s = await scopedHost(t, f), first = f.file('first.mp4'), media = f.file('waiting.mp4'), subtitle = f.file('waiting.srt', 'captions'), idle = f.file('idle.mp4');
    let id, card;
    if (target !== 'unrecorded') id = s.ledger.record({...historyInput(media), subtitle: {filePath: subtitle}}).record.id;
    else s.ledger.record({...historyInput(media), subtitle: {filePath: subtitle}}); // Remember the companion, then remove metadata only.
    if (target === 'unrecorded') f.history.clear();
    card = s.ledger.register({path: media, historyId: id}, f.root);
    const idleId = f.history.add(historyInput(idle)).id;
    const a = s.host.prepareMedia({jobId: 'current', inputPath: first, emit() {}});
    const b = s.host.prepareMedia({jobId: 'waiting', inputPath: subtitle, emit() {}}); const cancelled = assert.rejects(b, /cancelled/);
    try {
      assert.deepEqual(s.started, ['current']); assert.equal(s.host.mediaPathsInUse().has(subtitle), true);
      if (target === 'history') assert.throws(() => s.ledger.deleteHistory(id), {message: IN_USE});
      else assert.deepEqual(s.ledger.deleteCard(card), {deleted: false, message: IN_USE});
      assert.equal(fs.readFileSync(media, 'utf8'), 'source'); assert.equal(fs.readFileSync(subtitle, 'utf8'), 'captions');
      assert.equal(s.ledger.deleteHistory(idleId).deleted, true); assert.equal(fs.existsSync(idle), false);
      assert.throws(() => s.ledger.clearHistory(), /Wait for active/);
    } finally { await s.cancelPreparation('waiting'); s.gates.get('current').resolve({filePath: first, fileName: 'first.mp4'}); await a; await cancelled; }
  });
}
test('C: outstanding handoff blocks every record sharing its file and releases after settlement', async t => {
  const f = fixture(t), s = await scopedHost(t, f), media = f.file('shared.mp4'), idle = f.file('idle.mp4');
  const a = f.history.add(historyInput(media)), b = f.history.add(historyInput(media)), c = f.history.add(historyInput(idle));
  const gate = deferred(), work = s.host.handoff(() => gate.promise, [media]);
  try {
    for (const r of [a, b]) assert.throws(() => s.ledger.deleteHistory(r.id), {message: IN_USE});
    assert.equal(s.ledger.deleteHistory(c.id).deleted, true); assert.throws(() => s.ledger.clearHistory(), /Wait for active/);
    await assert.rejects(s.host.changeFolder(async () => null, () => f.root), /Wait for active/);
  } finally {gate.resolve(); await work;}
  assert.equal(s.ledger.deleteHistory(a.id).deleted, false); assert.equal(fs.existsSync(media), true);
  assert.equal(s.ledger.deleteHistory(b.id).deleted, true); assert.equal(fs.existsSync(media), false);
});
test('C: current preparation blocks its media but allows unrelated deletion', async t => {
  const f = fixture(t), s = await scopedHost(t, f), media = f.file('current.mp4'), idle = f.file('idle.mp4');
  const r = f.history.add(historyInput(media)), other = f.history.add(historyInput(idle));
  const work = s.host.prepareMedia({jobId: 'current', inputPath: media, emit() {}});
  try {
    assert.throws(() => s.ledger.deleteHistory(r.id), {message: IN_USE}); assert.equal(s.ledger.deleteHistory(other.id).deleted, true);
    assert.equal(fs.readFileSync(media, 'utf8'), 'source');
  } finally {s.gates.get('current').resolve({filePath: media, fileName: 'current.mp4'}); await work;}
  assert.equal(s.ledger.deleteHistory(r.id).deleted, true);
});
test('C: real IPC handoff protects a shared subtitle while Cleanup and Clear keep global guards', async t => {
  const f = await mainFixture(t), history = f.controls.history;
  const media = path.join(f.root, 'clip.mp4'), other = path.join(f.root, 'other.mp4'), subtitle = path.join(f.root, 'clip.srt');
  for (const file of [media, other, subtitle]) fs.writeFileSync(file, 'source');
  const a = history.add({...historyInput(media), subtitle: {filePath: subtitle}}), b = history.add({...historyInput(other), subtitle: {filePath: subtitle}});
  const card = (await f.invoke('historyList')).find(record => record.id === a.id).cardId;
  const entered = deferred(), release = deferred(); f.controls.transfer = async () => {entered.resolve(); await release.promise; return {ok: true, kind: 'imported'};};
  const transfer = f.invoke('importToMediaPool', card, 'active'); await entered.promise;
  try {
    await assert.rejects(f.invoke('historyDelete', b.id), {message: IN_USE});
    await assert.rejects(f.invoke('historyClear'), /Wait for active/); await assert.rejects(f.invoke('cleanupWorkspace'), /Wait for active/);
    await assert.rejects(f.invoke('chooseDownloadFolder'), /Wait for active/); assert.equal(fs.existsSync(other), true);
  } finally {release.resolve(); await transfer; f.quit();}
});

for (const via of ['import', 'timeline', 'drag']) {
  test(`D: successful ${via} persists Resolve use through reload and relink`, async t => {
    const f = fixture(t), media = f.file('clip.mkv'), r = f.history.add(historyInput(media)); const card = f.ledger.listHistory()[0].cardId;
    const handlers = createMainTransferHandlers({requireSender() {}, resolveCard: id => resolveMainProcessCard(f.ledger, id),
      transfer: {importToMediaPool: async () => ({ok: true, kind: 'imported'}), addToTimeline: async () => ({ok: true, kind: 'timeline'})},
      noteResolveUse: (id, kind) => f.ledger.noteResolveUse(id, kind)});
    if (via === 'drag') { let dragged; handlers.nativeDragStart({}, card, file => {dragged = file;}); assert.equal(dragged, media); assert.ok(f.ledger.protectedPaths().includes(media)); }
    else assert.equal((await (via === 'import' ? handlers.importToMediaPool({}, card, 'active') : handlers.addToTimeline({}, card, 'active', 'end'))).ok, true);
    assert.equal(f.history.get(r.id).sentToResolve, true); assert.equal(f.disk().records[0].resolveUse.via, via);
    const restarted = f.open(); assert.equal(restarted.get(r.id).sentToResolve, true);
    const moved = f.file('relinked.mp4'); assert.equal(restarted.relink(r.id, moved).sentToResolve, true);
    assert.equal(f.open().get(r.id).sentToResolve, true);
  });
}
test('D: a failed handoff never marks the record sent', async t => {
  const f = await mainFixture(t); const media = path.join(f.root, 'clip.mp4'); fs.writeFileSync(media, 'source'); const r = f.controls.history.add(historyInput(media));
  const card = (await f.invoke('historyList'))[0].cardId; f.controls.transfer = async () => ({ok: false, kind: 'import-error', message: 'failed'});
  assert.equal((await f.invoke('importToMediaPool', card, 'active')).ok, false); assert.equal(f.controls.history.get(r.id).sentToResolve, false); f.quit();
});
test('D: History native drag keeps session protection after relisting and clearing metadata', t => {
  const f = fixture(t), media = f.file('clip.mp4'), subtitle = f.file('clip.srt'); f.history.add({...historyInput(media), subtitle: {filePath: subtitle}});
  const card = f.ledger.listHistory()[0].cardId;
  const handlers = createMainTransferHandlers({requireSender() {}, resolveCard: id => resolveMainProcessCard(f.ledger, id), transfer: {}, noteResolveUse: (id, via) => f.ledger.noteResolveUse(id, via)});
  let dragged; handlers.nativeDragStart({}, card, file => {dragged = file;}); assert.equal(dragged, media);
  f.ledger.listHistory(); assert.equal(f.ledger.clearHistory(), 1);
  assert.deepEqual(new Set(f.ledger.protectedPaths()), new Set([media, subtitle])); assert.equal(cleanupWorkspace(f.root, f.ledger.cleanupProtectedPaths()).deletedFileCount, 0);
  assert.equal(fs.existsSync(media), true); assert.equal(fs.existsSync(subtitle), true);
});
for (const protect of [false, true]) {
  test(`D: retry keeps a sent source and adds an unsent converted record ${protect ? 'with' : 'without'} an active card`, async t => {
    const f = fixture(t), media = f.file('clip.mkv'), r = f.history.add({...historyInput(media), preparationFailed: {profile: 'fast'}});
    f.history.noteResolveUse(media, 'import'); if (protect) f.ledger.reuseHistory(r.id);
    const resolveUse = f.disk().records.find(record => record.id === r.id).resolveUse;
    const result = await retryHandlers(f).retryPreparation(r.id);
    assert.deepEqual(result, {cancelled: false, profile: 'fast', originalKept: true});
    assert.equal(fs.readFileSync(media, 'utf8'), 'source');
    assert.equal(f.history.resolve(r.id)?.path, media); assert.equal(f.history.get(r.id).sentToResolve, true);
    assert.equal(f.history.list().length, 2);
    const converted = f.history.list().find(record => record.profile === 'fast'); assert.ok(converted);
    assert.notEqual(converted.id, r.id); assert.equal(converted.sentToResolve, false);
    assert.equal(fs.readFileSync(f.history.resolve(converted.id).path, 'utf8'), 'converted');
    const stored = f.disk().records;
    assert.deepEqual(stored.find(record => record.id === r.id).resolveUse, resolveUse);
    assert.equal('resolveUse' in stored.find(record => record.id === converted.id), false);
    const restarted = f.open(); assert.equal(restarted.resolve(r.id)?.path, media);
    assert.equal(restarted.get(r.id).sentToResolve, true); assert.equal(restarted.get(converted.id).sentToResolve, false);
    const ledger = new DownloadLedger(restarted, () => false);
    assert.ok(ledger.cleanupProtectedPaths().includes(media)); assert.equal(ledger.cleanupProtectedPaths().includes(restarted.resolve(converted.id).path), false);
  });
}
test('D: Cleanup excludes a sent record and subtitle after restart', t => {
  const f = fixture(t), media = f.file('clip.mp4'), subtitle = f.file('clip.srt'), idle = f.file('idle.mp4');
  f.history.add({...historyInput(media), subtitle: {filePath: subtitle}}); f.history.noteResolveUse(media, 'timeline');
  const ledger = new DownloadLedger(f.open(), () => false), protectedPaths = ledger.cleanupProtectedPaths();
  assert.equal(inspectWorkspace(f.root, protectedPaths).cleanupFileCount, 1); assert.equal(cleanupWorkspace(f.root, protectedPaths).deletedFileCount, 1);
  assert.equal(fs.existsSync(idle), false); assert.equal(fs.existsSync(media), true); assert.equal(fs.existsSync(subtitle), true);
});
test('B/D: retry crash recovery never removes a sent source still referenced by another record', t => {
  const f = fixture(t), source = f.file('clip.mkv'), output = f.file('converted.mp4');
  const sent = f.history.add(historyInput(source)); f.history.noteResolveUse(source, 'drag'); const converted = f.history.add(historyInput(output));
  f.pending.put(retryEntry(converted.id, source, output)); assert.deepEqual(replay(f), []);
  assert.equal(f.history.get(sent.id).sentToResolve, true); assert.equal(fs.readFileSync(source, 'utf8'), 'source');
});
test('D: bulk deletion warns for sent records and still allows their explicit deletion', async t => {
  const f = fixture(t), sentFile = f.file('sent.mp4'), idleFile = f.file('idle.mp4'); f.history.add(historyInput(sentFile)); f.history.add(historyInput(idleFile)); f.history.noteResolveUse(sentFile, 'import');
  const h = createHarness(); h.api.historyList = async () => f.ledger.listHistory(); h.api.historyDelete = async id => f.ledger.deleteHistory(id);
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  const all = h.elements.get('history-select-all'); all.checked = true; all.listeners.change(); h.elements.get('history-delete-selected-btn').click();
  assert.match(h.elements.get('history-delete-summary').textContent, /Resolve/); assert.equal(fs.existsSync(sentFile), true);
  h.elements.get('history-delete-confirm').click(); await h.flush();
  assert.equal(fs.existsSync(sentFile), false); assert.equal(fs.existsSync(idleFile), false); assert.equal(f.history.list().length, 0);
});
for (const geometry of [{name: 'up when it fits', top: 400, height: 200, expected: 200}, {name: 'down near the top', top: 20, height: 200, expected: 40}, {name: 'clamped near right edge', top: 20, height: 200, expected: 40}]) {
  test(`E: History menu ${geometry.name} stays inside the viewport`, async () => {
    const h = createHarness(); h.api.historyList = async () => [{id: 'row', provider: 'youtube', source: historyInput('').source, fileName: 'clip.mp4', title: 'Clip', createdAt: 1, bytes: 10, available: true}];
    await h.fireReady(); h.test.setSurface('library'); await h.flush();
    const row = h.elements.get('history-list').children[0], trigger = row.children.find(c => c.className === 'history-actions'), menu = row.children.find(c => c.className.includes('history-menu'));
    trigger.getBoundingClientRect = () => ({top: geometry.top, bottom: geometry.top + 20, right: 958});
    menu.getBoundingClientRect = () => ({height: geometry.height, width: 240}); trigger.click();
    const top = parseFloat(menu.style.top), left = parseFloat(menu.style.left);
    assert.equal(top, geometry.expected); assert.ok(top >= 0 && top + geometry.height <= h.window.innerHeight); assert.ok(left >= 0 && left + 240 <= h.window.innerWidth);
  });
}
