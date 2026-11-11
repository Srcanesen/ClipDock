import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PendingArtifacts } from '../dist/pending-artifacts.js';
import { DownloadHistory } from '../dist/history.js';
import { ManagedRoot } from '../dist/managed-root.js';
import { createHistoryPreparationHandlers, createProviderDownloadHandlers, recoverPendingArtifacts } from '../dist/main-process.js';
import { mainFixture, historyInput, deferred } from './helpers/files-main.mjs';
import { providerIpcFixture } from './helpers/provider-ipc.mjs';
import { claimDownloadFolder } from '../dist/settings.js';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-artifacts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const file = path.join(dir, 'pending-artifacts.json');
  const pending = new PendingArtifacts(file);
  const history = new DownloadHistory(path.join(dir, 'history.json'), root); t.after(() => history.dispose());
  const source = path.join(root.providerPath('youtube'), 'source.mkv'); fs.writeFileSync(source, 'source');
  const output = path.join(root.providerPath('youtube'), 'prepared.mp4');
  const entry = { id: 'download', kind: 'download', path: source, trustedRoot: root.verify(), record: historyInput(source), requestedProfile: 'fast' };
  return { dir, root, file, pending, history, source, output, entry };
}

test('journal atomically round-trips, replaces by id, removes, and returns detached values', t => {
  const f = fixture(t); f.pending.put(f.entry);
  const list = f.pending.list(); list[0].record.title = 'mutated';
  assert.equal(f.pending.list()[0].record.title, 'Clip');
  const retry = { id: 'retry', kind: 'retry', historyId: 'history', sourcePath: f.source, outputPath: f.output };
  f.pending.put(retry); f.pending.put({ ...f.entry, path: f.output, requestedProfile: undefined });
  const loaded = new PendingArtifacts(f.file);
  assert.deepEqual(loaded.list(), [retry, JSON.parse(JSON.stringify({ ...f.entry, path: f.output, requestedProfile: undefined }))]);
  loaded.remove('retry'); loaded.remove('download'); loaded.remove('absent');
  assert.deepEqual(new PendingArtifacts(f.file).list(), []);
  assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.endsWith('.tmp')), []);
});

for (const content of ['{broken', JSON.stringify({ schemaVersion: 9, entries: [] })]) {
  test(`invalid journal is quarantined: ${content}`, t => {
    const f = fixture(t); fs.writeFileSync(f.file, content);
    const loaded = new PendingArtifacts(f.file);
    assert.deepEqual(loaded.list(), []);
    assert.equal(fs.existsSync(f.file), false);
    const quarantine = fs.readdirSync(f.dir).find(name => name.startsWith('pending-artifacts.json.corrupt-'));
    assert.equal(fs.readFileSync(path.join(f.dir, quarantine), 'utf8'), content);
    loaded.put(f.entry); assert.equal(new PendingArtifacts(f.file).list().length, 1);
  });
}

test('invalid entries are dropped without losing valid entries or quarantining the journal', t => {
  const f = fixture(t);
  const invalid = [null, {}, { ...f.entry, kind: 'bogus' }, { ...f.entry, path: '../outside' }, { ...f.entry, requestedProfile: 'original' }, { ...f.entry, record: {} }, { ...f.entry, record: { ...f.entry.record, title: null } }, { ...f.entry, record: { ...f.entry.record, automation: { chapters: [null] } } }, { id: 'retry', kind: 'retry', historyId: null, sourcePath: f.source, outputPath: f.output }];
  fs.writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, entries: [...invalid, f.entry] }));
  assert.deepEqual(new PendingArtifacts(f.file).list(), [f.entry]);
  assert.equal(fs.readdirSync(f.dir).some(name => name.includes('.corrupt-')), false);
});

test('an unreadable journal is quarantined and treated as empty', t => {
  const f = fixture(t); fs.mkdirSync(f.file);
  const loaded = new PendingArtifacts(f.file);
  assert.deepEqual(loaded.list(), []);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('pending-artifacts.json.corrupt-')), true);
});

