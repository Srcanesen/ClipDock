import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {MacKeychainPexelsCredentialStore} from '../dist/pexels-credential.js';
import {deferred, historyInput} from './helpers/files-main.mjs';

const owners = [
  ['empty', ''],
  ['unparsable', '{broken'],
  ['invalid PID', JSON.stringify({pid: 0, token: 'legacy-owner'})],
];
for (const [kind, encoded] of owners) {
  for (const aged of [false, true]) {
    for (const provider of ['History', 'Keychain']) {
      test(`${provider} ${aged ? 'recovers aged' : 'preserves fresh'} ${kind} legacy lock`, async t => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-lock-')));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const lock = path.join(root, 'history.json.lock');
        fs.writeFileSync(lock, encoded);
        if (aged) {
          const old = new Date(Date.now() - 120_000);
          fs.utimesSync(lock, old, old);
        }
        if (provider === 'History') {
          const media = path.join(root, 'clip.mp4'); fs.writeFileSync(media, 'media');
          const history = new DownloadHistory(path.join(root, 'history.json'), root);
          if (aged) {
            assert.equal(history.add(historyInput(media)).title, 'Clip');
            assert.deepEqual(new DownloadHistory(path.join(root, 'history.json'), root).list().map(x => x.title), ['Clip']);
            assert.equal(fs.existsSync(lock), false);
          } else {
            assert.throws(() => history.add(historyInput(media)), /locked by another writer/);
            assert.equal(fs.readFileSync(lock, 'utf8'), encoded);
            assert.equal(fs.existsSync(path.join(root, 'history.json')), false);
          }
          return;
        }
        let calls = 0;
        const store = new MacKeychainPexelsCredentialStore(() => {
          calls++;
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = new EventEmitter(); child.kill = () => true;
          child.stdin.end = () => queueMicrotask(() => child.emit('close', 44));
          return child;
        }, lock);
        t.after(() => store.dispose());
        if (aged) {
          assert.deepEqual(await store.load(), {key: null, message: 'Disconnected.'});
          assert.equal(calls, 1);
          assert.equal(fs.existsSync(lock), false);
        } else {
          // Observe the real acquisition attempt before cancelling the wait.
          const attempted = deferred(), link = fs.linkSync;
          t.mock.method(fs, 'linkSync', (from, to, ...args) => {
            if (to === lock) attempted.resolve();
            return link(from, to, ...args);
          });
          const pending = store.load();
          await attempted.promise;
          await store.dispose();
          assert.equal((await pending).key, null);
          assert.equal(calls, 0);
          assert.equal(fs.readFileSync(lock, 'utf8'), encoded);
        }
      });
    }
  }
}

test('History preserves a legacy lock refreshed immediately before recovery unlink', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-refresh-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'history.json'), lock = file + '.lock';
  const media = path.join(root, 'clip.mp4'); fs.writeFileSync(media, 'media');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 120_000); fs.utimesSync(lock, old, old);
  const history = new DownloadHistory(file, root), read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === lock && ++reads === 2) {
      const fresh = new Date(); fs.utimesSync(lock, fresh, fresh);
    }
    return read(target, ...args);
  });
  assert.throws(() => history.add(historyInput(media)), /locked by another writer/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '');
  assert.equal(fs.existsSync(file), false);
});
