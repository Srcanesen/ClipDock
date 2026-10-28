import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DownloadHistory } from '../dist/history.js';
import { discoverFfmpeg } from '../dist/ytdlp.js';
import { discoverFfprobe } from '../dist/media-prep.js';
import { deferred, download, historyInput, mainFixture } from './helpers/files-main.mjs';

const ffmpegPath = discoverFfmpeg();
const ffprobePath = discoverFfprobe(ffmpegPath);
const tools = async () => ({ ffmpegPath, ffprobePath });
const realTools = { skip: !ffmpegPath || !ffprobePath ? 'ffmpeg and ffprobe are required for real media fixtures' : false };
const nameFor = id => `clipdock-history-${createHash('sha256').update(id).digest('hex')}.jpg`;
function fixture(t, options = { tools }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-thumbnails-')));
  const root = path.join(dir, 'downloads'); fs.mkdirSync(root);
  const store = path.join(dir, 'data', 'download-history.json');
  const history = new DownloadHistory(store, root, () => null, options);
  t.after(async () => { await history.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, store, history, thumbnails: path.join(dir, 'data', 'history-thumbnails') };
}
function media(root, image = false) {
  const file = path.join(root, image ? 'photo.png' : 'video.mp4');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', image ? 'smptebars=size=180x320' : 'testsrc2=size=320x180:rate=10', ...(image ? ['-frames:v', '1'] : ['-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']), '-threads', '1', file]);
  return file;
}
function dimensions(file) {
  return JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' })).streams.map(({ width, height }) => [width, height]);
}

test('video and portrait photo produce Retina-size bounded local thumbnails exactly once, including after restart', realTools, async t => {
  const calls = [];
  const f = fixture(t, { tools, spawn: (...args) => { calls.push(args); return spawn(...args); } });
  for (const image of [false, true]) {
    const record = f.history.add(historyInput(media(f.root, image)));
    const [first, concurrent] = await Promise.all([f.history.thumbnail(record.id), f.history.thumbnail(record.id)]);
    assert.match(first, /^data:image\/jpeg;base64,\/9j\//);
    assert.equal(concurrent, first);
    assert.equal(await f.history.thumbnail(record.id), first);
    const file = path.join(f.thumbnails, nameFor(record.id));
    assert.deepEqual(dimensions(file), [[224, 126]]);
    assert.ok(fs.statSync(file).size > 1000 && fs.statSync(file).size < 32 * 1024);
    const restored = new DownloadHistory(f.store, f.root, () => null, { tools: async () => { throw new Error('Cached artwork must not run tools'); } });
    assert.equal(await restored.thumbnail(record.id), first);
    await restored.dispose();
  }
  assert.equal(calls.length, 4, 'one probe and one frame extraction per record');
  assert.ok(calls.every(([, , opts]) => opts.shell === false && opts.detached === (process.platform !== 'win32' ? true : undefined)));
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['photo.png', 'video.mp4'], 'no artwork in the download folder');
});

test('legacy entries generate lazily; a missing file or audio keeps the placeholder', realTools, async t => {
  const f = fixture(t);
  const record = f.history.add(historyInput(media(f.root)));
  assert.equal(fs.existsSync(f.thumbnails), false, 'recording a download never starts artwork work');
  const restored = new DownloadHistory(f.store, f.root, () => null, { tools });
  assert.match(await restored.thumbnail(record.id), /^data:image\/jpeg;base64,/);
  const missing = restored.add(historyInput(media(f.root, true))); fs.unlinkSync(path.join(f.root, 'photo.png'));
  assert.equal(await restored.thumbnail(missing.id), null);
  const audioFile = path.join(f.root, 'audio.mp3'); fs.writeFileSync(audioFile, 'audio');
  const audio = restored.add({ ...historyInput(audioFile), mediaMode: 'audio' });
  assert.equal(await restored.thumbnail(audio.id), null);
  assert.deepEqual(fs.readdirSync(f.thumbnails), [nameFor(record.id)]);
  await restored.dispose();
});

test('deleting an entry removes its thumbnail; clearing History removes all artwork and keeps media', realTools, async t => {
  const f = fixture(t);
  const video = media(f.root), photo = media(f.root, true);
  const first = f.history.add(historyInput(video)), second = f.history.add(historyInput(photo));
  await f.history.thumbnail(first.id); await f.history.thumbnail(second.id);
  assert.deepEqual(f.history.delete(first.id, [video]), { deleted: false, removed: true });
  assert.deepEqual(fs.readdirSync(f.thumbnails), [nameFor(second.id)]);
  assert.equal(f.history.clear(), 1);
  assert.deepEqual(fs.readdirSync(f.thumbnails), []);
  assert.deepEqual(new DownloadHistory(f.store, f.root).list(), []);
  assert.equal(fs.existsSync(video), true); assert.equal(fs.existsSync(photo), true);
  assert.equal(f.history.clear(), 0);
});

test('startup cleanup is idempotent, removes only orphan artwork and temp files, and never follows a link or descends', realTools, async t => {
  const f = fixture(t);
  const first = f.history.add(historyInput(media(f.root))), orphan = f.history.add(historyInput(media(f.root, true)));
  await f.history.thumbnail(first.id); await f.history.thumbnail(orphan.id);
  const raw = JSON.parse(fs.readFileSync(f.store, 'utf8')); raw.records = raw.records.filter(r => r.id !== orphan.id); fs.writeFileSync(f.store, JSON.stringify(raw));
  const outside = path.join(f.dir, nameFor(orphan.id)); fs.writeFileSync(outside, 'outside');
  const unknown = path.join(f.thumbnails, 'keep.jpg'); fs.writeFileSync(unknown, 'foreign');
  const nested = path.join(f.thumbnails, nameFor('nested')); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, nameFor(orphan.id)), 'nested');
  fs.symlinkSync(outside, path.join(f.thumbnails, nameFor('link')));
  fs.writeFileSync(path.join(f.thumbnails, `${nameFor('temp').slice(0, -4)}.${randomUUID()}.tmp`), 'partial');
  for (let i = 0; i < 2; i++) {
    const restored = new DownloadHistory(f.store, f.root, () => null, { tools });
    assert.deepEqual(fs.readdirSync(f.thumbnails).sort(), [nameFor(first.id), nameFor('nested'), 'keep.jpg'].sort());
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    assert.equal(fs.readFileSync(path.join(nested, nameFor(orphan.id)), 'utf8'), 'nested');
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'foreign');
    await restored.dispose();
  }
});

