import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {ManagedRoot} from '../dist/managed-root.js';
import {cleanupWorkspace} from '../dist/workspace.js';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {GalleryDlWorker} from '../dist/gallerydl.js';
import {PexelsClient} from '../dist/pexels.js';

for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) {
  for (const mutation of ['pruned', 'directory', 'symlink', 'parent-missing', 'parent-replaced']) {
    test(`${provider} public retry after ${mutation} preserves directory authority`, async t => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-cleanup-')));
      const managed = path.join(base, 'managed'), root = ManagedRoot.prepare(managed);
      const directory = root.providerPath(provider);
      let starts = 0;
      const spawn = () => {
        starts++;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
        queueMicrotask(() => {child.stderr.emit('data', 'ERROR: fixture refusal'); child.emit('close', 1);});
        return child;
      };
      const worker = provider === 'pinterest' ? new GalleryDlWorker('/fake/gallerydl', spawn, {sessionDir: directory})
        : provider === 'pexels' ? new PexelsClient(directory, async () => {starts++; throw Error('fixture refusal');})
        : new YtdlpWorker('/fake/ytdlp', spawn, undefined, {sessionDir: directory, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
      t.after(async () => {await worker.dispose(); fs.rmSync(base, {recursive: true, force: true});});
      const run = id => provider === 'pinterest' ? worker.metadata('https://www.pinterest.com/pin/123/', {jobId: id})
        : provider === 'pexels' ? worker.download(id, {url: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg', mime: 'image/jpeg'}, () => {})
        : provider === 'social' ? worker.downloadSocial('https://www.instagram.com/p/ABC123/', 'best', id, () => {})
        : worker.download('https://youtu.be/dQw4w9WgXcQ', 'best', id, () => {});
      await assert.rejects(run('first')); assert.equal(starts, 1);
      if (mutation === 'pruned') {
        for (const attempt of [2, 3]) {
          cleanupWorkspace(root, []);
          assert.equal(fs.existsSync(directory), false);
          await assert.rejects(run(`retry-${attempt}`));
          assert.equal(starts, attempt, 'a pruned provider must reach the injected provider boundary');
          assert.equal(fs.existsSync(directory), true);
        }
      } else {
        if (mutation.startsWith('parent-')) {
          fs.renameSync(managed, path.join(base, 'original-managed'));
          if (mutation === 'parent-replaced') fs.mkdirSync(managed);
        } else {
          fs.renameSync(directory, path.join(base, 'original-provider'));
          if (mutation === 'directory') fs.mkdirSync(directory);
          else {fs.mkdirSync(path.join(base, 'outside')); fs.symlinkSync(path.join(base, 'outside'), directory);}
          fs.writeFileSync(path.join(directory, 'precious'), 'unrelated bytes');
        }
        await assert.rejects(run('retry'));
        assert.equal(starts, 1, 'replacement must be rejected before any provider work');
        if (mutation.startsWith('parent-')) assert.equal(fs.existsSync(directory), false);
        else {
          assert.deepEqual(fs.readdirSync(directory), ['precious']);
          assert.equal(fs.readFileSync(path.join(directory, 'precious'), 'utf8'), 'unrelated bytes');
        }
      }
    });
  }
}

test('Pinterest keeps its admitted directory after a rejected explicit folder selection', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-reselect-')));
  const root = ManagedRoot.prepare(path.join(base, 'managed'));
  const provider = root.providerPath('pinterest'), rejected = path.join(base, 'rejected');
  fs.symlinkSync(provider, rejected);
  let starts = 0;
  const worker = new GalleryDlWorker('/fake/gallerydl', () => {
    starts++;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    queueMicrotask(() => child.emit('close', 1));
    return child;
  }, {sessionDir: provider});
  t.after(async () => {await worker.dispose(); fs.rmSync(base, {recursive: true, force: true});});
  assert.throws(() => worker.setSessionDir(rejected));
  for (const attempt of [1, 2]) {
    await assert.rejects(worker.metadata('https://www.pinterest.com/pin/123/', {jobId: `attempt-${attempt}`}));
    assert.equal(starts, attempt);
    cleanupWorkspace(root, []);
  }
});
