import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {providerDownload} from './helpers/provider-job-main.mjs';

const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const noFetch = async () => {throw new Error('Unexpected network request');};
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-engine-regression-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  let sequence = 0;
  const executable = body => {
    const file = path.join(root, `tool-${++sequence}`);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`, {mode: 0o755});
    return file;
  };
  const worker = (body, options = {}) => {
    const instance = new YtdlpWorker(executable(body), undefined, noFetch, {
      sessionDir: path.join(root, `session-${sequence}`), ffmpegPath: '/fixture/ffmpeg',
      ffprobePath: executable(`console.log(JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96}], format: {duration: '1', format_name: 'mov,mp4,webm'}}));`), jsRuntime: null, ...options,
    });
    t.after(() => instance.dispose());
    return instance;
  };
  return {root, executable, worker};
}

test('bug 1: yt-dlp silent successful size skip reports the 2 GB limit', async t => {
  const {worker} = fixture(t);
  const events = [];
  await assert.rejects(providerDownload(worker('process.exit(0);'), {url: youtube, jobId: 'size-skip', emit: event => events.push(event)}),
    {message: 'This video exceeds ClipDock’s 2 GB download limit.'});
  assert.deepEqual(events, [
    {jobId: 'size-skip', state: 'downloading', percent: null, message: 'Starting download…'},
    {jobId: 'size-skip', state: 'failed', percent: null, message: 'This video exceeds ClipDock’s 2 GB download limit.'},
  ]);
  await assert.rejects(worker('process.exit(1);').download(youtube, 'best', 'failure', () => {}), {message: 'Download failed.'});
});

test('bug 2: gallery-dl successful size warnings report the image and video limits', async t => {
  const {GalleryDlWorker} = await import('../dist/gallerydl.js');
  const {root, executable} = fixture(t);
  for (const [kind, limit] of [['image', '20 MB'], ['video', '2 GB']]) {
    const instance = new GalleryDlWorker(executable(`console.error('[downloader.http][warning] File size larger than allowed maximum (123456789 > 1)');`), undefined, {sessionDir: path.join(root, kind)});
    t.after(() => instance.dispose());
    const events = [];
    await assert.rejects(providerDownload(instance, {provider: 'pinterest', url: 'https://www.pinterest.com/pin/123456789012/', kind, jobId: `size-${kind}`, emit: event => events.push(event)}),
      {message: `This ${kind} exceeds ClipDock’s ${limit} download limit.`});
    assert.deepEqual(events, [
      {jobId: `size-${kind}`, state: 'downloading', percent: null, message: 'Downloading from Pinterest (progress unavailable)…'},
      {jobId: `size-${kind}`, state: 'failed', percent: null, message: `This ${kind} exceeds ClipDock’s ${limit} download limit.`},
    ]);
    assert.equal(readdirSync(path.join(root, kind)).some(name => name.startsWith('download-')), false);
  }
});

test('bug 3: ended livestream VODs appear in search and social metadata while processing VODs wait', async t => {
  const {worker} = fixture(t);
  const statuses = ['was_live', 'not_live', null, 'is_live', 'is_upcoming', 'post_live'];
  const entries = statuses.map((live_status, index) => ({id: `video00000${index}`, title: 'Recorded show', live_status}));
  const page = await worker(`console.log(${JSON.stringify(JSON.stringify({entries}))});`).search('recorded show', 1);
  assert.deepEqual(page.results.map(item => item.id), ['video000000', 'video000001', 'video000002']);
  for (const live_status of statuses) {
    const raw = {id: 'recorded-show', title: 'Recorded show', live_status, formats: [{height: 720, vcodec: 'h264'}]};
    const instance = worker(`console.log(${JSON.stringify(JSON.stringify(raw))});`);
    const pending = instance.metadataSocial('https://www.instagram.com/reel/ABC123');
    if (live_status === 'post_live') await assert.rejects(pending, {message: 'This video is still processing after the live stream. Try again later.'});
    else if (live_status === 'is_live' || live_status === 'is_upcoming') await assert.rejects(pending, {message: 'Live streams are not supported. Use a public video post.'});
    else {
      const metadata = await pending;
      assert.deepEqual([metadata.id, metadata.heights], ['recorded-show', [720]]);
    }
  }
});

test('bug 4: yt-dlp ERROR diagnostics distinguish disk, write, format and provider failures', async t => {
  const {worker} = fixture(t);
  const cases = [
    ["WARNING: private cookies unavailable\nERROR: unable to write: [Errno 28] No space left on device: '/private/tmp/clip.part'", 'There is not enough disk space to finish the download.'],
    ["ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats for a list of available formats", 'The requested format is not available. Choose another quality or media mode.'],
    ["ERROR: unable to open for writing: [Errno 13] Permission denied: '/private/tmp/clip.part'", 'Could not write the downloaded media. Check the download folder permissions and try again.'],
    ["WARNING: private cookies unavailable\nERROR: extractor failed for '/private/tmp/video unavailable.mp4'", 'Download failed.'],
    ['WARNING: private cookies unavailable\nERROR: unexpected extractor failure', 'Download failed.'],
    ['ERROR: Private video. Sign in if you have access.', 'This video is private or requires login. Only public videos are supported.'],
    ['ERROR: Video unavailable. This video has been removed.', 'This video was removed or is no longer available.'],
    ['ERROR: unable to write: ENOSPC\nERROR: fragment download failed', 'There is not enough disk space to finish the download.'],
  ];
  for (const [detail, message] of cases) {
    const events = [];
    await assert.rejects(providerDownload(worker(`console.error(${JSON.stringify(detail)}); process.exitCode = 1;`), {url: youtube, jobId: 'diagnostic', emit: event => events.push(event)}), {message});
    assert.deepEqual(events, [
      {jobId: 'diagnostic', state: 'downloading', percent: null, message: 'Starting download…'},
      {jobId: 'diagnostic', state: 'failed', percent: null, message},
    ]);
  }
});

test('bug 5: yt-dlp stderr postprocess lines emit processing and preserve failure details', async t => {
  const {worker, root} = fixture(t);
  const events = [];
  const instance = worker(`
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const output = path.join(path.dirname(args[args.indexOf('-o') + 1]), 'clip.mp4');
    fs.writeFileSync(output, 'media');
    process.stderr.write('Q|sta');
    setTimeout(() => {
      process.stderr.write('rted\\r\\n');
      process.stdout.write('C|finished|100|100|100|0|0\\n');
      setTimeout(() => process.stdout.write('P|' + output + '\\n'), 20);
    }, 10);
  `);
  const result = await instance.download(youtube, 'best', 'postprocess', event => events.push(event));
  assert.equal(result.fileName, 'clip.mp4');
  assert.deepEqual(events.filter(event => event.state === 'processing').map(event => event.message), ['Processing media…']);
  // An unterminated progress line must also be flushed without consuming ERRORs.
  const failed = worker(`process.stderr.write('ERROR: unable to write: No space left on device\\nQ|finished'); process.exitCode = 1;`);
  const failures = [];
  await assert.rejects(providerDownload(failed, {url: youtube, jobId: 'postprocess-failed', emit: event => failures.push(event)}), {message: 'There is not enough disk space to finish the download.'});
  assert.deepEqual(failures, [
    {jobId: 'postprocess-failed', state: 'downloading', percent: null, message: 'Starting download…'},
    {jobId: 'postprocess-failed', state: 'processing', percent: null, message: 'Processing media…'},
    {jobId: 'postprocess-failed', state: 'failed', percent: null, message: 'There is not enough disk space to finish the download.'},
  ]);
  const logs = readdirSync(root).filter(name => name.startsWith('session-') && existsSync(path.join(root, name, 'clipdock.log'))).map(name => readFileSync(path.join(root, name, 'clipdock.log'), 'utf8')).join('\n');
  assert.equal(logs.includes('ERROR: unable to write: No space left on device'), true);
});

test('bug 6: Pexels previews choose the largest rendition up to 540p with a smallest-file fallback', async () => {
  const {parsePexelsPage} = await import('../dist/pexels.js');
  const parse = heights => parsePexelsPage({videos: [{id: 9, video_files: heights.map(height => ({
    id: height, width: height * 16 / 9, height, file_type: 'video/mp4', quality: 'hd', link: `https://videos.pexels.com/video-files/9/${height}.mp4`,
  }))}]}, 'video', 'clip', 1).results[0];
  const normal = parse([2160, 1080, 720, 540, 360, 240]);
  assert.equal(normal.previewUrl, 'https://videos.pexels.com/video-files/9/540.mp4');
  assert.deepEqual(normal.files.map(file => file.height), [2160, 1080, 720, 540, 360, 240]);
  assert.equal(parse([2160, 1080, 720]).previewUrl, 'https://videos.pexels.com/video-files/9/720.mp4');
  assert.equal(parse([240, 360]).previewUrl, 'https://videos.pexels.com/video-files/9/360.mp4');
});

