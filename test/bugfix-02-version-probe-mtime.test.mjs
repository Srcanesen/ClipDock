import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverGalleryDl } from '../dist/gallerydl.js';
import { discoverFfmpeg } from '../dist/ytdlp.js';
import { discoverFfprobe } from '../dist/media-prep.js';

function tempExecutable(name) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-'));
  const file = path.join(dir, name);
  writeFileSync(file, '#!/bin/sh\necho hi\n');
  chmodSync(file, 0o755);
  return { dir, file };
}

test('gallery-dl version_probe cache invalidates on mtime change', () => {
  const { dir, file } = tempExecutable('gallery-dl');
  try {
    let call = 0;
    const probe = (candidate) => {
      call += 1;
      if (candidate !== file) return null;
      return call === 1 ? { code: 0, text: 'gallery-dl 1.28.0' } : { code: 0, text: 'gallery-dl 1.27.9' };
    };
    const env = { PATH: '', CLIPDOCK_GALLERYDL_PATH: file, HOME: dir };
    const first = discoverGalleryDl(env, 'linux', [], probe);
    assert.equal(first, file, 'first discover should succeed');
    // bump mtime
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
    // second call same probe instance; old cache would still return file despite unsupported version
    const second = discoverGalleryDl(env, 'linux', [], probe);
    assert.equal(second, null, 'after mtime change, unsupported version must be re-probed and rejected');
    assert.equal(call, 2, 'probe must have been called again after mtime change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpeg version probe cache invalidates on mtime change', () => {
  const { dir, file } = tempExecutable('ffmpeg');
  try {
    let call = 0;
    const probe = (candidate) => {
      call += 1;
      if (candidate !== file) return null;
      return call === 1 ? { code: 0, text: 'ffmpeg version 6.0' } : { code: 0, text: 'not ffmpeg' };
    };
    const env = { PATH: '', CLIPDOCK_FFMPEG_PATH: file, HOME: dir };
    const first = discoverFfmpeg(env, 'linux', [], probe);
    assert.equal(first, file);
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
    const second = discoverFfmpeg(env, 'linux', [], probe);
    assert.equal(second, null);
    assert.equal(call, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ffprobe version probe cache invalidates on mtime change', () => {
  const { dir, file } = tempExecutable('ffprobe');
  try {
    let call = 0;
    const probe = (candidate) => {
      call += 1;
      if (candidate !== file) return null;
      return call === 1 ? { code: 0, text: 'ffprobe version 6.0' } : { code: 0, text: 'old' };
    };
    const env = { PATH: '', CLIPDOCK_FFPROBE_PATH: file, HOME: dir };
    const first = discoverFfprobe(null, env, 'linux', [], probe);
    assert.equal(first, file);
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
    const second = discoverFfprobe(null, env, 'linux', [], probe);
    assert.equal(second, null);
    assert.equal(call, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
