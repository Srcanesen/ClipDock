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
    const keys = ['A'.repeat(20), 'B'.repeat(20)];
    const outcomes = await Promise.allSettled([first.save(keys[0]), second.save(keys[1])]);
    assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled'], 'one save must not remove the other save\'s temporary file');
    assert.deepEqual(outcomes.map(result => result.value), [true, true]);
    assert.equal(keys.includes((await first.load()).key), true, 'published credential must be one complete input key');
    assert.deepEqual(readdirSync(root), ['credential.json'], 'temporary ciphertext files must be removed');
  });
}
