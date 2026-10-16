import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {tryAcquireFileLock} from '../dist/file-lock.js';
import {historyInput} from './helpers/files-main.mjs';

for (const failure of ['candidate unlink', 'descriptor close']) {
  test(`History retains release authority when post-publication ${failure} fails`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lock-')));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const media = path.join(root, 'clip.mp4'), file = path.join(root, 'history.json'), lock = file + '.lock';
    fs.writeFileSync(media, 'media');
    const history = new DownloadHistory(file, root);
    let injected = false;
    if (failure === 'candidate unlink') {
      const unlink = fs.unlinkSync;
      t.mock.method(fs, 'unlinkSync', (target, ...args) => {
        if (!injected && target.startsWith(lock + '.') && target.endsWith('.owner')) {
          injected = true; throw Object.assign(Error('transient cleanup failure'), {code: 'EPERM'});
        }
        return unlink(target, ...args);
      });
    } else {
      const close = fs.closeSync;
      t.mock.method(fs, 'closeSync', fd => {
        close(fd);
        if (!injected && fs.existsSync(lock)) {
          injected = true; throw Object.assign(Error('transient close failure'), {code: 'EPERM'});
        }
      });
    }
    assert.equal(history.add({...historyInput(media), title: 'First'}).title, 'First');
    assert.equal(injected, true);
    assert.equal(fs.existsSync(lock), false);
    history.add({...historyInput(media), title: 'Second'});
    assert.deepEqual(new DownloadHistory(file, root).list().map(x => x.title), ['Second', 'First']);
  });
}

test('published lock authority does not depend on a fallible pathname snapshot after linking', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lock-snapshot-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const lock = path.join(root, 'writer.lock'), link = fs.linkSync, read = fs.readFileSync;
  let linked = false;
  t.mock.method(fs, 'linkSync', (from, to, ...args) => {
    const result = link(from, to, ...args); if (to === lock) linked = true; return result;
  });
  const faultyRead = t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (linked && target === lock) throw Object.assign(Error('post-link snapshot failure'), {code: 'EIO'});
    return read(target, ...args);
  });
  const owner = tryAcquireFileLock(lock);
  assert.equal(linked, true);
  faultyRead.mock.restore();
  owner.release();
  assert.equal(fs.existsSync(lock), false);
});
