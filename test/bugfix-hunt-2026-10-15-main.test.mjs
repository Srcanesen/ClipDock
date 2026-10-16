import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {mainFixture, deferred, download, historyInput} from './helpers/files-main.mjs';

test('MAIN-1: restoring the captured folder clears its error and resumes downloads without a chooser', async t => {
  const f = await mainFixture(t);
  const moved = `${f.root}.away`;
  fs.renameSync(f.root, moved);
  assert.match((await f.invoke('downloadFolderStatus')).error, /folder changed/);
  fs.renameSync(moved, f.root);
  // A download must revalidate even if the renderer has not refreshed folder status.
  assert.equal((await download(f)).fileName, 'job.mp4');
  assert.equal((await f.invoke('downloadFolderStatus')).error, undefined);
  fs.renameSync(f.root, moved);
  assert.match((await f.invoke('downloadFolderStatus')).error, /folder changed/);
  fs.renameSync(moved, f.root);
  assert.equal((await f.invoke('downloadFolderStatus')).error, undefined);
  fs.renameSync(f.root, moved);
  fs.cpSync(moved, f.root, {recursive: true});
  assert.match((await f.invoke('downloadFolderStatus')).error, /folder changed/);
  await assert.rejects(download(f), /folder changed/);
  assert.equal(fs.readFileSync(path.join(f.root, 'youtube', 'job.mp4'), 'utf8'), 'media');
  // A valid root identity must not clear a distinct startup/provider safety failure.
  const discovery = deferred();
  const unsafe = await mainFixture(t, {discovery: discovery.promise});
  const outside = path.join(unsafe.dir, 'outside'); fs.mkdirSync(outside);
  fs.rmdirSync(path.join(unsafe.root, 'youtube')); fs.symlinkSync(outside, path.join(unsafe.root, 'youtube'));
  discovery.resolve({ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null});
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await unsafe.invoke('downloadFolderStatus')).error, /Choose a usable/);
  await assert.rejects(download(unsafe), /Choose a usable/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('MAIN-2: shutdown refuses new handoffs and waits for both pending native transfers before cleanup', async t => {
  const f = await mainFixture(t);
  const clip = path.join(f.dir, 'clip.mp4'); fs.writeFileSync(clip, 'media');
  f.controls.dialog = async () => ({canceled: false, filePaths: [clip]});
  const {cardId} = await f.invoke('selectFile');
  const imports = deferred(), timelines = deferred();
  let calls = 0;
  f.controls.transfer = () => (++calls === 1 ? imports.promise : timelines.promise);
  const importing = f.invoke('importToMediaPool', cardId, 'active');
  const appending = f.invoke('addToTimeline', cardId, 'active', 'end');
  const outcome = appending.then(() => null, error => error.message);
  t.after(async () => { imports.resolve({ok: true, kind: 'imported'}); timelines.resolve({ok: true}); await Promise.allSettled([importing, appending, outcome]); });
  await turn();
  assert.equal(calls, 2);
  f.quit(); f.quit();
  await pause(20);
  assert.equal(f.lifecycle.cleanups, 0);
  await assert.rejects(f.invoke('importToMediaPool', cardId, 'active'), /shutting down/);
  await assert.rejects(f.invoke('addToTimeline', cardId, 'active', 'end'), /shutting down/);
  assert.equal(calls, 2);
  imports.resolve({ok: true, kind: 'imported'});
  assert.equal((await importing).ok, true);
  await turn();
  assert.equal(f.lifecycle.cleanups, 0);
  // An unsuccessful native call must release shutdown just like a successful one.
  timelines.resolve(Promise.reject(new Error('native failure')));
  assert.equal(await outcome, 'native failure'); await turn();
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.lifecycle.completedQuits, 1);
  // ResolveQuit can arrive synchronously as the handoff crosses into the native module.
  const reentrant = await mainFixture(t), release = deferred();
  t.after(() => release.resolve({ok: true, kind: 'imported'}));
  const media = path.join(reentrant.dir, 'clip.mp4'); fs.writeFileSync(media, 'media');
  reentrant.controls.dialog = async () => ({canceled: false, filePaths: [media]});
  const selected = await reentrant.invoke('selectFile');
  reentrant.controls.transfer = () => { reentrant.quit(); return release.promise; };
  const pending = reentrant.invoke('importToMediaPool', selected.cardId, 'active');
  await pause(20);
  assert.equal(reentrant.lifecycle.cleanups, 0);
  release.resolve({ok: true, kind: 'imported'});
  assert.equal((await pending).ok, true);
  await turn();
  assert.equal(reentrant.lifecycle.cleanups, 1);
  // A stuck bridge must still release shutdown at the existing eight second deadline.
  t.mock.timers.enable({apis: ['setTimeout']});
  const stuck = deferred();
  let boundedTransfer;
  try {
    const bounded = await mainFixture(t);
    const local = path.join(bounded.dir, 'clip.mp4'); fs.writeFileSync(local, 'media');
    bounded.controls.dialog = async () => ({canceled: false, filePaths: [local]});
    const card = await bounded.invoke('selectFile');
    bounded.controls.transfer = () => stuck.promise;
    boundedTransfer = bounded.invoke('addToTimeline', card.cardId, 'active', 'end');
    await turn(); bounded.quit(); await turn();
    t.mock.timers.tick(7999); await turn();
    assert.equal(bounded.lifecycle.cleanups, 0);
    t.mock.timers.tick(1); await turn();
    assert.equal(bounded.lifecycle.cleanups, 1);
    assert.equal(bounded.lifecycle.completedQuits, 1);
  } finally {
    stuck.resolve({ok: true, kind: 'appended'});
    await boundedTransfer;
    t.mock.timers.reset();
  }
});

