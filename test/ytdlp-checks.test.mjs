import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);
const focusedExpect = expect;
const fail = (message) => assert.fail(message);

test('range validation and cleaned subtitle cues', async (t) => {
  const { validateRange, parseSubtitleCues } = await import(path.join(dist, 'ytdlp.js'));
  focusedExpect('youtube: range accepts finite ordered duration-bounded values', validateRange({ start: 2, end: 4, label: 'Cut' }, 10)?.label, 'Cut');
  focusedExpect('youtube: range rejects reversed/outside values', [validateRange({ start: 4, end: 2, label: 'x' }, 10), validateRange({ start: 2, end: 11, label: 'x' }, 10)], [null, null]);
  focusedExpect('youtube: subtitle parser bounds and strips cue markup', parseSubtitleCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b>Hello</b>', 1), [{ start: 1, end: 2, text: 'Hello' }]);
});

test('social and YouTube URL/process/search/download/cancel boundaries', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const urlContracts = await import(path.join(dist, 'ytdlp-url.js'));
  const { validateYoutubeUrl } = urlContracts;
  const { validateSocialUrl } = urlContracts;
  const { YtdlpWorker, discoverFfmpeg, validateYoutubeSearch, downloadFailureMessage } = await import(path.join(dist, 'ytdlp.js'));
  const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const socialCanonical = 'https://www.instagram.com/reel/ABC_def-123';
  const socialAccepted = [
    ['https://www.instagram.com/reel/ABC_def-123/?utm_source=share', { url: socialCanonical, platform: 'instagram' }],
    ['https://instagram.com/p/POST123?igsh=tracking', { url: 'https://www.instagram.com/p/POST123', platform: 'instagram' }],
    ['https://x.com/editor/status/1234567890123456789?s=20', { url: 'https://x.com/editor/status/1234567890123456789', platform: 'twitter' }],
    ['https://twitter.com/editor/status/1234567890123456789?utm_source=share', { url: 'https://x.com/editor/status/1234567890123456789', platform: 'twitter' }],
    ['https://twitter.com/i/web/status/1234567890123456789?ref=share', { url: 'https://x.com/i/status/1234567890123456789', platform: 'twitter' }],
    ['https://www.facebook.com/watch/?v=987654321&utm_source=share', { url: 'https://www.facebook.com/watch?v=987654321', platform: 'facebook' }],
    ['https://facebook.com/reel/246813579?mibextid=tracking', { url: 'https://www.facebook.com/reel/246813579', platform: 'facebook' }],
    ['https://fb.watch/AbC_123/?utm_source=share', { url: 'https://fb.watch/AbC_123', platform: 'facebook' }],
  ];
  for (const [input, expected] of socialAccepted) expect(`social accepts and canonicalizes ${input}`, validateSocialUrl(input), expected);
  for (const bad of [
    'http://www.instagram.com/reel/ABC_def-123',
    'https://user:pass@x.com/editor/status/123',
    'https://www.instagram.com/accounts/login/',
    'https://www.instagram.com/stories/editor/123',
    'https://www.instagram.com/p/one/two',
    'https://x.com/editor/status/not-a-status',
    'https://twitter.com/search?q=video',
    'https://www.facebook.com/watch?v=abc',
    'https://www.facebook.com/watch?foo=987654321',
    'https://www.facebook.com/watch?v=987654321&list=bulk',
    'https://www.facebook.com/profile.php?id=123',
    'https://evil.example/instagram/reel/ABC_def-123',
    'https://www.facebook.com:443/reel/123',
  ]) expect(`social rejects ${bad}`, validateSocialUrl(bad), null);
  expect('social backend provider seam exists', typeof YtdlpWorker.prototype.metadataSocial, 'function');
  expect('social download seam exists', typeof YtdlpWorker.prototype.downloadSocial, 'function');

  const phase3Root = mkdtempSync(path.join(fixtureDir(), 'clipdock-contract-'));
  const child = () => {
    const value = new EventEmitter();
    value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
    value.kills = []; value.kill = (signal) => { value.kills.push(signal); return true; };
    return value;
  };
  const queuedSpawn = (runs, calls = []) => (_binary, args, options) => {
    if (_binary.endsWith('ffprobe') && args.includes('-show_streams') && /\[[^\]]+\]\.(?:mp4|mp3|wav|m4a)$/.test(args.at(-1))) {
      const value = child(); calls.push({args, options, child: value});
      queueMicrotask(() => { value.stdout.emit('data', Buffer.from(JSON.stringify({streams: [{codec_type: /\.(mp3|wav|m4a)$/.test(args.at(-1)) ? 'audio' : 'video', width: 160, height: 96}], format: {duration: '10', format_name: 'mov,mp4'}}))); value.emit('close', 0); });
      return value;
    }
    const value = child(); calls.push({ args, options, child: value });
    const run = runs.shift(); if (run) queueMicrotask(() => run(value, args));
    return value;
  };
  const closeWith = (stdout, code = 0, stderr = '') => (proc) => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  };
  const rejected = async (label, promise, message) => {
    try { await promise; fail(`${label} — resolved`); }
    catch (error) { expect(label, error.message, message); }
  };
  const versionFixture = (file, identity) => {
    writeFileSync(file, `#!/bin/sh\n[ "$1" = "-version" ] || exit 1\nprintf '${identity} version 99.0 fixture\\n'\n`, { mode: 0o755 });
    return file;
  };
  {
    const calls = []; const fetchCalls = [];
    const fakeFetch = async (url) => { fetchCalls.push(url); return { ok: true, url, headers: { get: (name) => name === 'content-type' ? 'image/jpeg' : name === 'content-length' ? '2' : null }, arrayBuffer: async () => Uint8Array.from([1, 2]).buffer }; };
    const socialJson = JSON.stringify({ id: 'social-video-1', title: 'Social title', uploader: 'Social creator', duration: 42, thumbnail: 'https://scontent.cdninstagram.com/media.jpg', formats: [{ height: 720, vcodec: 'h264' }, { height: 1080, vcodec: 'h264' }, { height: 1080, vcodec: 'none' }] });
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(socialJson)], calls), fakeFetch, { sessionDir: path.join(phase3Root, 'social-metadata') });
    const meta = await worker.metadataSocial('https://www.instagram.com/reel/ABC_def-123/?utm_source=share');
    expect('social metadata narrows platform, canonical source, creator, and heights', [meta.id, meta.platform, meta.source, meta.title, meta.channel, meta.heights, meta.formatSummary], ['social-video-1', 'instagram', socialCanonical, 'Social title', 'Social creator', [720, 1080], ['720p', '1080p']]);
    expect('social metadata uses the existing no-playlist first-entry argv seam', [calls[0].args, calls[0].args.at(-1), calls[0].options], [['--ignore-config', '--no-warnings', '--no-colors', '--no-playlist', '--playlist-items', '1', '--socket-timeout', '15', '--max-filesize', '2147483648', '--dump-single-json', socialCanonical], socialCanonical, { shell: false, detached: true }]);
    expect('social thumbnail fetch uses only an approved platform CDN host', [await worker.thumbnailSocial(meta.source), fetchCalls], ['data:image/jpeg;base64,AQI=', ['https://scontent.cdninstagram.com/media.jpg']]);
  }
  {
    const calls = []; const events = [];
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([null], calls), undefined, { sessionDir: path.join(phase3Root, 'social-preflight-cancel'), platform: 'darwin' });
    const pending = worker.metadataSocial(socialCanonical, { jobId: 'social-preflight-job', emit: (event) => events.push(event) }).then(() => worker.downloadSocial(socialCanonical, '720p', 'social-preflight-job', (event) => events.push(event)));
    expect('social authoritative metadata preflight cancel matches job id', worker.cancel('social-preflight-job') instanceof Promise, true);
    expect('social authoritative metadata preflight cancel terminates child', calls[0].child.kills, ['SIGTERM']);
    calls[0].child.emit('close', null);
    await rejected('social authoritative metadata preflight remains cancelled', pending, 'Download cancelled.');
  }
  {
    const entries = [
      { id: 'image-entry', title: 'Image', availability: 'public', formats: [{ height: 1080, vcodec: 'none' }] },
      { id: 'first-video', title: 'First supported video', duration: 4, formats: [{ height: 720, vcodec: 'h264' }] },
      { id: 'second-video', title: 'Second video', duration: 5, formats: [{ height: 1080, vcodec: 'h264' }] },
    ];
    const calls = []; const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(JSON.stringify({ entries }))], calls), undefined, { sessionDir: path.join(phase3Root, 'social-first-entry') });
    const meta = await worker.metadataSocial('https://x.com/editor/status/1234567890123456789');
    expect('social carousel selects only the first supported video entry', [meta.id, meta.title, meta.heights, calls[0].args.includes('--no-playlist'), calls[0].args[calls[0].args.indexOf('--playlist-items') + 1]], ['first-video', 'First supported video', [720], true, '1']);
  }
  for (const [label, raw, message] of [
    ['social live classification', { id: 'live', live_status: 'is_live', formats: [{ height: 720, vcodec: 'h264' }] }, 'Live streams are not supported. Use a public video post.'],
    ['social private/login classification', { id: 'private', availability: 'needs_auth', formats: [{ height: 720, vcodec: 'h264' }] }, 'This video is private or requires login. Only public videos are supported.'],
    ['social image-only classification', { id: 'image', ext: 'jpg', vcodec: 'none', formats: [{ height: 1080, vcodec: 'none' }] }, 'This post does not contain a supported video. Image-only posts are not supported.'],
  ]) {
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(JSON.stringify(raw))]), undefined, { sessionDir: path.join(phase3Root, label.replaceAll(' ', '-')) });
    await rejected(label, worker.metadataSocial('https://www.facebook.com/reel/246813579'), message);
  }
  {
    const calls = []; const events = [];
    const run = (proc, args) => { const dir = path.dirname(args[args.indexOf('-o') + 1]); const file = path.join(dir, 'Social title [social-video-1].mp4'); writeFileSync(file, 'social-video'); proc.stdout.emit('data', Buffer.from('C|downloading|50|1|2|1000|2\n')); proc.stdout.emit('data', Buffer.from(`P|${file}\n`)); proc.emit('close', 0); };
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run], calls), undefined, { sessionDir: path.join(phase3Root, 'social-download'), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    const result = await worker.downloadSocial(socialCanonical, '720p', 'social-job', (event) => events.push(event));
    expect('social download reuses managed output/progress/cancel seam', [result.fileName, readFileSync(result.filePath, 'utf8'), events.some((event) => event.percent === null && event.message === 'Downloading stream (50.0%)…'), calls[0].args.at(-1), calls[0].args.includes('--ignore-config'), calls[0].args.includes('--max-filesize'), calls[0].options.shell, calls[0].args.some((arg) => /cookies?|password|username/i.test(arg))], ['Social title [social-video-1].mp4', 'social-video', true, socialCanonical, true, true, false, false]);
  }
  for (const accepted of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&token=secret',
    'https://youtu.be/dQw4w9WgXcQ?t=10',
    'https://youtube.com/shorts/dQw4w9WgXcQ?si=secret',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5',
  ]) expect(`ytdlp canonicalizes ${new URL(accepted).pathname}`, validateYoutubeUrl(accepted), { url: canonical, videoId: 'dQw4w9WgXcQ' });
  for (const bad of [
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=x',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&list=x',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:444/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://youtube.com/watch?v=abc123',
    'https://youtube.com/watch?v=bad!',
  ]) expect(`ytdlp rejects ${bad.slice(0, 32)}`, validateYoutubeUrl(bad), null);

  const metadataJson = (extra = {}) => JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Safe title', duration: 61, channel: 'Safe channel', formats: [360, 720, 1080, 1440, 2160, 2160].map((height) => ({ height })), ...extra });

  // Phase 6 slice 1 starts red: search input must be validated before it reaches yt-dlp.
  expect('search validator trims Unicode input', validateYoutubeSearch('  café  '), 'café');
  expect('search validator rejects controls and invalid lengths', [validateYoutubeSearch('a'), validateYoutubeSearch('ok\nno'), validateYoutubeSearch('x'.repeat(101))], [null, null, null]);
  const searchEntry = (n, extra = {}) => ({ id: `search${String(n).padStart(5, '0')}`, title: `Search title ${n}`, channel: 'Search channel', duration: n, view_count: 10000 * n, timestamp: 1700000000 + n, channel_is_verified: n % 2 === 0, ...extra });
  const searchJson = (entries) => JSON.stringify({ entries });
  // Search returns provider URLs without performing image I/O.
  {
    const calls = []; let fetches = 0;
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(searchJson([searchEntry(1), searchEntry(2, {thumbnail: 'https://evil.example/raw.jpg'})]))], calls), async () => { fetches++; throw new Error('unexpected thumbnail'); }, {sessionDir: path.join(phase3Root, 'remote-thumbnails')});
    const first = await worker.search('thumbnail page', 1);
    expect('search returns allowlisted URL and rejects foreign host', first.results.map(item => item.thumbnailUrl), ['https://i.ytimg.com/vi/search00001/mqdefault.jpg', null]);
    await worker.search('thumbnail page', 1);
    expect('search and revisits never fetch thumbnails', [calls.length, fetches], [1, 0]);
  }
  {
    const calls = []; let now = 0;
    const entries = Array.from({ length: 23 }, (_, i) => searchEntry(i + 1));
    entries.push(searchEntry(1), searchEntry(24, { live_status: 'is_live' }), searchEntry(25, { availability: 'private' }), { id: 'bad', title: 'bad' });
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(searchJson(entries)), closeWith('', 1)], calls), undefined, { sessionDir: path.join(phase3Root, 'search'), now: () => now });
    const first = await worker.search('  café search  ', 1);
    expect('search exact metadata-only argv', calls[0].args, ['--ignore-config', '--no-warnings', '--no-colors', '--socket-timeout', '15', '--flat-playlist', '--dump-single-json', '--skip-download', '--playlist-end', '30', 'ytsearch30:café search']);
    expect('search parses, filters, dedupes and canonicalizes', [first.results.length, first.results[0].url, first.hasPrevious, first.hasNext, first.totalResults, first.pageCount, first.results[0].thumbnailUrl], [10, 'https://www.youtube.com/watch?v=search00001', false, true, 23, 3, 'https://i.ytimg.com/vi/search00001/mqdefault.jpg']);
    expect('search first entry carries narrow numerics and strict verified', [first.results[0].viewCount, first.results[0].publishedAt, first.results[0].channelVerified], [10000, 1700000001, false]);
    const third = await worker.search('CAFÉ SEARCH', 3);
    expect('search cache pages 10/10/3 without respawn', [third.results.length, third.hasPrevious, third.hasNext, calls.length, third.totalResults, third.pageCount], [3, true, false, 1, 23, 3]);
    now = 300001; await rejected('search cache expires and respawns', worker.search('café search', 1), 'Could not search YouTube.');
  }
  {
    const entries = [
      searchEntry(1, { thumbnail: 'https://evil.example/x.png', view_count: 1234567, timestamp: 4102444800, channel_is_verified: true }),
      searchEntry(2, { thumbnail: 'javascript:alert(1)', view_count: 1e15, timestamp: 0, channel_is_verified: 'true' }),
      searchEntry(3, { view_count: 1e15 + 1, timestamp: 4102444801, channel_is_verified: false }),
      searchEntry(4, { view_count: 12.5, timestamp: -5, channel_is_verified: 1 }),
      searchEntry(5, { view_count: '1200', timestamp: '1700000000' }),
      searchEntry(6, { view_count: 980, timestamp: 1700000000, duration: 61 }),
    ];
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(searchJson(entries))]), undefined, { sessionDir: path.join(phase3Root, 'search-narrow') });
    const page = await worker.search('narrow', 1);
    const byId = (id) => page.results.find((r) => r.id === id);
    expect('search rejects non-allowlisted thumbnail URLs', [byId('search00001').thumbnailUrl, byId('search00002').thumbnailUrl], [null, null]);
    expect('search view count bounds are strict (integer 0..1e15)', [byId('search00001').viewCount, byId('search00002').viewCount, byId('search00003').viewCount, byId('search00004').viewCount, byId('search00005').viewCount], [1234567, 1e15, null, null, null]);
    expect('search timestamp bounds are strict (integer 0..4102444800)', [byId('search00001').publishedAt, byId('search00002').publishedAt, byId('search00003').publishedAt, byId('search00004').publishedAt, byId('search00005').publishedAt], [4102444800, 0, null, null, null]);
    expect('search verified is strict true', [byId('search00001').channelVerified, byId('search00002').channelVerified, byId('search00003').channelVerified, byId('search00004').channelVerified, byId('search00005').channelVerified], [true, false, false, false, false]);
    expect('search page exposes filtered totals and page count', [page.totalResults, page.pageCount, page.hasNext, page.results.length], [6, 1, false, 6]);
  }
  for (const [label, run, message] of [
    ['search invalid JSON is controlled', closeWith('{bad'), 'Could not search YouTube.'],
    ['search nonzero is controlled', closeWith('', 1), 'Could not search YouTube.'],
    ['search oversized stdout is controlled', closeWith('x'.repeat(2 * 1024 * 1024 + 1)), 'Search results were too large.'],
  ]) {
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run]), undefined, { sessionDir: path.join(phase3Root, `search-${label.replaceAll(' ', '-')}`) });
    await rejected(label, worker.search('safe query', 1), message);
  }
  {
    const calls = []; const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([null], calls), undefined, { sessionDir: path.join(phase3Root, 'search-dispose'), platform: 'darwin' });
    const pending = worker.search('safe query', 1);
    worker.dispose(); expect('search dispose TERM leaves no orphan', calls[0].child.kills[0], 'SIGTERM');
    calls[0].child.emit('close', null); await rejected('search dispose is controlled', pending, 'Could not search YouTube.');
  }

  // Metadata is narrow, canonical, busy-safe, and its thumbnail policy is bounded.
  {
    const calls = [];
    const fetchCalls = [];
    const fakeFetch = async (url) => { fetchCalls.push(url); return { ok: true, url, headers: { get: (name) => name === 'content-type' ? 'image/jpeg; charset=binary' : name === 'content-length' ? '2' : null }, arrayBuffer: async () => Uint8Array.from([1, 2]).buffer }; };
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(metadataJson({ thumbnail: 'https://i.ytimg.com/vi/x/default.jpg' }))], calls), fakeFetch, { sessionDir: path.join(phase3Root, 'metadata') });
    const meta = await worker.metadata('https://youtu.be/dQw4w9WgXcQ?token=secret');
    expect('ytdlp metadata exposes unique 4K height', [meta.id, meta.title, meta.heights, meta.thumbnailUrl], ['dQw4w9WgXcQ', 'Safe title', [360, 720, 1080, 1440, 2160], 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg']);
    expect('ytdlp metadata URL is canonical and last', calls[0].args.at(-1), canonical);
    expect('ytdlp metadata argv starts ignore-config', calls[0].args[0], '--ignore-config');
    expect('ytdlp metadata spawn shell false', calls[0].options, { shell: false, detached: true });
  }
  {
    let fetches = 0;
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith(metadataJson({thumbnail: 'https://img.youtube.com/unapproved.jpg'}))]), async () => {fetches++; throw Error('unexpected');}, {sessionDir: path.join(phase3Root, 'thumbnail-policy')});
    expect('metadata rejects image hosts outside the exact CSP', (await worker.metadata(canonical)).thumbnailUrl, null);
    expect('metadata never fetches thumbnails', fetches, 0);
  }

  // Download drives progress/result events through the worker interface and creates a real file.
  const successRun = (chunks = ['C|down', 'loading|120.0|1|2|1500000|65\nnoise\n']) => (proc, args) => {
    const template = args[args.indexOf('-o') + 1];
    const file = path.join(path.dirname(template), 'Safe title [dQw4w9WgXcQ].mp4'); writeFileSync(file, 'video');
    for (const piece of chunks) proc.stdout.emit('data', Buffer.from(piece));
    proc.stdout.emit('data', Buffer.from(`P|${file}\n`));
    proc.emit('close', 0);
  };
  {
    const calls = [], events = [];
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([successRun()], calls), undefined, { sessionDir: path.join(phase3Root, 'success'), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    const result = await worker.download('https://youtube.com/shorts/dQw4w9WgXcQ?token=secret', '2160p', 'job-success', (event) => events.push(event));
    expect('download completion result keeps title and id', [result.fileName, readFileSync(result.filePath, 'utf8')], ['Safe title [dQw4w9WgXcQ].mp4', 'video']);
    const outputTemplate = calls[0].args[calls[0].args.indexOf('-o') + 1];
    expect('download output template is safe title plus id', [path.basename(outputTemplate), calls[0].args.includes('--windows-filenames')], ['%(title).150B [%(id)s].%(ext)s', true]);
    expect('download output template is not literal clip', outputTemplate.includes('clip.%(ext)s'), false);
    expect('download passes absolute ffmpeg and merge format', [calls[0].args[calls[0].args.indexOf('--ffmpeg-location') + 1], calls[0].args[calls[0].args.indexOf('--merge-output-format') + 1]], ['/fake/ffmpeg', 'mp4']);
    expect('download progress chunk parses percent, speed and ETA safely', events.filter((event) => event.speedBytesPerSecond !== undefined).map(({ percent, speedBytesPerSecond, etaSeconds }) => [percent, speedBytesPerSecond, etaSeconds]), [[null, 1500000, 65]]);
    expect('download exact progress template includes raw speed and ETA fields', calls[0].args[calls[0].args.indexOf('--progress-template') + 1], 'download:C|%(progress.status)s|%(progress._percent).1f|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s');
    expect('download URL is canonical and last', calls[0].args.at(-1), canonical);
    expect('download argv starts ignore-config', calls[0].args[0], '--ignore-config');
    expect('download spawn shell false', calls[0].options, { shell: false, detached: true });
  }
  {
    const calls = [], events = [];
    const audioRun = (proc, args) => { const dir = path.dirname(args[args.indexOf('-o') + 1]); writeFileSync(path.join(dir, 'Safe title [dQw4w9WgXcQ].en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nCaption\n'); const file = path.join(dir, 'Safe title [dQw4w9WgXcQ].mp3'); writeFileSync(file, 'audio'); proc.stdout.emit('data', Buffer.from(`P|${file}\n`)); proc.emit('close', 0); };
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([audioRun], calls), undefined, { sessionDir: path.join(phase3Root, 'audio-subtitle'), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    const result = await worker.download(canonical, 'best', 'job-audio-subtitle', (event) => events.push(event), { mediaMode: 'audio', audioFormat: 'mp3', subtitles: true, subtitleLanguage: 'en' });
    expect('audio MP3 completion and optional SRT remain separate artifacts', [result.fileName, result.subtitleFileName, !!result.warning], ['Safe title [dQw4w9WgXcQ].mp3', 'Safe title [dQw4w9WgXcQ].en.srt', false]);
    expect('audio uses exact safe extraction argv', [calls[0].args[calls[0].args.indexOf('-f') + 1], calls[0].args.includes('-x'), calls[0].args[calls[0].args.indexOf('--audio-format') + 1]], ['ba/b', true, 'mp3']);
    expect('subtitle uses fixed SRT/VTT argv with validated language', [calls[0].args.includes('--write-subs'), calls[0].args.includes('--write-auto-subs'), calls[0].args[calls[0].args.indexOf('--sub-langs') + 1], calls[0].args[calls[0].args.indexOf('--sub-format') + 1]], [true, true, 'en', 'srt/vtt']);
  }
  for (const format of ['wav', 'm4a']) {
    const calls = [];
    const run = (proc, args) => { const dir = path.dirname(args[args.indexOf('-o') + 1]); const file = path.join(dir, `Safe title [dQw4w9WgXcQ].${format}`); writeFileSync(file, 'audio'); proc.stdout.emit('data', Buffer.from(`P|${file}\n`)); proc.emit('close', 0); };
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run], calls), undefined, { sessionDir: path.join(phase3Root, `audio-${format}`), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    const result = await worker.download(canonical, 'best', `job-audio-${format}`, () => undefined, { mediaMode: 'audio', audioFormat: format, subtitles: false, subtitleLanguage: 'en' });
    expect(`audio ${format} completion uses its exact extension and argv`, [result.fileName.endsWith(`.${format}`), calls[0].args[calls[0].args.indexOf('--audio-format') + 1]], [true, format]);
  }
  for (const [quality, selector] of [
    ['best', 'bv*+ba/b'],
    ['720p', 'bv*[height<=720]+ba/b[height<=720]'],
    ['2160p', 'bv*[height<=2160]+ba/b[height<=2160]'],
  ]) {
    const calls = [], events = [];
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([successRun(['C|downloading|oops|1|2|bad|bad\n', 'C|downloading|42.5|1|2|-1|999999999\n', 'C|downloading|43|1|2||\n'])], calls), undefined, { sessionDir: path.join(phase3Root, `selector-${quality}`), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    await worker.download(canonical, quality, `job-${quality}`, (event) => events.push(event));
    expect(`download selector ${quality}`, calls[0].args[calls[0].args.indexOf('-f') + 1], selector);
    expect(`download malformed progress ignored ${quality}`, events.filter((event) => event.speedBytesPerSecond !== undefined).map(({ percent, speedBytesPerSecond, etaSeconds }) => [percent, speedBytesPerSecond, etaSeconds]), [[null, null, 604800], [null, null, null]]);
  }
  for (const quality of ['143p', '4321p', '02160p', '4K', '../2160p']) {
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([]), undefined, { sessionDir: path.join(phase3Root, `invalid-${quality.replaceAll('/', '-')}`), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' });
    await rejected(`download rejects unsafe quality ${quality}`, worker.download(canonical, quality, 'job-invalid', () => undefined), 'Invalid download request.');
  }
  {
    const calls = [];
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([], calls), undefined, { sessionDir: path.join(phase3Root, 'no-ffmpeg'), ffmpegPath: null });
    await rejected('download requires ffmpeg before spawn', worker.download(canonical, '2160p', 'job-no-ffmpeg', () => undefined), 'ffmpeg was not found. Install ffmpeg or set CLIPDOCK_FFMPEG_PATH to an absolute executable path.');
    expect('missing ffmpeg does not spawn yt-dlp', calls.length, 0);
  }
  const ffmpegDiscoveryFixture = versionFixture(path.join(phase3Root, 'ffmpeg-version-fixture'), 'ffmpeg');
  expect('ffmpeg discovery accepts executable env path', discoverFfmpeg({ CLIPDOCK_FFMPEG_PATH: ffmpegDiscoveryFixture, PATH: '' }, process.platform), ffmpegDiscoveryFixture);

  // Controlled parser/process failures and safe final-path enforcement.
  {
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith('{bad json')]), undefined, { sessionDir: path.join(phase3Root, 'bad-json') });
    await rejected('malformed metadata JSON is controlled', worker.metadata(canonical), 'yt-dlp returned invalid metadata.');
  }
  focusedExpect('download errors map known yt-dlp failures to fixed safe messages', [
    downloadFailureMessage('ERROR: Private video. Sign in if you have access.'),
    downloadFailureMessage('ERROR: Video unavailable. This video has been removed.'),
    downloadFailureMessage('File is larger than max-filesize (2147483648 bytes), aborting'),
    downloadFailureMessage('write failed: ENOSPC: no space left on device'),
    downloadFailureMessage('parser failed https://example.test/?token=SECRET'),
  ], [
    'This video is private or requires login. Only public videos are supported.',
    'This video was removed or is no longer available.',
    'This video exceeds ClipDock’s 2 GB download limit.',
    'There is not enough disk space to finish the download.',
    'Download failed.',
  ]);
  for (const [label, run, message] of [
    ['download nonzero is controlled', closeWith('', 2, 'parser failed'), 'Download failed.'],
    ['download missing final path is controlled', closeWith('C|downloading|oops|1|2\n', 0), 'Download failed.'],
    ['download private/login error is actionable', closeWith('', 2, 'ERROR: Private video. Sign in to confirm access.'), 'This video is private or requires login. Only public videos are supported.'],
    ['download removed error is actionable', closeWith('', 2, 'ERROR: Video unavailable. This video has been removed.'), 'This video was removed or is no longer available.'],
    ['download 2 GB limit error is actionable', closeWith('', 2, 'File is larger than max-filesize (2147483648 bytes), aborting'), 'This video exceeds ClipDock’s 2 GB download limit.'],
    ['download disk-space error is actionable', closeWith('', 2, 'ERROR: unable to write: No space left on device'), 'There is not enough disk space to finish the download.'],
  ]) {
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run]), undefined, { sessionDir: path.join(phase3Root, label.replaceAll(' ', '-')) });
    await rejected(label, worker.download(canonical, 'best', 'job-error', () => undefined), message);
  }
  for (const kind of ['parent', 'outside', 'symlink', 'relative', 'missing', 'directory']) {
    let jobDir;
    const run = (proc, args) => {
      jobDir = path.dirname(args[args.indexOf('-o') + 1]);
      const output = kind === 'parent' ? path.join(jobDir, '..') : kind === 'outside' ? path.join(jobDir, '..', 'outside.mp4') : kind === 'relative' ? 'clip.mp4' : path.join(jobDir, kind === 'missing' ? 'missing.mp4' : kind === 'symlink' ? 'link.mp4' : 'folder');
      if (kind === 'directory') mkdirSync(output);
      if (kind === 'outside') writeFileSync(output, 'outside');
      if (kind === 'symlink') { const target = path.join(jobDir, '..', 'target.mp4'); writeFileSync(target, 'outside'); symlinkSync(target, output); }
      proc.stdout.emit('data', Buffer.from(`P|${output}\n`)); proc.emit('close', 0);
    };
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run]), undefined, { sessionDir: path.join(phase3Root, `path-${kind}`) });
    await rejected(`download rejects ${kind} final path`, worker.download(canonical, 'best', `job-path-${kind}`, () => undefined), 'Downloaded file failed the safety check.');
    expect(`download cleans ${kind} job directory`, existsSync(jobDir), false);
  }

  // Cancel is job-scoped; Unix escalates, Windows kills the process tree, dispose leaves no active child.
  {
    const calls = [], events = [], spawn = queuedSpawn([null, closeWith(metadataJson())], calls);
    const worker = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, { sessionDir: path.join(phase3Root, 'cancel-unix'), platform: 'darwin', killGraceMs: 5 });
    const pending = worker.download(canonical, 'best', 'job-unix', (event) => events.push(event));
    expect('cancel matching job id is true', worker.cancel('job-unix') instanceof Promise, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect('cancel Unix TERM then KILL', calls[0].child.kills, ['SIGTERM', 'SIGKILL']);
    calls[0].child.emit('close', null); await rejected('cancel Unix completion is controlled', pending, 'Download cancelled.');
    expect('cancel close clears active worker', (await worker.metadata(canonical)).id, 'dQw4w9WgXcQ');
  }
  {
    const calls = [], spawn = queuedSpawn([null], calls);
    const worker = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, { sessionDir: path.join(phase3Root, 'cancel-close'), platform: 'darwin', killGraceMs: 5 });
    const pending = worker.download(canonical, 'best', 'job-close', () => undefined);
    worker.cancel('job-close'); calls[0].child.emit('close', null);
    await rejected('cancel close before grace is controlled', pending, 'Download cancelled.');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect('cancel close clears kill timer', calls[0].child.kills, ['SIGTERM']);
  }
  {
    const calls = [], treeCalls = [], spawn = queuedSpawn([null], calls);
    const processSpawn = (binary, args, options) => { treeCalls.push({ binary, args, options }); return child(); };
    const worker = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, { sessionDir: path.join(phase3Root, 'cancel-win'), platform: 'win32', processSpawn, killGraceMs: 5, ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe' });
    const pending = worker.download(canonical, 'best', 'job-win', () => undefined);
    calls[0].child.pid = 4100; // Windows-only PID; taskkill uses the injected process spawner.
    expect('cancel Windows matching job', worker.cancel('job-win') instanceof Promise, true);
    expect('cancel Windows process tree argv', treeCalls.map(({ binary, args, options }) => [binary, args, options]), [['taskkill', ['/PID', '4100', '/T', '/F'], { shell: false }]]);
    calls[0].child.emit('close', null); await rejected('cancel Windows completion is controlled', pending, 'Download cancelled.');
  }
  {
    const calls = [], spawn = queuedSpawn([null, closeWith(metadataJson())], calls);
    const worker = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, { sessionDir: path.join(phase3Root, 'dispose') });
    const pending = worker.metadata(canonical);
    worker.dispose(); expect('dispose kills active metadata child', calls[0].child.kills[0], 'SIGTERM');
    calls[0].child.emit('close', null); await rejected('disposed metadata is controlled', pending, 'Could not load video metadata.');
  }
  {
    const calls = [], spawn = queuedSpawn([null], calls);
    const worker = new YtdlpWorker('/fake/yt-dlp', spawn, undefined, { sessionDir: path.join(phase3Root, 'dispose-download') });
    const pending = worker.download(canonical, 'best', 'job-dispose', () => undefined);
    worker.dispose(); expect('dispose kills active download child', calls[0].child.kills[0], 'SIGTERM');
    calls[0].child.emit('close', null); await rejected('disposed download is controlled', pending, 'Download cancelled.');
  }

  // Spawn errors are controlled and cannot reflect a supplied URL/token to the user.
  for (const kind of ['metadata', 'download']) {
    const sessionDir = path.join(phase3Root, `spawn-error-${kind}`);
    const run = (proc) => proc.emit('error', new Error('spawn failed https://www.youtube.com/?token=SPAWN_SECRET'));
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([run]), undefined, { sessionDir });
    let message = '';
    try {
      if (kind === 'metadata') await worker.metadata(canonical);
      else await worker.download(canonical, 'best', 'job-spawn-error', () => undefined);
    } catch (error) { message = error.message; }
    expect(`${kind} spawn error is controlled`, message, kind === 'metadata' ? 'Could not load video metadata.' : 'Download failed.');
    const log = readFileSync(path.join(sessionDir, 'clipdock.log'), 'utf8');
    expect(`${kind} spawn log strips URL/token`, [log.includes('https://'), log.includes('SPAWN_SECRET')], [false, false]);
  }

  // Session log survives failed job cleanup, is bounded, and never stores URLs/tokens.
  {
    const sessionDir = path.join(phase3Root, 'logging');
    const secretUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=TOP_SECRET';
    const stderr = `parser failed ${secretUrl}\n${'x'.repeat(400_000)}`;
    const worker = new YtdlpWorker('/fake/yt-dlp', queuedSpawn([closeWith('', 2, stderr)]), undefined, { sessionDir });
    let userError = '';
    try { await worker.download(secretUrl, 'best', 'job-log', () => undefined); } catch (error) { userError = error.message; }
    const logPath = path.join(sessionDir, 'clipdock.log');
    expect('session log survives failure', existsSync(logPath), true);
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf8');
      expect('session log contains stderr summary', log.includes('parser failed'), true);
      expect('session log strips URL and query token', [log.includes('https://'), log.includes('TOP_SECRET')], [false, false]);
      expect('session log is bounded', statSync(logPath).size <= 128 * 1024, true);
    }
    expect('user error strips URL and token', [userError.includes('https://'), userError.includes('TOP_SECRET')], [false, false]);
  }
});
