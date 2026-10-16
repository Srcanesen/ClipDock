import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {mainFixture, deferred, download} from './helpers/files-main.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('merged startup uses discovered paths and registers late-created services for awaited shutdown', async t => {
  const discovered = {ffmpegPath: '/discovered/ffmpeg', ffprobePath: '/discovered/ffprobe', ytdlpPath: '/discovered/yt-dlp', galleryDlPath: '/discovered/gallery-dl'};
  const f = await mainFixture(t, {discovery: Promise.resolve(discovered)});
  assert.deepEqual(f.order.slice(0, 2), ['window', 'discovery']);
  assert.equal(f.workers.length, 9);
  for (const index of [0, 1, 5, 6, 7, 8]) assert.equal(f.workers[index].options.ffprobePath, '/discovered/ffprobe');
  assert.equal(path.basename(f.workers[2].initialRoot), 'pinterest');
  assert.equal(path.basename(path.dirname(f.workers[2].initialRoot)).startsWith('clipdock-runtime-'), true);
  const release = deferred(), entered = deferred();
  let disposed = 0;
  for (const worker of f.workers) worker.dispose = async () => {disposed++; if (worker === f.workers[0]) {entered.resolve(); await release.promise;}};
  f.quit();
  await entered.promise;
  assert.equal(disposed, 9);
  assert.equal(f.lifecycle.completedQuits, 0);
  assert.equal(f.lifecycle.cleanups, 0);
  f.quit(); // A second quit event must share the in-progress shutdown.
  release.resolve(); await tick();
  assert.equal(disposed, 9);
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.lifecycle.completedQuits, 1);
});

test('merged shutdown waits for discovery without creating services after quit begins', async t => {
  const discovery = deferred();
  const f = await mainFixture(t, {discovery: discovery.promise});
  const pending = download(f);
  const rejected = assert.rejects(pending, /shutting down/);
  f.quit(); await tick();
  assert.deepEqual(f.order, ['window', 'discovery']);
  assert.equal(f.lifecycle.completedQuits, 0);
  discovery.resolve({ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null});
  await rejected; await tick();
  assert.equal(f.workers.length, 0);
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.lifecycle.completedQuits, 1);
});

for (const action of ['cancel', 'shutdown']) {
  test(`merged ${action} forwards YouTube ownership through the deferred dispatch wrapper`, async t => {
    const f = await mainFixture(t), entered = deferred(), release = deferred();
    f.controls.status = () => {entered.resolve(); return release.promise;};
    const pending = download(f), rejected = assert.rejects(pending, /cancelled/i);
    await entered.promise;
    const file = path.join(f.root, 'youtube', 'job.mp4');
    assert.equal(fs.readFileSync(file, 'utf8'), 'media');
    if (action === 'cancel') assert.equal(await f.invoke('cancelYoutube', 'job'), true);
    else f.quit();
    await rejected; await tick();
    assert.equal(fs.existsSync(file), false);
    assert.equal(f.controls.history.list().length, 0);
    if (action === 'shutdown') assert.equal(f.lifecycle.completedQuits, 1);
    else assert.equal((await f.invoke('workspaceStatus')).fileCount, 0);
    release.resolve({project: {name: 'Project'}});
  });
}
