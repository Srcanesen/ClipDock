import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {discoverFfmpeg, discoverYtdlp, downloadFailureMessage, YtdlpWorker} from '../dist/ytdlp.js';
import {discoverGalleryDl, GalleryDlWorker} from '../dist/gallerydl.js';
import {discoverFfprobe} from '../dist/media-prep.js';
import {validatePinterestUrl} from '../dist/ytdlp-url.js';

const ytdlp = discoverYtdlp();
const galleryDl = discoverGalleryDl();
const ffmpeg = discoverFfmpeg();
const ffprobe = discoverFfprobe(ffmpeg);
const id = 'dQw4w9WgXcQ';
const youtube = `https://www.youtube.com/watch?v=${id}`;
const noFetch = async () => { throw new Error('Unexpected network request'); };
const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

async function serve(t, routes) {
  const server = createServer((request, response) => {
    const [type, body] = routes[request.url] ?? ['text/plain', ''];
    response.writeHead(body ? 200 : 404, {'content-type': type, 'content-length': Buffer.byteLength(body)});
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// Real yt-dlp, ffmpeg and ffprobe against a local server. Extraction is the only
// fake: metadata prints `info`, and a URL run loads the same info from a plain path.
async function localYoutube(t, root, info, workerOptions = {}) {
  const media = path.join(root, 'source.mp4');
  const made = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', media], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  const base = await serve(t, {'/v.mp4': ['video/mp4', readFileSync(media)], ...info.routes});
  const resolved = JSON.parse(JSON.stringify({...info.data, id, title: 'clip', extractor: 'youtube', extractor_key: 'Youtube', duration: 2,
    formats: [{format_id: '18', url: `${base}/v.mp4`, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', width: 160, height: 96, protocol: 'http'}]}).replaceAll('BASE', base));
  const plainInfo = path.join(root, 'network.info.json');
  writeFileSync(plainInfo, JSON.stringify(resolved));
  const downloads = [];
  const fakeExtraction = (binary, args, options) => {
    if (args.includes('--dump-single-json')) return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(resolved))})`], options);
    const at = args.indexOf(youtube);
    if (path.basename(binary) !== 'ffprobe') downloads.push(args);
    return spawn(binary, at < 0 ? args : [...args.slice(0, at), '--load-info-json', plainInfo, ...args.slice(at + 1)], options);
  };
  const sessionDir = workerOptions.sessionDir ?? path.join(root, 'folder', 'youtube');
  mkdirSync(sessionDir, {recursive: true});
  const worker = new YtdlpWorker(ytdlp, fakeExtraction, noFetch, {ffmpegPath: ffmpeg, ffprobePath: ffprobe, jsRuntime: null, ...workerOptions, sessionDir});
  t.after(() => worker.dispose());
  await worker.metadata(youtube);
  return {worker, downloads, sessionDir};
}
const needsYtdlp = !ytdlp || !ffmpeg || !ffprobe ? 'yt-dlp, ffmpeg and ffprobe are required for this local integration check' : false;
const options = {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'};

test('bug 1: a $VAR download folder keeps yt-dlp media, info JSON and ffmpeg paths literal', {skip: needsYtdlp}, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-dollar-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  // $HOME is always set, so yt-dlp's expandvars would rewrite every path under it.
  const folder = path.join(root, '$HOME');
  mkdirSync(path.join(folder, 'bin'), {recursive: true});
  symlinkSync(ffmpeg, path.join(folder, 'bin', 'ffmpeg'));
  const {worker, downloads, sessionDir} = await localYoutube(t, root, {data: {}}, {sessionDir: path.join(folder, 'youtube'), ffmpegPath: path.join(folder, 'bin', 'ffmpeg')});
  const video = await worker.download(youtube, 'best', 'dollar-video', () => {}, options);
  const audio = await worker.download(youtube, 'best', 'dollar-audio', () => {}, {...options, mediaMode: 'audio'});
  assert.equal(downloads.length, 2, 'the cached info JSON loads without a URL retry');
  for (const result of [video, audio]) assert.equal(path.dirname(path.dirname(result.filePath)), realpathSync(sessionDir));
  assert.deepEqual(files(root).filter(file => /\.(?:mp4|m4a)$/.test(file) && !file.startsWith(folder)).map(file => path.relative(root, file)), ['source.mp4']);
});

test('bug 1: a $VAR download folder keeps the gallery-dl -D directory literal', {skip: !galleryDl ? 'gallery-dl is required for this local integration check' : false}, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-dollar-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const base = await serve(t, {'/image.jpg': ['image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)])]});
  const pin = 'https://www.pinterest.com/pin/123456789012/';
  const sessionDir = path.join(root, '$HOME', 'pinterest');
  mkdirSync(sessionDir, {recursive: true});
  // Only the Pin URL is replaced by a local direct image link.
  const worker = new GalleryDlWorker(galleryDl, (binary, args, spawnOptions) => spawn(binary, args.map(arg => arg === pin ? `${base}/image.jpg` : arg), spawnOptions), {sessionDir});
  t.after(() => worker.dispose());
  const result = await worker.download(pin, 1, 'image', 'dollar-pin', () => {});
  assert.equal(path.dirname(path.dirname(result.filePath)), realpathSync(sessionDir));
  assert.deepEqual(files(root).filter(file => file.endsWith('.jpg')), [path.join(sessionDir, path.basename(path.dirname(result.filePath)), 'pinterest.jpg')]);
});

test('bug 2: subtitles match regional tags, preferring human subtitles and the exact tag', {skip: needsYtdlp}, async t => {
  const vtt = text => ['text/vtt', `WEBVTT\n\n00:00:00.500 --> 00:00:01.500\n${text}\n`];
  const cases = [
    [{subtitles: {'en-GB': [{ext: 'vtt', url: 'BASE/human.vtt'}]}, automatic_captions: {en: [{ext: 'vtt', url: 'BASE/auto.vtt'}]}}, 'human regional'],
    [{subtitles: {'en-US': [{ext: 'vtt', url: 'BASE/regional.vtt'}], en: [{ext: 'vtt', url: 'BASE/human.vtt'}]}}, 'human exact'],
    [{automatic_captions: {'en-orig': [{ext: 'vtt', url: 'BASE/human.vtt'}], de: [{ext: 'vtt', url: 'BASE/auto.vtt'}]}}, 'auto regional'],
  ];
  for (const [data, expected] of cases) {
    const root = mkdtempSync(path.join(tmpdir(), 'clipdock-subtitle-tags-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const routes = {'/human.vtt': vtt(expected), '/regional.vtt': vtt('wrong regional'), '/auto.vtt': vtt('wrong automatic')};
    const {worker} = await localYoutube(t, root, {data, routes});
    const result = await worker.download(youtube, 'best', 'subtitle-tags', () => {}, {...options, subtitles: true});
    assert.equal(result.warning, undefined, expected);
    assert.match(readFileSync(result.subtitlePath, 'utf8'), new RegExp(expected));
    assert.deepEqual((await worker.subtitles(youtube, 'en')).map(cue => cue.text), [expected]);
  }
});

test('bug 2: an evicted info cache still chooses the human regional subtitle tag', {skip: needsYtdlp}, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-subtitle-evicted-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const vtt = text => ['text/vtt', `WEBVTT\n\n00:00:00.500 --> 00:00:01.500\n${text}\n`];
  const data = {subtitles: {'en-GB': [{ext: 'vtt', url: 'BASE/human.vtt'}]}, automatic_captions: {en: [{ext: 'vtt', url: 'BASE/auto.vtt'}]}};
  const {worker} = await localYoutube(t, root, {data, routes: {'/human.vtt': vtt('human regional'), '/auto.vtt': vtt('wrong automatic')}});
  // The narrow metadata stays cached while the raw info JSON (10 entries) is evicted.
  worker.metadataStore.raw.delete(id);
  const result = await worker.download(youtube, 'best', 'subtitle-evicted', () => {}, {...options, subtitles: true});
  assert.equal(result.warning, undefined);
  assert.match(readFileSync(result.subtitlePath, 'utf8'), /human regional/);
  worker.metadataStore.raw.delete(id);
  assert.deepEqual((await worker.subtitles(youtube, 'en')).map(cue => cue.text), ['human regional']);
});

test('bug 3: country-domain and /sent/ Pin URLs normalize to the www Pin URL', () => {
  for (const url of ['https://tr.pinterest.com/pin/123456789012/', 'https://www.pinterest.com/pin/123456789012/sent/?invite_code=abc&sender=1', 'https://de.pinterest.com/pin/123456789012/sent/']) {
    assert.deepEqual(validatePinterestUrl(url), {url: 'https://www.pinterest.com/pin/123456789012/', pinId: '123456789012'}, url);
  }
  for (const url of ['https://evil.pinterest.com.example/pin/1/', 'https://a.b.pinterest.com/pin/123456789012/', 'https://tr.pinterest.com/pin/123456789012/other/', 'https://pinterest.example/pin/123456789012/']) {
    assert.equal(validatePinterestUrl(url), null, url);
  }
});

test('bug 4: words inside the extractor ID prefix do not classify yt-dlp failures', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-error-id-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const postId of ['DQ-live-x9', 'Cprivate_9A', 'Bxlogin7Qa']) {
    const binary = path.join(root, `yt-dlp-${postId}`);
    writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(`ERROR: [Instagram] ${postId}: Unable to extract shared data; please report this issue\n`)});process.exit(1);\n`, {mode: 0o755});
    const worker = new YtdlpWorker(binary, undefined, noFetch, {sessionDir: path.join(root, postId), ffmpegPath: null, ffprobePath: null, jsRuntime: null});
    t.after(() => worker.dispose());
    await assert.rejects(worker.metadataSocial(`https://www.instagram.com/reel/${postId}/`), {message: 'Could not load public social video metadata. Only permitted public video posts are supported.'});
    assert.equal(downloadFailureMessage(`ERROR: [youtube] ${postId}: Unable to download video data\n`), 'Download failed.');
  }
  assert.equal(downloadFailureMessage('ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you have been granted access\n'), 'This video is private or requires login. Only public videos are supported.');
  assert.equal(downloadFailureMessage('ERROR: [download] Got error: video removed\n'), 'This video was removed or is no longer available.');
});