test('swapping the thumbnail directory cannot grant reads or deletions outside its captured identity', realTools, async t => {
  const f = fixture(t);
  const record = f.history.add(historyInput(media(f.root))); await f.history.thumbnail(record.id);
  fs.renameSync(f.thumbnails, `${f.thumbnails}-held`);
  const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  const sentinel = path.join(outside, nameFor(record.id)); fs.writeFileSync(sentinel, 'outside');
  fs.symlinkSync(outside, f.thumbnails);
  assert.equal(await f.history.thumbnail(record.id), null);
  assert.equal(f.history.clear(), 1);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside');
});

test('a pending thumbnail cannot reappear after clear or relink', realTools, async t => {
  for (const action of ['clear', 'relink']) {
    const entered = deferred(), release = deferred();
    const f = fixture(t, { tools: async () => { entered.resolve(); return release.promise; } });
    const file = media(f.root);
    const record = f.history.add(historyInput(file));
    const pending = f.history.thumbnail(record.id); await entered.promise;
    if (action === 'clear') f.history.clear();
    else { const next = path.join(f.root, 'other.mp4'); fs.writeFileSync(next, 'other'); f.history.relink(record.id, next); }
    release.resolve(await tools());
    assert.equal(await pending, null);
    assert.equal(fs.existsSync(f.thumbnails), false);
  }
});

test('thumbnail failure and pending artwork never block or fail the real main download completion entry point', realTools, async t => {
  const entered = deferred(), release = deferred();
  const f = await mainFixture(t, { modules: { './history': { DownloadHistory: class extends DownloadHistory {
    constructor(file, root, project) { super(file, root, project, { tools: async () => { entered.resolve(); await release.promise; return tools(); } }); }
  } } } });
  assert.equal((await download(f)).fileName, 'job.mp4');
  const records = await f.invoke('historyList');
  const pending = f.invoke('historyThumbnail', records[0].id); await entered.promise;
  const next = await f.invoke('downloadYoutube', records[0].source, 'best', 'original', 'job-2', { mediaMode: 'video', audioFormat: 'wav', subtitles: false, subtitleLanguage: 'en' });
  assert.equal(next.fileName, 'job-2.mp4'); assert.equal(next.warning, undefined);
  // The fake download writes invalid media: the real ffprobe exits nonzero.
  release.resolve(); assert.equal(await pending, null);
  assert.equal((await f.invoke('historyList')).length, 2);
  assert.equal(f.events.filter(e => e.update.state === 'completed').length, 2);
});

test('renderer thumbnail/delete arguments are record ids; arbitrary paths and untrusted senders grant no access', async t => {
  const f = await mainFixture(t);
  const sentinel = path.join(f.dir, 'private.jpg'); fs.writeFileSync(sentinel, 'private image');
  for (const value of [sentinel, '../private.jpg', { path: sentinel }, null]) {
    assert.equal(await f.invoke('historyThumbnail', value), null);
    const result = await f.invoke('historyDelete', value);
    assert.equal(result.removed, false); assert.equal(result.deleted, false);
  }
  assert.equal(await f.invoke('historyClear', sentinel), 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'private image');
  for (const channel of ['clipdock:history-thumbnail', 'clipdock:history-clear']) {
    await assert.rejects(f.invokeEvent(channel, { sender: {}, senderFrame: {} }, sentinel), /sender|frame|ClipDock/i);
  }
});

test('shutdown cancels its active thumbnail child and never starts queued work', async t => {
  const entered = deferred(), signals = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = signal => { signals.push(signal); child.emit('close', null); return true; };
  let starts = 0;
  const f = fixture(t, { tools: async () => ({ ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe' }), spawn: () => { starts++; entered.resolve(); return child; } });
  const file = path.join(f.root, 'clip.mp4'); fs.writeFileSync(file, 'media');
  const first = f.history.add(historyInput(file)), second = f.history.add(historyInput(file));
  const pending = f.history.thumbnail(first.id), queued = f.history.thumbnail(second.id); await entered.promise;
  await f.history.dispose();
  assert.equal(await pending, null); assert.equal(await queued, null);
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(starts, 1);
});
