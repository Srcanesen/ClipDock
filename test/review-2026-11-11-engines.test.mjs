import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {appendFileSync, existsSync, mkdtempSync, readdirSync, renameSync, mkdirSync, rmSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {GalleryDlWorker} from '../dist/gallerydl.js';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {PexelsClient} from '../dist/pexels.js';
import {PixabayClient} from '../dist/pixabay.js';
import {createStatusProvider} from '../dist/status-provider.js';
import {probeVersion} from '../dist/provider-platform.js';

const MINUTE = 60_000;
const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const pin = 'https://www.pinterest.com/pin/123/';
const turn = () => new Promise(resolve => setImmediate(resolve));
function root(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clipdock-review-engines-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}
const probe = JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96}], format: {duration: '10', format_name: 'mov,mp4'}});
function engine(t, kind) {
  let child, directory;
  const spawn = (_binary, args) => {
    const next = new Child();
    if (args.includes('-show_streams')) queueMicrotask(() => {next.stdout.emit('data', probe); next.emit('close', 0);});
    else {child = next; directory = kind === 'gallery' ? args[args.indexOf('-D') + 1] : dirname(args[args.indexOf('-o') + 1]);}
    return next;
  };
  const options = {sessionDir: root(t), ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', killGraceMs: 1};
  const worker = kind === 'gallery' ? new GalleryDlWorker('/fake/gallery', spawn, options) : new YtdlpWorker('/fake/ytdlp', spawn, undefined, options);
  t.after(() => worker.dispose());
  return {
    worker,
    get child() { return child; },
    get directory() { return directory; },
    start(id) { return kind === 'gallery' ? worker.download(pin, 1, 'video', id, () => {}) : worker.download(youtube, 'best', id, () => {}); },
    finish() {
      const file = join(directory, kind === 'gallery' ? 'pinterest.mp4' : 'clip.mp4');
      writeFileSync(file, Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
      if (kind !== 'gallery') child.stdout.emit('data', `P|${file}\n`);
      child.emit('close', 0);
    },
  };
}

// One defect across all download engines, including silent transfer/merge phases,
// a real stall and immediate cancellation. Each old fixed deadline is crossed.
test('L1: progressing downloads have no elapsed-time deadline; silence scales with input', async t => {
  for (const kind of ['gallery', 'ytdlp']) await t.test(kind, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const e = engine(t, kind);
    const pending = e.start('healthy');
    let error;
    void pending.catch(value => {error = value;});
    await turn();
    const part = join(e.directory, 'stream.mp4.part'); writeFileSync(part, 'bytes');
    const hours = kind === 'gallery' ? 3 : 9;
    for (let minute = 0; minute < hours * 60; minute++) {
      if (error) break;
      if (kind === 'gallery') appendFileSync(part, 'more');
      if (kind === 'ytdlp') e.child.stdout.emit('data', `C|downloading|50|${minute + 1}|999999|1|1|18\n`);
      t.mock.timers.tick(MINUTE); await turn();
    }
    assert.equal(error, undefined, 'healthy bytes must survive the old overall deadline');
    assert.equal(existsSync(part), true);
    // A 1.5 GiB input needs a byte-sized read/write budget even for short media.
    truncateSync(part, 1536 * 1024 * 1024);
    if (kind === 'ytdlp') e.child.stderr.emit('data', 'Q|started\n');
    t.mock.timers.tick(MINUTE); await turn();
    t.mock.timers.tick(35 * MINUTE); await turn();
    assert.equal(error, undefined, 'a silent merge must use the bytes it processes');
    e.finish();
    assert.match((await pending).fileName, /\.mp4$/);
    assert.deepEqual(e.child.signals, []);

    const stalled = e.start('stalled'); const rejected = assert.rejects(stalled, /timed out/);
    await turn(); t.mock.timers.tick(31 * MINUTE); await rejected;
    assert.deepEqual(e.child.signals, ['SIGTERM']);

    const cancelled = e.start('cancelled'); const cancellation = assert.rejects(cancelled, /cancelled/);
    await turn(); const stopping = e.worker.cancel('cancelled');
    assert.deepEqual(e.child.signals, ['SIGTERM']);
    await stopping; await cancellation;

    if (kind === 'ytdlp') {
      const longMedia = e.start('longmedia');
      let failure; void longMedia.catch(value => {failure = value;});
      await turn();
      e.child.stdout.emit('data', 'S|18|NA|2048|14400\n');
      e.child.stderr.emit('data', 'Q|started\n');
      t.mock.timers.tick(90 * MINUTE); await turn();
      assert.equal(failure, undefined, 'the extracted input duration sizes silent processing');
      e.finish(); assert.equal((await longMedia).fileName, 'clip.mp4');
    }
  });
  for (const Client of [PexelsClient, PixabayClient]) await t.test(Client.name, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let stream;
    const client = new Client(root(t), async () => new Response(new ReadableStream({start(controller) {stream = controller;}}), {headers: {'content-type': 'video/mp4'}}));
    t.after(() => client.dispose());
    const host = Client === PexelsClient ? 'videos.pexels.com' : 'cdn.pixabay.com';
    const pending = client.download('healthy', {url: `https://${host}/clip.mp4`, mime: 'video/mp4'}, () => {});
    let error; void pending.catch(value => {error = value;});
    await turn();
    for (let step = 0; step < 7 * 60 * 3; step++) {
      if (error) break;
      stream.enqueue(new Uint8Array([1])); await turn(); await turn();
      t.mock.timers.tick(20_000); await turn();
    }
    assert.equal(error, undefined, 'HTTP bytes must survive the old six-hour deadline');
    stream.close(); assert.match((await pending).fileName, /\.mp4$/);
  });
});

