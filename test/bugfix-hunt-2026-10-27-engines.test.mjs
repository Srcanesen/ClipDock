import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {createMediaPrep} from '../dist/media-prep.js';

const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const reel = 'https://www.instagram.com/reel/ABC123';
const MINUTE = 60_000;
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}
const probe = (container = 'mp4') => JSON.stringify({
  streams: [{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', duration: '10'}, {codec_type: 'audio', codec_name: 'aac', duration: '10'}],
  format: {duration: '10', format_name: container === 'mp4' ? 'mov,mp4' : 'matroska,webm', tags: {major_brand: container === 'mp4' ? 'isom' : ''}},
});
const turn = () => new Promise(resolve => setImmediate(resolve));
// Bounded waits: on a regression the test fails instead of hanging under mocked timers.
async function until(condition) { for (let i = 0; i < 200 && !condition(); i++) await turn(); assert.ok(condition()); }
function root(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
// The fake yt-dlp records each download child; ffprobe answers immediately.
function ytdlp(t, dir, respond = () => {}) {
  const downloads = [];
  const spawn = (_binary, args) => {
    const child = new Child();
    if (args.includes('-show_streams')) queueMicrotask(() => { child.stdout.emit('data', Buffer.from(probe())); child.emit('close', 0); });
    else if (args.includes('--dump-single-json')) queueMicrotask(() => { respond(child, args); child.emit('close', 0); });
    else downloads.push({child, args, dir: dirname(args[args.indexOf('-o') + 1])});
    return child;
  };
  const worker = new YtdlpWorker('/fixture/yt-dlp', spawn, undefined, {sessionDir: dir, ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe', jsRuntime: null, killGraceMs: 5});
  t.after(() => worker.dispose());
  return {worker, downloads};
}
function finish(download, name = 'clip.mp4') {
  const file = join(download.dir, name); writeFileSync(file, 'media');
  download.child.stdout.emit('data', Buffer.from(`P|${file}\n`));
  download.child.emit('close', 0);
}

test('yt-dlp download that keeps reporting progress past 30 minutes completes', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {worker, downloads} = ytdlp(t, root(t, 'clipdock-slow-download-'));
  const pending = worker.download(youtube, 'best', 'slow', () => {});
  await until(() => downloads.length > 0);
  for (let elapsed = 0; elapsed < 40 * MINUTE; elapsed += 500) {
    downloads[0].child.stdout.emit('data', Buffer.from('C|downloading|50.0|1|2|1|1|18\n'));
    t.mock.timers.tick(500);
  }
  finish(downloads[0]);
  assert.equal((await pending).fileName, 'clip.mp4');
  assert.deepEqual(downloads[0].child.signals, []);
});

test('a silent yt-dlp download is stopped by its stall window, not the backstop', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {worker, downloads} = ytdlp(t, root(t, 'clipdock-stalled-download-'));
  let settled = false;
  const pending = worker.download(youtube, 'best', 'stalled', () => {});
  void pending.catch(() => {}).finally(() => { settled = true; });
  await until(() => downloads.length > 0);
  // Unknown duration assumes one hour of media: half of it is the silent budget.
  t.mock.timers.tick(29 * MINUTE); await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(2 * MINUTE); await until(() => settled);
  await assert.rejects(pending, {message: 'yt-dlp request timed out.'});
  assert.deepEqual(downloads[0].child.signals, ['SIGTERM']);
});

function mediaPrep(t, dir) {
  const ffmpeg = [];
  let probes = 0;
  const prep = createMediaPrep({ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', platform: 'linux', killGraceMs: 5, spawn: (binary, args) => {
    const child = new Child();
    if (binary === '/fake/ffprobe') { probes++; queueMicrotask(() => { child.stdout.emit('data', Buffer.from(probe(probes === 1 ? 'other' : 'mp4'))); child.emit('close', 0); }); }
    else ffmpeg.push({child, output: args.at(-1)});
    return child;
  }});
  t.after(() => prep.dispose());
  const input = join(dir, 'clip.mkv'); writeFileSync(input, 'source');
  return {prep, ffmpeg, input};
}

test('ffmpeg conversion that keeps reporting progress past 30 minutes completes', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const dir = root(t, 'clipdock-slow-prep-');
  const {prep, ffmpeg, input} = mediaPrep(t, dir);
  const pending = prep.prepare({jobId: 'slow', inputPath: input, allowedRoot: dir, profile: 'fast', emit: () => {}});
  await until(() => ffmpeg.length > 0);
  for (let elapsed = 0; elapsed < 40 * MINUTE; elapsed += 500) {
    ffmpeg[0].child.stdout.emit('data', Buffer.from('out_time_us=5000000\nprogress=continue\n'));
    t.mock.timers.tick(500);
  }
  writeFileSync(ffmpeg[0].output, 'prepared');
  ffmpeg[0].child.stdout.emit('data', Buffer.from('progress=end\n'));
  ffmpeg[0].child.emit('close', 0);
  const result = await pending;
  assert.equal(result.action, 'remux');
  assert.equal(readFileSync(result.filePath, 'utf8'), 'prepared');
});

test('a silent ffmpeg conversion is stopped after its stall window and keeps the source', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const dir = root(t, 'clipdock-stalled-prep-');
  const {prep, ffmpeg, input} = mediaPrep(t, dir);
  let settled = false;
  const pending = prep.prepare({jobId: 'stalled', inputPath: input, allowedRoot: dir, profile: 'fast', emit: () => {}});
  void pending.catch(() => {}).finally(() => { settled = true; });
  await until(() => ffmpeg.length > 0);
  // A 10-second source gets the 5-minute floor for silent phases.
  t.mock.timers.tick(4 * MINUTE); await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(2 * MINUTE); await until(() => settled);
  await assert.rejects(pending, {message: 'Media preparation failed: Media tool timed out.'});
  assert.deepEqual(ffmpeg[0].child.signals, ['SIGTERM']);
  assert.equal(readFileSync(input, 'utf8'), 'source');
});

