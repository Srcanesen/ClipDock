import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chmodSync, lstatSync, readFileSync, renameSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerDownload} from './helpers/provider-job-main.mjs';

import {
  YtdlpWorker,
  discoverFfmpeg,
  discoverYtdlp,
  parseSubtitleCues,
} from '../dist/ytdlp.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = [];
  }
  kill(signal) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('close', 143));
    return true;
  }
}

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('yt-dlp discovery honors executable absolute overrides and PATH candidates', () => {
  const root = tempRoot('clipdock-ytdlp-discovery-');
  try {
    const binary = path.join(root, 'yt-dlp');
    const ffmpeg = path.join(root, 'ffmpeg');
    writeFileSync(binary, '#!/bin/sh\n');
    writeFileSync(ffmpeg, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    chmodSync(ffmpeg, 0o755);
    assert.equal(discoverYtdlp({CLIPDOCK_YTDLP_PATH: binary, PATH: ''}, 'linux', []), binary);
    assert.equal(discoverYtdlp({PATH: root}, 'linux', [root]), binary);
    assert.equal(discoverYtdlp({CLIPDOCK_YTDLP_PATH: 'relative', PATH: ''}, 'win32', []), null);
    assert.equal(discoverFfmpeg({CLIPDOCK_FFMPEG_PATH: ffmpeg, PATH: ''}, 'linux', [], () => ({code: 0, text: 'ffmpeg version 7.1'})), ffmpeg);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('subtitle parser returns bounded, cleaned cues', () => {
  const cues = parseSubtitleCues(`WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<b>Hello</b>  world\n\n00:00:03.000 --> 00:00:02.000\ninvalid\n`);
  assert.deepEqual(cues, [{start: 1, end: 2.5, text: 'Hello world'}]);
});

test('yt-dlp subtitles use the fixed metadata argv, parse SRT-compatible VTT, and clean the job directory', async () => {
  const root = tempRoot('clipdock-ytdlp-subtitles-');
  const calls = [];
  try {
    const spawn = (_binary, args, options) => {
      assert.deepEqual(options, {shell: false, detached: true});
      const child = new FakeChild();
      calls.push(args);
      const template = args[args.indexOf('-o') + 1];
      setImmediate(() => {
        mkdirSync(path.dirname(template), {recursive: true});
        writeFileSync(template.replace('%(ext)s', 'vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCaption <i>one</i>\n');
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new YtdlpWorker('/usr/local/bin/yt-dlp', spawn, undefined, {sessionDir: root});
    const cues = await worker.subtitles('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'en');
    assert.deepEqual(cues, [{start: 0, end: 1, text: 'Caption one'}]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--ignore-config'));
    assert.ok(calls[0].includes('--write-subs'));
    assert.ok(calls[0].includes('--write-auto-subs'));
    assert.ok(calls[0].includes('--sub-langs') && calls[0][calls[0].indexOf('--sub-langs') + 1] === 'en');
    assert.equal(calls[0].at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.deepEqual(readdirSync(root), []);
    assert.equal(worker.isActive(), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('yt-dlp dispose terminates an active subtitle process and leaves no session job', async () => {
  const root = tempRoot('clipdock-ytdlp-dispose-');
  let child;
  try {
    const spawn = () => {
      child = new FakeChild();
      return child;
    };
    const worker = new YtdlpWorker('/usr/local/bin/yt-dlp', spawn, undefined, {sessionDir: root, killGraceMs: 10});
    const pending = worker.subtitles('https://youtu.be/dQw4w9WgXcQ', 'tr');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.isActive(), true);
    worker.dispose();
    await assert.rejects(pending, /Subtitles were unavailable/);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('yt-dlp cancellation during subtitles cancels the whole job and removes media and partial captions', async () => {
  const root = tempRoot('clipdock-ytdlp-subtitle-cancel-');
  const ffmpeg = path.join(root, 'ffmpeg');
  writeFileSync(ffmpeg, '#!/bin/sh\n');
  chmodSync(ffmpeg, 0o755);
  let subtitleChild = null;
  let phase = 0;
  const events = [];
  const emit = (event) => events.push(event);
  const spawn = (_binary, args) => {
    phase += 1;
    if (args.includes('-show_streams')) {
      const child = new FakeChild();
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96}], format: {duration: '1', format_name: 'mov,mp4'}})); child.emit('close', 0); });
      return child;
    }
    if (args.includes('--write-subs')) {
      subtitleChild = new FakeChild();
      const dir = path.dirname(args[args.indexOf('-o') + 1]);
      writeFileSync(path.join(dir, 'clip.mp4'), 'partial media');
      writeFileSync(path.join(dir, 'clip.en.srt.part'), 'partial captions');
      queueMicrotask(() => subtitleChild.stdout.emit('data', 'Q|started\n'));
      return subtitleChild;
    }
    const child = new FakeChild();
    const template = args[args.indexOf('-o') + 1];
    const jobDir = path.dirname(template);
    setImmediate(() => {
      mkdirSync(jobDir, {recursive: true});
      const file = path.join(jobDir, 'My Video [dQw4w9WgXcQ].mp4');
      writeFileSync(file, Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(16)]));
      child.stdout.emit('data', `P|${file}\n`);
      child.emit('close', 0);
    });
    return child;
  };
  const worker = new YtdlpWorker('/usr/local/bin/yt-dlp', spawn, undefined, {sessionDir: root, ffmpegPath: ffmpeg, ffprobePath: '/fixture/ffprobe', killGraceMs: 5});
  const pending = worker.download('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', 'job-sub-cancel', emit, {mediaMode: 'video', audioFormat: 'mp3', subtitles: true, subtitleLanguage: 'en'});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.isActive(), true);
  assert.ok(subtitleChild, 'subtitle phase should have started');
  assert.equal(worker.cancel('job-sub-cancel') instanceof Promise, true);
  await assert.rejects(pending, /Download cancelled/);
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('download-')), []);
  assert.ok(subtitleChild.killed.includes('SIGTERM'));
  assert.equal(worker.isActive(), false);
  assert.ok(events.some((entry) => entry.state === 'processing'));
  rmSync(root, {recursive: true, force: true});
});

test('yt-dlp accepts cancellation at the starting event before spawning any process', async t => {
  const root = tempRoot('clipdock-ytdlp-before-spawn-');
  let spawned = 0, accepted = false;
  const worker = new YtdlpWorker('/fake/yt-dlp', () => {spawned++; return new FakeChild();}, undefined, {sessionDir: root, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
  t.after(async () => {await worker.dispose(); rmSync(root, {recursive: true, force: true});});
  const events = [];
  await assert.rejects(providerDownload(worker, {url: 'https://youtu.be/dQw4w9WgXcQ', jobId: 'before-spawn', emit: event => {
    events.push(event);
    if (event.message === 'Starting download…') accepted = worker.cancel('before-spawn');
  }}), {message: 'Download cancelled.'});
  assert.notEqual(accepted, null); await accepted;
  assert.equal(spawned, 0);
  assert.deepEqual(events.filter(event => event.state === 'cancelled'), [{jobId: 'before-spawn', state: 'cancelled', percent: null, message: 'Download cancelled.'}]);
  assert.equal(worker.isActive(), false);
  assert.equal(readdirSync(root).some(name => name.startsWith('download-')), false);
});

test('yt-dlp cancellation preserves a replacement of its private job directory', async t => {
  const root = tempRoot('clipdock-ytdlp-directory-swap-');
  const moved = path.join(root, 'moved-job');
  let directory, spawns = 0, cancellation;
  const worker = new YtdlpWorker('/fixture/yt-dlp', () => {spawns++; throw new Error('Unexpected spawn');}, undefined, {sessionDir: root, ffmpegPath: '/fixture/ffmpeg'});
  t.after(async () => {await worker.dispose(); rmSync(root, {recursive: true, force: true});});
  await assert.rejects(providerDownload(worker, {url: 'https://youtu.be/dQw4w9WgXcQ', jobId: 'job', emit: event => {
    if (event.message !== 'Starting download…') return;
    directory = path.join(root, readdirSync(root).find(name => name.startsWith('download-')));
    const owned = lstatSync(directory);
    renameSync(directory, moved);
    mkdirSync(directory);
    assert.notEqual(lstatSync(directory).ino, owned.ino);
    writeFileSync(path.join(directory, 'user-media.mov'), 'irreplaceable user media');
    cancellation = worker.cancel('job');
  }}), {message: 'Download cancelled.'});
  assert.notEqual(cancellation, null); await cancellation;
  assert.equal(spawns, 0);
  assert.equal(readFileSync(path.join(directory, 'user-media.mov'), 'utf8'), 'irreplaceable user media');
  assert.equal(lstatSync(moved).isDirectory(), true);
  assert.equal(worker.isActive(), false);
});
