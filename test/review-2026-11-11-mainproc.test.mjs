import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';
import {createMediaPrep, parseFfprobe} from '../dist/media-prep.js';
import {DownloadHistory} from '../dist/history.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {createProviderDownloadHandlers} from '../dist/main-process.js';
import {ProviderJobCancelledError} from '../dist/provider-job.js';

const require = createRequire(import.meta.url);
const MINUTE = 60_000;
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let i = 0; i < 200 && !condition(); i++) await turn(); assert.ok(condition()); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-review-mainproc-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const input = path.join(root, 'clip.mkv'); fs.writeFileSync(input, 'downloaded');
  return {root, input};
}
const probe = ({container = 'mp4', duration = '10', streamDuration = duration, start = '0'} = {}) => JSON.stringify({
  streams: [{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: streamDuration, start_time: start}],
  format: {duration, start_time: start, format_name: container === 'mp4' ? 'mov,mp4' : 'matroska,webm', tags: {major_brand: container === 'mp4' ? 'isom' : ''}},
});
function preparation(t, inputProbe = probe({container: 'other'}), outputProbe = probe(), finish = false) {
  const ffmpeg = [];
  let probes = 0;
  const prep = createMediaPrep({ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', platform: 'linux', killGraceMs: 5, spawn: (binary, args) => {
    const child = new Child();
    if (binary === '/fake/ffprobe') {
      const json = probes++ === 0 ? inputProbe : outputProbe;
      queueMicrotask(() => { child.stdout.emit('data', json); child.emit('close', 0); });
    } else {
      fs.writeFileSync(args.at(-1), 'prepared'); ffmpeg.push({child, output: args.at(-1), progress: args[args.indexOf('-progress') + 1] === 'pipe:2' ? child.stderr : child.stdout});
      if (finish) queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  }});
  t.after(() => prep.dispose());
  return {prep, ffmpeg};
}

test('healthy preparation survives eight hours and more than 16 MiB of processed progress', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const success of [true, false]) {
    const {root, input} = fixture(t);
    const {prep, ffmpeg} = preparation(t);
    const pending = prep.prepare({jobId: 'healthy', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
    void pending.catch(() => {});
    await until(() => ffmpeg.length === 1);
    let bytes = 0;
    for (let sample = 1; sample <= 80_000; sample++) {
      const time = sample * 500_000;
      const block = `frame=${sample}\nfps=30.00\nstream_0_0_q=-1.0\nbitrate=1000.0kbits/s\ntotal_size=${sample * 1024}\nout_time_us=${time}\nout_time_ms=${time}\nout_time=00:00:01.000000\ndup_frames=0\ndrop_frames=0\nspeed=1.00x\nprogress=continue\n`;
      bytes += Buffer.byteLength(block);
      ffmpeg[0].progress.emit('data', Buffer.from(block));
      t.mock.timers.tick(500);
    }
    assert.ok(bytes > 16 * 1024 * 1024);
    ffmpeg[0].progress.emit('data', 'progress=end\n');
    if (!success) ffmpeg[0].child.stderr.emit('data', 'Conversion fixture failed.\n');
    ffmpeg[0].child.emit('close', success ? 0 : 1);
    if (success) {
      const result = await pending;
      assert.equal(result.action, 'remux');
      assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'prepared');
    } else {
      await assert.rejects(pending, {message: 'Media preparation failed: Conversion fixture failed.'});
      assert.equal(fs.readFileSync(input, 'utf8'), 'downloaded');
    }
    assert.deepEqual(ffmpeg[0].child.signals, []);
  }
});

test('Matroska timestamp endpoints are compared as elapsed spans and truncation still fails', async t => {
  // Measured ffprobe shape for a one-second Matroska made with -output_ts_offset 5.
  const raw = JSON.parse(probe({container: 'other', start: '5.000000', duration: '6.000000'})); delete raw.streams[0].duration;
  const inputProbe = JSON.stringify(raw);
  for (const [duration, valid] of [['1', true], ['0.2', false]]) {
    const {root, input} = fixture(t);
    const {prep, ffmpeg} = preparation(t, inputProbe, probe({duration}), true);
    const pending = prep.prepare({jobId: 'shifted', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
    const expected = valid ? pending : assert.rejects(pending, {message: 'Prepared media failed validation.'});
    void pending.catch(() => {});
    const result = await expected;
    if (valid) {
      assert.equal(result.action, 'remux');
      assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'prepared');
      assert.equal(parseFfprobe(inputProbe).duration, 1);
    } else {
      assert.equal(fs.readFileSync(input, 'utf8'), 'downloaded');
      assert.deepEqual(fs.readdirSync(root), ['clip.mkv']);
      assert.equal(ffmpeg.length, 2);
    }
  }
});

const historyInput = filePath => ({provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []}});
function historyWithRename(renameSync) {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync('dist/history.js', 'utf8'), {module, exports: module.exports, URL, Date, require: id => id === 'node:fs' ? {...fs, renameSync} : id.startsWith('.') ? require(path.resolve('dist', id)) : require(id)});
  return module.exports.DownloadHistory;
}

