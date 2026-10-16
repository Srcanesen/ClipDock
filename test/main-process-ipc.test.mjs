import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';

// Captured by running these real main/preload/provider flows at c3b9fe0.
// These literals describe the IPC contract, independently of which module emits.
const event = (state, message, percent = null) => ({state, message, percent});
const completed = event('completed', 'Ready for Resolve.', 100);
const cancelled = event('cancelled', 'Download cancelled.');
const ytdlpStart = event('downloading', 'Starting download…');
const ytdlpCancel = event('cancelling', 'Cancelling download…');
const pexelsStart = event('downloading', 'Downloading from Pexels…', 0);
const pinStart = event('downloading', 'Downloading from Pinterest (progress unavailable)…');
const cases = {
  youtube: {
    success: [ytdlpStart, completed],
    failure: [ytdlpStart, event('failed', 'There is not enough disk space to finish the download.')],
    failureMessage: 'There is not enough disk space to finish the download.',
    before: [ytdlpCancel, cancelled], mid: [ytdlpStart, ytdlpCancel, cancelled],
    busy: 'Another YouTube job with this ID is already active.', disposed: 'yt-dlp worker is shut down.',
  },
  social: {
    success: [ytdlpStart, completed],
    failure: [ytdlpStart, event('failed', 'There is not enough disk space to finish the download.')],
    failureMessage: 'There is not enough disk space to finish the download.',
    before: [ytdlpCancel, cancelled], mid: [ytdlpStart, ytdlpCancel, cancelled],
    busy: 'Provider job job is already active.', disposed: 'yt-dlp worker is shut down.',
  },
  pinterest: {
    success: [pinStart, event('downloading', 'Pinterest download complete.', 100), completed],
    failure: [pinStart, event('failed', 'Pinterest download failed.')], failureMessage: 'Pinterest download failed.',
    before: [cancelled], mid: [pinStart, event('downloading', 'Cancelling download…'), cancelled],
    busy: 'Provider job job is already active.', disposed: 'Pinterest worker is shut down.',
  },
  pexels: {
    success: [pexelsStart, event('downloading', 'Downloading from Pexels…', 99.9), event('downloading', 'Downloading from Pexels…', 100), completed],
    // Ordinary Pexels failures reject the invoke; only its timeouts emitted failed.
    failure: [pexelsStart], failureMessage: 'Pexels media request failed.',
    before: [cancelled], mid: [pexelsStart, cancelled],
    busy: 'Provider job job is already active.', disposed: 'Pexels client is shut down.',
  },
};
for (const [provider, expected] of Object.entries(cases)) {
  for (const scenario of ['success', 'failure', 'before start', 'mid-download', 'busy', 'disposed']) {
    test(`${provider} IPC preserves c3b9fe0 ${scenario} events and boolean cancel reply`, async t => {
      const f = await providerIpcFixture(t, provider, {
        failure: scenario === 'failure', holdMetadata: ['before start', 'busy'].includes(scenario),
        holdDownload: scenario === 'mid-download', holdTermination: true,
      });
      let pending;
      try {
        assert.equal(await f.cancel('missing'), false);
        assert.equal(await f.cancel(null), false);
        if (scenario === 'disposed') await f.workers[provider].dispose();
        let settled = false;
        pending = f.start().then(result => {settled = true; return {ok: true};}, error => {settled = true; return {error: error.message, name: error.name};});
        if (['before start', 'busy'].includes(scenario)) await f.metadataEntered.promise;
        if (scenario === 'mid-download') await f.downloadEntered.promise;
        if (scenario === 'busy') {
          await assert.rejects(f.start(), {name: 'Error', message: expected.busy});
          assert.deepEqual(f.events(), [], 'rejected admission sends no event');
        }
        if (['before start', 'mid-download'].includes(scenario)) {
          // The renderer gets an immediate boolean, not the provider's cleanup promise.
          assert.equal(await f.cancel('job'), true);
          assert.equal(settled, false, 'cancel IPC must not wait for process/HTTP termination');
          assert.equal(await f.cancel('job'), false);
          assert.equal(await f.cancel('missing'), false);
        }
        f.releaseMetadata.resolve(); f.releaseDownload.resolve();
        for (const child of f.children) if (child.signals.length) child.emit('close', 143);
        const result = await pending;
        if (scenario === 'failure') {
          assert.deepEqual(result, {error: expected.failureMessage, name: 'Error'});
          assert.deepEqual(f.events(), expected.failure);
        } else if (scenario === 'disposed') {
          assert.deepEqual(result, {error: expected.disposed, name: 'Error'});
          assert.deepEqual(f.events(), []);
        } else if (['before start', 'mid-download'].includes(scenario)) {
          assert.deepEqual(result, {error: 'Download cancelled.', name: 'ProviderJobCancelledError'});
          assert.deepEqual(f.events(), scenario === 'before start' ? expected.before : expected.mid);
        } else {
          assert.deepEqual(result, {ok: true});
          assert.deepEqual(f.events(), expected.success);
        }
        assert.equal(await f.cancel('job'), false);
      } finally {await f.stop(); await pending;}
    });
  }
}

