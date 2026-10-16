import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnBounded} from '../dist/provider-platform.js';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', 143)); return true; }
}
test('ENG-6: UTF-8 lines survive split bytes', async () => {
  const child = new Child(), lines = [];
  const pending = spawnBounded('fixture', [], () => child, {onLine: line => lines.push(line)});
  const bytes = Buffer.from('P|café.mp4\n');
  child.stdout.emit('data', bytes.subarray(0, 6));
  child.stdout.emit('data', bytes.subarray(6));
  child.emit('close', 0);
  assert.equal((await pending).stdout, 'P|café.mp4\n');
  assert.deepEqual(lines, ['P|café.mp4']);
});
test('ENG-19/PRV-20: callback output stops at the total byte limit and terminates promptly', async () => {
  const child = new Child(), lines = [];
  const pending = spawnBounded('fixture', [], () => child, {maxStdout: 8, onLine: line => lines.push(line), killGraceMs: 5});
  child.stdout.emit('data', Buffer.from('a\na\na\na\na\na\n'));
  child.stdout.emit('data', Buffer.from('b\n'.repeat(100)));
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.stdoutTruncated, true);
  assert.equal(lines.join('').includes('b'), false);
  assert.ok(lines.join('\n').length <= 8);
  assert.ok(child.signals.includes('SIGTERM'));
});
test('ENG-10/SHL-9: job cancellation owns metadata preflight and cleans it before disposal resolves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-preflight-'));
  const child = new Child();
  const worker = new YtdlpWorker('/fixture', () => child, undefined, {sessionDir: root, killGraceMs: 5});
  let pending;
  try {
    pending = worker.metadata('https://youtu.be/dQw4w9WgXcQ', {jobId: 'queued', emit: () => {}});
    const rejected = assert.rejects(pending, /cancelled/i);
    void rejected.catch(() => {});
    worker.cancel('queued');
    await worker.dispose();
    await rejected;
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('metadata-')), []);
  } finally { await worker.dispose(); await pending?.catch(() => {}); rmSync(root, {recursive: true, force: true}); }
});

