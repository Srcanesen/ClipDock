import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {PexelsClient} from '../dist/pexels.js';
for (const kind of ['photo', 'video']) {
  test(`Pexels ${kind} page 100 has no unsupported successor`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-cap-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    let requests = 0;
    const client = new PexelsClient(root, async () => {requests++; return new Response(JSON.stringify({photos: [], videos: [], next_page: 'https://api.pexels.com/?page=101', total_results: 100000}), {headers: {'content-type': 'application/json'}});});
    client.setKey('P'.repeat(20), false);
    try {
      assert.equal((await client.search(kind, 'studio', 99)).hasNext, true);
      const page = await client.search(kind, 'studio', 100);
      assert.equal(page.page, 100); assert.equal(page.hasPrevious, true); assert.equal(page.hasNext, false);
      await assert.rejects(client.search(kind, 'studio', 101), /page.*1.*100/i);
      assert.equal(requests, 2);
    } finally {await client.dispose();}
  });
}
