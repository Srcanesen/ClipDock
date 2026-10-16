// Phase 6 follow-up: optional subtitle companion persistence.
// Deterministic tests for the main-only DownloadHistory seam: the public record
// exposes only {fileName, bytes, available} for a companion, the main-only
// resolveSubtitle() resolver returns a validated path (rejecting missing,
// symlinked, and unsupported files), old stores stay readable, malformed
// optional data fails closed without invalidating the media record, and record
// deletion removes the companion only under the same managed-root/symlink/
// protection rules as the media file.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {DownloadHistory, safeHistorySource} from '../dist/history.js';

test('Pinterest history source is canonical and rejects non-Pin persistence', () => {
  assert.equal(safeHistorySource('pinterest', 'https://pinterest.com/pin/123456789/?utm=x'), 'https://www.pinterest.com/pin/123456789/');
  assert.equal(safeHistorySource('pinterest', 'https://www.pinterest.com/board/example/'), null);
  assert.equal(safeHistorySource('pinterest', 'https://www.pinterest.com:443/pin/123456789/'), null);
});

function tempRoot(prefix) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function historyInput(over = {}) {
  return {
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    filePath: '',
    assetId: 'dQw4w9WgXcQ',
    title: 'Title',
    creator: 'Channel',
    profile: 'original',
    quality: 'best',
    mediaMode: 'video',
    selection: null,
    automation: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []},
    ...over,
  };
}

const SUBTITLE_TEXT = '1\n00:00:00,000 --> 00:00:01,000\nHi\n';

function storedRecord(over = {}) {
  return {
    id: 'old-1',
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    project: null,
    filePath: '',
    managed: true,
    fileName: 'clip.mp4',
    bytes: 5,
    assetId: 'dQw4w9WgXcQ',
    title: 'Title',
    creator: 'Channel',
    profile: 'original',
    quality: 'best',
    mediaMode: 'video',
    selection: null,
    automation: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []},
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  };
}

function writeStore(file, records) {
  writeFileSync(file, JSON.stringify({schemaVersion: 1, records}, null, 2));
}