for (const [provider, expected] of Object.entries(cases)) {
  test(`${provider} IPC cancel before admission returns false and leaves the download running`, async t => {
    const f = await providerIpcFixture(t, provider);
    let pending;
    try {
      pending = f.start();
      assert.equal(await f.cancel('job'), false);
      assert.equal(typeof (await pending).cardId, 'string');
      assert.deepEqual(f.events(), expected.success);
    } finally {await f.stop(); await pending?.catch(() => {});}
  });
}

for (const [provider, message] of [
  ['youtube', 'Could not load video metadata.'],
  ['social', 'Could not load public social video metadata. Only permitted public video posts are supported.'],
  ['pinterest', 'Could not load this Pinterest Pin.'],
  ['pexels', 'Pexels request failed (500).'],
]) {
  test(`${provider} IPC metadata failure rejects without a terminal notification`, async t => {
    const f = await providerIpcFixture(t, provider, {metadataFailure: true});
    try {
      await assert.rejects(f.start(), {name: 'Error', message});
      assert.deepEqual(f.events(), []);
      assert.equal(await f.cancel('job'), false);
    } finally {await f.stop();}
  });
}

for (const provider of ['youtube', 'social', 'pinterest']) {
  test(`${provider} IPC worker busy rejection sends no terminal notification`, async t => {
    const f = await providerIpcFixture(t, provider, {holdMetadata: true});
    let blocked;
    try {
      const worker = f.workers[provider];
      blocked = (provider === 'youtube' ? worker.metadata('https://www.youtube.com/watch?v=aaaaaaaaaaa')
        : provider === 'social' ? worker.metadataSocial('https://www.instagram.com/reel/other')
        : worker.metadata('https://www.pinterest.com/pin/456/')).catch(error => error.message);
      await f.metadataEntered.promise;
      await assert.rejects(f.start(), {name: 'Error', message: provider === 'pinterest' ? 'Another Pinterest job is already active.' : 'Another ClipDock URL job is already active.'});
      assert.deepEqual(f.events(), []);
      assert.equal(await f.cancel('job'), false);
    } finally {await f.stop(); await blocked;}
  });
}

test('Pexels IPC timeout retains its failed notification as well as the invoke rejection', async t => {
  const timers = new Map(); let next = 0;
  const f = await providerIpcFixture(t, 'pexels', {holdDownload: true, pexelsTimers: {
    setTimeout(callback, delay) {timers.set(++next, {callback, delay}); return next;},
    clearTimeout(id) {timers.delete(id);},
  }});
  let pending;
  try {
    pending = f.start();
    const rejection = assert.rejects(pending, {name: 'Error', message: 'Pexels media download timed out.'});
    await f.downloadEntered.promise;
    const idle = [...timers.values()].find(timer => timer.delay === 30000);
    assert.equal(typeof idle?.callback, 'function'); idle.callback();
    await rejection;
    assert.deepEqual(f.events(), [pexelsStart, event('failed', 'Pexels media download timed out.')]);
    assert.equal(await f.cancel('job'), false);
  } finally {await f.stop(); await pending?.catch(() => {});}
});


