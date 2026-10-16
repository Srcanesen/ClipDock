import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {providerIpcFixture, youtubeUrl, tick} from './helpers/provider-ipc.mjs';

// Only the extractor child is fake: subscriptions, jobs, IPC and terminal events
// use production code. A pending child is released explicitly, never by a timer.
function fixture(t, social = false) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'review-cancel-'));
  const children = [], workers = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.signals = [];
    child.kill = signal => { child.signals.push(signal); queueMicrotask(() => child.emit('close', 143)); return true; };
    children.push(child); return child;
  };
  const make = () => {
    const worker = new YtdlpWorker('/fixture/yt-dlp', spawn, undefined, {
      sessionDir: path.join(root, String(workers.length)), ffmpegPath: null, ffprobePath: null, killGraceMs: 5,
    });
    workers.push(worker); return worker;
  };
  const load = (worker, jobId) => social
    ? worker.metadataSocial('https://x.com/user/status/123', {jobId, emit() {}})
    : worker.metadata(youtubeUrl, {jobId, emit() {}});
  const release = () => {
    children[0].stdout.emit('data', JSON.stringify({id: social ? '123' : 'dQw4w9WgXcQ', title: 'Clip', ext: 'mp4', formats: [{height: 720}]}));
    children[0].emit('close', 0);
  };
  t.after(async () => { await Promise.all(workers.map(worker => worker.dispose())); fs.rmSync(root, {recursive: true, force: true}); });
  return {make, load, release, children, root};
}

for (const social of [false, true]) {
  const provider = social ? 'social' : 'YouTube';
  for (const action of ['cancel', 'dispose']) {
    test(`${provider}: ${action} settles a joined metadata subscriber before extraction completes`, async t => {
      const f = fixture(t, social), owner = f.make(), subscriber = f.make();
      const first = f.load(owner, 'owner');
      void first.catch(() => {});
      let outcome = 'pending';
      const joined = f.load(subscriber, 'joined').then(() => { outcome = 'completed'; }, error => { outcome = error.message; });
      assert.equal(f.children.length, 1);
      if (action === 'cancel') void subscriber.cancel('joined');
      else void subscriber.dispose();
      await tick();
      assert.equal(outcome, 'Download cancelled.');
      assert.deepEqual(f.children[0].signals, []);
      const retry = action === 'cancel' ? f.load(subscriber, 'retry') : null;
      f.release();
      assert.equal((await first).title, 'Clip');
      if (retry) assert.equal((await retry).title, 'Clip');
      assert.equal(f.children.length, 1);
      await joined;
      assert.equal(subscriber.isActive(), false);
    });
  }

  test(`${provider}: disposing the first subscriber preserves extraction for another subscriber`, async t => {
    const f = fixture(t, social), owner = f.make(), subscriber = f.make();
    const first = f.load(owner, 'owner').then(() => 'completed', error => error.message);
    const joined = f.load(subscriber, 'joined');
    // Observe rejection even on the unfixed implementation before asserting.
    void joined.catch(() => {});
    await owner.dispose();
    assert.equal(await first, 'Download cancelled.');
    assert.deepEqual(f.children[0].signals, []);
    f.release();
    assert.equal((await joined).title, 'Clip');
    assert.equal(f.children.length, 1);
  });

  test(`${provider}: disposing all subscribers terminates extraction and removes private metadata files`, async t => {
    const f = fixture(t, social), owner = f.make(), subscriber = f.make();
    const first = f.load(owner, 'owner').catch(error => error.message);
    const joined = f.load(subscriber, 'joined').catch(error => error.message);
    await Promise.all([owner.dispose(), subscriber.dispose()]);
    assert.deepEqual(await Promise.all([first, joined]), ['Download cancelled.', 'Download cancelled.']);
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    for (const dir of fs.readdirSync(f.root)) {
      assert.deepEqual(fs.readdirSync(path.join(f.root, dir)).filter(name => name.startsWith('metadata-')), []);
    }
  });

  test(`${provider}: a retry cannot join abandoned extraction or be evicted by its completion`, async t => {
    const f = fixture(t, social), owner = f.make(), retryWorker = f.make(), joinWorker = f.make();
    const first = f.load(owner, 'owner').catch(error => error.message);
    const cancelled = owner.cancel('owner');
    const retry = f.load(retryWorker, 'retry'); void retry.catch(() => {});
    await cancelled; await first;
    const joined = f.load(joinWorker, 'joined'); void joined.catch(() => {});
    assert.equal(f.children.length, 2);
    f.children[1].stdout.emit('data', JSON.stringify({id: social ? '123' : 'dQw4w9WgXcQ', title: 'Retry', ext: 'mp4', formats: [{height: 720}]}));
    f.children[1].emit('close', 0);
    assert.deepEqual((await Promise.all([retry, joined])).map(metadata => metadata.title), ['Retry', 'Retry']);
  });

  test(`${provider}: same-worker subscribers cancel by ID and all settle on disposal`, async t => {
    const f = fixture(t, social), owner = f.make(), other = f.make();
    const first = f.load(owner, 'owner').catch(error => error.message);
    const joined = f.load(owner, 'joined').catch(error => error.message);
    const survivor = f.load(other, 'survivor'); void survivor.catch(() => {});
    const cancelled = owner.cancel('joined');
    assert.equal(cancelled instanceof Promise, true);
    await cancelled;
    assert.equal(await joined, 'Download cancelled.');
    const replacement = f.load(owner, 'replacement').catch(error => error.message);
    await owner.dispose();
    assert.deepEqual(await Promise.all([first, replacement]), ['Download cancelled.', 'Download cancelled.']);
    assert.deepEqual(f.children[0].signals, []);
    f.release();
    assert.equal((await survivor).title, 'Clip');
    assert.equal(f.children.length, 1);
  });
}

test('Stop settles the download invoke and emits one cancelled terminal while prefetch stays pending', async t => {
  const f = await providerIpcFixture(t, 'youtube', {holdMetadata: true});
  try {
    const prefetch = f.api.prefetchYoutube(youtubeUrl);
    await f.metadataEntered.promise;
    let outcome = 'pending';
    const download = f.start('joined').then(() => { outcome = 'completed'; }, error => { outcome = error.message; });
    await tick();
    assert.equal(await f.cancel('joined'), true);
    await tick();
    assert.equal(outcome, 'Download cancelled.');
    assert.deepEqual(f.events('joined').filter(event => ['completed', 'failed', 'cancelled'].includes(event.state)), [
      {state: 'cancelled', message: 'Download cancelled.', percent: null},
    ]);
    assert.deepEqual(f.children[0].signals, []);
    assert.equal(f.requests.metadata, 1);
    f.releaseMetadata.resolve(); await prefetch; await download;
    assert.equal(f.requests.media, 0);
  } finally { await f.stop(); }
});
