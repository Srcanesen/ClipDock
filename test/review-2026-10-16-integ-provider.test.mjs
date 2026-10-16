import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {ManagedRoot} from '../dist/managed-root.js';
import {YtdlpWorker} from '../dist/ytdlp.js';

for (const mutation of ['pruned', 'directory', 'symlink', 'parent-replaced', 'parent-missing']) {
  test(`provider retry admits only an absent owned directory: ${mutation}`, async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-provider-')));
    const managed = path.join(base, 'managed'), root = ManagedRoot.prepare(managed);
    const provider = root.providerPath('youtube');
    let attempts = 0;
    const worker = new YtdlpWorker('/fake/yt-dlp', () => {
      attempts++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      queueMicrotask(() => {child.stderr.emit('data', `ERROR: refused attempt ${attempts}`); child.emit('close', 1);});
      return child;
    }, undefined, {sessionDir: provider, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
    t.after(async () => {await worker.dispose(); fs.rmSync(base, {recursive: true, force: true});});
    const fail = id => assert.rejects(worker.download('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best', id, () => {}));
    await fail('first');
    assert.equal(attempts, 1);
    if (mutation.startsWith('parent-')) {
      fs.renameSync(managed, path.join(base, 'original-managed'));
      if (mutation === 'parent-replaced') fs.mkdirSync(managed);
    } else {
      // Preserve the old inode so a replacement cannot accidentally reuse it.
      fs.renameSync(provider, path.join(base, 'original-provider'));
      if (mutation === 'directory') fs.mkdirSync(provider);
      if (mutation === 'symlink') {
        fs.mkdirSync(path.join(base, 'outside'));
        fs.symlinkSync(path.join(base, 'outside'), provider);
      }
      if (mutation !== 'pruned') fs.writeFileSync(path.join(provider, 'clipdock.log'), 'unrelated log');
    }
    await fail('retry');
    assert.equal(attempts, mutation === 'pruned' ? 2 : 1, 'retry must spawn only through its verified original parent');
    if (mutation === 'pruned') assert.match(fs.readFileSync(path.join(provider, 'clipdock.log'), 'utf8'), /refused attempt 2/);
    else if (mutation.startsWith('parent-')) assert.equal(fs.existsSync(provider), false);
    else assert.equal(fs.readFileSync(path.join(provider, 'clipdock.log'), 'utf8'), 'unrelated log');
  });
}

test('provider recovery never recreates an arbitrary selected session root', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-session-')));
  const session = path.join(base, 'selected'); fs.mkdirSync(session);
  let attempts = 0;
  const worker = new YtdlpWorker('/fake/yt-dlp', () => {attempts++; throw Error('unexpected spawn');}, undefined,
    {sessionDir: session, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
  t.after(async () => {await worker.dispose(); fs.rmSync(base, {recursive: true, force: true});});
  fs.renameSync(session, path.join(base, 'original'));
  await assert.rejects(worker.download('https://youtu.be/dQw4w9WgXcQ', 'best', 'missing-session', () => {}));
  assert.equal(attempts, 0);
  assert.equal(fs.existsSync(session), false);
});