test('bug 7: every accepted yt-dlp container records and resolves from history after restart', async t => {
  const {DownloadHistory, recordHistory, supportedHistoryMediaPath} = await import('../dist/history.js');
  const {ManagedRoot} = await import('../dist/managed-root.js');
  const {root, worker} = fixture(t);
  const managed = ManagedRoot.prepare(path.join(root, 'managed'));
  const store = path.join(root, 'history.json');
  const history = new DownloadHistory(store, managed);
  const extensions = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', 'ts', 'm2ts', 'flv', 'ogg', 'ogv'];
  const records = [];
  for (const ext of extensions) {
    const result = await worker(`
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2);
      const output = path.join(path.dirname(args[args.indexOf('-o') + 1]), 'clip.${ext}');
      fs.writeFileSync(output, 'media'); console.log('P|' + output);
    `, {sessionDir: managed.providerPath('youtube')}).download(youtube, 'best', `container-${ext}`, () => {});
    const saved = recordHistory(history, {provider: 'youtube', source: youtube, filePath: result.filePath,
      assetId: 'dQw4w9WgXcQ', title: 'Recorded clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null,
      automation: {provider: 'youtube', source: youtube, selection: null, chapters: []}});
    assert.equal(saved.warning, undefined, ext);
    assert.equal(saved.record.fileName, `clip.${ext}`);
    records.push({id: saved.record.id, path: result.filePath});
  }
  const restarted = new DownloadHistory(store, managed);
  assert.equal(restarted.list().length, 13);
  assert.equal(restarted.list().filter(record => record.available).length, 13);
  for (const record of records) assert.equal(restarted.resolve(record.id)?.path, record.path);
  assert.deepEqual(['mp3', 'm4a', 'wav', 'jpg', 'jpeg', 'png', 'WEBM', 'txt', 'part', 'exe'].map(ext => supportedHistoryMediaPath(`clip.${ext}`)), [true, true, true, true, true, true, true, false, false, false]);
});

