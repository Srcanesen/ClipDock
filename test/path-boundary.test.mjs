import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalRoot, contains, regularFile, isSafeMediaFile } from '../dist/path-boundary.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// canonicalRoot
test('canonicalRoot accepts real directory and rejects symlink / file / relative', () => {
  const root = tempRoot('clipdock-pb-canonical-');
  try {
    const dir = path.join(root, 'real');
    mkdirSync(dir);
    const symlink = path.join(root, 'link');
    symlinkSync(dir, symlink);
    const file = path.join(root, 'file.txt');
    writeFileSync(file, 'x');

    const canonical = canonicalRoot(dir);
    assert.equal(canonical, realpathSync(dir));
    assert.equal(canonicalRoot(symlink), null, 'symlink root must be rejected');
    assert.equal(canonicalRoot(file), null, 'file as root must be rejected');
    assert.equal(canonicalRoot('relative/path'), null);
    assert.equal(canonicalRoot(path.join(root, 'missing')), null);
    // resolved symlink directory is directory but original lstat is symlink => reject
    // also ensure canonical after realpath not symlink
    assert.equal(canonicalRoot(root), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonicalRoot rejects directory that resolves to symlink', () => {
  const root = tempRoot('clipdock-pb-canonical2-');
  const outside = tempRoot('clipdock-pb-outside-');
  try {
    const target = path.join(outside, 'target');
    mkdirSync(target);
    const link = path.join(root, 'linkdir');
    symlinkSync(target, link);
    // link itself is symlink, should be rejected at first lstat
    assert.equal(canonicalRoot(link), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// regularFile
test('regularFile accepts regular file, rejects symlink and directory', () => {
  const root = tempRoot('clipdock-pb-regular-');
  try {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'hello');
    const link = path.join(root, 'link.txt');
    symlinkSync(file, link);
    const dir = path.join(root, 'subdir');
    mkdirSync(dir);

    assert.equal(regularFile(file), realpathSync(file));
    assert.equal(regularFile(link), null, 'symlink file must be rejected');
    assert.equal(regularFile(dir), null, 'directory must be rejected');
    assert.equal(regularFile(path.join(root, 'missing.txt')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regularFile returns canonical realpath for symlink-free file', () => {
  const root = tempRoot('clipdock-pb-regular2-');
  try {
    const file = path.join(root, 'b.mp4');
    writeFileSync(file, 'data');
    const result = regularFile(file);
    assert.ok(result, 'should return path');
    assert.equal(result, realpathSync(file));
    assert.equal(statSync(result).isFile(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// contains
test('contains enforces managed-root containment including .. and symlink escape', () => {
  const root = tempRoot('clipdock-pb-contains-');
  const outside = tempRoot('clipdock-pb-contains-out-');
  try {
    const fileInside = path.join(root, 'youtube', 'clip.mp4');
    mkdirSync(path.dirname(fileInside), { recursive: true });
    writeFileSync(fileInside, 'inside');

    const fileOutside = path.join(outside, 'evil.mp4');
    writeFileSync(fileOutside, 'outside');

    // direct inside
    assert.equal(contains(root, fileInside), true);
    // outside via absolute path
    assert.equal(contains(root, fileOutside), false);
    // .. traversal - file that is inside but path contains .. segments should still resolve inside
    // Create a file and reference via .. path that resolves inside
    const viaDotDot = path.join(root, 'youtube', '..', 'youtube', 'clip.mp4');
    assert.equal(contains(root, viaDotDot), true, '.. that resolves inside should be allowed');

    // file that resolves via symlink outside: create symlink inside root pointing outside
    const evilLink = path.join(root, 'link.mp4');
    symlinkSync(fileOutside, evilLink);
    assert.equal(contains(root, evilLink), false, 'symlink escape via realpath must be rejected (resolves outside)');

    // root itself vs file == root should be false (strict)
    assert.equal(contains(root, root), false);

    // parent traversal from outside
    assert.equal(contains(root, path.join(root, '..', path.basename(outside), 'evil.mp4')), false);

    // different root file
    assert.equal(contains(fileOutside, fileInside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('contains tightens with isAbsolute check for absolute relative edge', () => {
  const root = tempRoot('clipdock-pb-abs-');
  try {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');
    // On posix relative never returns absolute, but we verify contains handles isAbsolute correctly
    // Simulate Windows-style: we check that contains rejects when relative would be absolute (different drive)
    // On posix, we can verify that an absolute file outside still fails, and contains returns false for non-absolute root
    assert.equal(contains('relative', file), false, 'relative root must fail');
    assert.equal(contains(root, 'relative.txt'), false, 'relative file must fail');
    // absolute-rel edge: if file is absolute and root is absolute, relative is not absolute => normal check
    assert.equal(contains(root, file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('contains rejects symlink root', () => {
  const root = tempRoot('clipdock-pb-contains-symroot-');
  try {
    const real = path.join(root, 'real');
    mkdirSync(real);
    const file = path.join(real, 'file.mp4');
    writeFileSync(file, 'x');
    const linkRoot = path.join(root, 'linkroot');
    symlinkSync(real, linkRoot);
    assert.equal(contains(linkRoot, file), false, 'symlink root must be rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isSafeMediaFile wrapper preserves symlink and containment semantics', () => {
  const root = tempRoot('clipdock-pb-issafe-');
  try {
    const file = path.join(root, 'ok.mp4');
    writeFileSync(file, 'data');
    const link = path.join(root, 'link.mp4');
    symlinkSync(file, link);
    assert.equal(isSafeMediaFile(file), true);
    assert.equal(isSafeMediaFile(link), false);
    assert.equal(isSafeMediaFile(file, root), true);
    assert.equal(isSafeMediaFile(link, root), false);
    assert.equal(isSafeMediaFile(file, path.join(root, 'missing')), false);
    assert.equal(isSafeMediaFile(file, null), false, 'null root must fail closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
