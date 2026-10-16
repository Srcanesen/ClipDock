import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {createMediaPrep} from '../dist/media-prep.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {cleanupWorkspace} from '../dist/workspace.js';
import {ProviderJobRunner} from '../dist/provider-job.js';
import {PexelsClient} from '../dist/pexels.js';
import {YtdlpWorker} from '../dist/ytdlp.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'safefs-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = ManagedRoot.prepare(path.join(base, 'managed'));
  const input = path.join(root.verify(), 'clip.mkv'); fs.writeFileSync(input, 'source');
  return {base, root, input};
}
function child() {
  const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
  value.kill = () => true; return value;
}
function probe(container) {
  return JSON.stringify({streams: [{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '1'}], format: {format_name: container ? 'mov,mp4' : 'matroska,webm', tags: {major_brand: container ? 'isom' : ''}, duration: '1'}});
}
function prep(t, hook = () => {}) {
  let probes = 0;
  const service = createMediaPrep({ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', spawn(binary, args) {
    const value = child();
    queueMicrotask(() => {
      if (binary.endsWith('ffprobe')) {hook(++probes, args); value.stdout.emit('data', probe(probes !== 1));}
      else fs.writeFileSync(args.at(-1), 'prepared');
      value.emit('close', 0);
    }); return value;
  }});
  t.after(() => service.dispose()); return service;
}
const request = f => ({jobId: 'race', inputPath: f.input, allowedRoot: f.root.verify(), profile: 'fast', emit() {}});

test('media preparation rejects a root replaced during the decision probe without outside writes', async t => {
  const f = fixture(t), rootPath = f.root.verify(), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  const victim = path.join(outside, 'clip.mkv'); fs.writeFileSync(victim, 'precious');
  const service = prep(t, count => {if (count === 1) {fs.renameSync(rootPath, `${rootPath}-original`); fs.symlinkSync(outside, rootPath);}});
  await assert.rejects(service.prepare(request(f)), /changed|replaced|safety check/i);
  assert.deepEqual(fs.readdirSync(outside), ['clip.mkv']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(`${rootPath}-original`, 'clip.mkv'), 'utf8'), 'source');
});

test('media preparation preserves and reports a source replaced during output validation', async t => {
  const f = fixture(t);
  const service = prep(t, count => {if (count === 2) {fs.renameSync(f.input, `${f.input}.original`); fs.writeFileSync(f.input, 'unrelated replacement');}});
  await assert.rejects(service.prepare(request(f)), /source.*(?:changed|replaced)/i);
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'unrelated replacement');
  assert.equal(fs.readFileSync(`${f.input}.original`, 'utf8'), 'source');
  assert.equal(fs.readdirSync(f.root.verify()).some(name => name.endsWith('.resolve.mp4')), false);
});

test('media preparation treats a dangling destination symlink as occupied and never writes through it', async t => {
  const f = fixture(t), outside = path.join(f.base, 'outside.mp4');
  const link = path.join(f.root.verify(), 'clip.resolve.mp4'); fs.symlinkSync(outside, link);
  const service = prep(t);
  const outcome = await service.prepare(request(f)).then(value => ({value}), error => ({error}));
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.fileName, 'clip.resolve-2.mp4');
  assert.equal(fs.readFileSync(outcome.value.filePath, 'utf8'), 'prepared');
});

test('workspace cleanup preserves protected media when an inventoried parent is replaced', t => {
  const f = fixture(t); fs.unlinkSync(f.input);
  const provider = f.root.providerPath('youtube'), old = path.join(provider, 'old'), keep = path.join(provider, 'keep');
  fs.mkdirSync(old); fs.mkdirSync(keep);
  const candidate = path.join(old, 'clip.mp4'), victim = path.join(keep, 'clip.mp4');
  fs.writeFileSync(candidate, 'old media'); fs.writeFileSync(victim, 'protected media');
  const lstat = fs.lstatSync; let visits = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === candidate && ++visits === 2) {fs.renameSync(old, path.join(f.base, 'moved-old')); fs.symlinkSync(keep, old);}
    return lstat(file, ...args);
  });
  const result = cleanupWorkspace(f.root, [victim]);
  assert.ok(visits >= 2);
  assert.equal(result.deletedFileCount, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'protected media');
  assert.equal(fs.readFileSync(path.join(f.base, 'moved-old/clip.mp4'), 'utf8'), 'old media');
});

