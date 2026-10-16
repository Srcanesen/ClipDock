import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { ManagedRoot, ManagedRootSelection } from '../dist/managed-root.js';
import { DownloadLedger } from '../dist/download-ledger.js';
import { DownloadHistory } from '../dist/history.js';
import { inspectWorkspace, cleanupWorkspace, inspectWorkspaceAsync, cleanupWorkspaceAsync } from '../dist/workspace.js';
import { claimDownloadFolder, saveDownloadFolder, loadDownloadFolder } from '../dist/settings.js';

const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const input = filePath => ({ provider: 'youtube', source, filePath, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source, selection: null, chapters: [] } });
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-root-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('prepare creates provider directories, captures once and round-trips the immutable identity', t => {
  const dir = fixture(t), folder = path.join(dir, 'new');
  const root = ManagedRoot.prepare(folder);
  assert.equal(root.verify(), folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['pexels', 'pinterest', 'social', 'youtube']);
  const media = path.join(folder, 'youtube', 'clip.mp4'); fs.writeFileSync(media, 'media');
  assert.equal(root.resolve(media), media);
  assert.equal(root.resolve(dir), null);
  assert.equal(ManagedRoot.restore(JSON.parse(JSON.stringify(root.snapshot()))).resolve(media), media);
  assert.equal(Object.isFrozen(root.snapshot().directories[0]), true);
});

test('replacement fails closed in session but history survives a new session at the same path', t => {
  const dir = fixture(t), folder = path.join(dir, 'managed');
  const root = ManagedRoot.prepare(folder), file = path.join(folder, 'youtube', 'clip.mp4');
  fs.writeFileSync(file, 'owned');
  const history = new DownloadHistory(path.join(dir, 'history.json'), root), ledger = new DownloadLedger(history, () => false);
  const record = history.add(input(file)), card = ledger.register({ path: file, historyId: record.id }, root);
  const snapshot = root.snapshot();
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
  legacy.records[0].rootIdentity = { ...snapshot, directories: snapshot.directories.map(entry => ({ ...entry, birthtimeMs: 123 })) };
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(legacy));
  fs.renameSync(folder, path.join(dir, 'original')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'owned');
  assert.throws(() => root.verify(), /Managed root.*safety check/);
  assert.equal(ledger.resolve(card), null);
  assert.equal(ManagedRoot.restore(snapshot).resolve(file), null);
  assert.throws(() => cleanupWorkspace(root, []), /Managed root.*safety check/);
  const restarted = new DownloadHistory(path.join(dir, 'history.json'), ManagedRoot.capture(folder));
  assert.equal(restarted.resolve(record.id)?.path, file);
  assert.equal(restarted.get(record.id).available, true);
  assert.equal(new DownloadLedger(restarted, () => false).deleteHistory(record.id).deleted, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(dir, 'original', 'youtube', 'clip.mp4'), 'utf8'), 'owned');
});

test('swapping an ancestor for a symlink rejects every consumer and preserves all media', async t => {
  const dir = fixture(t), ancestor = path.join(dir, 'downloads'), folder = path.join(ancestor, 'managed');
  const root = ManagedRoot.prepare(folder), media = path.join(folder, 'youtube', 'clip.mp4'); fs.writeFileSync(media, 'owned');
  const store = path.join(dir, 'history.json'), history = new DownloadHistory(store, root), ledger = new DownloadLedger(history, () => false);
  const record = history.add(input(media)), card = ledger.register({ path: media, historyId: record.id }, root);
  assert.equal(ledger.resolve(card).path, media);
  assert.equal((await inspectWorkspaceAsync(root, [])).fileCount, 1);
  const outside = path.join(dir, 'outside'), replacement = path.join(outside, 'managed', 'youtube', 'clip.mp4');
  fs.mkdirSync(path.dirname(replacement), { recursive: true }); fs.writeFileSync(replacement, 'precious');
  fs.renameSync(ancestor, path.join(dir, 'original')); fs.symlinkSync(outside, ancestor);
  assert.equal(ledger.resolve(card), null);
  assert.equal(ledger.deleteCard(card).deleted, false);
  assert.throws(() => history.add(input(media)), /Managed root.*safety check/);
  assert.equal(history.list().length, 1);
  assert.equal(ledger.deleteHistory(record.id).deleted, false);
  assert.throws(() => inspectWorkspace(root, ledger.protectedPaths()), /Managed root.*safety check/);
  assert.throws(() => cleanupWorkspace(root, ledger.protectedPaths()), /Managed root.*safety check/);
  await assert.rejects(async () => inspectWorkspaceAsync(root, ledger.protectedPaths()), /Managed root.*safety check/);
  await assert.rejects(async () => cleanupWorkspaceAsync(root, ledger.protectedPaths()), /Managed root.*safety check/);
  assert.throws(() => root.providerPath('youtube'), /Managed root.*safety check/);
  assert.equal(history.resolve(record.id), null);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(dir, 'original', 'managed', 'youtube', 'clip.mp4'), 'utf8'), 'owned');
});

