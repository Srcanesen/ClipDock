import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PexelsClient} from '../dist/pexels.js';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';

const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const clock = () => {const timers = new Map(); return {setTimeout: (fn, ms) => {const token = {}; timers.set(token, {fn, ms}); return token;}, clearTimeout: token => timers.delete(token), fire: ms => {for (const [token, timer] of [...timers]) if (timer.ms === ms) {timers.delete(token); timer.fn();}}};};
const settled = (promise, ms = 500) => Promise.race([promise.then(() => 'completed', error => error.message), new Promise(resolve => setTimeout(() => resolve('still pending'), ms))]);
const setup = (t, fetch, options) => {
  const root = mkdtempSync(join(tmpdir(), 'pexels-hunt-'));
  const client = new PexelsClient(root, fetch, options);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {client, root};
};
// A hostile upstream never acknowledges body cancellation.
const hostileCancel = () => new Promise(() => {});

test('browse request cancellation leaves a download\'s metadata step running', async t => {
  const f = await providerIpcFixture(t, 'pexels', {holdMetadata: true});
  let pending;
  try {
    pending = f.start();
    const result = pending.then(() => 'completed', error => error.message);
    await f.metadataEntered.promise;
    assert.equal(await f.api.cancelPexelsRequests(), false);
    f.releaseMetadata.resolve();
    assert.equal(await result, 'completed');
    assert.equal(f.events().at(-1).state, 'completed');
  } finally {await f.stop(); await pending?.catch(() => {});}
});

test('a search without a connected key asks for one', async t => {
  const {client} = setup(t, async () => json({photos: []}));
  t.after(() => client.dispose());
  await assert.rejects(client.search('photo', 'studio', 1), {message: 'Connect a Pexels API key.'});
  await assert.rejects(client.load('photo', 1), {message: 'Connect a Pexels API key.'});
});

test('an oversized API body whose cancel never resolves still fails the request', async t => {
  const {client} = setup(t, async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(1024 * 1024 + 1));}, cancel: hostileCancel,
  }), {headers: {'content-type': 'application/json'}}));
  client.restoreKey('P'.repeat(20), true, 'Connected');
  assert.equal(await settled(client.load('photo', 1)), 'Pexels API response is too large.');
});

for (const ending of ['size limit', 'cancel', 'idle timeout']) {
  test(`a media body whose cancel never resolves ends at its ${ending} and removes the partial file`, async t => {
    const timers = clock();
    const {client, root} = setup(t, async () => new Response(new ReadableStream(ending === 'size limit'
      ? {pull(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024));}, cancel: hostileCancel}
      : {start(controller) {controller.enqueue(new Uint8Array(10));}, pull: () => new Promise(() => {}), cancel: hostileCancel}),
    {headers: {'content-type': 'image/jpeg'}}), timers);
    client.restoreKey('P'.repeat(20), true, 'Connected');
    const download = client.download('hostile', {url: 'https://images.pexels.com/photos/1/a.jpeg', mime: 'image/jpeg'}, () => undefined);
    let cancelled = null;
    if (ending !== 'size limit') {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (ending === 'cancel') cancelled = client.cancel('hostile'); else timers.fire(30_000);
    }
    assert.equal(await settled(download), {'size limit': 'Pexels media exceeds the download size limit.', cancel: 'Download cancelled.', 'idle timeout': 'Pexels media download timed out.'}[ending]);
    if (cancelled) assert.equal(await settled(cancelled), 'completed');
    assert.deepEqual(readdirSync(root), []);
    assert.equal(client.isDownloading(), false);
    await client.dispose();
  });
}