test('live history corruption is quarantined under the writer lock and failed quarantine refuses writes', async t => {
  const {root, input} = fixture(t);
  const media = path.join(root, 'clip.mp4'); fs.renameSync(input, media);
  const store = path.join(root, 'history.json');
  let deny = false, quarantines = 0;
  const History = historyWithRename((from, to) => {
    assert.equal(fs.existsSync(`${store}.lock`), true);
    assert.ok(to.startsWith(`${store}.corrupt-`));
    if (deny) throw new Error('quarantine denied');
    quarantines++;
    return fs.renameSync(from, to);
  });
  const history = new History(store, root);
  t.after(() => history.dispose());
  history.add(historyInput(media));
  fs.writeFileSync(store, '{broken');
  const record = history.add(historyInput(media));
  assert.equal(quarantines, 1);
  const quarantined = fs.readdirSync(root).find(name => name.startsWith('history.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(root, quarantined), 'utf8'), '{broken');
  assert.equal(new DownloadHistory(store, root).list()[0].id, record.id);
  assert.equal(history.reuse(record.id).record.id, record.id);
  assert.equal(history.clear(), 1);
  assert.equal(history.add(historyInput(media)).title, 'Clip');
  assert.equal(history.list().length, 1);

  fs.writeFileSync(store, '{broken again'); deny = true;
  assert.throws(() => history.delete(history.list()[0].id, []), /could not be quarantined/);
  assert.throws(() => history.add(historyInput(media)), /could not be quarantined/);
  assert.throws(() => history.clear(), /could not be quarantined/);
  assert.equal(fs.readFileSync(store, 'utf8'), '{broken again');
  assert.equal(fs.readFileSync(media, 'utf8'), 'downloaded');
  assert.equal(fs.existsSync(`${store}.lock`), false);
});

function preparationDownload(t, historyFails = false) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-retained-source-')));
  const root = ManagedRoot.prepare(path.join(directory, 'managed'));
  const input = path.join(root.providerPath('youtube'), 'clip.mkv'); fs.writeFileSync(input, 'downloaded');
  const store = path.join(directory, 'history.json');
  const history = new DownloadHistory(store, root);
  if (historyFails) fs.mkdirSync(store);
  const ledger = new DownloadLedger(history, () => false);
  const {prep, ffmpeg} = preparation(t);
  const events = [];
  const handlers = createProviderDownloadHandlers({
    ffprobeAvailable: true, cancelMediaPreparation: id => prep.cancel(id),
    registerSubtitle: () => {throw new Error('Unexpected subtitle');},
    completion: {
      isSafeMediaFile: file => root.resolve(file) !== null,
      refreshHistoryProject: async () => {}, recordHistory: input => ledger.record(input),
      registerCard: input => ledger.register(input, root), prepareMedia: request => prep.prepare(request),
    },
    youtube: {
      worker: {
        metadata: async () => ({id: 'dQw4w9WgXcQ', title: 'Clip', duration: 10, chapters: []}),
        download: async () => ({filePath: input, fileName: 'clip.mkv'}), cancel: () => null,
      },
      emit: (_event, update) => events.push(update),
    },
    social: {}, pinterest: {}, pexels: {}, pixabay: {},
  });
  t.after(async () => {await handlers.shutdown(); await prep.dispose(); await history.dispose(); fs.rmSync(directory, {recursive: true, force: true});});
  const start = () => handlers.youtube({sender: {}}, historyInput(input).source, 'best', 'fast', 'retained', {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'});
  return {root, input, history, ledger, ffmpeg, handlers, events, start};
}

test('a preparation stall keeps the original in History, reports failure, and leaves it listable and deletable', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = preparationDownload(t);
  const rejection = assert.rejects(f.start(), {message: 'Media preparation failed: Media tool timed out. The original download was kept in History.'});
  await until(() => f.ffmpeg.length === 1);
  assert.equal(fs.existsSync(f.ffmpeg[0].output), true);
  t.mock.timers.tick(6 * MINUTE);
  await rejection;
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'downloaded');
  assert.equal(fs.existsSync(f.ffmpeg[0].output), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.input)), ['clip.mkv']);
  const records = f.ledger.listHistory();
  assert.equal(records.length, 1);
  assert.equal(records[0].profile, 'original');
  assert.equal(records[0].available, true);
  assert.equal(f.ledger.resolve(records[0].cardId).path, f.input);
  assert.equal(f.history.resolve(records[0].id).path, f.input);
  assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
  assert.equal(f.handlers.cancel('retained'), false);
  assert.equal(f.ledger.deleteHistory(records[0].id).deleted, true);
  assert.equal(fs.existsSync(f.input), false);
  assert.deepEqual(f.ledger.listHistory(), []);
  assert.deepEqual(f.ledger.protectedPaths(), []);
});

test('a preparation stall deletes the original when History cannot record it and does not claim retention', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = preparationDownload(t, true);
  const rejection = assert.rejects(f.start(), {message: 'Media preparation failed: Media tool timed out.'});
  await until(() => f.ffmpeg.length === 1);
  t.mock.timers.tick(6 * MINUTE);
  await rejection;
  assert.equal(fs.existsSync(f.input), false);
  assert.equal(fs.existsSync(f.ffmpeg[0].output), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.input)), []);
  assert.deepEqual(f.ledger.listHistory(), []);
  assert.deepEqual(f.ledger.protectedPaths(), []);
  assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
});

test('user cancellation during preparation still deletes the original without recording it in History', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = preparationDownload(t);
  const rejection = assert.rejects(f.start(), error => {
    assert.ok(error instanceof ProviderJobCancelledError);
    assert.equal(error.message, 'Download cancelled.');
    return true;
  });
  await until(() => f.ffmpeg.length === 1);
  assert.equal(f.handlers.cancel('retained'), true);
  await rejection;
  assert.equal(fs.existsSync(f.input), false);
  assert.equal(fs.existsSync(f.ffmpeg[0].output), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.input)), []);
  assert.deepEqual(f.ledger.listHistory(), []);
  assert.deepEqual(f.ledger.protectedPaths(), []);
  assert.deepEqual(f.ffmpeg[0].child.signals, ['SIGTERM']);
  assert.equal(f.events.at(-1).state, 'cancelled');
  assert.equal(f.events.at(-1).message, 'Media preparation cancelled.');
});
