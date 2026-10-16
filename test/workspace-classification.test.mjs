// Phase 6 follow-up: truthful workspace classification and cleanup accounting.
// Deterministic tests for inspectWorkspace/cleanupWorkspace: user-facing counts
// separate media + companions from transient (.part/temp/.ytdl) and diagnostic
// (clipdock.log) files, while cleanup accounting counts exactly the unprotected
// files cleanup will delete — including stale transient/diagnostic files —
// without weakening symlink or managed-root protections.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {cleanupWorkspace, inspectWorkspace} from '../dist/workspace.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const bytes = (text) => Buffer.byteLength(text, 'utf8');

test('user-facing counts exclude transient and diagnostic files but include companions', () => {
  const root = tempRoot('clipdock-ws-class-');
  try {
    const youtube = path.join(root, 'youtube');
    mkdirSync(youtube);
    const files = {
      'clip.mp4': 'media-body',           // media
      'clip.en.srt': '1\n00:00:00,000 --> 00:00:01,000\nHi\n', // companion
      'notes.txt': 'notes',               // unclassified content keeps the historical default
      'clip.mp4.part': 'partial',         // transient
      'clip.mp4.ytdl': 'meta',            // transient
      'stale.tmp': 'temp',                // transient
      'clipdock.log': 'log',              // diagnostic
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(youtube, name), content);
    const contentBytes = bytes(files['clip.mp4']) + bytes(files['clip.en.srt']) + bytes(files['notes.txt']);
    const cleanupBytes = Object.values(files).reduce((sum, content) => sum + bytes(content), 0);

    const summary = inspectWorkspace(root, []);
    assert.equal(summary.fileCount, 3, 'media + companion + unclassified content, never transient/diagnostic');
    assert.equal(summary.totalBytes, contentBytes);
    assert.equal(summary.cleanupFileCount, 7, 'cleanup accounting covers every unprotected file cleanup will delete');
    assert.equal(summary.cleanupBytes, cleanupBytes);

    const result = cleanupWorkspace(root, []);
    assert.deepEqual(result, {deletedFileCount: 7, deletedBytes: cleanupBytes, fileCount: 0, totalBytes: 0});
    for (const name of Object.keys(files)) assert.equal(existsSync(path.join(youtube, name)), false, `${name} was cleaned`);
    assert.equal(existsSync(youtube), false, 'empty provider directories are pruned');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('cleanup accounting matches deletion exactly and protects listed files', () => {
  const root = tempRoot('clipdock-ws-class-');
  try {
    const youtube = path.join(root, 'youtube');
    mkdirSync(youtube);
    const keep = path.join(youtube, 'keep.mp4');
    const old = path.join(youtube, 'old.mp4');
    const subtitle = path.join(youtube, 'old.en.srt');
    const part = path.join(youtube, 'old.mp4.part');
    const log = path.join(youtube, 'clipdock.log');
    writeFileSync(keep, 'keep');
    writeFileSync(old, 'old-file');
    writeFileSync(subtitle, 'cues');
    writeFileSync(part, 'partial');
    writeFileSync(log, 'log');

    const summary = inspectWorkspace(root, [keep]);
    assert.equal(summary.fileCount, 3, 'keep + old media + companion');
    assert.equal(summary.totalBytes, bytes('keep') + bytes('old-file') + bytes('cues'));
    assert.equal(summary.cleanupFileCount, 4, 'protected keep.mp4 is excluded, stale companion/partial/log are included');
    assert.equal(summary.cleanupBytes, bytes('old-file') + bytes('cues') + bytes('partial') + bytes('log'));

    const result = cleanupWorkspace(root, [keep]);
    assert.deepEqual(result, {
      deletedFileCount: 4,
      deletedBytes: bytes('old-file') + bytes('cues') + bytes('partial') + bytes('log'),
      fileCount: 1,
      totalBytes: bytes('keep'),
    });
    assert.equal(existsSync(keep), true, 'protected media survives');
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(subtitle), false);
    assert.equal(existsSync(part), false);
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('symlinked and outside-root files are never counted or deleted', () => {
  const root = tempRoot('clipdock-ws-class-');
  const outside = tempRoot('clipdock-ws-outside-');
  try {
    const youtube = path.join(root, 'youtube');
    mkdirSync(youtube);
    const realMedia = path.join(outside, 'real.mp4');
    const realSubtitle = path.join(outside, 'real.srt');
    writeFileSync(realMedia, 'outside-media');
    writeFileSync(realSubtitle, 'outside-cues');
    symlinkSync(realMedia, path.join(youtube, 'link.mp4'));
    symlinkSync(realSubtitle, path.join(youtube, 'link.srt'));
    symlinkSync(realMedia, path.join(youtube, 'link.mp4.part'));

    const summary = inspectWorkspace(root, []);
    assert.deepEqual(summary, {fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0});

    const result = cleanupWorkspace(root, []);
    assert.deepEqual(result, {deletedFileCount: 0, deletedBytes: 0, fileCount: 0, totalBytes: 0});
    for (const name of ['link.mp4', 'link.srt', 'link.mp4.part']) assert.equal(existsSync(path.join(youtube, name)), true, `${name} symlink survives`);
    assert.equal(readFileSync(realMedia, 'utf8'), 'outside-media', 'outside target is untouched');
    assert.equal(readFileSync(realSubtitle, 'utf8'), 'outside-cues', 'outside subtitle target is untouched');
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

test('classification is case-insensitive for extensions and scoped to the managed provider roots', () => {
  const root = tempRoot('clipdock-ws-class-');
  try {
    const social = path.join(root, 'social');
    const pexels = path.join(root, 'pexels');
    mkdirSync(social, {recursive: true});
    mkdirSync(pexels, {recursive: true});
    // Uppercase transient/companion extensions are still classified.
    writeFileSync(path.join(social, 'clip.MP4'), 'social');
    writeFileSync(path.join(social, 'clip.SRT'), 'cues');
    writeFileSync(path.join(pexels, 'photo-1.PART'), 'partial');
    // The diagnostic log name is exact; sibling logs are unclassified content.
    writeFileSync(path.join(social, 'CLIPDOCK.LOG'), 'log');

    const summary = inspectWorkspace(root, []);
    assert.equal(summary.fileCount, 3, 'media + companion + unclassified CLIPDOCK.LOG');
    assert.equal(summary.cleanupFileCount, 4);

    // Top-level files directly under managedRoot are now counted (except dotfiles); root log is diagnostic.
    writeFileSync(path.join(root, 'root.mp4'), 'root-level');
    writeFileSync(path.join(root, 'clipdock.log'), 'root-log');
    const scoped = inspectWorkspace(root, []);
    assert.equal(scoped.fileCount, 4, 'root-level media is now counted');
    assert.equal(scoped.cleanupFileCount, 6, 'top-level files are included in cleanup');
    assert.equal(scoped.totalBytes, summary.totalBytes + bytes('root-level'));
    assert.equal(scoped.cleanupBytes, summary.cleanupBytes + bytes('root-level') + bytes('root-log'));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
