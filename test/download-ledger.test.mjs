import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ManagedRoot, ManagedRootSelection } from '../dist/managed-root.js';
import { DownloadLedger } from '../dist/download-ledger.js';
import { DownloadHistory } from '../dist/history.js';
import { createMainTransferHandlers, resolveMainProcessCard } from '../dist/main-process.js';
import { inspectWorkspace, cleanupWorkspace } from '../dist/workspace.js';

const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const input = filePath => ({ provider: 'youtube', source, filePath, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source, selection: null, chapters: [] } });
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'download-ledger-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  let reading = false;
  const history = new DownloadHistory(path.join(dir, 'history.json'), root), ledger = new DownloadLedger(history, () => reading);
  const file = (name, text = 'media') => { const file = path.join(root.providerPath('youtube'), name); fs.writeFileSync(file, text); return file; };
  return { dir, root, history, ledger, file, setReading: value => { reading = value; } };
}

test('register, resolve, protect and delete use opaque cards and reject outside, malformed and replaced files', t => {
  const { dir, root, history, ledger, file } = fixture(t), media = file('clip.mp4'), outside = path.join(dir, 'outside.mp4'); fs.writeFileSync(outside, 'outside');
  const record = ledger.record(input(media)).record, card = ledger.register({ path: media, historyId: record.id }, root);
  assert.match(card, /^[0-9a-f-]{36}$/); assert.equal(resolveMainProcessCard(ledger, card).path, media);
  assert.deepEqual(ledger.protectedPaths(), [media]);
  assert.throws(() => ledger.register({ path: outside }, root), /safely register/);
  assert.throws(() => ledger.register({ path: dir }, root), /safely register/);
  for (const id of [null, undefined, 42, {}, '', 'missing']) assert.equal(ledger.resolve(id), null);
  const external = ledger.registerExternal(outside); assert.equal(ledger.resolve(external).path, outside);
  assert.equal(ledger.deleteCard(external).deleted, false); assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  fs.renameSync(media, `${media}.original`); fs.symlinkSync(outside, media);
  assert.equal(ledger.resolve(card), null); assert.equal(ledger.deleteCard(card).deleted, false); assert.equal(history.get(record.id).available, false);
  fs.rmSync(media); fs.renameSync(`${media}.original`, media);
  assert.deepEqual(ledger.deleteCard(card), { deleted: true, message: 'File deleted.' });
  assert.equal(fs.existsSync(media), false); assert.equal(ledger.resolve(card), null); assert.equal(history.get(record.id), null);
});

test('native drag resolves through the ledger and rejects a captured-root ancestor replacement (66d3440)', t => {
  const { dir, root, ledger, file } = fixture(t), media = file('clip.mp4'), card = ledger.register({ path: media }, root), drags = [];
  const handlers = createMainTransferHandlers({ requireSender() {}, resolveCard: id => resolveMainProcessCard(ledger, id), transfer: {} });
  handlers.nativeDragStart({}, card, paths => drags.push(paths)); assert.deepEqual(drags, [media]); drags.length = 0;
  const replacement = path.join(dir, 'outside'); fs.mkdirSync(path.join(replacement, 'youtube'), { recursive: true }); fs.writeFileSync(path.join(replacement, 'youtube', 'clip.mp4'), 'precious');
  fs.renameSync(root.verify(), path.join(dir, 'original')); fs.symlinkSync(replacement, path.join(dir, 'managed'));
  handlers.nativeDragStart({}, card, paths => drags.push(paths)); assert.deepEqual(drags, []); assert.equal(ledger.resolve(card), null);
  assert.equal(fs.readFileSync(path.join(replacement, 'youtube', 'clip.mp4'), 'utf8'), 'precious');
});

