import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {discoverFfmpeg} from '../dist/ytdlp.js';
import {discoverFfprobe} from '../dist/media-prep.js';

// Discovery tests must not depend on a system FFmpeg install. Executable
// fixture scripts (never a real FFmpeg) cover the real bounded `-version`
// probe path; an injected probe covers rejection/fallback mechanics without
// spawning anything.

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function fixture(root, name, body) {
  const file = path.join(root, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function binDirs(root, names) {
  return names.map(name => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    return dir;
  });
}

test('ffmpeg discovery rejects wrong identity, nonzero, and timeout candidates until the first valid one', () => {
  const root = tempRoot('clipdock-ffmpeg-valid-');
  try {
    const [d1, d2, d3, d4] = binDirs(root, ['bin1', 'bin2', 'bin3', 'bin4']);
    for (const dir of [d1, d2, d3, d4]) fixture(dir, 'ffmpeg', 'exit 0');
    const calls = [];
    const probe = candidate => {
      calls.push(candidate);
      if (candidate === path.join(d1, 'ffmpeg')) return {code: 0, text: 'ffprobe version 7.1'}; // wrong identity
      if (candidate === path.join(d2, 'ffmpeg')) return {code: 2, text: 'ffmpeg version 7.1'}; // nonzero exit
      if (candidate === path.join(d3, 'ffmpeg')) return {code: null, text: ''}; // probe timeout shape
      return {code: 0, text: 'ffmpeg version 8.1.2 fixture'}; // valid
    };
    const found = discoverFfmpeg({PATH: [d1, d2, d3, d4].join(path.delimiter)}, 'linux', undefined, probe);
    assert.equal(found, path.join(d4, 'ffmpeg'));
    assert.deepEqual(calls, [path.join(d1, 'ffmpeg'), path.join(d2, 'ffmpeg'), path.join(d3, 'ffmpeg'), path.join(d4, 'ffmpeg')]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('valid env override wins first and PATH candidates are never probed', () => {
  const root = tempRoot('clipdock-ffmpeg-override-');
  try {
    const override = fixture(root, 'ffmpeg', 'exit 0');
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    fixture(dir, 'ffmpeg', 'exit 0');
    const calls = [];
    const probe = candidate => { calls.push(candidate); return {code: 0, text: 'ffmpeg version 7.1'}; };
    const found = discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: override, PATH: dir}, 'linux', undefined, probe);
    assert.equal(found, override);
    assert.deepEqual(calls, [override]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('invalid env override is rejected and discovery falls back to PATH candidates', () => {
  const root = tempRoot('clipdock-ffmpeg-fallback-');
  try {
    const override = fixture(root, 'ffmpeg-broken', 'exit 0');
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const valid = fixture(dir, 'ffmpeg', 'exit 0');
    const calls = [];
    const probe = candidate => {
      calls.push(candidate);
      return candidate === valid ? {code: 0, text: 'ffmpeg version 7.1'} : {code: 1, text: 'ffmpeg version 7.1'};
    };
    const found = discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: override, PATH: dir}, 'linux', undefined, probe);
    assert.equal(found, valid);
    assert.deepEqual(calls, [override, valid]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('probe results are cached for the process lifetime', () => {
  const root = tempRoot('clipdock-ffmpeg-cache-');
  try {
    const override = fixture(root, 'ffmpeg', 'exit 0');
    let calls = 0;
    const probe = () => { calls += 1; return {code: 0, text: 'ffmpeg version 7.1'}; };
    const env = {CLIPDOCK_FFMPEG_PATH: override, PATH: ''};
    assert.equal(discoverFfmpeg(env, 'linux', [], probe), override);
    assert.equal(discoverFfmpeg(env, 'linux', [], probe), override);
    assert.equal(calls, 2, 'version probe cache was removed so binary replacement via mtime is detected (each discover re-probes)');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('spawn-error probes (null) and nonexistent candidates are rejected without probing', () => {
  const root = tempRoot('clipdock-ffmpeg-none-');
  try {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const calls = [];
    const probe = candidate => { calls.push(candidate); return null; };
    assert.equal(discoverFfmpeg({PATH: dir}, 'linux', undefined, probe), null);
    assert.deepEqual(calls, []); // no executable candidate, so nothing is probed
    const missing = fixture(root, 'ffmpeg-broken', 'exit 0');
    assert.equal(discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: missing, PATH: ''}, 'linux', [], () => null), null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('real fixture scripts pass the bounded -version probe with the expected identity and exit code', () => {
  const root = tempRoot('clipdock-ffmpeg-fixture-');
  try {
    const [d1, d2, d3] = binDirs(root, ['wrong', 'nonzero', 'valid']);
    fixture(d1, 'ffmpeg', "printf 'ffprobe version 99.0 fixture\\n'"); // wrong identity
    fixture(d2, 'ffmpeg', "printf 'ffmpeg version 99.0 fixture\\n'\nexit 3"); // nonzero exit
    // The fixture only exits 0 when the probe passes `-version` as its first argument.
    const valid = fixture(d3, 'ffmpeg', '[ \"$1\" = \"-version\" ] || exit 7\nprintf \'ffmpeg version 99.0 fixture\\n\'');
    const found = discoverFfmpeg({PATH: [d1, d2, d3].join(path.delimiter)}, 'linux');
    assert.equal(found, valid);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('hanging fixture is bounded by the probe timeout and rejected', () => {
  const root = tempRoot('clipdock-ffmpeg-timeout-');
  try {
    fixture(root, 'ffmpeg', 'sleep 60');
    const started = Date.now();
    const found = discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: path.join(root, 'ffmpeg'), PATH: ''}, 'linux');
    const elapsed = Date.now() - started;
    assert.equal(found, null);
    assert.ok(elapsed < 10_000, `probe timeout was not bounded (took ${elapsed}ms)`);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('ffprobe discovery mirrors ffmpeg validation with its own identity', () => {
  const root = tempRoot('clipdock-ffprobe-');
  try {
    const override = fixture(root, 'ffprobe', 'exit 0');
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const valid = fixture(dir, 'ffprobe', 'exit 0');
    const calls = [];
    const probe = candidate => {
      calls.push(candidate);
      if (candidate === override) return {code: 0, text: 'ffmpeg version 7.1'}; // wrong identity for ffprobe
      if (candidate === valid) return {code: 0, text: 'ffprobe version 7.1'};
      return {code: 1, text: ''};
    };
    assert.equal(discoverFfprobe(null, {CLIPDOCK_FFPROBE_PATH: override, PATH: dir}, 'linux', undefined, probe), valid);
    assert.deepEqual(calls, [override, valid]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('ffprobe discovery prefers the ffmpeg sibling candidate before PATH', () => {
  const root = tempRoot('clipdock-ffprobe-sibling-');
  try {
    fixture(root, 'ffmpeg', 'exit 0');
    const sibling = fixture(root, 'ffprobe', 'exit 0');
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const calls = [];
    const probe = candidate => { calls.push(candidate); return {code: 0, text: 'ffprobe version 7.1'}; };
    const found = discoverFfprobe(path.join(root, 'ffmpeg'), {PATH: dir}, 'linux', undefined, probe);
    assert.equal(found, sibling);
    assert.deepEqual(calls, [sibling]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('win32 discovery keeps the override-first candidate order and rejects nothing silently', () => {
  const calls = [];
  const probe = candidate => { calls.push(candidate); return null; };
  assert.equal(discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: 'C:\\bad\\ffmpeg.exe', PATH: ''}, 'win32', [], probe), null);
  assert.equal(discoverFfprobe(null, {CLIPDOCK_FFPROBE_PATH: 'C:\\bad\\ffprobe.exe', PATH: ''}, 'win32', [], probe), null);
  assert.deepEqual(calls, []); // nonexistent overrides are never probed
});
