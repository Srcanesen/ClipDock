import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PexelsCredentialStore } from '../dist/pexels-credential.js';

for (const separateStores of [false, true]) {
  test(`overlapping credential saves use separate temporary files (${separateStores ? 'two stores' : 'one store'})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pexels-concurrent-save-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'credential.json');
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    };
    const first = new PexelsCredentialStore(file, storage);
    const second = separateStores ? new PexelsCredentialStore(file, storage) : first;
    assert.equal(await first.save('C'.repeat(20)), true);
    const originalWrite = fs.writeFile;
    let writes = 0, release;
    const written = new Promise(resolve => { release = resolve; });
    // Hold publication until both real writes have finished: no timing sleeps,
    // and each writer must remain able to rename its own complete ciphertext.
    t.mock.method(fs, 'writeFile', async (...args) => {
      await originalWrite(...args);
      if (++writes === 2) release();
      await written;
    });
    if (process.platform === 'win32') {
      const originalRename = fs.rename;
      let renaming = false;
      t.mock.method(fs, 'rename', async (...args) => {
        assert.equal(renaming, false, 'Windows credential renames must not overlap');
        renaming = true;
        try { await originalRename(...args); } finally { renaming = false; }
      });
    }
    const keys = ['A'.repeat(20), 'B'.repeat(20)];
    const completed = [];
    const outcomes = await Promise.allSettled([first, second].map(async (store, index) => {
      assert.equal(await store.save(keys[index]), true);
      completed.push(keys[index]);
    }));
    for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
    assert.notEqual(fs.writeFile.mock.calls[0].arguments[0], fs.writeFile.mock.calls[1].arguments[0]);
    const {key} = await first.load();
    if (process.platform === 'win32') assert.equal(key, completed.at(-1));
    else assert.equal(keys.includes(key), true, 'published credential must be one complete input key');
    assert.deepEqual(readdirSync(root), ['credential.json'], 'temporary ciphertext files must be removed');
  });
}
