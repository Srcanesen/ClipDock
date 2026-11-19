import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverEnginePaths } from '../dist/main-process.js';
import { discoverFfprobe } from '../dist/media-prep.js';
import { discoverFfmpeg, discoverJsRuntime, discoverYtdlp, YtdlpWorker } from '../dist/ytdlp.js';
import { redirectFixtureProbes, writeNodeFixture } from './helpers/node-fixture.cjs';

const windows = { skip: process.platform !== 'win32' };
const ytDlpVersion = "if (process.argv[2] !== '--version') process.exit(1); console.log('2026.08.19');";

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-ytdlp-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('discovery worker finds yt-dlp when Windows inherits mixed-case Path', windows, async t => {
  const dir = workspace(t);
  const binary = writeNodeFixture(dir, 'yt-dlp', ytDlpVersion);
  const require = createRequire(import.meta.url);
  const threads = require('node:worker_threads');
  const preload = path.join(dir, 'fixture-probes.cjs');
  writeFileSync(preload,
    `require('node:child_process').spawnSync = require(${JSON.stringify(require.resolve('./helpers/node-fixture.cjs'))}).fixtureProbeSpawn(__dirname);`);
  t.mock.method(threads, 'Worker', class extends threads.Worker {
    constructor(filename, options) {
      super(filename, {...options, execArgv: ['--require', preload]});
    }
  });
  const originals = Object.entries(process.env).filter(([key]) => /^(path|clipdock_ytdlp_path)$/i.test(key));
  t.after(() => {
    delete process.env.Path;
    Object.assign(process.env, Object.fromEntries(originals));
  });
  delete process.env.PATH;
  delete process.env.CLIPDOCK_YTDLP_PATH;
  process.env.Path = dir;
  assert.equal((await discoverEnginePaths()).ytdlpPath, binary);
});

test('Windows ignores yt-dlp batch wrappers and finds user WinGet executables without PATH', windows, t => {
  const root = workspace(t);
  const bin = path.join(root, 'Microsoft', 'WinGet', 'Links');
  mkdirSync(bin, { recursive: true });
  redirectFixtureProbes(t, root);
  const wrapper = path.join(root, 'yt-dlp.bat');
  const ytDlp = writeNodeFixture(bin, 'yt-dlp', ytDlpVersion);
  const [deno, ffmpeg] = ['deno.exe', 'ffmpeg.exe'].map(name => path.join(bin, name));
  for (const file of [wrapper, deno, ffmpeg]) writeFileSync(file, '');
  const env = { PATH: root, CLIPDOCK_YTDLP_PATH: wrapper, LOCALAPPDATA: root, ProgramFiles: root };
  assert.equal(discoverYtdlp(env, 'win32'), ytDlp);
  assert.equal(discoverJsRuntime(env, 'win32', undefined, () => ({ code: 0, text: 'deno 2.3.0' })), `deno:${deno}`);
  assert.equal(discoverFfmpeg(env, 'win32', undefined, () => ({ code: 0, text: 'ffmpeg version fixture' })), ffmpeg);
});

test('Windows skips broken and empty yt-dlp executables before a working WinGet copy', windows, t => {
  const root = workspace(t);
  redirectFixtureProbes(t, root);
  const broken = writeNodeFixture(path.join(root, 'configured'), 'yt-dlp', "console.log('2026.08.19'); process.exitCode = 1;");
  const emptyDir = path.join(root, 'path');
  writeNodeFixture(emptyDir, 'yt-dlp', '');
  const valid = writeNodeFixture(path.join(root, 'Microsoft', 'WinGet', 'Links'), 'yt-dlp', ytDlpVersion);
  const env = { PATH: emptyDir, CLIPDOCK_YTDLP_PATH: broken, LOCALAPPDATA: root, ProgramFiles: root };
  assert.equal(discoverYtdlp(env, 'win32'), valid);
});

for (const [location, directories, exe] of [
  ['machine links', ['WinGet', 'Links'], 'ffmpeg.exe'],
  ['an unlinked package', ['Microsoft', 'WinGet', 'Packages', 'Portable.VideoTools', 'distribution', 'bin'], 'FFmpeg.EXE'],
]) {
  test(`Windows finds FFmpeg and FFprobe via WinGet ${location} without PATH`, windows, t => {
    const root = workspace(t);
    const bin = path.join(root, ...directories);
    mkdirSync(bin, { recursive: true });
    const binary = path.join(bin, exe);
    const probeBinary = path.join(bin, 'ffprobe.exe');
    writeFileSync(binary, '');
    writeFileSync(probeBinary, '');
    const env = { PATH: '', LOCALAPPDATA: root, ProgramFiles: root };
    assert.equal(discoverFfmpeg(env, 'win32', undefined, () => ({ code: 0, text: 'ffmpeg version fixture' })), binary);
    assert.equal(discoverFfprobe(null, env, 'win32', undefined, () => ({ code: 0, text: 'ffprobe version fixture' })), probeBinary);
  });
}

test('YouTube search returns the Windows install command when yt-dlp is missing', async t => {
  const worker = new YtdlpWorker(null, () => assert.fail('Unexpected spawn'), undefined, {
    platform: 'win32', sessionDir: workspace(t), ffmpegPath: null, ffprobePath: null,
  });
  await assert.rejects(worker.search('mountain landscape', 1), {
    message: 'yt-dlp was not found. Run winget install --id yt-dlp.yt-dlp --exact --scope user or set CLIPDOCK_YTDLP_PATH to an absolute executable path.',
  });
});