test('status expiry releases the shared slot and late completions cannot take it back', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const stage of ['initialize', 'resolve', 'project']) {
    let releaseOld, releaseNew, calls = 0;
    const hang = () => new Promise(resolve => {if (++calls === 1) releaseOld = resolve; else releaseNew = resolve;});
    const resolve = {GetVersionString: async () => '21', GetProjectManager: () => stage === 'project' ? hang() : null};
    const provider = createStatusProvider({
      Initialize: () => stage === 'initialize' ? hang() : true,
      GetInfo: () => ({}),
      GetResolve: () => stage === 'resolve' ? hang() : resolve,
    }, 'test');
    const first = provider.getStatus(); assert.equal(provider.getStatus(), first);
    let expired; void first.then(value => {expired = value;});
    await turn(); t.mock.timers.tick(15_000); await turn();
    assert.equal(expired?.phase, 'bridge-error');
    assert.match(expired.message, /timed out/);
    const second = provider.getStatus(); await turn();
    assert.notEqual(second, first); assert.equal(calls, 2);
    releaseOld(stage === 'initialize' ? true : null); await turn();
    assert.equal(provider.getStatus(), second, 'expired collection must not release a newer slot');
    provider.noteResolveQuit();
    let quit; void second.then(value => {quit = value;}); await turn();
    assert.equal(quit?.bridge.connected, false);
    assert.match(quit.message, /shutting down/);
    assert.match((await provider.getStatus()).message, /shutting down/);
    releaseNew(stage === 'initialize' ? true : null); await turn();
  }
});

test('stock cancels an accepted response when output-file admission fails', async t => {
  for (const Client of [PexelsClient, PixabayClient]) {
    const parent = root(t), directory = join(parent, 'output');
    let cancelled = 0;
    const client = new Client(directory, async () => {
      renameSync(directory, join(parent, 'old-output')); mkdirSync(directory);
      return new Response(new ReadableStream({cancel() {cancelled++;}}), {headers: {'content-type': 'video/mp4'}});
    });
    t.after(() => client.dispose());
    const host = Client === PexelsClient ? 'videos.pexels.com' : 'cdn.pixabay.com';
    await assert.rejects(client.download('diskfail', {url: `https://${host}/clip.mp4`, mime: 'video/mp4'}, () => {}), /media download failed/);
    assert.equal(cancelled, 1);
    assert.deepEqual(readdirSync(directory), []);
    await client.dispose(); assert.equal(cancelled, 1);
  }
});

test('gallery extraction warnings reject each search without caching an empty result', async t => {
  let calls = 0;
  const worker = new GalleryDlWorker('/fake/gallery', () => {
    calls++; const child = new Child();
    queueMicrotask(() => {
      child.stderr.emit('data', '[pinterest][warning] 123: Error when extracting download URLs (ValueError: max() iterable argument is empty)\n');
      child.emit('close', 0);
    });
    return child;
  }, {sessionDir: root(t)});
  t.after(() => worker.dispose());
  for (let i = 0; i < 2; i++) await assert.rejects(worker.search('video', 1), /extract/i);
  assert.equal(calls, 2);
  assert.equal(worker.searchCache.get('video'), null);
});

test('every short-link response body is cancelled after its headers on success or rejection', async t => {
  const api = 'https://api.pinterest.com/url_shortener/abc/redirect/';
  for (const responses of [
    [[302, pin]], [[200, '']], [[302, 'https://evil.example/pin/123/']],
    [[302, api], [302, pin]], [[302, api], [200, '']], [[302, api], [302, 'https://evil.example/']],
  ]) {
    let requests = 0, cancelled = 0;
    const worker = new GalleryDlWorker('/fake/gallery', () => {
      const child = new Child();
      queueMicrotask(() => {child.stdout.emit('data', '[2,{"id":"123","count":1}]\n[3,"https://i.pinimg.com/123.jpg",{"id":"123","extension":"jpg"}]\n'); child.emit('close', 0);});
      return child;
    }, {sessionDir: root(t), fetcher: async () => {
      const [status, location] = responses[requests++];
      return {status, headers: {get: () => location}, body: new ReadableStream({cancel() {cancelled++; return new Promise(() => {});}})};
    }});
    t.after(() => worker.dispose());
    if (responses.at(-1)[1] === pin) assert.equal((await worker.metadata('https://pin.it/abc')).pinId, '123');
    else await assert.rejects(worker.metadata('https://pin.it/abc'), /short link/);
    assert.equal(requests, responses.length);
    assert.equal(cancelled, responses.length, 'cancellation must not await a hostile body');
  }
});

test('version probes kill on timeout and reject spawn errors even with exit status zero', t => {
  const options = [];
  let result = {status: 0, stdout: 'fixture version 1.0', stderr: ''};
  t.mock.method(childProcess, 'spawnSync', (_binary, _args, opts) => {options.push(opts); return result;});
  assert.deepEqual(probeVersion('/fake/tool', ['--version']), {code: 0, text: 'fixture version 1.0'});
  for (const code of ['ETIMEDOUT', 'ENOENT']) {
    result = {...result, error: Object.assign(new Error(code), {code})};
    assert.equal(probeVersion('/fake/tool', ['--version']), null);
  }
  assert.deepEqual(options.map(option => [option.timeout, option.killSignal, option.shell]), Array(3).fill([3000, 'SIGKILL', false]));
});