import {spawn as nodeSpawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {GalleryDlWorker} from '../dist/gallerydl.js';
import {createMediaPrep} from '../dist/media-prep.js';
const {awaitEngineShutdown} = await import('../dist/provider-platform.js');
const url = 'https://youtu.be/dQw4w9WgXcQ';
const options = {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'};
const videoProbe = (duration = 10) => JSON.stringify({streams: [{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', duration: String(duration)}], format: {duration: String(duration), format_name: 'mov,mp4', tags: {major_brand: 'isom'}}});
function downloader(root, {name = 'café.mp4', size = 24, probe = videoProbe(), residue = false, chunks = []} = {}) {
  const calls = [];
  const spawn = (_binary, args) => {
    calls.push(args);
    const child = new Child();
    queueMicrotask(() => {
      if (args.includes('-show_streams')) child.stdout.emit('data', Buffer.from(probe));
      else if (args.includes('--write-subs')) {
        const directory = dirname(args[args.indexOf('-o') + 1].replace(/%%/g, '%'));
        writeFileSync(join(directory, 'full.en.srt'), '1\n00:00:08,000 --> 00:00:11,000\nFirst\n\n2\n00:00:12,000 --> 00:00:14,000\nMiddle\n\n3\n00:00:19,000 --> 00:00:22,000\nLast\n\n4\n00:00:30,000 --> 00:00:31,000\nOutside\n');
        writeFileSync(join(directory, 'captions.part'), 'partial');
      }
      if (!args.includes('-show_streams') && !args.includes('--skip-download')) {
        const directory = dirname(args[args.indexOf('-o') + 1].replace(/%%/g, '%'));
        const file = join(directory, name);
        writeFileSync(file, Buffer.alloc(Math.min(size, 24))); if (size > 24) truncateSync(file, size);
        if (residue) { writeFileSync(join(directory, 'temp.part'), 'partial'); mkdirSync(join(directory, 'scratch')); writeFileSync(join(directory, 'scratch', 'tmp'), 'tmp'); }
        for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
        const bytes = Buffer.from(`P|${file}\n`), split = bytes.indexOf(0xc3) + 1;
        child.stdout.emit('data', bytes.subarray(0, split)); child.stdout.emit('data', bytes.subarray(split));
      }
      child.emit('close', 0);
    });
    return child;
  };
  return {calls, worker: new YtdlpWorker('/fixture/yt-dlp', spawn, undefined, {sessionDir: root, ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe', killGraceMs: 5})};
}
test('ENG-1/ENG-2: cancellation reaps a TERM-resistant descendant with inherited pipes before shutdown completes', {timeout: 5000}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-tree-'));
  let parent, descendant, watchdog;
  const worker = new YtdlpWorker('/fixture', (_binary, _args, opts) => {
    parent = nodeSpawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']}); console.log(child.pid); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`], opts);
    return parent;
  }, undefined, {sessionDir: root, killGraceMs: 30, ffmpegPath: '/fixture/ffmpeg'});
  try {
    const pending = worker.download(url, 'best', 'tree', () => {});
    const rejection = assert.rejects(pending, /cancelled/i);
    void rejection.catch(() => {});
    let text = '';
    await new Promise(resolve => parent.stdout.on('data', bytes => { text += bytes; if (text.includes('ready')) { descendant = Number(text.split('\n')[0]); resolve(); } }));
    watchdog = setTimeout(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } }, 1000);
    const cancellationStarted = Date.now();
    worker.cancel('tree');
    await worker.dispose(); await rejection;
    assert.ok(Date.now() - cancellationStarted < 800, 'cancellation must not wait for the fixture watchdog to kill the descendant');
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('download-')), []);
    // Give the OS a turn to reap the orphan after the process group was killed.
    for (let i = 0; i < 30; i++) {
      try { process.kill(descendant, 0); } catch { descendant = null; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(descendant, null, 'owned descendant must be gone');
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    clearTimeout(watchdog);
    if (parent?.pid) { try { process.kill(-parent.pid, 'SIGKILL'); } catch { parent.kill('SIGKILL'); } }
    await worker.dispose(); rmSync(root, {recursive: true, force: true});
  }
});
test('ENG-2: shared shutdown awaits cleanup and has a bounded outer deadline', async () => {
  let cleaned = false;
  await awaitEngineShutdown([{async dispose() { await new Promise(resolve => setTimeout(resolve, 15)); cleaned = true; }}], 100);
  assert.equal(cleaned, true);
  const start = Date.now();
  await awaitEngineShutdown([{dispose: () => new Promise(() => {})}], 20);
  assert.ok(Date.now() - start < 200);
});
test('ENG-6: public download preserves a split UTF-8 filename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-utf8-'));
  try { const {worker} = downloader(root); const result = await worker.download(url, 'best', 'utf8', () => {}); assert.equal(result.fileName, 'café.mp4'); assert.equal(existsSync(result.filePath), true); }
  finally { rmSync(root, {recursive: true, force: true}); }
});
for (const [label, fixture] of [['empty', {name: 'empty.mp4', size: 0}], ['oversize', {name: 'large.mp4', size: 2147483649}], ['non-video', {name: 'image.jpg', size: 3, probe: '{"streams":[]}'}], ['invalid media', {name: 'invalid.mp4', probe: '{"streams":[]}'}], ['disguised still image', {name: 'image.mp4', probe: JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96}], format: {format_name: 'jpeg_pipe', duration: '1'}})}]]) {
  test(`ENG-12: final ${label} artifact is rejected and removed`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'engines-output-'));
    try { const {worker} = downloader(root, fixture); await assert.rejects(worker.download(url, 'best', 'invalid', () => {}), /Downloaded media/); assert.deepEqual(readdirSync(root).filter(name => name.startsWith('download-')), []); }
    finally { rmSync(root, {recursive: true, force: true}); }
  });
}
async function within(promise, milliseconds = 300) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('The operation did not settle within the test deadline.')), milliseconds);})]); }
  finally {clearTimeout(timer);}
}
test('ENG-8: metadata and media probes time out, become idle, and clean output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-timeout-'));
  let worker, prep, pending, preparing;
  try {
    worker = new YtdlpWorker('/fixture', () => new Child(), undefined, {sessionDir: root, metadataTimeoutMs: 10, killGraceMs: 5});
    pending = worker.metadata(url);
    await assert.rejects(within(pending), /Could not load|timed out/);
    assert.equal(worker.isActive(), false);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('metadata-')), []);
    const input = join(root, 'input.mp4'); writeFileSync(input, 'source');
    prep = createMediaPrep({ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe', spawn: () => new Child(), probeTimeoutMs: 10, killGraceMs: 5});
    preparing = prep.prepare({jobId: 'timeout', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
    await assert.rejects(within(preparing), /timed out/);
    assert.equal(prep.isActive(), false); assert.equal(readFileSync(input, 'utf8'), 'source');
  } finally { await worker?.dispose(); await prep?.dispose(); await pending?.catch(() => {}); await preparing?.catch(() => {}); rmSync(root, {recursive: true, force: true}); }
});
test('ENG-9: metadata never waits for a hanging image request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-thumb-immediate-')); let fetches = 0;
  const worker = new YtdlpWorker('/fixture', () => {const child = new Child(); queueMicrotask(() => {child.stdout.emit('data', JSON.stringify({id: 'dQw4w9WgXcQ'})); child.emit('close', 0);}); return child;}, async () => {fetches++; return new Promise(() => {});}, {sessionDir: root});
  try { assert.equal((await worker.metadata(url)).thumbnailUrl, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'); assert.equal(fetches, 0); }
  finally {await worker.dispose(); rmSync(root, {recursive: true, force: true});}
});
test('ENG-11: short-link resolution is tracked, aborted, and never spawns after disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-short-'));
  let spawned = 0, signal, pending;
  const worker = new GalleryDlWorker('/fixture', () => {
    spawned++; const child = new Child();
    queueMicrotask(() => {child.stdout.emit('data', '[2,{"id":"123","count":1,"title":"Pin"}]\n[3,"https://i.pinimg.com/pin.jpg",{"pin_id":"123","extension":"jpg"}]\n'); child.emit('close', 0);});
    return child;
  }, {sessionDir: root, fetcher: (_url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({status: 302, headers: {get: () => 'https://www.pinterest.com/pin/123/'}}), 100);
      init.signal.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('aborted'));}, {once: true});
    });
  }});
  try {
    pending = worker.metadata('https://pin.it/abc', {jobId: 'short'});
    const rejection = assert.rejects(pending, /cancelled/i); void rejection.catch(() => {});
    assert.equal(worker.isActive(), true); worker.cancel('short');
    await worker.dispose(); await rejection;
    assert.equal(signal.aborted, true); assert.equal(spawned, 0); assert.deepEqual(readdirSync(root), []);
  } finally { await worker.dispose(); await pending?.catch(() => {}); rmSync(root, {recursive: true, force: true}); }
});
test('ENG-11: cached listing retains worker cancellation ownership without image I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-cache-'));
  let signal, pending;
  const worker = new GalleryDlWorker('/fixture', () => {throw new Error('cache must not spawn');}, {sessionDir: root, fetcher: (url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ok: true, url, headers: {get: name => name === 'content-type' ? 'image/jpeg' : null}, arrayBuffer: async () => Uint8Array.from([255,216,255,224,0,0,0,0]).buffer}), 100);
      init.signal.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('aborted'));}, {once: true});
    });
  }});
  worker.searchCache.set('ocean', {query: 'ocean', createdAt: Date.now(), results: [{id: '123', title: 'Ocean', kind: 'image', url: 'https://www.pinterest.com/pin/123/'}], thumbnailUrls: new Map([['123', 'https://i.pinimg.com/236x/ocean.jpg']])});
  try {
    pending = worker.search('ocean', 1);
    const rejection = assert.rejects(pending, /cancelled/i); void rejection.catch(() => {});
    assert.equal(worker.isActive(), true); worker.cancel();
    await worker.dispose(); await rejection; assert.equal(signal, undefined); assert.equal(worker.isActive(), false);
  } finally { await worker.dispose(); await pending?.catch(() => {}); rmSync(root, {recursive: true, force: true}); }
});
test('ENG-16: component completion never claims whole-job completion and postprocessing is explicit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-progress-')), events = [];
  try {
    const {worker} = downloader(root, {name: 'clip.mp4', chunks: ['C|finished|100|1|1|5|0\n', 'C|downloading|1|1|100|5|10\n', 'Q|started\n']});
    await worker.download(url, 'best', 'progress', event => events.push(event));
    assert.deepEqual(events.map(event => event.percent), [null, null, null, null]);
    assert.equal(events.at(-1).state, 'processing');
    assert.match(events[1].message, /stream/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-17/ENG-18/ENG-23: accurate segments carry clipped rebased subtitles and preserve only finished artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-segment-'));
  try {
    const {worker, calls} = downloader(root, {name: 'clip.mp4', residue: true});
    const result = await worker.download(url, 'best', 'segment', () => {}, {...options, subtitles: true, selection: {start: 10, end: 20, label: 'Segment'}});
    assert.ok(calls[0].includes('--force-keyframes-at-cuts'));
    assert.equal(result.subtitleFileName, 'captions.segment.srt');
    assert.equal(readFileSync(result.subtitlePath, 'utf8'), '1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:02,000 --> 00:00:04,000\nMiddle\n\n3\n00:00:09,000 --> 00:00:10,000\nLast\n');
    assert.deepEqual(readdirSync(dirname(result.filePath)).sort(), ['captions.segment.srt', 'clip.mp4']);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-18: an inexact section is rejected instead of registered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-bad-range-'));
  try { const {worker} = downloader(root, {name: 'clip.mp4', probe: videoProbe(1.15)}); await assert.rejects(worker.download(url, 'best', 'range', () => {}, {...options, selection: {start: 2.25, end: 3.25, label: 'Cut'}}), /In\/Out range/); }
  finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-22: log errors preserve the IPC failure event and cleanup', async t => {
  const f = await providerIpcFixture(t, 'youtube', {failure: true});
  const root = join(f.root, 'youtube');
  mkdirSync(join(root, 'clipdock.log'));
  try {
    await assert.rejects(f.start(), {message: 'There is not enough disk space to finish the download.'});
    assert.deepEqual(f.events(), [
      {state: 'downloading', message: 'Starting download…', percent: null},
      {state: 'failed', message: 'There is not enough disk space to finish the download.', percent: null},
    ]);
    assert.equal(await f.cancel('job'), false);
    assert.deepEqual(readdirSync(root), ['clipdock.log']);
  } finally {await f.stop();}
});
test('ENG-24: literal directory percents are escaped in media and subtitle templates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-template-')), session = join(root, '100%(title)s');
  try {
    const {worker, calls} = downloader(session, {name: 'clip.mp4'});
    const result = await worker.download(url, 'best', 'template', () => {}, {...options, subtitles: true});
    assert.ok(result.filePath.startsWith(realpathSync(session)));
    const templates = calls.filter(args => args.includes('-o')).map(args => args[args.indexOf('-o') + 1]);
    assert.equal(templates.length, 1); assert.equal(templates.every(template => template.includes('100%%(title)s')), true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-15/ENG-23: gallery pipe progress is explicitly indeterminate and temporary residue is removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-gallery-output-')), events = [];
  const worker = new GalleryDlWorker('/fixture', (_binary, args) => { const child = new Child(); queueMicrotask(() => {const directory = args[args.indexOf('-D') + 1]; const file = join(directory, 'pinterest.jpg'); writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])); writeFileSync(join(directory, 'unused.part'), 'partial'); child.stdout.emit('data', `${file}\n`); child.emit('close', 0);}); return child;}, {sessionDir: root});
  try {
    const result = await worker.download('https://www.pinterest.com/pin/123/', 1, 'image', 'gallery', event => events.push(event));
    assert.deepEqual(events.map(event => event.percent), [null, 100]);
    assert.equal(events[0].message, 'Downloading from Pinterest (progress unavailable)…');
    assert.deepEqual(readdirSync(dirname(result.filePath)), ['pinterest.jpg']);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-20: social thumbnail streaming stops and cancels at the byte limit without arrayBuffer allocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-thumb-limit-'));
  let cancelled = false, allocated = false;
  const response = {ok: true, url: 'https://pbs.twimg.com/test.jpg', headers: {get: name => name === 'content-type' ? 'image/jpeg' : null}, body: new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(1024 * 1024));}, cancel() {cancelled = true;}}), async arrayBuffer() {allocated = true; return new ArrayBuffer(6 * 1024 * 1024);}};
  const worker = new YtdlpWorker('/fixture', () => {const child = new Child(); queueMicrotask(() => {child.stdout.emit('data', JSON.stringify({id: 'social', ext: 'mp4', thumbnail: response.url})); child.emit('close', 0);}); return child;}, async () => response, {sessionDir: root});
  try { const result = await worker.metadataSocial('https://x.com/creator/status/123456789'); assert.equal(result.thumbnailDataUrl, null); assert.equal(await worker.thumbnailSocial(result.source), null); assert.equal(cancelled, true); assert.equal(allocated, false); }
  finally { rmSync(root, {recursive: true, force: true}); }
});
test('ENG-7: preparation validates display dimensions after autorotation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engines-rotation-')), input = join(root, 'rotated.mp4');
  writeFileSync(input, 'source'); let probes = 0;
  const prep = createMediaPrep({ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe', spawn: (_binary, args) => {const child = new Child(); queueMicrotask(() => {if (args.includes('-show_streams')) {const value = JSON.parse(videoProbe()); probes++; if (probes === 1) value.streams[0].side_data_list = [{rotation: 90}]; else Object.assign(value.streams[0], {width: 96, height: 160, codec_name: 'prores', pix_fmt: 'yuv422p10le'}); value.format.tags.major_brand = probes === 1 ? 'isom' : 'qt'; child.stdout.emit('data', JSON.stringify(value));} else writeFileSync(args.at(-1), 'prepared'); child.emit('close', 0);}); return child;}});
  try { const result = await prep.prepare({jobId: 'rotated', inputPath: input, allowedRoot: root, profile: 'editing', emit: () => {}}); assert.equal(result.action, 'transcode'); assert.equal(readFileSync(result.filePath, 'utf8'), 'prepared'); assert.equal(existsSync(input), false); }
  finally { rmSync(root, {recursive: true, force: true}); }
});