test('passive listing leaves history unchanged, caches bindings, replaces relinks, and permits cleanup (SHL-7)', t => {
  const { dir, root, history, ledger, file } = fixture(t), media = file('clip.mp4'), record = history.add(input(media));
  const before = fs.readFileSync(path.join(dir, 'history.json'), 'utf8');
  assert.equal(inspectWorkspace(root, ledger.protectedPaths()).cleanupFileCount, 1);
  const first = ledger.listHistory()[0].cardId;
  assert.equal(typeof first, 'string'); assert.equal(ledger.listHistory()[0].cardId, first);
  assert.equal(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'), before);
  assert.deepEqual(ledger.protectedPaths(), []);
  const replacement = file('new.mov'); history.relink(record.id, replacement);
  const next = ledger.listHistory()[0].cardId; assert.notEqual(next, first); assert.equal(ledger.resolve(first), null); assert.equal(ledger.resolve(next).path, replacement);
  fs.renameSync(replacement, `${replacement}.hidden`); assert.equal(ledger.bindHistory(record.id), null);
  fs.renameSync(`${replacement}.hidden`, replacement); assert.equal(ledger.bindHistory(record.id), next);
  assert.equal(cleanupWorkspace(root, ledger.protectedPaths()).deletedFileCount, 2);
  assert.equal(fs.existsSync(media), false); assert.equal(fs.existsSync(replacement), false);
});

test('history deletion releases all cards for the target record and keeps other active cards', t => {
  const { root, history, ledger, file } = fixture(t), media = file('clip.mp4'), other = file('other.mp4');
  const subtitle = file('clip.srt', 'captions'), companion = ledger.registerSubtitle(subtitle, root);
  const record = ledger.record({ ...input(media), subtitle: { filePath: subtitle } }).record, otherRecord = history.add(input(other));
  const complete = ledger.register({ path: media, historyId: record.id }, root), reused = ledger.reuseHistory(record.id).cardId;
  const drag = ledger.bindHistory(record.id), keep = ledger.register({ path: other, historyId: otherRecord.id }, root);
  assert.deepEqual(new Set(ledger.protectedPaths()), new Set([media, subtitle, other]));
  assert.deepEqual(ledger.deleteHistory(record.id), { deleted: true, removed: true, removedCardIds: [companion, complete, reused, drag] });
  assert.equal(fs.existsSync(subtitle), false);
  assert.equal(fs.existsSync(media), false); assert.equal(fs.readFileSync(other, 'utf8'), 'media');
  for (const id of [companion, complete, reused, drag]) assert.equal(ledger.resolve(id), null);
  assert.equal(ledger.resolve(keep).path, other); assert.deepEqual(ledger.protectedPaths(), [other]);
});

test('queue deletion releases subtitle cards and companions together', t => {
  const { root, ledger, file } = fixture(t), media = file('clip.mp4'), subtitle = file('clip.en.srt', 'captions');
  const companion = ledger.registerSubtitle(subtitle, root), record = ledger.record({ ...input(media), subtitle: { filePath: subtitle } }).record;
  const card = ledger.register({ path: media, historyId: record.id }, root);
  assert.deepEqual(new Set(ledger.protectedPaths()), new Set([media, subtitle]));
  assert.equal(ledger.deleteCard(card).deleted, true); assert.equal(ledger.resolve(companion), null);
  assert.equal(fs.existsSync(media), false); assert.equal(fs.existsSync(subtitle), false); assert.deepEqual(ledger.protectedPaths(), []);
});

test('reused subtitle protection survives history eviction for cleanup and history deletion (6bf3a28)', t => {
  const { root, history, ledger, file } = fixture(t), media = file('keep.mp4'), subtitle = file('keep.srt', 'captions'), other = file('other.mp4');
  const record = history.add({ ...input(media), subtitle: { filePath: subtitle } }), reused = ledger.reuseHistory(record.id);
  const passive = ledger.bindHistory(record.id);
  for (let i = 0; i < 200; i++) history.add(input(other));
  ledger.listHistory(); assert.equal(history.get(record.id), null); assert.equal(ledger.resolve(passive), null); assert.equal(ledger.resolve(reused.cardId).path, media);
  assert.deepEqual(new Set(ledger.protectedPaths()), new Set([media, subtitle]));
  const removable = file('remove.mp4'), removableRecord = history.add({ ...input(removable), subtitle: { filePath: subtitle } });
  assert.equal(ledger.deleteHistory(removableRecord.id).deleted, true); assert.equal(fs.existsSync(removable), false); assert.equal(fs.readFileSync(subtitle, 'utf8'), 'captions');
  assert.equal(inspectWorkspace(root, ledger.protectedPaths()).cleanupFileCount, 1);
  assert.equal(cleanupWorkspace(root, ledger.protectedPaths()).deletedFileCount, 1);
  assert.equal(fs.existsSync(other), false); assert.equal(fs.readFileSync(media, 'utf8'), 'media'); assert.equal(fs.readFileSync(subtitle, 'utf8'), 'captions');
  assert.equal(ledger.deleteCard(reused.cardId).deleted, true); assert.equal(fs.existsSync(media), false); assert.equal(fs.existsSync(subtitle), false);
});

test('session ownership outlives history retention and failed metadata recording (SHL-8)', t => {
  const { root, history, ledger, file } = fixture(t), media = file('session.mp4'), other = file('other.mp4');
  const record = ledger.record(input(media)).record, card = ledger.register({ path: media, historyId: record.id }, root);
  ledger.listHistory(); for (let i = 0; i < 201; i++) history.add(input(other)); ledger.listHistory();
  assert.equal(history.get(record.id), null); assert.equal(ledger.resolve(card).path, media); assert.deepEqual(ledger.protectedPaths(), [media]);
  assert.equal(ledger.deleteCard(card).deleted, true); assert.equal(fs.existsSync(media), false);
  const unrecorded = file('unrecorded.mp4'), subtitle = file('unrecorded.srt', 'captions');
  const add = history.add; history.add = () => { throw new Error('disk full'); };
  const result = ledger.record({ ...input(unrecorded), subtitle: { filePath: subtitle } }); history.add = add;
  assert.deepEqual(result, { record: null, warning: 'Download history could not be updated.' });
  const id = ledger.register({ path: unrecorded }, root);
  assert.deepEqual(new Set(ledger.protectedPaths()), new Set([unrecorded, subtitle]));
  assert.equal(ledger.deleteCard(id).deleted, true); assert.equal(fs.existsSync(unrecorded), false); assert.equal(fs.existsSync(subtitle), false);
});

test('delete decisions refuse media in use but do not wait for unrelated provider work', t => {
  const { root, history, ledger, file, setReading } = fixture(t), media = file('clip.mp4'), record = history.add(input(media)), card = ledger.register({ path: media, historyId: record.id }, root);
  setReading(true); assert.equal(ledger.deleteCard(card).deleted, false); assert.throws(() => ledger.deleteHistory(record.id), /Wait for active/); assert.equal(fs.readFileSync(media, 'utf8'), 'media');
  setReading(false); assert.equal(ledger.deleteCard(card).deleted, true); assert.equal(fs.existsSync(media), false);
});

test('old owned media and subtitles remain deletable after folder change; external files remain external (r2-03)', t => {
  const { dir, root, history, ledger, file } = fixture(t), media = file('clip.mp4'), subtitle = file('clip.srt', 'captions');
  const record = history.add({ ...input(media), subtitle: { filePath: subtitle } });
  const next = ManagedRoot.prepare(path.join(dir, 'next')); history.setManagedRoot(next);
  assert.equal(history.resolve(record.id).trustedRoot.verify(), root.verify());
  assert.deepEqual(ledger.deleteHistory(record.id), { deleted: true, removed: true, removedCardIds: [] }); assert.equal(fs.existsSync(media), false); assert.equal(fs.existsSync(subtitle), false);
  const external = path.join(dir, 'external.mp4'); fs.writeFileSync(external, 'outside'); const externalRecord = history.add(input(external));
  assert.equal(history.resolve(externalRecord.id).trustedRoot, undefined);
  history.setManagedRoot(root); assert.deepEqual(ledger.deleteHistory(externalRecord.id), { deleted: false, removed: true, removedCardIds: [] }); assert.equal(fs.readFileSync(external, 'utf8'), 'outside');
});

test('independent cards and duplicate history references keep a file until deletion is safe', t => {
  const { root, history, ledger, file } = fixture(t), media = file('clip.mp4'), record = history.add(input(media));
  const owned = ledger.register({ path: media, historyId: record.id }, root), independent = ledger.register({ path: media }, root);
  assert.equal(ledger.deleteCard(owned).deleted, false); assert.equal(fs.existsSync(media), true);
  assert.equal(ledger.deleteCard(independent).deleted, false); assert.equal(fs.existsSync(media), true);
  assert.equal(history.get(record.id).fileName, 'clip.mp4');
});

test('healthy historical media stays resolvable and deletable when the current root lookup throws', t => {
  const { dir, root, file } = fixture(t), media = file('old.mp4'), subtitle = file('old.srt', 'captions');
  const selection = new ManagedRootSelection(); selection.change(root, []);
  const store = path.join(dir, 'history.json');
  const history = new DownloadHistory(store, () => selection.current()), ledger = new DownloadLedger(history, () => false);
  const record = history.add({ ...input(media), subtitle: { filePath: subtitle } });
  const next = ManagedRoot.prepare(path.join(dir, 'next')); selection.change(next, []);
  assert.equal(history.resolve(record.id)?.path, media);
  fs.renameSync(next.verify(), path.join(dir, 'unavailable'));
  assert.throws(() => selection.current(), /Managed root.*safety check/);
  assert.equal(root.resolve(media), media);
  const resolved = history.resolve(record.id), companion = history.resolveSubtitle(record.id);
  const available = history.get(record.id).available, deletion = ledger.deleteHistory(record.id);
  assert.deepEqual({ path: resolved?.path ?? null, subtitle: companion?.path ?? null, available, deletion, mediaExists: fs.existsSync(media), subtitleExists: fs.existsSync(subtitle), record: history.get(record.id) }, {
    path: media, subtitle, available: true, deletion: { deleted: true, removed: true, removedCardIds: [] }, mediaExists: false, subtitleExists: false, record: null,
  });
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).records.length, 0);
});