test('workspace cleanup protects the captured file identity through a hard-link alias', t => {
  const f = fixture(t), alias = path.join(f.root.providerPath('youtube'), 'alias.mp4');
  fs.linkSync(f.input, alias);
  const result = cleanupWorkspace(f.root, [f.input]);
  assert.equal(result.deletedFileCount, 0);
  assert.equal(fs.readFileSync(alias, 'utf8'), 'source');
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'source');
});

for (const replacement of ['parent symlink', 'regular file']) {
  test(`provider cancellation preserves a replacement ${replacement}`, async t => {
    const f = fixture(t), directory = path.join(f.root.verify(), 'job'); fs.mkdirSync(directory);
    const output = path.join(directory, 'clip.mp4'); fs.writeFileSync(output, 'owned output');
    const jobs = new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'Disposed.'});
    await assert.rejects(jobs.run('job', async context => {
      context.register(output);
      if (replacement === 'parent symlink') {
        const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'clip.mp4'), 'irreplaceable');
        fs.renameSync(directory, `${directory}-original`); fs.symlinkSync(outside, directory);
      } else {fs.renameSync(output, `${output}.original`); fs.writeFileSync(output, 'irreplaceable');}
      jobs.cancel('job'); return 'late';
    }), /Download cancelled/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'irreplaceable');
  });
}

test('provider publication through a canonical alias releases the same captured file', async t => {
  const f = fixture(t), jobs = new ProviderJobRunner({cancelledMessage: 'Cancelled.', disposedMessage: 'Disposed.'});
  const alias = `${f.root.verify()}/./clip.mkv`;
  const result = await jobs.run('alias', async context => {
    context.register(alias); context.register(f.input); context.publish(f.input); return 'published';
  });
  assert.equal(result, 'published');
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'source');
});

test('provider registration cannot adopt a replacement through a new pathname spelling', async t => {
  const f = fixture(t), jobs = new ProviderJobRunner({cancelledMessage: 'Cancelled.', disposedMessage: 'Disposed.'});
  await assert.rejects(jobs.run('alias', async context => {
    context.register(f.input);
    fs.renameSync(f.input, `${f.input}.original`); fs.writeFileSync(f.input, 'replacement');
    context.register(`${f.root.verify()}/./clip.mkv`);
    return 'must reject';
  }), /replaced/);
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(`${f.input}.original`, 'utf8'), 'source');
});

test('Pexels rejects a provider directory replaced while awaiting the response', async t => {
  const f = fixture(t), provider = f.root.providerPath('pexels'), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  let respond;
  const client = new PexelsClient(provider, () => new Promise(resolve => {respond = resolve;})); t.after(() => client.dispose());
  const pending = client.download('swap', {id: '1', url: 'https://videos.pexels.com/1.mp4', mime: 'video/mp4'}, () => {});
  fs.renameSync(provider, `${provider}.old`); fs.symlinkSync(outside, provider);
  respond(new Response('MEDIA', {headers: {'content-type': 'video/mp4'}}));
  const outcome = await pending.then(value => ({value}), error => ({error}));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(outcome.error, 'a changed output directory must reject the download');
});

test('yt-dlp diagnostic logging preserves an unrelated symlink target byte for byte', async t => {
  const f = fixture(t), provider = f.root.providerPath('youtube'), victim = path.join(f.base, 'unrelated.txt');
  const original = 'IMPORTANT HEADER\n' + 'v'.repeat(200000); fs.writeFileSync(victim, original);
  fs.symlinkSync(victim, path.join(provider, 'clipdock.log'));
  const worker = new YtdlpWorker('/fake/yt-dlp', () => {
    const value = child(); queueMicrotask(() => {value.stderr.emit('data', 'ERROR: provider refused request'); value.emit('close', 1);}); return value;
  }, undefined, {sessionDir: provider, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
  t.after(() => worker.dispose());
  await assert.rejects(worker.download('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', 'log-symlink', () => {}));
  assert.equal(fs.readFileSync(victim, 'utf8'), original);
});