test('temporary Pinterest search sources round-trip just like History input', t => {
  const f = fixture(t);
  const source = 'https://www.pinterest.com/pin/e1_AfqPShwWJ_9nNp98oMy8EENZLzrcH3zYISwyG7ODp0u4p3s_onow/';
  const entry = { ...f.entry, record: { ...f.entry.record, provider: 'pinterest', source, automation: { provider: 'pinterest', source, selection: null, chapters: [] } } };
  f.pending.put(entry);
  assert.deepEqual(new PendingArtifacts(f.file).list(), [entry]);
});

// Only our own child exits. It drives real provider/retry registration and
// commits, substituting the provider and conversion tool boundaries.
const crashChild = `
import fs from 'node:fs';
import path from 'node:path';
import { PendingArtifacts } from './dist/pending-artifacts.js';
import { DownloadHistory } from './dist/history.js';
import { ManagedRoot } from './dist/managed-root.js';
import { createHistoryPreparationHandlers, createProviderDownloadHandlers } from './dist/main-process.js';
const [mode, folder, userData] = process.argv.slice(1);
const root = ManagedRoot.prepare(folder);
const history = new DownloadHistory(path.join(userData, 'download-history.json'), root);
const pending = new PendingArtifacts(path.join(userData, 'pending-artifacts.json'));
const source = path.join(root.providerPath('youtube'), 'source.mkv'); fs.writeFileSync(source, 'source');
const output = path.join(root.providerPath('youtube'), 'prepared.mp4');
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const record = { provider: 'youtube', source: url, filePath: source, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source: url, selection: null, chapters: [] } };
const prepare = async () => { fs.writeFileSync(output, 'prepared'); return { filePath: output, fileName: 'prepared.mp4' }; };
if (mode.startsWith('retry')) {
  const saved = history.add({ ...record, preparationFailed: { profile: 'fast' } });
  if (mode === 'retry-precommit') history.replacePreparedArtifact = () => process.exit(74);
  const api = createHistoryPreparationHandlers({ history, pendingArtifacts: pending, prepareMedia: prepare, cancelMediaPreparation: () => null, replaced: () => process.exit(74) });
  await api.retryPreparation(saved.id);
} else {
  const api = createProviderDownloadHandlers({
    ffprobeAvailable: true, cancelMediaPreparation: () => null, registerSubtitle() {},
    completion: { pendingArtifacts: pending, artifactRoot: () => root, isSafeMediaFile: file => !!root.resolve(file), refreshHistoryProject: async () => process.exit(74), recordHistory: input => ({ record: history.add(input) }), registerCard: () => 'card', prepareMedia: async () => { const result = await prepare(); fs.unlinkSync(source); return result; } },
    youtube: { emit() {}, worker: { metadata: async () => ({ id: 'dQw4w9WgXcQ', title: 'Clip', channel: null, duration: 10, chapters: [] }), download: async () => ({ filePath: source, fileName: 'source.mkv' }), cancel: () => null } }, social: {}, pinterest: {}, pexels: {}, pixabay: {},
  });
  await api.youtube({ sender: {} }, url, 'best', mode === 'normal-prepared' ? 'fast' : 'original', 'crash', { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' });
}
throw new Error('Expected crash boundary');
`;

