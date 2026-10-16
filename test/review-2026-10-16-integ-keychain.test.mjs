import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {mock, test} from 'node:test';
import {MacKeychainPexelsCredentialStore} from '../dist/pexels-credential.js';

for (const kind of ['temp-itself', 'outside-existing', 'outside-missing', 'shared-parent', 'symlink', 'private-existing', 'private-new']) {
  test(`keychain lock parent: ${kind}`, async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-integ-keychain-')));
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    const temp = path.join(base, 'temp'); fs.mkdirSync(temp, {mode: 0o755});
    const peer = path.join(base, 'peer'); fs.mkdirSync(peer, {mode: 0o755});
    mock.method(os, 'tmpdir', () => temp);
    t.after(() => mock.restoreAll());
    let parent = path.join(temp, 'ClipDock');
    if (kind === 'temp-itself') parent = temp;
    else if (kind === 'outside-existing') parent = peer;
    else if (kind === 'outside-missing') parent = path.join(peer, 'missing');
    else if (kind === 'shared-parent') fs.mkdirSync(parent, {mode: 0o755});
    else if (kind === 'private-existing') fs.mkdirSync(parent, {mode: 0o700});
    else if (kind === 'symlink') fs.symlinkSync(peer, parent);
    let calls = 0;
    const store = new MacKeychainPexelsCredentialStore(() => {
      calls++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdin.end = () => queueMicrotask(() => child.emit('close', 44));
      return child;
    }, path.join(parent, 'keychain.lock'));
    t.after(() => store.dispose());
    const result = await store.load();
    const allowed = kind.startsWith('private-');
    assert.equal(calls, allowed ? 1 : 0, 'only a dedicated private child of temp may admit a command');
    assert.equal(result.message, allowed ? 'Disconnected.' : 'Disconnected. Saved credential could not be read.');
    assert.equal(fs.statSync(temp).mode & 0o777, 0o755, 'never chmod the temp directory');
    assert.equal(fs.statSync(peer).mode & 0o777, 0o755, 'never chmod an unrelated parent');
    if (kind === 'outside-missing') assert.equal(fs.existsSync(parent), false, 'validate before mkdir');
    else if (kind === 'shared-parent') assert.equal(fs.statSync(parent).mode & 0o777, 0o755);
    else if (allowed) assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
  });
}
