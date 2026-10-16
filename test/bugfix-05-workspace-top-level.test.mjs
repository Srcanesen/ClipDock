import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectWorkspace, cleanupWorkspace } from '../dist/workspace.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('files() includes top-level files directly under managedRoot', () => {
  const root = tempRoot('clipdock-ws-top-');
  try {
    mkdirSync(path.join(root, 'youtube'), { recursive: true });
    writeFileSync(path.join(root, 'youtube', 'keep.mp4'), 'keep');
    writeFileSync(path.join(root, 'top-level.txt'), 'top');
    writeFileSync(path.join(root, 'top-level.mp4'), 'top2');
    writeFileSync(path.join(root, '.DS_Store'), 'dot');
    writeFileSync(path.join(root, '.clipdock-owned'), 'marker');

    const summary = inspectWorkspace(root, []);
    // top-level .txt and .mp4 should be counted, .DS_Store and marker should not
    // provider file + 2 top-level = 3
    assert.equal(summary.fileCount, 3, `expected 3 counted files, got ${summary.fileCount}`);
    assert.equal(summary.cleanupFileCount, 3);

    const result = cleanupWorkspace(root, []);
    assert.equal(result.deletedFileCount, 3);
    assert.equal(existsSync(path.join(root, 'top-level.txt')), false, 'top-level.txt must be deleted');
    assert.equal(existsSync(path.join(root, 'top-level.mp4')), false);
    assert.equal(existsSync(path.join(root, '.DS_Store')), true, 'dotfiles protected');
    assert.equal(existsSync(path.join(root, '.clipdock-owned')), true, 'marker protected');
    assert.equal(existsSync(path.join(root, 'youtube', 'keep.mp4')), false, 'provider file deleted when not protected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('top-level protected files survive cleanup', () => {
  const root = tempRoot('clipdock-ws-top2-');
  try {
    mkdirSync(path.join(root, 'youtube'), { recursive: true });
    const keepTop = path.join(root, 'keep-top.mp4');
    writeFileSync(keepTop, 'keep');
    writeFileSync(path.join(root, 'old-top.mp4'), 'old');
    const summary = inspectWorkspace(root, [keepTop]);
    assert.equal(summary.fileCount, 2);
    assert.equal(summary.cleanupFileCount, 1);
    const result = cleanupWorkspace(root, [keepTop]);
    assert.equal(result.deletedFileCount, 1);
    assert.equal(existsSync(keepTop), true);
    assert.equal(existsSync(path.join(root, 'old-top.mp4')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