for (const [method, args, message] of [
  ['searchYoutube', ['safe query', 1], 'Could not search YouTube.'],
  ['loadYoutube', ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 'Could not load video metadata.'],
  ['loadSocial', ['https://www.instagram.com/reel/abc'], 'Could not load public social video metadata.'],
]) {
  test(`yt-dlp diagnostics: missing binary preserves ${method} rejection`, async t => {
    const f = await providerIpcFixture(t, 'youtube', {ytdlpPath: null});
    try {
      await assert.rejects(f.api[method](...args), {name: 'Error', message});
      assert.equal(f.children.length, 0);
      assert.deepEqual(f.events(), []);
    } finally {await f.stop();}
  });
}

test('yt-dlp diagnostics: missing ffprobe preserves failed IPC payload, log and cleanup', async t => {
  const f = await providerIpcFixture(t, 'youtube', {ffprobePath: null});
  const message = 'ffprobe was not found. Install ffprobe to validate downloaded media.';
  try {
    await assert.rejects(f.start(), {name: 'Error', message});
    assert.deepEqual(f.events(), [ytdlpStart, event('failed', message)]);
    assert.equal(f.children.length, 2, 'metadata and download run, without a validation spawn');
    const log = join(f.root, 'youtube', 'clipdock.log');
    assert.equal(existsSync(log), true);
    assert.match(readFileSync(log, 'utf8'), /download error: ffprobe was not found\. Install ffprobe to validate downloaded media\./);
    assert.deepEqual(readdirSync(join(f.root, 'youtube')), ['clipdock.log']);
  } finally {await f.stop();}
});

for (const [provider, phase, expected] of [
  ['youtube', 'download', 'download cancelled'],
  ['social', 'metadata', 'social metadata cancelled'],
]) {
  test(`yt-dlp diagnostics: ${provider} ${phase} cancellation retains its log line`, async t => {
    const f = await providerIpcFixture(t, provider, {holdDownload: phase === 'download', holdMetadata: phase === 'metadata'});
    let pending;
    try {
      pending = f.start(); const rejection = assert.rejects(pending, {message: 'Download cancelled.'});
      await (phase === 'download' ? f.downloadEntered.promise : f.metadataEntered.promise);
      assert.equal(await f.cancel('job'), true);
      f.releaseDownload.resolve(); f.releaseMetadata.resolve();
      await rejection;
      const log = join(f.root, provider, 'clipdock.log');
      assert.equal(existsSync(log), true);
      assert.equal(readFileSync(log, 'utf8').split('\n').filter(line => line.endsWith(` ${expected}`)).length, 1);
      assert.deepEqual(f.events().filter(update => update.state === 'cancelled'), [cancelled]);
    } finally {await f.stop(); await pending?.catch(() => {});}
  });
}

test('provider-originated Pexels preflight cancellation normalizes the invoke rejection', async t => {
  const f = await providerIpcFixture(t, 'pexels', {holdMetadata: true});
  let pending;
  try {
    pending = f.start();
    const result = pending.then(() => 'completed', error => error.message);
    await f.metadataEntered.promise;
    assert.equal(f.workers.pexels.abortApiRequests(), true);
    f.releaseMetadata.resolve();
    assert.equal(await result, 'Download cancelled.');
    assert.deepEqual(f.events(), [cancelled]);
    assert.equal(await f.cancel('job'), false);
    assert.deepEqual(readdirSync(join(f.root, 'pexels')), []);
  } finally {await f.stop(); await pending?.catch(() => {});}
});