test('worker verifies the captured identity itself after main has sent it', async t => {
  const dir = fixture(t), folder = path.join(dir, 'managed'), root = ManagedRoot.prepare(folder), identity = root.snapshot();
  fs.renameSync(folder, path.join(dir, 'original')); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'keep.mp4'), 'keep');
  const worker = new Worker(new URL('../dist/workspace.js', import.meta.url), { workerData: { clipdockWorkspace: true, root: identity, protectedPaths: [], cleanup: true } });
  const error = await new Promise(resolve => worker.once('error', resolve));
  assert.match(error.message, /Managed root.*safety check/);
  assert.equal(fs.readFileSync(path.join(folder, 'keep.mp4'), 'utf8'), 'keep');
});

test('folder change prepares fully, swaps every consumer together, and rolls all back on apply or persistence failure', t => {
  const dir = fixture(t), old = ManagedRoot.prepare(path.join(dir, 'old')), selection = new ManagedRootSelection();
  const paths = Array(4).fill(null), names = ['youtube', 'social', 'pinterest', 'pexels']; let failing = -1;
  const adapters = names.map((name, i) => root => { paths[i] = root.providerPath(name); if (failing === i && root !== old) throw new Error('apply denied'); });
  selection.change(old, adapters);
  const history = new DownloadHistory(path.join(dir, 'history.json'), () => selection.current()), ledger = new DownloadLedger(history, () => false);
  const file = path.join(old.verify(), 'youtube', 'clip.mp4'); fs.writeFileSync(file, 'owned');
  const record = history.add(input(file)), card = ledger.register({ path: file, historyId: record.id }, selection.current());
  const chosen = path.join(dir, 'chosen'); fs.mkdirSync(chosen);
  const next = ManagedRoot.prepare(chosen, claimDownloadFolder);
  for (const index of [0, 1, 2, 3]) {
    failing = index; assert.throws(() => selection.change(next, adapters), /apply denied/);
    assert.equal(selection.current(), old);
    assert.deepEqual(paths, names.map(name => path.join(old.verify(), name)));
    assert.equal(ledger.resolve(card).path, file);
  }
  failing = -1;
  assert.throws(() => selection.change(next, adapters, () => { throw new Error('save denied'); }), /save denied/);
  assert.equal(selection.current(), old); assert.deepEqual(paths, names.map(name => path.join(old.verify(), name)));
  const settings = path.join(dir, 'settings.json');
  selection.change(next, adapters, root => saveDownloadFolder(settings, root));
  assert.equal(selection.current(), next); assert.deepEqual(paths, names.map(name => path.join(chosen, name)));
  assert.equal(loadDownloadFolder(settings, dir).folder, chosen);
  assert.equal(ledger.resolve(card).trustedRoot, old);
  assert.equal(history.resolve(record.id).trustedRoot.verify(), old.verify());
  assert.equal(ledger.deleteCard(card).deleted, true); assert.equal(fs.existsSync(file), false);
});

test('unsafe provider directory fails preparation before any consumer is changed; a failed root can be recovered', t => {
  const dir = fixture(t), selection = new ManagedRootSelection(), old = ManagedRoot.prepare(path.join(dir, 'old'));
  let applied = old; selection.change(old, [root => { applied = root; }]);
  const bad = path.join(dir, 'bad'); fs.mkdirSync(bad); fs.symlinkSync(dir, path.join(bad, 'youtube'));
  assert.throws(() => selection.change(ManagedRoot.prepare(bad), [root => { applied = root; }]), /safety check/);
  assert.equal(applied, old); assert.equal(selection.current(), old);
  fs.renameSync(old.verify(), path.join(dir, 'moved'));
  assert.throws(() => selection.current(), /safety check/);
  const recovered = ManagedRoot.prepare(path.join(dir, 'recovered'));
  selection.change(recovered, [root => { applied = root; }]);
  assert.equal(selection.current(), recovered); assert.equal(applied, recovered);
  assert.equal(inspectWorkspace(recovered, []).fileCount, 0);
});