for (const mode of ['normal-original', 'normal-prepared', 'retry-precommit', 'retry-postcommit']) {
  test(`startup recovers the actual ${mode} crash before History listing`, async t => {
    let crashed;
    const f = await mainFixture(t, { setup({ root, userData }) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', crashChild, mode, root, userData], { encoding: 'utf8' });
      assert.equal(result.status, 74, result.stderr);
      crashed = JSON.parse(fs.readFileSync(path.join(userData, 'pending-artifacts.json'), 'utf8')).entries;
      assert.equal(crashed.length, 1);
    } });
    const list = await f.invoke('historyList');
    assert.equal(list.length, 1);
    const prepared = mode === 'normal-prepared' || mode === 'retry-postcommit';
    assert.equal(list[0].fileName, prepared ? 'prepared.mp4' : 'source.mkv');
    assert.equal(list[0].profile, prepared ? 'fast' : 'original');
    assert.equal(fs.existsSync(path.join(f.root, 'youtube', 'source.mkv')), !prepared);
    assert.equal(fs.existsSync(path.join(f.root, 'youtube', 'prepared.mp4')), prepared);
    assert.deepEqual(new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list(), []);
    if (mode === 'normal-prepared') assert.equal(crashed[0].record.profile, 'fast');
    await f.controls.history.dispose();
  });
}

test('a second instance refuses recovery while the existing process owns the store', async t => {
  let file;
  const f = await mainFixture(t, { lock: false, setup({ root, userData }) {
    fs.mkdirSync(root); file = path.join(root, 'pending.mp4'); fs.writeFileSync(file, 'pending');
    new PendingArtifacts(path.join(userData, 'pending-artifacts.json')).put({ id: 'live', kind: 'download', path: file, trustedRoot: root, record: historyInput(file) });
  } });
  assert.equal(f.windows.length, 0);
  assert.equal(f.controls.history.list().length, 0);
  assert.equal(new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list().length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'pending');
});

for (const kind of ['default', 'marked']) {
  test(`startup admits a former ${kind} root with another folder active`, async t => {
    let file;
    const f = await mainFixture(t, { setup({ root, userData }) {
      const custom = path.join(userData, 'custom'); fs.mkdirSync(custom); claimDownloadFolder(ManagedRoot.capture(custom));
      fs.writeFileSync(path.join(userData, 'clipdock-settings.json'), JSON.stringify({ downloadFolder: custom }));
      const former = kind === 'default' ? root : path.join(userData, 'former'); fs.mkdirSync(former);
      if (kind === 'marked') claimDownloadFolder(ManagedRoot.capture(former));
      file = path.join(former, 'pending.mp4'); fs.writeFileSync(file, 'pending');
      new PendingArtifacts(path.join(userData, 'pending-artifacts.json')).put({ id: 'old-root', kind: 'download', path: file, trustedRoot: former, record: historyInput(file) });
    } });
    const list = await f.invoke('historyList');
    assert.equal(list.length, 1); assert.equal(f.controls.history.resolve(list[0].id).path, file);
    assert.equal(f.controls.history.resolve(list[0].id).trustedRoot.verify(), path.dirname(file));
    assert.deepEqual(new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list(), []);
  });
}

test('recovery marks an unconverted requested profile, deduplicates paths, ignores missing and recorded files, and is idempotent', t => {
  const f = fixture(t); f.pending.put(f.entry); f.pending.put({ ...f.entry, id: 'duplicate' });
  f.pending.put({ ...f.entry, id: 'missing', path: path.join(f.root.verify(), 'missing.mp4') });
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(f.history.list().length, 1);
  assert.deepEqual(f.history.list()[0].preparationFailed, { profile: 'fast' });
  f.pending.put(f.entry); recoverPendingArtifacts(f.history, f.pending); recoverPendingArtifacts(f.history, f.pending);
  assert.equal(f.history.list().length, 1);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'source');
  assert.deepEqual(new PendingArtifacts(f.file).list(), []);
});

test('recovery restores the requested profile when only the journal path changed to prepared output', t => {
  const f = fixture(t); fs.writeFileSync(f.output, 'prepared'); fs.unlinkSync(f.source);
  f.pending.put({ ...f.entry, path: f.output });
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(f.history.list().length, 1);
  assert.equal(f.history.list()[0].profile, 'fast');
  assert.equal(f.history.list()[0].preparationFailed, undefined);
  assert.equal(f.history.resolve(f.history.list()[0].id).path, f.output);
  assert.deepEqual(f.pending.list(), []);
});

