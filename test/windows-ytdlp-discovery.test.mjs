import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverEnginePaths } from '../dist/main-process.js';
import { discoverFfmpeg, discoverJsRuntime, discoverYtdlp, YtdlpWorker } from '../dist/ytdlp.js';

const windows = { skip: process.platform !== 'win32' };

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-ytdlp-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('discovery worker finds yt-dlp when Windows inherits mixed-case Path', windows, async t => {
  const dir = workspace(t);
  const binary = path.join(dir, 'yt-dlp.exe');
  writeFileSync(binary, '');
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
  const wrapper = path.join(root, 'yt-dlp.bat');
  const [ytDlp, deno, ffmpeg] = ['yt-dlp.exe', 'deno.exe', 'ffmpeg.exe'].map(name => path.join(bin, name));
  for (const file of [wrapper, ytDlp, deno, ffmpeg]) writeFileSync(file, '');
  const env = { PATH: root, CLIPDOCK_YTDLP_PATH: wrapper, LOCALAPPDATA: root, ProgramFiles: root };
  assert.equal(discoverYtdlp(env, 'win32'), ytDlp);
  assert.equal(discoverJsRuntime(env, 'win32', undefined, () => ({ code: 0, text: 'deno 2.3.0' })), `deno:${deno}`);
  assert.equal(discoverFfmpeg(env, 'win32', undefined, () => ({ code: 0, text: 'ffmpeg version fixture' })), ffmpeg);
});

test('YouTube search returns the Windows install command when yt-dlp is missing', async t => {
  const worker = new YtdlpWorker(null, () => assert.fail('Unexpected spawn'), undefined, {
    platform: 'win32', sessionDir: workspace(t), ffmpegPath: null, ffprobePath: null,
  });
  await assert.rejects(worker.search('mountain landscape', 1), {
    message: 'yt-dlp was not found. Run winget install --id yt-dlp.yt-dlp --exact --scope user or set CLIPDOCK_YTDLP_PATH to an absolute executable path.',
  });
});
