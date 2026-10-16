import assert from 'node:assert/strict';
import {PexelsClient, parsePexelsPage} from '../dist/pexels.js';

const raw = {
  photos: [
    {id: 'malformed', src: {medium: 'https://images.pexels.com/wrong-thumbnail.jpg'}},
    {id: 42, width: 1200, height: 800, alt: 'valid', src: {medium: 'https://images.pexels.com/correct-thumbnail.jpg'}},
  ],
  total_results: 2,
};

const parsed = parsePexelsPage(raw, 'photo', 'test', 1);
assert.deepEqual(parsed.results.map((asset) => asset.id), [42]);

const fetched = [];
const client = new PexelsClient(undefined, async (input) => {
  const url = String(input);
  fetched.push(url);
  if (url.startsWith('https://api.pexels.com/')) {
    return new Response(JSON.stringify(raw), {status: 200, headers: {'content-type': 'application/json'}});
  }
  const thumbnail = url.endsWith('correct-thumbnail.jpg') ? 'correct' : 'wrong';
  return new Response(Buffer.from(thumbnail), {status: 200, headers: {'content-type': 'image/jpeg'}});
});

assert.equal(client.restoreKey('a'.repeat(20), false, 'connected'), true);
const result = await client.search('photo', 'test', 1);
assert.equal(result.results.length, 1);
assert.equal(result.results[0].id, 42);
assert.equal(result.results[0].thumbnailDataUrl, `data:image/jpeg;base64,${Buffer.from('correct').toString('base64')}`);
assert.equal(fetched.some((url) => url.endsWith('correct-thumbnail.jpg')), true);
assert.equal(fetched.some((url) => url.endsWith('wrong-thumbnail.jpg')), false);
client.dispose();

console.log('Pexels malformed-row thumbnail association: PASS');