test('recovery never adopts or deletes outside admitted roots, including symlinked parents', t => {
  const f = fixture(t);
  const foreign = path.join(f.dir, 'foreign'); fs.mkdirSync(foreign);
  const victim = path.join(foreign, 'victim.mp4'); fs.writeFileSync(victim, 'victim');
  fs.symlinkSync(foreign, path.join(f.root.verify(), 'linked'));
  f.pending.put({ ...f.entry, id: 'foreign-root', path: victim, trustedRoot: foreign });
  f.pending.put({ ...f.entry, id: 'outside', path: victim });
  f.pending.put({ ...f.entry, id: 'symlink', path: path.join(f.root.verify(), 'linked', 'victim.mp4') });
  const record = f.history.add({ ...historyInput(f.source), preparationFailed: { profile: 'fast' } });
  f.pending.put({ id: 'retry-outside', kind: 'retry', historyId: record.id, sourcePath: f.source, outputPath: victim });
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(f.history.list().length, 1);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
  assert.deepEqual(f.pending.list(), []);
});

test('recovery admits media and subtitle through captured files and drops outside companions', t => {
  const f = fixture(t);
  const subtitle = path.join(f.root.verify(), 'source.srt'); fs.writeFileSync(subtitle, 'captions');
  f.pending.put({ ...f.entry, record: { ...f.entry.record, subtitle: { filePath: subtitle } } });
  recoverPendingArtifacts(f.history, f.pending);
  assert.deepEqual(f.history.list()[0].subtitle, { fileName: 'source.srt', bytes: 8, available: true });
  const outside = path.join(f.dir, 'outside.srt'); fs.writeFileSync(outside, 'outside');
  fs.writeFileSync(f.output, 'prepared');
  f.pending.put({ ...f.entry, id: 'other', path: f.output, record: { ...f.entry.record, subtitle: { filePath: outside } } });
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(f.history.list()[0].subtitle, null);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('retry recovery preserves a source shared by another record and an output recorded separately', t => {
  const f = fixture(t); fs.writeFileSync(f.output, 'prepared');
  const original = f.history.add({ ...historyInput(f.source), preparationFailed: { profile: 'fast' } });
  const shared = f.history.add(historyInput(f.source));
  f.history.replacePreparedArtifact(original.id, { filePath: f.output, profile: 'fast' });
  f.pending.put({ id: 'post', kind: 'retry', historyId: original.id, sourcePath: f.source, outputPath: f.output });
  f.pending.put({ id: 'pre', kind: 'retry', historyId: shared.id, sourcePath: f.source, outputPath: f.output });
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'source');
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'prepared');
  assert.deepEqual(f.pending.list(), []);
});

for (const artifact of ['media', 'subtitle']) {
  test(`retry recovery preserves persisted Resolve-used ${artifact}`, t => {
    const f = fixture(t); fs.writeFileSync(f.output, 'prepared');
    const subtitle = path.join(f.root.verify(), 'source.srt'); fs.writeFileSync(subtitle, 'captions');
    const used = f.history.add({ ...historyInput(f.source), subtitle: { filePath: subtitle } });
    f.history.noteResolveUse(f.source, 'import');
    const prepared = f.history.add(historyInput(f.output));
    f.pending.put({ id: 'postcommit', kind: 'retry', historyId: prepared.id, sourcePath: artifact === 'media' ? f.source : subtitle, outputPath: f.output });
    const restarted = new DownloadHistory(path.join(f.dir, 'history.json'), f.root); t.after(() => restarted.dispose());
    assert.equal(restarted.get(used.id).sentToResolve, true);
    recoverPendingArtifacts(restarted, new PendingArtifacts(f.file));
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'source');
    assert.equal(fs.readFileSync(subtitle, 'utf8'), 'captions');
    assert.equal(fs.readFileSync(f.output, 'utf8'), 'prepared');
    assert.equal(restarted.list().length, 2);
    assert.equal(restarted.get(used.id).sentToResolve, true);
    assert.deepEqual(new PendingArtifacts(f.file).list(), []);
  });
}

