import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {YtdlpWorker, discoverJsRuntime} from '../dist/ytdlp.js';

// Regression: inside Resolve the panel inherits a minimal PATH, yt-dlp finds no
// JavaScript runtime, cannot solve YouTube's player challenge and downloads fail
// with HTTP 403. ClipDock must find the runtime itself and hand it to yt-dlp.

function fixture(dir, name, output) {
  mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(file, 0o755);
  return file;
}

test('JS runtime discovery finds deno in ~/.deno/bin when PATH does not list it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-jsrt-deno-'));
  try {
    const deno = fixture(path.join(root, '.deno', 'bin'), 'deno', 'deno 2.3.0 (stable)');
    assert.equal(discoverJsRuntime({HOME: root, PATH: '/nonexistent'}, 'linux'), `deno:${deno}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('JS runtime discovery falls back to node and rejects impostors', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-jsrt-node-'));
  try {
    const bin = path.join(root, 'bin');
    fixture(bin, 'deno', 'not a runtime');
    const node = fixture(bin, 'node', 'v22.3.0');
    assert.equal(discoverJsRuntime({HOME: root, PATH: bin}, 'linux'), `node:${node}`);
    assert.equal(discoverJsRuntime({HOME: root, PATH: '/nonexistent'}, 'linux'), null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('yt-dlp is started with the discovered JS runtime, and without the flag when none exists', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-jsrt-worker-'));
  try {
    const calls = [];
    const spawn = (command, args) => { calls.push(args); throw new Error('spawn blocked in test'); };
    const withRuntime = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, {sessionDir: path.join(root, 'a'), ffmpegPath: null, ffprobePath: null, jsRuntime: 'deno:/opt/deno'});
    await withRuntime.search('drone city night', 1).catch(() => {});
    const without = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, {sessionDir: path.join(root, 'b'), ffmpegPath: null, ffprobePath: null, jsRuntime: null});
    await without.search('drone city night', 1).catch(() => {});
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 3), ['--ignore-config', '--js-runtimes', 'deno:/opt/deno']);
    assert.equal(calls[1].includes('--js-runtimes'), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