// ffmpeg 9.0.1 measured: the +faststart rewrite runs silently after the last progress
// block and before progress=end, which arrives together with the exit.
async function finishingPhase(t, totalSize) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const dir = root(t, 'clipdock-faststart-prep-');
  const {prep, ffmpeg, input} = mediaPrep(t, dir);
  let settled = false;
  const pending = prep.prepare({jobId: 'faststart', inputPath: input, allowedRoot: dir, profile: 'fast', emit: () => {}});
  void pending.catch(() => {}).finally(() => { settled = true; });
  await until(() => ffmpeg.length > 0);
  ffmpeg[0].child.stdout.emit('data', Buffer.from(`total_size=${totalSize}\nout_time_us=10000000\nprogress=continue\n`));
  return {pending, ffmpeg, input, settled: () => settled};
}

test('a large output survives a silent +faststart rewrite longer than the stall floor', async t => {
  // 25 GB (a 10-minute 4K ProRes clip) on a slow disk: an hour of silence before progress=end.
  const {pending, ffmpeg, settled} = await finishingPhase(t, 25e9);
  t.mock.timers.tick(60 * MINUTE); await turn();
  assert.equal(settled(), false);
  writeFileSync(ffmpeg[0].output, 'prepared');
  ffmpeg[0].child.stdout.emit('data', Buffer.from('progress=end\n'));
  ffmpeg[0].child.emit('close', 0);
  const result = await pending;
  assert.equal(readFileSync(result.filePath, 'utf8'), 'prepared');
  assert.deepEqual(ffmpeg[0].child.signals, []);
});

test('a small output that goes silent is still stopped by the stall floor', async t => {
  const {pending, ffmpeg, input, settled} = await finishingPhase(t, 1_000_000);
  t.mock.timers.tick(4 * MINUTE); await turn();
  assert.equal(settled(), false);
  t.mock.timers.tick(2 * MINUTE); await until(settled);
  await assert.rejects(pending, {message: 'Media preparation failed: Media tool timed out.'});
  assert.deepEqual(ffmpeg[0].child.signals, ['SIGTERM']);
  assert.equal(readFileSync(input, 'utf8'), 'source');
});

const socialInfo = {id: 'ABC123', title: 'Reel', webpage_url: reel, formats: [{height: 720, vcodec: 'h264'}]};
test('social download reuses the extracted info instead of extracting the post again', async t => {
  let extractions = 0;
  const {worker, downloads} = ytdlp(t, root(t, 'clipdock-social-info-'), child => { extractions++; child.stdout.emit('data', Buffer.from(JSON.stringify(socialInfo))); });
  await worker.metadataSocial(reel);
  const pending = worker.downloadSocial(reel, 'best', 'social', () => {});
  await until(() => downloads.length > 0);
  const {args} = downloads[0];
  assert.equal(args.includes(reel), false);
  const info = JSON.parse(readFileSync(args[args.indexOf('--load-info-json') + 1], 'utf8'));
  assert.deepEqual([info.id, info.webpage_url], ['ABC123', undefined]);
  finish(downloads[0]);
  assert.equal((await pending).fileName, 'clip.mp4');
  assert.equal(extractions, 1);
});

test('social download retries from the URL when the reused info has expired', async t => {
  const {worker, downloads} = ytdlp(t, root(t, 'clipdock-social-retry-'), child => child.stdout.emit('data', Buffer.from(JSON.stringify(socialInfo))));
  await worker.metadataSocial(reel);
  const pending = worker.downloadSocial(reel, 'best', 'social-retry', () => {});
  await until(() => downloads.length > 0);
  downloads[0].child.stderr.emit('data', Buffer.from('ERROR: unable to download video data: HTTP Error 403: Forbidden\n'));
  downloads[0].child.emit('close', 1);
  await until(() => downloads.length === 2);
  assert.deepEqual([downloads[0].args.includes('--load-info-json'), downloads[1].args.includes('--load-info-json'), downloads[1].args.at(-1)], [true, false, reel]);
  finish(downloads[1]);
  assert.equal((await pending).fileName, 'clip.mp4');
  assert.equal(existsSync(join(downloads[1].dir, 'source.info.json')), false);
});