test('MAIN-3: a second instance quits promptly without waiting for services it never started', async t => {
  const started = Date.now();
  const f = await mainFixture(t, {lock: false});
  await pause(50);
  assert.equal(f.lifecycle.completedQuits, 1);
  assert.equal(f.lifecycle.cleanups, 1);
  assert.equal(f.windows.length, 0);
  assert.deepEqual(f.order, []);
  assert.ok(Date.now() - started < 1000, 'second instance must exit in under one second');
});

test('MAIN-4: status, history, pin and workspace IPC answer while engine discovery is pending', async t => {
  const discovery = deferred();
  const f = await mainFixture(t, {discovery: discovery.promise});
  const timedOut = Symbol('engine-independent IPC blocked');
  let timer;
  try {
    const result = await Promise.race([
      Promise.all([f.invoke('getStatus'), f.invoke('historyList'), f.invoke('setAlwaysOnTop', true), f.invoke('workspaceStatus')]),
      new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), 500); }),
    ]);
    assert.notEqual(result, timedOut);
    const [status, history, pinned, workspace] = result;
    assert.equal(status.project.name, 'Project');
    assert.deepEqual(history, []);
    assert.equal(pinned, true);
    assert.equal(f.windows[0].isAlwaysOnTop(), true);
    assert.equal(workspace.fileCount, 0);
    assert.equal(workspace.cleanupBytes, 0);
    assert.equal(f.workers.length, 0);
  } finally {
    clearTimeout(timer);
    discovery.resolve({ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null});
    await turn();
  }
});

test('MAIN-5: failed engine discovery yields a clear service error and folder changes write nothing', async t => {
  const f = await mainFixture(t, {discovery: Promise.reject(new Error('discovery crashed'))});
  const expected = 'Download services could not start: Initialization failed.';
  assert.equal((await f.invoke('downloadFolderStatus')).error, expected);
  const chosen = path.join(f.dir, 'chosen'); fs.mkdirSync(chosen);
  f.controls.dialog = async () => ({canceled: false, filePaths: [chosen]});
  const requests = [
    ['searchYoutube', 'cats', 1], ['loadYoutube', 'https://youtu.be/dQw4w9WgXcQ'],
    ['searchSubtitles', 'https://youtu.be/dQw4w9WgXcQ', 'en'], ['loadSocial', 'https://www.instagram.com/reel/abc/'],
    ['searchPinterest', 'cats', 1], ['loadPinterest', 'https://www.pinterest.com/pin/123/'],
    ['pexelsKeyStatus'], ['setPexelsKey', 'key'], ['clearPexelsKey'],
    ['searchPexels', 'video', 'cats', 1], ['loadPexels', 'video', 1], ['cancelPexelsRequests'],
    ['chooseDownloadFolder'],
  ];
  // Inspect the chosen folder first: the old path leaves a marker and four provider directories behind.
  const folderOutcome = await f.invoke('chooseDownloadFolder').then(() => null, error => error.message);
  assert.deepEqual(fs.readdirSync(chosen), []);
  assert.equal(folderOutcome, expected);
  for (const [channel, ...args] of requests) {
    await assert.rejects(f.invoke(channel, ...args), error => error.message === expected, channel);
  }
  await assert.rejects(download(f), error => error.message === expected);
  assert.equal((await f.invoke('downloadFolderStatus')).folder, f.root);
  assert.equal(fs.existsSync(path.join(f.userData, 'clipdock-settings.json')), false);
});