test('bug 8: Pexels photo rendition dimensions fit the original aspect ratio and apply dpr', async () => {
  const {parsePexelsPage} = await import('../dist/pexels.js');
  const base = 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg';
  const src = {original: base, large2x: `${base}?dpr=2&h=650&w=940`, large: `${base}?h=650&w=940`, medium: `${base}?h=350`, small: `${base}?h=130`,
    portrait: `${base}?fit=crop&h=1200&w=800`, landscape: `${base}?fit=crop&h=627&w=1200`, tiny: `${base}?fit=crop&h=200&w=280`};
  const files = (width, height, variants = src) => parsePexelsPage({photos: [{id: 2014422, width, height, src: variants}]}, 'photo', 'photo', 1).results[0].files;
  assert.deepEqual(files(3024, 3024).map(({id, width, height, label}) => [id, width, height, label]), [
    ['original', 3024, 3024, 'Original · 3024×3024'],
    ['large2x', 1300, 1300, 'Large 2× · 1300×1300'],
    ['large', 650, 650, 'Large · 650×650'],
    ['medium', 350, 350, 'Medium · 350×350'],
    ['small', 130, 130, 'Small · 130×130'],
  ]);
  assert.deepEqual(files(4000, 2000).map(({width, height}) => [width, height]), [[4000, 2000], [1880, 940], [940, 470], [700, 350], [260, 130]]);
  assert.deepEqual(files(3000, 4000).map(({width, height}) => [width, height]), [[3000, 4000], [975, 1300], [488, 650], [263, 350], [98, 130]]);
  assert.deepEqual(files(4000, 2000, {medium: `${base}?w=400&dpr=1.5`}).map(({width, height}) => [width, height]), [[600, 300]]);
  assert.deepEqual(files(4000, 2000, {original: base, medium: `${base}?auto=compress`}).map(({width, height}) => [width, height]), [[4000, 2000], [4000, 2000]]);
});

test('queue progress: merged video+audio streams report one rising overall percent', async t => {
  const {worker} = fixture(t);
  // Mirrors real yt-dlp 2026.08.19 output: before_dl names the streams and sizes,
  // then each stream reports its own 0-100% progress tagged with its format id.
  const run = lines => worker(`
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const output = path.join(path.dirname(args[args.indexOf('-o') + 1]), 'clip.mp4');
    fs.writeFileSync(output, 'media');
    process.stdout.write(${JSON.stringify(lines.join('\n'))} + '\\nP|' + output + '\\n');
  `);
  const progress = async (lines, jobId) => {
    const events = [];
    await run(lines).download(youtube, 'best', jobId, event => events.push(event));
    return events.filter(event => event.state === 'downloading' && event.percent !== null).map(event => [event.percent, event.message]);
  };
  assert.deepEqual(await progress([
    'S|137+140|900, 100|1000',
    'C|downloading|50.0|450|900|1000|5|137',
    'C|finished|100.0|900|900|0|0|137',
    'C|downloading|0.0|0|100|1000|1|140',
    'C|downloading|50.0|50|100|1000|1|140',
  ], 'merged'), [
    [45, 'Downloading stream 1 of 2…'],
    [90, 'Downloaded stream; processing media…'],
    [90, 'Downloading stream 2 of 2…'],
    [95, 'Downloading stream 2 of 2…'],
  ]);
  // A single stream with no known size still fills the bar directly.
  assert.deepEqual(await progress(['S|18||NA', 'C|downloading|2.9|1|2|1000|8|18'], 'single'), [[2.9, 'Downloading…']]);
});
