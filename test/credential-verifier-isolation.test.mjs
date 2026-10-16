import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MacKeychainPexelsCredentialStore } from '../dist/pexels-credential.js';

// Exercise the real transaction with fake commands and a private mutex, including
// fixture failure. Never acquire or remove the user's default Keychain mutex.
for (const failFixture of [false, true]) test(`fake credential transactions clean an isolated mutex after ${failFixture ? 'failure' : 'success'}`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-credential-isolation-'));
  const lock = path.join(root, 'keychain.lock');
  const key = 'test_key_12345678901234567890';
  const calls = []; let saved = null;
  const spawn = (command, args, options) => {
    assert.equal(existsSync(lock), true, 'the real transaction owns its isolated mutex before spawning');
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    // The production command writes input before ending the stream.
    proc.stdin = new EventEmitter(); proc.stdin.write = (input) => { saved = input; }; proc.stdin.end = (input) => { if (input !== undefined) saved = input; }; proc.kill = () => true;
    calls.push({ command, args, options });
    queueMicrotask(() => {
      if (args[0] === 'find-generic-password' && saved) proc.stdout.emit('data', Buffer.from(key));
      proc.emit('close', args[0] === 'find-generic-password' && !saved ? 44 : 0);
    });
    return proc;
  };
  const run = async () => {
    try {
      const store = new MacKeychainPexelsCredentialStore(spawn, lock);
      assert.equal(await store.save(key), true);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].command, '/usr/bin/security');
      assert.deepEqual(calls[1].args, ['-i']);
      assert.equal(calls[1].options.shell, false);
      assert.equal(existsSync(lock), false);
      if (failFixture) throw new Error('controlled fixture failure');
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  if (failFixture) await assert.rejects(run(), /controlled fixture failure/);
  else await run();
  assert.equal(existsSync(root), false);
});