test('one recovery failure is logged and does not prevent later entries', t => {
  const f = fixture(t); f.pending.put(f.entry); f.pending.put({ ...f.entry, id: 'later' });
  const original = f.history.addRecovered.bind(f.history); let calls = 0;
  f.history.addRecovered = (...args) => { if (++calls === 1) throw new Error('fixture commit failure'); return original(...args); };
  const logs = []; t.mock.method(console, 'warn', (...args) => logs.push(args));
  recoverPendingArtifacts(f.history, f.pending);
  assert.equal(logs.length, 1);
  assert.equal(f.history.list().length, 1);
  recoverPendingArtifacts(f.history, f.pending);
  assert.deepEqual(f.pending.list(), []);
});

function downloads(f, { refresh = async () => {}, prepare = async () => { throw new Error('fixture preparation failed'); }, record = input => ({ record: f.history.add(input) }) } = {}) {
  const observations = [];
  const put = f.pending.put.bind(f.pending); f.pending.put = entry => { put(entry); observations.push(new PendingArtifacts(f.file).list()); };
  const api = createProviderDownloadHandlers({
    ffprobeAvailable: true, cancelMediaPreparation: () => null, registerSubtitle() {},
    completion: { pendingArtifacts: f.pending, artifactRoot: () => f.root, isSafeMediaFile: file => !!f.root.resolve(file), refreshHistoryProject: refresh, recordHistory: record, registerCard: () => 'card', prepareMedia: prepare },
    youtube: { emit() {}, worker: { metadata: async () => ({ id: 'dQw4w9WgXcQ', title: 'Clip', channel: null, duration: 10, chapters: [] }), download: async () => ({ filePath: f.source, fileName: 'source.mkv' }), cancel: () => null } }, social: {}, pinterest: {}, pexels: {}, pixabay: {},
  });
  const start = profile => api.youtube({ sender: {} }, f.entry.record.source, 'best', profile, 'job', { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' });
  return { api, start, observations };
}

for (const mode of ['finished', 'failed', 'cancelled']) {
  test(`journal is empty after a ${mode} download, with registration observed before completion`, async t => {
    const f = fixture(t); const entered = deferred();
    const d = downloads(f, mode === 'cancelled' ? { refresh: async () => { entered.resolve(); return new Promise(() => {}); } } : {});
    if (mode === 'finished') assert.equal((await d.start('original')).cardId, 'card');
    if (mode === 'failed') await assert.rejects(d.start('fast'), /fixture preparation failed/);
    if (mode === 'cancelled') {
      const operation = d.start('original'); const rejected = assert.rejects(operation, /Download cancelled/);
      await entered.promise; assert.equal(d.api.cancel('job'), true); await rejected;
    }
    assert.equal(d.observations.length, 1);
    assert.equal(d.observations[0].length, 1);
    assert.equal(d.observations[0][0].path, f.source);
    assert.deepEqual(new PendingArtifacts(f.file).list(), []);
    assert.equal(fs.existsSync(f.source), mode !== 'cancelled');
    assert.equal(f.history.list().length, mode === 'cancelled' ? 0 : 1);
    await d.api.shutdown();
  });
}

for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) {
  test(`${provider} IPC journals the real provider artifact before History and clears it on commit`, async t => {
    const f = await providerIpcFixture(t, provider); let observed;
    f.controls.status = async () => {
      observed = new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list();
      return { project: { name: 'Project' } };
    };
    try {
      await f.start();
      assert.equal(observed.length, 1); assert.equal(observed[0].record.provider, provider);
      assert.equal(fs.existsSync(observed[0].path), true);
      assert.deepEqual(new PendingArtifacts(path.join(f.userData, 'pending-artifacts.json')).list(), []);
      assert.equal(f.controls.history.list().length, 1);
    } finally { await f.stop(); }
  });
}

test('prepared registration replaces the source journal before refresh; History commit clears it before card binding', async t => {
  const f = fixture(t); let refreshed = false;
  const d = downloads(f, { prepare: async () => { fs.writeFileSync(f.output, 'prepared'); fs.unlinkSync(f.source); return { filePath: f.output, fileName: 'prepared.mp4' }; }, refresh: async () => {
    const entry = new PendingArtifacts(f.file).list()[0]; assert.equal(entry.path, f.output); assert.equal(entry.requestedProfile, undefined); assert.equal(entry.record.profile, 'fast'); refreshed = true;
  }, record: input => {
    assert.equal(f.pending.list().length, 1);
    return { record: f.history.add(input) };
  } });
  await d.start('fast'); assert.equal(refreshed, true); assert.equal(d.observations.length, 2);
  assert.deepEqual(f.pending.list(), []);
});

test('journal write errors are logged and do not fail a download', async t => {
  const f = fixture(t); const d = downloads(f);
  f.pending.put = () => { throw new Error('fixture journal write failure'); };
  const logs = []; t.mock.method(console, 'warn', (...args) => logs.push(args));
  assert.equal((await d.start('original')).cardId, 'card');
  assert.equal(logs.length, 1); assert.equal(f.history.list().length, 1); assert.equal(fs.readFileSync(f.source, 'utf8'), 'source');
});

test('successful download settles its journal when History cannot commit and recovery does not adopt it later', async t => {
  const f = fixture(t); let journaled = false;
  const d = downloads(f, { record: () => {
    assert.equal(new PendingArtifacts(f.file).list()[0].path, f.source); journaled = true;
    return { record: null, warning: 'history unavailable' };
  } });
  const result = await d.start('original');
  assert.equal(result.cardId, 'card'); assert.equal(result.warning, 'history unavailable');
  assert.equal(journaled, true);
  assert.deepEqual(new PendingArtifacts(f.file).list(), []);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'source');
  recoverPendingArtifacts(f.history, f.pending);
  assert.deepEqual(f.history.list(), []);
});

