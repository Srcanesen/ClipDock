import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';

import {createMediaPrep} from '../dist/media-prep.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill() { return true; }
}

function probeJson({container = 'mp4'} = {}) {
  return JSON.stringify({
    streams: [
      {codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '10'},
      {codec_type: 'audio', codec_name: 'aac', duration: '10'},
    ],
    format: {
      format_name: container === 'mp4' ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'matroska,webm',
      duration: '10',
      tags: {major_brand: container === 'mp4' ? 'isom' : ''},
    },
  });
}

function fixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const input = path.join(root, 'clip.mp4');
  writeFileSync(input, 'source');
  return {root, input};
}

function worker(spawn) {
  return createMediaPrep({
    ffmpegPath: '/fake/ffmpeg',
    ffprobePath: '/fake/ffprobe',
    platform: 'linux',
    spawn,
  });
}

test('media-prep direct path runs exactly one ffprobe and no ffmpeg', async () => {
  const {root, input} = fixture('clipdock-media-prep-direct-');
  const calls = [];
  try {
    const mediaPrep = worker((binary, args, options) => {
      assert.deepEqual(options, {shell: false, detached: true});
      const child = new FakeChild();
      calls.push({binary, args});
      setImmediate(() => {
        child.stdout.emit('data', probeJson());
        child.emit('close', 0);
      });
      return child;
    });
    const result = await mediaPrep.prepare({jobId: 'direct', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => undefined});
    assert.equal(result.action, 'direct');
    assert.deepEqual(calls.map(({binary}) => binary), ['/fake/ffprobe'], 'decision probe already proves an untouched direct file is compatible');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('media-prep converted path keeps its post-ffmpeg validation probe', async () => {
  const {root, input} = fixture('clipdock-media-prep-remux-');
  const calls = [];
  let probes = 0;
  try {
    const mediaPrep = worker((binary, args, options) => {
      assert.deepEqual(options, {shell: false, detached: true});
      const child = new FakeChild();
      calls.push({binary, args});
      setImmediate(() => {
        if (binary === '/fake/ffprobe') {
          probes += 1;
          child.stdout.emit('data', probeJson({container: probes === 1 ? 'other' : 'mp4'}));
        } else {
          writeFileSync(args.at(-1), 'prepared');
        }
        child.emit('close', 0);
      });
      return child;
    });
    const result = await mediaPrep.prepare({jobId: 'remux', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => undefined});
    assert.equal(result.action, 'remux');
    assert.deepEqual(calls.map(({binary}) => binary), ['/fake/ffprobe', '/fake/ffmpeg', '/fake/ffprobe']);
    assert.equal(probes, 2, 'converted output is still validated after ffmpeg');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('media-prep cancellation at output validation preserves the input and removes prepared output', async t => {
  const {root, input} = fixture('clipdock-media-prep-cancel-validation-');
  let probes = 0, accepted = false, output;
  const mediaPrep = worker((binary, args) => {
    const child = new FakeChild();
    setImmediate(() => {
      if (binary === '/fake/ffprobe') {
        probes++;
        child.stdout.emit('data', probeJson({container: probes === 1 ? 'other' : 'mp4'}));
      } else {output = args.at(-1); writeFileSync(output, 'prepared');}
      child.emit('close', 0);
      if (probes === 2) queueMicrotask(() => {accepted = mediaPrep.cancel('validation-cancel');});
    });
    return child;
  });
  t.after(async () => {await mediaPrep.dispose(); rmSync(root, {recursive: true, force: true});});
  const events = [];
  await assert.rejects(mediaPrep.prepare({jobId: 'validation-cancel', inputPath: input, allowedRoot: root, profile: 'fast', emit: event => events.push(event)}), {message: 'Media preparation cancelled.'});
  assert.equal(accepted instanceof Promise, true);
  assert.equal(probes, 2);
  assert.equal(existsSync(input), true);
  assert.equal(existsSync(output), false);
  assert.equal(mediaPrep.isActive(), false);
});


for (const origin of ['download job', 'preparation service']) {
  test(`media-prep IPC cancellation from ${origin} emits its terminal payload and removes partial output`, async t => {
    const f = await providerIpcFixture(t, 'youtube', {realPreparation: true, profile: 'editing'});
    let pending;
    try {
      pending = f.start();
      const rejection = assert.rejects(pending, {message: 'Download cancelled.'});
      await f.preparationEntered.promise;
      assert.equal(f.preparedPaths.length, 1);
      assert.equal(existsSync(f.preparedPaths[0]), true);
      if (origin === 'download job') assert.equal(await f.cancel('job'), true);
      else await f.workers.preparation.cancel('job');
      await rejection;
      assert.deepEqual(f.events(), [
        {state: 'downloading', message: 'Starting download…', percent: null},
        {state: 'processing', message: 'Preparing for Resolve…', percent: 0},
        {state: 'cancelled', message: 'Media preparation cancelled.', percent: null},
      ]);
      assert.deepEqual(f.children.filter(child => child.preparation && child.signals.length).map(child => child.signals), [['SIGTERM']]);
      assert.equal(existsSync(f.preparedPaths[0]), false);
      assert.equal((await f.api.workspaceStatus()).fileCount, 0);
      assert.equal(await f.cancel('job'), false);
    } finally {await f.stop(); await pending?.catch(() => {});}
  });
}
