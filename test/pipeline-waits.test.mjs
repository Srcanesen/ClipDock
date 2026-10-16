import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {createHarness} from './helpers/renderer-harness.mjs';
import {mainFixture, download} from './helpers/files-main.mjs';

const url = 'https://www.youtube.com/watch?v=PavYAOpVpJI';
const options = {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'};
function workers(t, {stale = false, selection = null, caption = false, wroteMedia = false, failUrl = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-pipeline-')); const calls = [];
  const spawn = (binary, args) => {
    calls.push(args);
    if (args.includes('--load-info-json')) {const info = JSON.parse(readFileSync(args[args.indexOf('--load-info-json') + 1], 'utf8')); assert.equal(info.id, 'PavYAOpVpJI'); assert.equal(info.webpage_url, undefined);}
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    queueMicrotask(() => {
      let code = 0;
      if (args.includes('--dump-single-json')) c.stdout.emit('data', JSON.stringify({id: 'PavYAOpVpJI', webpage_url: url, title: 'Clip', duration: 24, formats: [{height: 1080}]}));
      else if (args.includes('-show_streams')) c.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1', start_time: '0'}, {codec_type: 'audio'}], format: {duration: selection ? '1' : '24', format_name: 'mov,mp4'}}));
      else if ((stale && args.includes('--load-info-json')) || (failUrl && args.includes('--progress'))) { if (args.includes('--load-info-json')) assert.equal(statSync(args[args.indexOf('--load-info-json') + 1]).mode & 0o777, 0o600); if (wroteMedia) {const dir = dirname(args[args.indexOf('-o') + 1]); writeFileSync(join(dir, 'clip.mp4.part'), 'bytes'); c.stdout.emit('data', 'C|downloading|1|5|500|0|0\n');}
        c.stderr.emit('data', stale === true ? 'HTTP Error 403: Forbidden' : stale); code = 1; }
      else {
        const dir = dirname(args[args.indexOf('-o') + 1]);
        if (!args.includes('--skip-download')) { const file = join(dir, `Clip [PavYAOpVpJI].${args.includes('--audio-format') ? 'm4a' : 'mp4'}`); writeFileSync(file, 'media'); c.stdout.emit('data', `P|${file}\n`); }
        if (caption && args.includes('--write-subs')) writeFileSync(join(dir, `Clip [PavYAOpVpJI].en.${caption === 'vtt' ? 'vtt' : 'srt'}`), caption === 'vtt' ? 'WEBVTT\n\n00:00.000 --> 00:02.000\n<c>Hello</c>\n' : '1\n00:00:00,000 --> 00:00:02,000\nHello\n');
      }
      c.emit('close', code);
    }); return c;
  };
  const make = name => new YtdlpWorker('/fixture/yt-dlp', spawn, undefined, {sessionDir: join(root, name), ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe'});
  const inspector = make('inspector'), downloader = make('download');
  t.after(async () => { await Promise.all([inspector.dispose(), downloader.dispose()]); rmSync(root, {recursive: true, force: true}); });
  return {inspector, downloader, calls};
}

for (const [profile, quality, mediaMode, sort] of [
  ['fast', '1080p', 'video', 'res:1080,vcodec:h264,acodec:aac'],
  ['fast', '720p', 'video', 'res:720,vcodec:h264,acodec:aac'],
  ['fast', '1440p', 'video', null],
  ['fast', '2160p', 'video', null],
  ['fast', 'best', 'video', null],
  ['original', '1080p', 'video', null],
  ['editing', '1080p', 'video', null],
  ['fast', '1080p', 'audio', null],
]) test(`H.264 preference argv: ${profile} ${quality} ${mediaMode}`, async t => {
  const {downloader, calls} = workers(t);
  const result = await downloader.download(url, quality, 'format-sort', () => {}, {...options, mediaMode, preferH264: profile === 'fast'});
  assert.equal(readFileSync(result.filePath, 'utf8'), 'media');
  const args = calls.find(args => args.includes('--progress'));
  const selector = mediaMode === 'audio' ? 'ba/b' : quality === 'best' ? 'bv*+ba/b' : `bv*[height<=${quality.slice(0, -1)}]+ba/b[height<=${quality.slice(0, -1)}]`;
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-o') + 1), ['-f', selector, ...(sort ? ['-S', sort] : []), '-o']);
  assert.equal(args.includes('-S'), sort !== null);
});

for (const stale of [false, true]) test(`loaded info preserves Fast H.264 sort${stale ? ' on URL retry' : ''}`, async t => {
  const {inspector, downloader, calls} = workers(t, {stale});
  await inspector.metadata(url);
  const result = await downloader.download(url, '1080p', 'loaded-fast', () => {}, {...options, preferH264: true});
  assert.equal(readFileSync(result.filePath, 'utf8'), 'media');
  const runs = calls.filter(args => args.includes('--progress'));
  assert.equal(runs.length, stale ? 2 : 1);
  assert.ok(runs[0].includes('--load-info-json'));
  if (stale) assert.equal(runs[1].at(-1), url);
  for (const args of runs) assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-o') + 1), ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '-S', 'res:1080,vcodec:h264,acodec:aac', '-o']);
});

test('metadata across inspector/download workers extracts once, clones replies and loads raw info', async t => {
  const {inspector, downloader, calls} = workers(t);
  const [a, b] = await Promise.all([inspector.metadata(url), downloader.metadata(url)]);
  a.heights.push(4320); b.title = 'mutated';
  assert.deepEqual((await downloader.metadata(url)).heights, [1080]);
  assert.equal((await downloader.metadata(url)).title, 'Clip');
  const result = await downloader.download(url, '1080p', 'one', () => {}, options);
  assert.equal(readFileSync(result.filePath, 'utf8'), 'media');
  assert.equal(calls.filter(a => a.includes('--dump-single-json')).length, 1);
  const args = calls.find(a => a.includes('--progress'));
  assert.ok(args.includes('--load-info-json')); assert.equal(args.includes(url), false);
  assert.equal(args[args.indexOf('--progress-delta') + 1], '0.25');
});
for (const stale of [true, 'HTTP Error 410: Gone', 'Requested format is not available', 'Unclassified failure before bytes']) test(`stale loaded info retries once with URL: ${stale}`, async t => {
  const {inspector, downloader, calls} = workers(t, {stale}); await inspector.metadata(url);
  await downloader.download(url, 'best', 'stale', () => {}, options);
  const runs = calls.filter(a => a.includes('--progress'));
  assert.equal(runs.length, 2); assert.ok(runs[0].includes('--load-info-json')); assert.equal(runs[1].at(-1), url);
});
test('a failed URL retry does not trigger a third download', async t => {
  const {inspector, downloader, calls} = workers(t, {stale: true, failUrl: true}); await inspector.metadata(url);
  await assert.rejects(downloader.download(url, 'best', 'fail-both', () => {}, options));
  assert.equal(calls.filter(a => a.includes('--progress')).length, 2);
});
test('ordinary failure after media bytes does not retry loaded info', async t => {
  const {inspector, downloader, calls} = workers(t, {stale: 'Disk write failed', wroteMedia: true}); await inspector.metadata(url);
  await assert.rejects(downloader.download(url, 'best', 'disk', () => {}, options));
  assert.equal(calls.filter(a => a.includes('--progress')).length, 1);
});
test('In/Out conservatively uses URL and keeps aligned separate captions', async t => {
  const selection = {start: 0, end: 1, label: 'Intro'};
  const {inspector, downloader, calls} = workers(t, {selection, caption: true}); await inspector.metadata(url);
  const result = await downloader.download(url, 'best', 'range', () => {}, {...options, selection, subtitles: true});
  assert.equal(calls.find(a => a.includes('--progress')).at(-1), url);
  assert.equal(calls.filter(a => a.includes('--load-info-json')).length, 0);
  assert.equal(readFileSync(result.subtitlePath, 'utf8'), '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
});
for (const caption of [true, 'vtt']) test(`full clip ${caption === 'vtt' ? 'VTT' : 'SRT'} subtitles share one yt-dlp media run`, async t => {
  const {downloader, calls} = workers(t, {caption});
  const result = await downloader.download(url, 'best', 'subs', () => {}, {...options, subtitles: true});
  assert.equal(readFileSync(result.subtitlePath, 'utf8'), '1\n00:00:00,000 --> 00:00:02,000\nHello\n');
  assert.equal(calls.filter(a => !a.includes('-show_streams')).length, 1);
  assert.equal(result.subtitleFileName, 'Clip [PavYAOpVpJI].en.srt');
});
test('social metadata returns while thumbnail fetch hangs and shares cloned cache', {timeout: 1000}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-social-immediate-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  let spawns = 0, now = 0;
  const spawn = () => { spawns++; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); queueMicrotask(() => {c.stdout.emit('data', JSON.stringify({id: '123', ext: 'mp4', thumbnail: 'https://pbs.twimg.com/a.jpg', formats: [{height: 720}]})); c.emit('close', 0);}); return c; };
  const make = () => new YtdlpWorker('/fixture', spawn, () => new Promise(() => {}), {sessionDir: root, ffmpegPath: null, now: () => now});
  const a = make(), b = make(); t.after(() => Promise.all([a.dispose(), b.dispose()]));
  const metadata = await a.metadataSocial('https://x.com/user/status/123'); metadata.heights.push(4320);
  assert.deepEqual((await b.metadataSocial(metadata.source)).heights, [720]); assert.equal(spawns, 1);
  now = 120_000; await b.metadataSocial(metadata.source); assert.equal(spawns, 2);
});
const defaults = {profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null};
function stage(h, id, intent = 'download') { h.test.stage({key: `youtube:${id}`, provider: 'youtube', resultId: id, source: `https://www.youtube.com/watch?v=${id}`, title: id, channel: null, thumbnailDataUrl: null, snapshot: {...defaults, intent}, overrides: {}}); }
test('next download starts while previous Resolve import remains open', async () => {
  const h = createHarness(); await h.fireReady(); stage(h, 'aaaaaaaaaaa', 'import'); stage(h, 'bbbbbbbbbbb');
  let finish; h.api.importToMediaPool = () => new Promise(resolve => {finish = resolve;});
  await h.test.enqueueSelected(); assert.equal(h.downloads.length, 1);
  h.downloads[0].resolve({cardId: 'card1', fileName: 'one.mp4'}); await h.flush();
  assert.equal(h.test.queue()[0].status, 'transferring'); assert.equal(h.downloads.length, 2);
  finish({ok: false, message: 'Host busy'}); await h.flush();
  assert.equal(h.test.queue()[0].transferError, 'Host busy'); assert.equal(h.test.activeQueueId(), h.test.queue()[1].queueId);
});
test('bulk enqueue starts first download before last metadata resolves', async () => {
  const h = createHarness(); await h.fireReady(); stage(h, 'aaaaaaaaaaa'); stage(h, 'bbbbbbbbbbb');
  const load = h.api.loadYoutube; let finish; h.api.loadYoutube = async u => u.endsWith('bbbbbbbbbbb') ? new Promise(resolve => {finish = resolve;}) : load(u);
  const pending = h.test.enqueueSelected(); await h.flush(); assert.equal(h.downloads.length, 1);
  finish(await load('https://www.youtube.com/watch?v=bbbbbbbbbbb')); await pending;
});
test('completion uses fresh polled project name without full native status read', async t => {
  const f = await mainFixture(t); let reads = 0; f.controls.status = async () => {reads++; return {project: {name: 'Cached project'}};};
  await f.invoke('getStatus'); await download(f);
  assert.equal(reads, 1); assert.equal(f.controls.history.list()[0].project, 'Cached project');
});
test('progress bursts update the existing row without rebuilding queue or search controls', async () => {
  const h = createHarness(); let event; h.api.onYoutubeEvent = callback => {event = callback; return () => {};};
  await h.fireReady(); stage(h, 'aaaaaaaaaaa'); await h.test.enqueueSelected();
  const container = h.elements.get('youtube-download-queue'), row = container.children[0]; let rebuilds = 0;
  const replace = container.replaceChildren; container.replaceChildren = function(...args) {rebuilds++; return replace.apply(this, args);};
  const searchRows = h.elements.get('youtube-search-results'); const children = searchRows.children; let walks = 0;
  Object.defineProperty(searchRows, 'children', {get() {walks++; return children;}});
  const find = element => element.tagName === 'PROGRESS' ? element : element.children?.map(find).find(Boolean);
  const progress = find(row); let paints = 0, value = progress.value; Object.defineProperty(progress, 'value', {get: () => value, set(next) {paints++; value = next;}});
  const item = h.test.queue()[0];
  for (let i = 0; i < 100; i++) event({jobId: item.jobId, state: 'downloading', percent: i, message: `Download ${i}`});
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(rebuilds, 0); assert.equal(container.children[0], row);
  assert.equal(progress.value, 99); assert.equal(paints, 1); assert.equal(walks, 0);
});

test('subtitle inspector worker shares loaded info without another extraction', async t => {
  const {inspector, downloader, calls} = workers(t, {caption: 'vtt'});
  await inspector.metadata(url);
  assert.deepEqual(await downloader.subtitles(url, 'en'), [{start: 0, end: 2, text: 'Hello'}]);
  assert.equal(calls.filter(a => a.includes('--dump-single-json')).length, 1);
  assert.equal(calls.filter(a => a.includes('--load-info-json')).length, 1);
});
test('history loads when library opens without an eager boot request', async () => {
  const h = createHarness(); let loads = 0; h.api.historyList = async () => {loads++; return [];};
  await h.fireReady(); assert.equal(loads, 0);
  h.test.setSurface('library'); await h.flush(); assert.equal(loads, 1);
});