test('relinking identical historical media keeps managed provenance when the current root verification fails', t => {
  const { dir, root, history, ledger, file } = fixture(t), media = file('old.mp4'), subtitle = file('old.srt', 'captions');
  const record = history.add({ ...input(media), subtitle: { filePath: subtitle } });
  const next = ManagedRoot.prepare(path.join(dir, 'next')); history.setManagedRoot(next);
  const nextPath = next.verify(), moved = path.join(dir, 'unavailable'); fs.renameSync(nextPath, moved);
  assert.throws(() => next.verify(), /Managed root.*safety check/);
  assert.equal(root.resolve(media), media);
  const relinked = history.relink(record.id, media), store = path.join(dir, 'history.json');
  const persisted = JSON.parse(fs.readFileSync(store, 'utf8')).records.find(hit => hit.id === record.id);
  assert.equal(relinked.available, true);
  assert.deepEqual({ managed: persisted.managed, trustedRoot: persisted.trustedRoot ?? null }, { managed: true, trustedRoot: root.verify() });
  assert.equal(history.resolve(record.id)?.path, media);
  assert.equal(history.resolve(record.id)?.trustedRoot, root);
  // Recover B as well: the identical-file relink must not have permanently discarded A's ownership.
  fs.renameSync(moved, nextPath); history.setManagedRoot(ManagedRoot.capture(nextPath));
  assert.deepEqual(ledger.deleteHistory(record.id), { deleted: true, removed: true, removedCardIds: [] });
  assert.equal(fs.existsSync(media), false); assert.equal(fs.existsSync(subtitle), false);
  assert.equal(history.get(record.id), null);
});
