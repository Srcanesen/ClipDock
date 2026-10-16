import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {mainFixture, deferred} from './helpers/files-main.mjs';
import {MacKeychainPexelsCredentialStore} from '../dist/pexels-credential.js';

for (const previous of ['A'.repeat(20), null]) {
  test(`orderly quit rolls back an admitted credential save during verification (${previous ? 'existing key' : 'absent key'})`, async t => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'gate-credential-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const lock = path.join(root, 'keychain.lock'), reached = deferred();
    const candidate = 'B'.repeat(20);
    let stored = previous, updated = false, blocked = false, client;
    class Credentials extends MacKeychainPexelsCredentialStore {
      constructor() {
        super((_command, args) => {
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
          let input = ''; child.stdin.write = value => {input += value;};
          child.kill = () => {queueMicrotask(() => child.emit('close', 1)); return true;};
          child.stdin.end = () => queueMicrotask(() => {
            if (args[0] === '-i') {
              stored = input.match(/ -w (\S+)\n/)[1]; updated = true; child.emit('close', 0);
            } else if (args[0] === 'find-generic-password') {
              if (updated && !blocked) {blocked = true; reached.resolve(); return;}
              if (stored !== null) child.stdout.emit('data', stored);
              child.emit('close', stored === null ? 44 : 0);
            } else {stored = null; child.emit('close', 0);}
          });
          return child;
        }, lock);
      }
    }
    class Pexels {
      constructor() {client = this; this.key = null; this.persisted = false;}
      setRoot() {} isDownloading() {return false;} abortApiRequests() {} dispose() {this.disposed = true;}
      restoreKey(key, persisted) {this.key = key; this.persisted = persisted; return true;}
      restoreStatus() {}
      status() {return {connected: !!this.key, persisted: this.persisted};}
      async validateKey(key) {return key;}
      setKey(key, persisted) {this.key = key; this.persisted = persisted; return this.status();}
    }
    const f = await mainFixture(t, {modules: {
      './pexels': {PexelsClient: Pexels},
      './pexels-credential': {MacKeychainPexelsCredentialStore: Credentials, PexelsCredentialStore: Credentials},
    }});
    await f.invoke('pexelsKeyStatus');
    assert.equal(client.key, previous);
    const save = f.invoke('setPexelsKey', candidate).then(value => ({value}), error => ({error: error.message}));
    await reached.promise;
    assert.equal(stored, candidate);
    f.quit();
    const outcome = await save;
    const deadline = Date.now() + 2000;
    while (!f.lifecycle.completedQuits && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.lifecycle.completedQuits, 1);
    assert.equal(stored, previous, 'failed save must restore the previously persisted credential before quit');
    assert.equal(fs.existsSync(lock), false);
    if (previous) {
      assert.deepEqual(outcome, {error: 'Could not save the new Pexels credential securely. Your existing connection was kept.'});
      assert.equal(client.key, previous);
    } else {
      assert.deepEqual(outcome, {value: {connected: true, persisted: false}});
    }
  });
}

test('shutdown rollback keeps its lock and bounds an unresponsive verification child', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'gate-rollback-bound-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const lock = path.join(root, 'keychain.lock'), reached = deferred(), rollbackVerification = deferred();
  const previous = 'A'.repeat(20);
  let stored = previous, reads = 0, kills = 0;
  const store = new MacKeychainPexelsCredentialStore((_command, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    let input = ''; child.stdin.write = value => {input += value;};
    child.kill = () => {kills++; queueMicrotask(() => child.emit('close', 1)); return true;};
    child.stdin.end = () => queueMicrotask(() => {
      if (args[0] === '-i') {stored = input.match(/ -w (\S+)\n/)[1]; child.emit('close', 0);}
      else if (++reads === 1) {child.stdout.emit('data', stored); child.emit('close', 0);}
      else if (reads === 2) reached.resolve();
      else rollbackVerification.resolve();
    });
    return child;
  }, lock);
  const saving = store.save('B'.repeat(20)).catch(error => error.message);
  await reached.promise;
  const disposing = store.dispose();
  await rollbackVerification.promise;
  assert.equal(stored, previous);
  assert.equal(fs.existsSync(lock), true, 'rollback retains exclusive ownership until its child ends');
  assert.equal(await saving, 'Could not save the Pexels credential securely.');
  await disposing;
  assert.equal(kills, 2, 'both candidate verification and deadline-bounded rollback child are terminated');
  assert.equal(fs.existsSync(lock), false);
});