test('add persists an optional subtitle companion and exposes only safe metadata', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const jobDir = path.join(root, 'youtube', 'download-1');
    mkdirSync(jobDir, {recursive: true});
    const media = path.join(jobDir, 'clip.mp4');
    const subtitle = path.join(jobDir, 'clip.en.srt');
    writeFileSync(media, 'media');
    writeFileSync(subtitle, SUBTITLE_TEXT);
    const history = new DownloadHistory(path.join(root, 'history.json'), root, () => 'Project');
    const record = history.add(historyInput({filePath: media, subtitle: {filePath: subtitle}}));

    assert.equal(record.available, true);
    assert.deepEqual(record.subtitle, {fileName: 'clip.en.srt', bytes: statSync(subtitle).size, available: true});
    assert.equal('filePath' in record, false);
    assert.equal('subtitlePath' in record, false, 'the stored path never appears on the public record');
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes(media) && !serialized.includes(subtitle), 'public payload carries no paths');
    assert.deepEqual(history.resolveSubtitle(record.id), {path: realpathSync(subtitle)});
    assert.equal(history.resolveSubtitle('unknown'), null);
    assert.equal(history.resolveSubtitle(null), null);
    assert.equal(history.resolveSubtitle(42), null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('managed provenance is persisted at creation, survives root changes, and stays main-only', () => {
  const root = tempRoot('clipdock-history-root-');
  const nextRoot = tempRoot('clipdock-history-next-');
  try {
    const media = path.join(root, 'youtube', 'clip.mp4');
    mkdirSync(path.dirname(media), {recursive: true});
    writeFileSync(media, 'media');
    const store = path.join(root, 'history.json');
    const history = new DownloadHistory(store, root);
    const added = history.add(historyInput({filePath: media}));
    const captured = realpathSync(root);
    const stored = JSON.parse(readFileSync(store, 'utf8')).records[0];
    assert.equal(stored.trustedRoot, captured, 'the managed root is captured with the record');
    assert.equal('trustedRoot' in added, false, 'public history DTOs never expose roots');
    assert.equal(history.resolve(added.id)?.trustedRoot?.verify(), captured);

    history.setManagedRoot(nextRoot);
    assert.equal(history.resolve(added.id)?.trustedRoot?.verify(), captured, 'changing the download folder cannot rebind old provenance');
    const reloaded = new DownloadHistory(store, nextRoot);
    assert.equal(reloaded.resolve(added.id)?.trustedRoot?.verify(), captured, 'persisted provenance survives restart');
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(nextRoot, {recursive: true, force: true});
  }
});

test('relinked history is external and never exposes a trusted root', () => {
  const root = tempRoot('clipdock-history-relink-root-');
  const outside = tempRoot('clipdock-history-relink-outside-');
  try {
    const managed = path.join(root, 'youtube', 'clip.mp4');
    const external = path.join(outside, 'external.mp4');
    mkdirSync(path.dirname(managed), {recursive: true});
    writeFileSync(managed, 'managed');
    writeFileSync(external, 'external');
    const history = new DownloadHistory(path.join(root, 'history.json'), root);
    const added = history.add(historyInput({filePath: managed}));
    assert.ok(history.relink(added.id, external));
    assert.equal(history.resolve(added.id)?.trustedRoot, undefined);
    assert.equal('trustedRoot' in history.get(added.id), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

test('restart read-back preserves safe subtitle metadata', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const jobDir = path.join(root, 'youtube', 'download-1');
    mkdirSync(jobDir, {recursive: true});
    const media = path.join(jobDir, 'clip.mp4');
    const subtitle = path.join(jobDir, 'clip.en.srt');
    writeFileSync(media, 'media');
    writeFileSync(subtitle, SUBTITLE_TEXT);
    const store = path.join(root, 'history.json');
    const first = new DownloadHistory(store, root);
    const added = first.add(historyInput({filePath: media, subtitle: {filePath: subtitle}}));

    const reloaded = new DownloadHistory(store, root);
    const record = reloaded.get(added.id);
    assert.ok(record, 'record survives restart');
    assert.equal(record.available, true);
    assert.deepEqual(record.subtitle, {fileName: 'clip.en.srt', bytes: statSync(subtitle).size, available: true});
    assert.deepEqual(reloaded.resolveSubtitle(added.id), {path: realpathSync(subtitle)});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('records without a companion (old stores) still load with subtitle null', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const media = path.join(root, 'youtube');
    mkdirSync(media);
    const clip = path.join(media, 'clip.mp4');
    writeFileSync(clip, 'media');
    const store = path.join(root, 'history.json');
    writeStore(store, [storedRecord({filePath: clip})]);

    const history = new DownloadHistory(store, root);
    const record = history.get('old-1');
    assert.ok(record, 'pre-companion record loads');
    assert.equal(record.available, true);
    assert.equal(record.subtitle, null);
    assert.equal(history.resolveSubtitle('old-1'), null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('malformed optional subtitle data fails closed without invalidating media', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const mediaDir = path.join(root, 'youtube');
    mkdirSync(mediaDir);
    const clip = path.join(mediaDir, 'clip.mp4');
    writeFileSync(clip, 'media');
    const store = path.join(root, 'history.json');

    for (const malformed of [42, {path: '/x/y.srt'}, null, true, 'notes.txt', 'clip.srt']) {
      const record = storedRecord({id: `m-${String(malformed).slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`, filePath: clip, subtitlePath: malformed});
      writeStore(store, [record]);
      const history = new DownloadHistory(store, root);
      const loaded = history.list()[0];
      assert.equal(loaded.available, true, `media record stays valid for subtitlePath=${JSON.stringify(malformed)}`);
      assert.equal(loaded.subtitle, null, `malformed companion fails closed for subtitlePath=${JSON.stringify(malformed)}`);
      assert.equal(history.resolveSubtitle(loaded.id), null);
    }

    // A stored .srt that is actually a symlink is kept as metadata but resolves
    // to nothing: unavailable companion, valid media record.
    const outside = path.join(root, 'outside.srt');
    writeFileSync(outside, SUBTITLE_TEXT);
    const linked = path.join(mediaDir, 'link.srt');
    symlinkSync(outside, linked);
    writeStore(store, [storedRecord({id: 'linked', filePath: clip, subtitlePath: linked})]);
    const history = new DownloadHistory(store, root);
    const record = history.get('linked');
    assert.equal(record.available, true);
    assert.deepEqual(record.subtitle, {fileName: 'link.srt', bytes: 0, available: false});
    assert.equal(history.resolveSubtitle('linked'), null, 'symlinked companion is never resolved');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('add ignores missing, unsupported, and symlinked subtitle inputs', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const jobDir = path.join(root, 'youtube', 'download-1');
    mkdirSync(jobDir, {recursive: true});
    const media = path.join(jobDir, 'clip.mp4');
    writeFileSync(media, 'media');
    const real = path.join(root, 'real.srt');
    writeFileSync(real, SUBTITLE_TEXT);
    const linked = path.join(jobDir, 'linked.srt');
    symlinkSync(real, linked);

    const history = new DownloadHistory(path.join(root, 'history.json'), root);
    const missing = history.add(historyInput({filePath: media, subtitle: {filePath: path.join(jobDir, 'gone.srt')}}));
    assert.equal(missing.available, true, 'missing subtitle never invalidates media');
    assert.equal(missing.subtitle, null);
    assert.equal(history.resolveSubtitle(missing.id), null);

    const unsupported = history.add(historyInput({filePath: media, subtitle: {filePath: path.join(jobDir, 'clip.txt')}}));
    assert.equal(unsupported.available, true);
    assert.equal(unsupported.subtitle, null);

    const symlinked = history.add(historyInput({filePath: media, subtitle: {filePath: linked}}));
    assert.equal(symlinked.available, true);
    assert.equal(symlinked.subtitle, null);
    assert.equal(history.resolveSubtitle(symlinked.id), null);
    assert.equal(existsSync(real), true, 'symlink target is untouched');

    const absent = history.add(historyInput({filePath: media}));
    assert.equal(absent.subtitle, null, 'no subtitle input stays null');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('delete removes the companion only with the media file under the same protections', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const jobDir = path.join(root, 'youtube', 'download-1');
    mkdirSync(jobDir, {recursive: true});
    const media = path.join(jobDir, 'clip.mp4');
    const subtitle = path.join(jobDir, 'clip.en.srt');
    const store = path.join(root, 'history.json');
    const history = new DownloadHistory(store, root);

    // Managed + unprotected: both files are deleted together.
    writeFileSync(media, 'media');
    writeFileSync(subtitle, SUBTITLE_TEXT);
    const free = history.add(historyInput({filePath: media, subtitle: {filePath: subtitle}}));
    assert.deepEqual(history.delete(free.id, []), {deleted: true, removed: true});
    assert.equal(existsSync(media), false);
    assert.equal(existsSync(subtitle), false, 'companion is removed with its media file');

    // Protected companion: media is deleted, companion is kept.
    writeFileSync(media, 'media');
    writeFileSync(subtitle, SUBTITLE_TEXT);
    const protectedCompanion = history.add(historyInput({filePath: media, subtitle: {filePath: subtitle}}));
    assert.deepEqual(history.delete(protectedCompanion.id, [subtitle]), {deleted: true, removed: true});
    assert.equal(existsSync(media), false);
    assert.equal(existsSync(subtitle), true, 'protected companion survives');

    // Symlinked companion: media is deleted, the symlink and its target survive.
    writeFileSync(media, 'media');
    const real = path.join(root, 'real.srt');
    writeFileSync(real, SUBTITLE_TEXT);
    const linked = path.join(jobDir, 'linked.srt');
    symlinkSync(real, linked);
    const symlinked = history.add(historyInput({filePath: media, subtitle: {filePath: linked}}));
    assert.deepEqual(history.delete(symlinked.id, []), {deleted: true, removed: true});
    assert.equal(existsSync(media), false);
    assert.equal(existsSync(linked), true, 'symlinked companion is never deleted');
    assert.equal(existsSync(real), true);

    // Unmanaged media (outside the managed root): nothing is deleted.
    const outside = tempRoot('clipdock-history-outside-');
    const outsideMedia = path.join(outside, 'clip.mp4');
    const outsideSubtitle = path.join(outside, 'clip.en.srt');
    writeFileSync(outsideMedia, 'media');
    writeFileSync(outsideSubtitle, SUBTITLE_TEXT);
    const unmanaged = history.add(historyInput({filePath: outsideMedia, subtitle: {filePath: outsideSubtitle}}));
    assert.deepEqual(history.delete(unmanaged.id, []), {deleted: false, removed: true});
    assert.equal(existsSync(outsideMedia), true);
    assert.equal(existsSync(outsideSubtitle), true);
    rmSync(outside, {recursive: true, force: true});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('relink keeps the subtitle companion', () => {
  const root = tempRoot('clipdock-history-sub-');
  try {
    const jobDir = path.join(root, 'youtube', 'download-1');
    mkdirSync(jobDir, {recursive: true});
    const media = path.join(jobDir, 'clip.mp4');
    const subtitle = path.join(jobDir, 'clip.en.srt');
    writeFileSync(media, 'media');
    writeFileSync(subtitle, SUBTITLE_TEXT);
    const store = path.join(root, 'history.json');
    const history = new DownloadHistory(store, root);
    const added = history.add(historyInput({filePath: media, subtitle: {filePath: subtitle}}));

    const replacement = path.join(root, 'replacement.mov');
    writeFileSync(replacement, 'replacement');
    const relinked = history.relink(added.id, replacement);
    assert.ok(relinked);
    assert.equal(relinked.fileName, 'replacement.mov');
    assert.deepEqual(relinked.subtitle, {fileName: 'clip.en.srt', bytes: statSync(subtitle).size, available: true});
    assert.deepEqual(history.resolveSubtitle(added.id), {path: realpathSync(subtitle)});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
