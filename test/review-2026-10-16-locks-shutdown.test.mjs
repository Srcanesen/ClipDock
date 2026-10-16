import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {mainFixture, deferred} from './helpers/files-main.mjs';
import {MacKeychainPexelsCredentialStore} from '../dist/pexels-credential.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, 'operation must finish within the shutdown bound');
}

test('quit kills pending credential restoration, releases its lock, and rejects queued credential work', async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-shutdown-keychain-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let child, lock, clientDisposed = false, ran = false;
  class Credentials extends MacKeychainPexelsCredentialStore {
    constructor() {
      lock = path.join(root, 'shutdown-keychain.lock');
      super(() => {
        child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.write = () => {};
        child.signals = []; child.kill = signal => {child.signals.push(signal); return true;};
        return child;
      }, lock);
    }
  }
  class Pexels {
    setRoot() {} isDownloading() {return false;} restoreStatus() {}
    dispose() {clientDisposed = true;}
    status() {ran = true; return {connected: false};}
  }
  const f = await mainFixture(t, {modules: {
    './pexels-credential': {MacKeychainPexelsCredentialStore: Credentials, PexelsCredentialStore: Credentials},
    './pexels': {PexelsClient: Pexels},
  }});
  await until(() => child !== undefined);
  const status = f.invoke('pexelsKeyStatus').then(value => ({value}), error => ({error: error.message}));
  await tick(); f.quit();
  try {
    await until(() => f.lifecycle.completedQuits === 1);
    assert.deepEqual(child.signals, ['SIGKILL']);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(f.lifecycle.cleanups, 1); assert.equal(clientDisposed, true);
    assert.match((await status).error, /shutting down/); assert.equal(ran, false);
  } finally {child.emit('close', 44); await status; await until(() => !fs.existsSync(lock));}
});

test('quit owns an admitted credential mutation until its continuation drains', async t => {
  const entered = deferred(), release = deferred(); let disposed = false, mutatedAfterDispose = false;
  class Pexels {
    setRoot() {} isDownloading() {return false;} restoreStatus() {}
    dispose() {disposed = true;}
    async validateKey() {entered.resolve(); await release.promise; return 'A'.repeat(20);}
    status() {return {connected: false, persisted: false};}
    setKey() {mutatedAfterDispose = disposed; return {connected: true};}
  }
  class Credentials {async load() {return {key: null};} async save() {return true;}}
  const f = await mainFixture(t, {modules: {
    './pexels-credential': {MacKeychainPexelsCredentialStore: Credentials, PexelsCredentialStore: Credentials},
    './pexels': {PexelsClient: Pexels},
  }});
  const saving = f.invoke('setPexelsKey', 'A'.repeat(20)); await entered.promise;
  f.quit(); await tick();
  const quitWhilePending = f.lifecycle.completedQuits;
  release.resolve(); await saving;
  await until(() => f.lifecycle.completedQuits === 1);
  assert.equal(quitWhilePending, 0); assert.equal(mutatedAfterDispose, false);
});

test('disposing credential lock waiters cancels admission without removing a live owner', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'credential-wait-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const lock = path.join(root, 'keychain.lock');
  const owner = JSON.stringify({pid: process.pid, token: 'live-owner', createdAt: Date.now()});
  fs.writeFileSync(lock, owner);
  let calls = 0;
  const store = new MacKeychainPexelsCredentialStore(() => {calls++; throw Error('unexpected child');}, lock);
  const pending = store.save('A'.repeat(20)).catch(error => error.message);
  await tick(); store.dispose();
  assert.equal(await pending, 'Could not save the Pexels credential securely.');
  await assert.rejects(store.clear(), /Could not remove/);
  assert.equal((await store.load()).key, null);
  assert.equal(calls, 0); assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});