test('MAIN-6: a failed folder change rolls back even after cleanup pruned the previous provider directories', async t => {
  const f = await mainFixture(t);
  const before = f.workers.map(worker => worker.root);
  assert.equal((await f.invoke('cleanupWorkspace')).fileCount, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'youtube')), false);
  const chosen = path.join(f.dir, 'chosen'); fs.mkdirSync(chosen);
  fs.mkdirSync(path.join(f.userData, 'clipdock-settings.json'));
  f.controls.dialog = async () => ({canceled: false, filePaths: [chosen]});
  await assert.rejects(f.invoke('chooseDownloadFolder'), /Could not change the download folder/);
  assert.equal((await f.invoke('downloadFolderStatus')).error, undefined);
  assert.equal((await f.invoke('downloadFolderStatus')).folder, f.root);
  assert.deepEqual(f.workers.map(worker => worker.root), before);
  for (const name of ['youtube', 'social', 'pinterest', 'pexels']) {
    assert.equal(fs.lstatSync(path.join(f.root, name)).isDirectory(), true);
  }
  assert.equal((await download(f)).fileName, 'job.mp4');
  assert.equal(fs.readFileSync(path.join(f.root, 'youtube', 'job.mp4'), 'utf8'), 'media');
  assert.deepEqual(fs.readdirSync(path.join(chosen, 'youtube')), []);
});

test('MAIN-7: history deletion reports every removed session card and an empty array when none were removed', async t => {
  const f = await mainFixture(t);
  const completed = await download(f);
  const record = (await f.invoke('historyList'))[0];
  const reused = await f.invoke('historyReuse', record.id);
  const other = path.join(f.root, 'youtube', 'other.mp4'); fs.writeFileSync(other, 'keep');
  const otherRecord = f.controls.history.add(historyInput(other));
  const keep = await f.invoke('historyReuse', otherRecord.id);
  const result = await f.invoke('historyDelete', record.id);
  assert.equal(result.deleted, true);
  assert.equal(result.removed, true);
  assert.deepEqual(result.removedCardIds?.sort(), [completed.cardId, reused.cardId, record.cardId].sort());
  assert.equal(fs.existsSync(path.join(f.root, 'youtube', 'job.mp4')), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
  for (const id of result.removedCardIds) assert.equal((await f.invoke('importToMediaPool', id, 'active')).kind, 'invalid-card');
  assert.equal((await f.invoke('importToMediaPool', keep.cardId, 'active')).ok, true);
  assert.deepEqual((await f.invoke('historyDelete', 'unknown')).removedCardIds, []);
  assert.deepEqual((await f.invoke('historyDelete', null)).removedCardIds, []);
  const unbound = path.join(f.root, 'youtube', 'unbound.mp4'); fs.writeFileSync(unbound, 'delete');
  const unboundRecord = f.controls.history.add(historyInput(unbound));
  assert.deepEqual((await f.invoke('historyDelete', unboundRecord.id)).removedCardIds, []);
  assert.equal(fs.existsSync(unbound), false);
});

test('MAIN-8: rejected external opens return false for Pexels and history sources', async t => {
  const f = await mainFixture(t);
  const file = path.join(f.root, 'youtube', 'clip.mp4'); fs.writeFileSync(file, 'media');
  const record = f.controls.history.add(historyInput(file));
  const urls = [];
  f.controls.openExternal = async url => { urls.push(url); throw new Error('no browser'); };
  assert.equal(await f.invoke('openPexelsExternal', 'https://www.pexels.com/video/123/'), false);
  assert.equal(await f.invoke('historySource', record.id), false);
  assert.deepEqual(urls, ['https://www.pexels.com/video/123/', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  f.controls.openExternal = async url => { urls.push(url); };
  assert.equal(await f.invoke('openPexelsExternal', 'https://www.pexels.com/video/123/'), true);
  assert.equal(await f.invoke('historySource', record.id), true);
  assert.equal(await f.invoke('openPexelsExternal', 'https://example.com/video/123/'), false);
  assert.equal(await f.invoke('historySource', 'missing'), false);
  assert.equal(urls.length, 4);
});

test('MAIN-9: malformed Resolve project or timeline names produce bridge-error status and recover', async t => {
  const f = await mainFixture(t, {realStatus: true});
  let projectName = 'Project', timelineName = 'Timeline';
  f.controls.nativeResolve = {
    GetVersionString: async () => '21.0',
    GetProjectManager: async () => ({GetCurrentProject: async () => ({
      GetName: async () => projectName,
      GetCurrentTimeline: async () => ({GetName: async () => timelineName}),
    })}),
  };
  for (const field of ['project', 'timeline']) {
    for (const malformed of [42, false, {}, []]) {
      projectName = field === 'project' ? malformed : 'Project';
      timelineName = field === 'timeline' ? malformed : 'Timeline';
      const status = await f.invoke('getStatus');
      assert.equal(status.phase, 'bridge-error');
      assert.equal(status.bridge.connected, false);
      assert.equal(status.bridge.error, `Resolve API call failed: Resolve returned an invalid ${field} name.`);
      assert.equal(status[field].name, null);
    }
  }
  projectName = '  Project  '; timelineName = ' Timeline ';
  const recovered = await f.invoke('getStatus');
  assert.equal(recovered.phase, 'ready');
  assert.equal(recovered.project.name, 'Project');
  assert.equal(recovered.timeline.name, 'Timeline');
});