for (const mode of ['finished', 'failed', 'cancelled']) {
  test(`journal is empty after a ${mode} retry, including cleanup of a captured output`, async t => {
    const f = fixture(t); const record = f.history.add({ ...historyInput(f.source), preparationFailed: { profile: 'fast' } });
    let controller, captured = 0;
    const put = f.pending.put.bind(f.pending);
    f.pending.put = entry => {
      put(entry); captured++;
      assert.equal(new PendingArtifacts(f.file).list()[0].outputPath, f.output);
      if (mode === 'cancelled') void controller.cancelPreparation(record.id);
    };
    if (mode === 'failed') f.history.replacePreparedArtifact = () => { throw new Error('fixture replacement failure'); };
    controller = createHistoryPreparationHandlers({ history: f.history, pendingArtifacts: f.pending, prepareMedia: async () => { fs.writeFileSync(f.output, 'prepared'); return { filePath: f.output, fileName: 'prepared.mp4' }; }, cancelMediaPreparation: () => null, replaced() {} });
    if (mode === 'failed') await assert.rejects(controller.retryPreparation(record.id), /fixture replacement failure/);
    else assert.deepEqual(await controller.retryPreparation(record.id), mode === 'cancelled' ? { cancelled: true } : { cancelled: false, profile: 'fast' });
    assert.equal(captured, 1);
    assert.deepEqual(new PendingArtifacts(f.file).list(), []);
    assert.equal(fs.existsSync(f.output), mode === 'finished');
    assert.equal(fs.existsSync(f.source), mode !== 'finished');
    assert.equal(f.history.resolve(record.id).path, mode === 'finished' ? f.output : f.source);
  });
}
