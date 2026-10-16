import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PexelsClient } from '../dist/pexels.js';

for (const operation of ['search', 'load']) {
  test(`Pexels ${operation} can restart immediately after cancelling an identical request`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pexels-cancel-retry-'));
    let calls = 0;
    const row = { id: 7, src: { original: 'https://images.pexels.com/7.jpg' } };
    const client = new PexelsClient(root, async (_url, {signal}) => {
      if (++calls === 1) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
      return new Response(JSON.stringify(operation === 'search' ? { photos: [row] } : row), { headers: { 'content-type': 'application/json' } });
    });
    t.after(async () => { await client.dispose(); rmSync(root, { recursive: true, force: true }); });
    client.setKey('A'.repeat(20), false);
    const start = () => operation === 'search' ? client.search('photo', 'studio', 1) : client.load('photo', 7);
    const first = start().then(() => 'completed', error => error.message);
    assert.equal(client.abortApiRequests(), true);
    // Start in the same turn while the old request is still unwinding. Provider
    // switches and request retries must not attach to its aborted coalescing slot.
    const retried = await start().then(result => operation === 'search' ? result.results[0].id : result.id, error => error.message);
    assert.equal(retried, 7, 'the fresh request must not inherit an earlier cancellation');
    assert.equal(await first, 'Pexels request cancelled.');
    assert.equal(calls, 2, 'the retry must issue a fresh API request');
  });
}