test('unreleased identity fields are ignored on read and never persisted again', t => {
  const dir = fixture(t), root = ManagedRoot.prepare(path.join(dir, 'managed')), file = path.join(root.verify(), 'clip.mp4');
  fs.writeFileSync(file, 'keep');
  const store = path.join(dir, 'history.json'), history = new DownloadHistory(store, root), record = history.add(input(file));
  const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal('rootIdentity' in saved.records[0], false);
  assert.equal(saved.records[0].trustedRoot, root.verify());
  for (const identity of [root.snapshot(), null, {}, { path: root.verify(), directories: [] }, { ...root.snapshot(), path: dir }]) {
    saved.records[0].rootIdentity = identity; fs.writeFileSync(store, JSON.stringify(saved));
    const restarted = new DownloadHistory(store, root);
    assert.equal(restarted.resolve(record.id)?.path, file);
    assert.equal(restarted.reuse(record.id)?.record.id, record.id);
    const stored = JSON.parse(fs.readFileSync(store, 'utf8')).records[0];
    assert.equal('rootIdentity' in stored, false);
    assert.equal(stored.trustedRoot, root.verify());
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  }
});

test('rollback failure closes the shared root until all adapters are successfully reapplied', t => {
  const dir = fixture(t), selection = new ManagedRootSelection(), old = ManagedRoot.prepare(path.join(dir, 'old')), next = ManagedRoot.prepare(path.join(dir, 'next'));
  const actual = [old, old]; let fail = false;
  const adapters = [root => { actual[0] = root; if (fail) throw new Error('first adapter failed'); }, root => { actual[1] = root; }];
  selection.change(old, adapters); fail = true;
  assert.throws(() => selection.change(next, adapters), /first adapter failed/);
  assert.throws(() => selection.current(), /Managed root.*safety check/);
  assert.deepEqual(actual, [old, old]);
  fail = false; selection.change(next, adapters);
  assert.equal(selection.current(), next); assert.deepEqual(actual, [next, next]);
});

test('session ancestor identities stop at the volume mount point and omit birth times', t => {
  const dir = fixture(t), root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const snapshot = root.snapshot(), entries = snapshot.directories;
  assert.equal(entries[0].path, root.verify());
  assert.equal(entries.every(entry => entry.dev === fs.lstatSync(root.verify()).dev), true);
  assert.equal(entries.every((entry, index) => index === 0 || entry.path === path.dirname(entries[index - 1].path)), true);
  const mount = entries.at(-1), parent = path.dirname(mount.path);
  assert.equal(parent === mount.path || fs.lstatSync(parent).dev !== mount.dev, true);
  assert.deepEqual(Object.keys(snapshot.directories[0]).sort(), ['dev', 'ino', 'path']);
  assert.equal(ManagedRoot.restore(JSON.parse(JSON.stringify(snapshot))).verify(), root.verify());
  if (snapshot.directories.length > 1) {
    const truncated = { ...snapshot, directories: snapshot.directories.slice(0, -1) };
    assert.throws(() => ManagedRoot.restore(truncated).verify(), /Managed root.*safety check/);
  }
});

test('persisted media reached through a replaced subdirectory symlink is never resolved or deleted', t => {
  const dir = fixture(t), root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const folder = path.join(root.providerPath('youtube'), 'original'); fs.mkdirSync(folder);
  const file = path.join(folder, 'clip.mp4'); fs.writeFileSync(file, 'keep');
  const history = new DownloadHistory(path.join(dir, 'history.json'), root), record = history.add(input(file));
  const moved = path.join(root.providerPath('youtube'), 'moved'); fs.renameSync(folder, moved); fs.symlinkSync(moved, folder);
  assert.equal(history.resolve(record.id), null);
  assert.equal(new DownloadLedger(history, () => false).deleteHistory(record.id).deleted, false);
  assert.equal(fs.readFileSync(path.join(moved, 'clip.mp4'), 'utf8'), 'keep');
});
