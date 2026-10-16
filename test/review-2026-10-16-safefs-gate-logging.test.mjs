import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {ManagedRoot} from '../dist/managed-root.js';
import {cleanupWorkspace} from '../dist/workspace.js';
import {YtdlpWorker} from '../dist/ytdlp.js';

function fixture(t, hook = () => {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'safefs-gate-log-')));
  const root = ManagedRoot.prepare(path.join(base, 'managed'));
  const provider = root.providerPath('youtube'), log = path.join(provider, 'clipdock.log');
  let attempts = 0;
  const worker = new YtdlpWorker('/fake/yt-dlp', () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    const attempt = ++attempts;
    queueMicrotask(() => {hook(attempt); child.stderr.emit('data', `ERROR: refused attempt ${attempt}`); child.emit('close', 1);});
    return child;
  }, undefined, {sessionDir: provider, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
  t.after(async () => {await worker.dispose(); fs.rmSync(base, {recursive: true, force: true});});
  const fail = id => assert.rejects(worker.download('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', id, () => {}));
  return {base, root, provider, log, fail};
}

test('diagnostics resume on the same worker after cleanup prunes and the next job recreates its provider', async t => {
  const f = fixture(t);
  await f.fail('first');
  assert.match(fs.readFileSync(f.log, 'utf8'), /refused attempt 1/);
  for (const attempt of [2, 3]) {
    assert.equal(cleanupWorkspace(f.root, []).deletedFileCount, 1);
    assert.equal(fs.existsSync(f.provider), false);
    await f.fail(`retry-${attempt}`);
    assert.equal(fs.existsSync(f.log), true, 'the admitted retry must recreate its diagnostic log');
    assert.match(fs.readFileSync(f.log, 'utf8'), new RegExp(`refused attempt ${attempt}`));
  }
});

test('diagnostics resume after cleanup removes only the log and leaves protected media', async t => {
  const f = fixture(t), protectedFile = path.join(f.provider, 'keep.mp4');
  fs.writeFileSync(protectedFile, 'protected media');
  await f.fail('first');
  assert.equal(cleanupWorkspace(f.root, [protectedFile]).deletedFileCount, 1);
  assert.equal(fs.existsSync(f.provider), true);
  await f.fail('retry');
  assert.equal(fs.existsSync(f.log), true);
  assert.match(fs.readFileSync(f.log, 'utf8'), /refused attempt 2/);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected media');
});

for (const kind of ['directory', 'symlink']) {
  test(`diagnostics reject a provider ${kind} replacement after job admission`, async t => {
    let f;
    f = fixture(t, attempt => {
      if (attempt !== 2) return;
      fs.renameSync(f.provider, path.join(f.base, 'original-provider'));
      if (kind === 'directory') fs.mkdirSync(f.provider);
      else {fs.mkdirSync(path.join(f.base, 'outside')); fs.symlinkSync(path.join(f.base, 'outside'), f.provider);}
      fs.writeFileSync(f.log, 'unrelated replacement');
    });
    await f.fail('first'); await f.fail('replaced');
    assert.equal(fs.readFileSync(f.log, 'utf8'), 'unrelated replacement');
  });
}

test('diagnostics never re-admit a provider under a replaced managed root', async t => {
  const f = fixture(t), managed = f.root.verify();
  await f.fail('first');
  fs.renameSync(managed, path.join(f.base, 'original-managed'));
  fs.mkdirSync(managed); fs.mkdirSync(f.provider); fs.writeFileSync(f.log, 'unrelated root');
  await f.fail('replaced-root');
  assert.equal(fs.readFileSync(f.log, 'utf8'), 'unrelated root');
});
