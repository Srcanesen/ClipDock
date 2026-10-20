// macOS writes "._name" AppleDouble sidecars next to files on exFAT, FAT and SMB
// volumes. They are not stored media: one clip must count once.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {inspectWorkspace} from '../dist/workspace.js';

test('AppleDouble sidecars are transient, not stored media', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-appledouble-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const youtube = path.join(root, 'youtube');
  mkdirSync(youtube);
  writeFileSync(path.join(youtube, 'clip.mp4'), Buffer.alloc(1000));
  writeFileSync(path.join(youtube, '._clip.mp4'), Buffer.alloc(4096));
  assert.deepEqual(inspectWorkspace(root, [path.join(youtube, 'clip.mp4')]), {fileCount: 1, totalBytes: 1000, cleanupFileCount: 1, cleanupBytes: 4096});
});
