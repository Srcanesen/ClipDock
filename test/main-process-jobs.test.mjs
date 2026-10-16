import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {createProviderDownloadHandlers} from '../dist/main-process.js';
import {ProviderJobRunner, ProviderJobCancelledError} from '../dist/provider-job.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {DownloadHistory} from '../dist/history.js';
import {mainFixture, download as startMainDownload} from './helpers/files-main.mjs';

const providers = ['youtube', 'social', 'pinterest', 'pexels'];
const cancelled = error => {
  assert.ok(error instanceof ProviderJobCancelledError);
  assert.equal(error.message, 'Download cancelled.');
  return true;
};
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
const runner = () => new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'Shut down.'});
function fixture(t, provider, boundary) {
  const directory = mkdtempSync(join(tmpdir(), 'clipdock-main-jobs-'));
  const root = ManagedRoot.prepare(join(directory, 'managed'));
  const history = new DownloadHistory(join(directory, 'history.json'), () => root, () => null);
  const ledger = new DownloadLedger(history, () => false);
  const downloads = runner(), preparation = runner();
  const entered = deferred(), release = deferred();
  const events = [];
  const original = join(root.providerPath(provider), 'original.mp4');
  const prepared = join(root.providerPath(provider), 'prepared.mp4');
  const subtitle = join(root.providerPath(provider), 'original.en.srt');
  const pause = async (context, stage) => {
    if (stage !== boundary && !(stage === 'preparation' && boundary === 'preparation-failure')) return;
    entered.resolve();
    await context.wait(Object.assign(release.promise, {cancel: async () => {release.resolve();}}));
  };
  const onReturn = (stage, value) => {
    if (boundary === `late-${stage}`) handlers.cancel('job');
    return value;
  };
  const download = () => downloads.run('job', async context => {
    context.register(original); writeFileSync(original, 'downloaded');
    if (provider === 'youtube') {context.register(subtitle); writeFileSync(subtitle, 'captions');}
    await pause(context, 'download');
    context.publish(original);
    if (provider === 'youtube') context.publish(subtitle);
    return {filePath: original, fileName: 'original.mp4', kind: 'video',
      ...(provider === 'youtube' ? {subtitlePath: subtitle, subtitleFileName: 'original.en.srt'} : {})};
  }).then(value => onReturn('download', value));
  const pin = {pinId: '123', creator: 'Creator', items: [{index: 1, kind: 'video', title: 'Pin'}]};
  const adapters = {
    youtube: {worker: {metadata: async () => ({id: 'dQw4w9WgXcQ', title: 'Video', duration: 10, chapters: []}), download, cancel: id => downloads.cancel(id)}},
    social: {worker: {metadataSocial: async () => ({id: 'abc', platform: 'instagram', source: 'https://www.instagram.com/reel/abc', title: 'Social'}), downloadSocial: download, cancel: id => downloads.cancel(id)}},
    pinterest: {worker: {metadata: async () => pin, download, cancel: id => downloads.cancel(id)}, snapshots: {get: () => pin, remember: () => {}}},
    pexels: {worker: {load: async () => ({kind: 'video', id: 7, sourceUrl: 'https://www.pexels.com/video/7/', title: 'Video', files: [{id: 'file', label: 'HD'}]}), download, cancel: id => downloads.cancel(id)}},
  };
  for (const adapter of Object.values(adapters)) adapter.emit = (_event, update) => events.push(update);
  const cancelPreparation = () => preparation.cancel('job');
  const dependencies = {
    ...adapters, ffprobeAvailable: true,
    cancelMediaPreparation: cancelPreparation,
    registerSubtitle: (file, fileName) => ({cardId: ledger.registerSubtitle(file, root), fileName}),
    completion: {
      isSafeMediaFile: file => root.resolve(file) !== null,
      refreshHistoryProject: async () => {
        if (boundary === 'completion') {entered.resolve(); await release.promise;}
      },
      recordHistory: input => ledger.record(input),
      registerCard: input => ledger.register(input, root),
      prepareMedia: request => preparation.run(request.jobId, async context => {
        if (boundary === 'direct') return {filePath: original, fileName: 'original.mp4'};
        context.register(prepared); writeFileSync(prepared, 'prepared');
        await pause(context, 'preparation');
        if (boundary === 'failure' || boundary === 'preparation-failure') throw new Error('Media preparation failed: fixture failure.');
        context.publish(prepared, () => rmSync(original, {force: true}));
        return {filePath: prepared, fileName: 'prepared.mp4'};
      }).then(value => onReturn('preparation', value)),
    },
  };
  const handlers = createProviderDownloadHandlers(dependencies);
  t.after(async () => {
    release.resolve();
    await handlers.shutdown(); await downloads.dispose(); await preparation.dispose();
    rmSync(directory, {recursive: true, force: true});
  });
  const start = (profile = 'fast') => {
    const event = {sender: {}};
    if (provider === 'youtube') return handlers.youtube(event, 'https://youtu.be/dQw4w9WgXcQ', 'best', profile, 'job', {mediaMode: 'video', audioFormat: 'm4a', subtitles: true, subtitleLanguage: 'en'});
    if (provider === 'social') return handlers.social(event, 'https://www.instagram.com/reel/abc', 'best', profile, 'job');
    if (provider === 'pinterest') return handlers.pinterest(event, 'https://www.pinterest.com/pin/123/', 1, profile, 'job');
    return handlers.pexels(event, {kind: 'video', id: 7}, 'file', profile, 'job');
  };
  const files = () => readdirSync(root.verify(), {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => relative(root.verify(), join(entry.parentPath, entry.name))).sort();
  return {handlers, dependencies, directory, root, start, entered, release, files, ledger, history, events, original, prepared, subtitle};
}

for (const provider of providers) {
  test(`${provider}: cancel during preparation removes every unpublished file`, async t => {
    const f = fixture(t, provider, 'preparation');
    const pending = f.start();
    const rejected = assert.rejects(pending, cancelled);
    await f.entered.promise;
    assert.equal(readFileSync(f.original, 'utf8'), 'downloaded');
    assert.equal(readFileSync(f.prepared, 'utf8'), 'prepared');
    assert.equal(f.handlers.cancel('job'), true);
    await rejected;
    assertUnpublished(f);
    assert.deepEqual(f.events, [{jobId: 'job', state: 'cancelled', percent: null, message: 'Download cancelled.'}]);
  });
}

function assertUnpublished(f) {
  assert.deepEqual(f.files(), []);
  assert.deepEqual(f.ledger.protectedPaths(), []);
  assert.deepEqual(f.history.list(), []);
  assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
  assert.equal(f.handlers.cancel('job'), false);
}

for (const provider of providers) {
  test(`${provider}: cancel during download terminates work and removes every file`, async t => {
    const f = fixture(t, provider, 'download');
    const pending = f.start();
    const rejected = assert.rejects(pending, cancelled);
    await f.entered.promise;
    assert.equal(readFileSync(f.original, 'utf8'), 'downloaded');
    assert.equal(f.handlers.cancel('job'), true);
    assert.equal(f.handlers.cancel('job'), false, 'only one cancellation is admitted');
    await rejected;
    assertUnpublished(f);
    assert.deepEqual(f.events, [{jobId: 'job', state: 'cancelled', percent: null, message: 'Download cancelled.'}]);
  });

  test(`${provider}: preparation failure removes download, partial output and subtitles`, async t => {
    const f = fixture(t, provider, 'failure');
    await assert.rejects(f.start(), {message: 'Media preparation failed: fixture failure.'});
    assertUnpublished(f);
  });

  for (const boundary of ['download', 'preparation']) {
    test(`${provider}: shutdown during ${boundary} awaits cleanup and refuses new jobs`, async t => {
      const f = fixture(t, provider, boundary);
      const pending = f.start();
      const rejected = assert.rejects(pending, cancelled);
      await f.entered.promise;
      await Promise.all([f.handlers.shutdown(), f.handlers.shutdown()]);
      await rejected;
      assertUnpublished(f);
      await assert.rejects(f.start(), {message: 'Download services are shutting down.'});
      assertUnpublished(f);
    });
  }

  for (const profile of ['original', 'fast']) {
    test(`${provider}: completed ${profile} job keeps exactly the card's files`, async t => {
      const f = fixture(t, provider);
      const result = await f.start(profile);
      const file = profile === 'original' ? f.original : f.prepared;
      const fileName = profile === 'original' ? 'original.mp4' : 'prepared.mp4';
      const expected = [`${provider}/${fileName}`, ...(provider === 'youtube' ? ['youtube/original.en.srt'] : [])].sort();
      assert.equal(result.fileName, fileName);
      assert.equal(f.ledger.resolve(result.cardId)?.path, file);
      assert.equal(readFileSync(file, 'utf8'), profile === 'original' ? 'downloaded' : 'prepared');
      assert.deepEqual(f.files(), expected);
      assert.deepEqual(f.ledger.protectedPaths().sort(), [file, ...(provider === 'youtube' ? [f.subtitle] : [])].sort());
      const records = f.history.list();
      assert.equal(records.length, 1);
      assert.equal(records[0].provider, provider);
      assert.equal(records[0].fileName, fileName);
      assert.equal(records[0].profile, profile);
      assert.equal(f.history.resolve(records[0].id)?.path, file);
      const completed = f.events.filter(event => event.state === 'completed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].cardId, result.cardId);
      assert.equal(completed[0].message, 'Ready for Resolve.');
      if (provider === 'youtube') {
        assert.equal(f.ledger.resolve(result.subtitle.cardId)?.path, f.subtitle);
        assert.equal(f.ledger.resolve(result.cardId)?.subtitlePath, f.subtitle);
        assert.equal(result.subtitle.fileName, 'original.en.srt');
      } else assert.equal(Object.hasOwn(completed[0], 'subtitle'), false);
      assert.equal(f.handlers.cancel('job'), false);
      await f.handlers.shutdown();
      assert.deepEqual(f.files(), expected, 'shutdown preserves published cards');
    });
  }
}

for (const provider of providers) {
  for (const stage of ['download', 'preparation']) {
    test(`${provider}: cancellation as ${stage} returns still cleans committed provider output`, async t => {
      const f = fixture(t, provider, `late-${stage}`);
      await assert.rejects(f.start(), cancelled);
      assertUnpublished(f);
    });
  }

  for (const action of ['cancel', 'shutdown']) {
    test(`${provider}: ${action} during completion never publishes a late card or subtitle`, async t => {
      const f = fixture(t, provider, 'completion');
      const pending = f.start();
      const rejected = assert.rejects(pending, cancelled);
      await f.entered.promise;
      assert.equal(readFileSync(f.prepared, 'utf8'), 'prepared');
      assert.deepEqual(f.ledger.protectedPaths(), [], 'card registration waits until publication');
      if (action === 'cancel') assert.equal(f.handlers.cancel('job'), true);
      else await f.handlers.shutdown();
      await rejected;
      f.release.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assertUnpublished(f);
    });
  }

  test(`${provider}: preparation can return the original file and publish its card`, async t => {
    const f = fixture(t, provider, 'direct');
    const result = await f.start();
    assert.equal(result.fileName, 'original.mp4');
    assert.equal(f.ledger.resolve(result.cardId)?.path, f.original);
    assert.equal(readFileSync(f.original, 'utf8'), 'downloaded');
    assert.deepEqual(f.files(), [`${provider}/original.mp4`, ...(provider === 'youtube' ? ['youtube/original.en.srt'] : [])].sort());
    assert.equal(f.history.list()[0].profile, 'fast');
  });
}

for (const channel of ['cancelYoutube', 'cancelSocial', 'cancelPinterest', 'cancelPexels']) {
  test(`main IPC ${channel} reaches the single cancellation owner for the admitted id`, async t => {
    // Run the full compiled main entry point. The helper substitutes Electron
    // and native services with in-process boundaries; it opens no real window.
    const f = await mainFixture(t);
    const entered = deferred(), release = deferred();
    f.controls.status = () => {entered.resolve(); return release.promise;};
    const pending = startMainDownload(f);
    const rejected = assert.rejects(pending, cancelled);
    await entered.promise;
    const original = join(f.root, 'youtube', 'job.mp4');
    assert.equal(readFileSync(original, 'utf8'), 'media');
    assert.equal(await f.invoke(channel, 'job'), true);
    await rejected;
    assert.equal(await f.invoke(channel, 'job'), false);
    assert.equal((await f.invoke('workspaceStatus')).fileCount, 0);
    assert.deepEqual(f.controls.history.list(), []);
    release.resolve({project: {name: 'Project'}});
    f.quit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.lifecycle.completedQuits, 1);
  });
}

// Gate reproductions adapted from root-cancel-directory-replacement.mjs,
// jobs-publication-subtitle-failure.cjs and root-history-commit-identity-swap.mjs.
for (const provider of providers) {
  for (const outcome of ['cancel', 'preparation failure']) {
    test(`gate: ${provider} preserves user media replacing a download directory on ${outcome}`, async t => {
      const f = fixture(t, provider, outcome === 'cancel' ? 'completion' : 'preparation-failure');
      const saved = join(f.directory, 'saved-original.mp4');
      const pending = f.start(outcome === 'cancel' ? 'original' : 'fast');
      const rejection = assert.rejects(pending, outcome === 'cancel' ? cancelled : {message: 'Media preparation failed: fixture failure.'});
      await f.entered.promise;
      renameSync(f.original, saved);
      mkdirSync(f.original);
      const userMedia = join(f.original, 'user-media.mov');
      writeFileSync(userMedia, 'irreplaceable user media');
      if (outcome === 'cancel') assert.equal(f.handlers.cancel('job'), true);
      else f.release.resolve();
      await rejection;
      assert.equal(readFileSync(userMedia, 'utf8'), 'irreplaceable user media');
      assert.equal(readFileSync(saved, 'utf8'), 'downloaded');
      assert.deepEqual(f.ledger.protectedPaths(), []);
      assert.deepEqual(f.history.list(), []);
      assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
    });
  }
}

test('gate: media card failure preserves an already bound subtitle', async t => {
  const f = fixture(t, 'youtube', 'completion');
  const saved = join(f.directory, 'moved.mp4');
  const pending = f.start('original');
  const rejection = assert.rejects(pending, {message: 'File safety check failed: replaced.'});
  await f.entered.promise;
  assert.deepEqual(f.ledger.protectedPaths(), []);
  renameSync(f.original, saved);
  f.release.resolve();
  await rejection;
  assert.equal(readFileSync(saved, 'utf8'), 'downloaded');
  assert.equal(readFileSync(f.subtitle, 'utf8'), 'captions');
  assert.deepEqual(f.ledger.protectedPaths(), [f.subtitle]);
  assert.deepEqual(f.history.list(), []);
  assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
});

test('gate: card failure after persisted history and an ancestor swap preserves referenced media', async t => {
  const f = fixture(t, 'social');
  const relocated = join(f.directory, 'relocated-managed');
  let recordedId;
  f.dependencies.completion.recordHistory = input => {
    const result = f.ledger.record(input);
    recordedId = result.record.id;
    renameSync(f.root.verify(), relocated);
    symlinkSync(relocated, join(f.directory, 'managed'));
    return result;
  };
  await assert.rejects(f.start('original'), {message: 'Could not safely register managed download.'});
  const saved = JSON.parse(readFileSync(join(f.directory, 'history.json'), 'utf8')).records;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, recordedId);
  assert.equal(saved[0].filePath, f.original);
  assert.equal(readFileSync(join(relocated, 'social', 'original.mp4'), 'utf8'), 'downloaded');
  assert.equal(f.events.filter(event => event.state === 'completed').length, 0);
});
