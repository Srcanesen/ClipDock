import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PexelsClient, parsePexelsPage} from '../dist/pexels.js';
const row = id => ({id, src: {original: `https://images.pexels.com/${id}.jpg`}});
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const setup = (t, fetch, options) => { const root = mkdtempSync(join(tmpdir(), 'pexels-regression-')); const client = new PexelsClient(root, fetch, options); client.restoreKey('P'.repeat(20), true, 'Connected'); t.after(() => {client.dispose(); rmSync(root, {recursive: true, force: true});}); return {client, root}; };
const clock = () => {const timers = new Map(); return {timers, setTimeout: (fn, ms) => {const token = {}; timers.set(token, {fn, ms}); return token;}, clearTimeout: token => timers.delete(token), fire: ms => {for (const [token, timer] of [...timers]) if(timer.ms === ms) {timers.delete(token); timer.fn();}}};};
const turn = () => new Promise(resolve => setImmediate(resolve));

test('PRV-7 exact photo and video search/detail paths', async t => {
 const paths = []; const {client} = setup(t, async url => {paths.push(url.pathname); return json(url.pathname.endsWith('search') ? {photos: [row(1)], videos: [row(1)]} : row(1));});
 await client.search('photo', 'studio', 1); await client.search('video', 'studio', 1); await client.load('photo', 1); await client.load('video', 1);
 assert.deepEqual(paths, ['/v1/search', '/videos/search', '/v1/photos/1', '/videos/videos/1']);
});
test('PRV-12 independent detail calls do not cancel one another', async t => {
 let release; const {client} = setup(t, async (url, init) => url.pathname.endsWith('/1') ? new Promise((resolve, reject) => {release = () => resolve(json(row(1))); init.signal.addEventListener('abort', () => reject(Error('aborted')));}) : json(row(2)));
 const first = client.load('photo', 1); const settled = first.then(x => x.id, e => e.message); await turn(); assert.equal((await client.load('photo', 2)).id, 2); release(); assert.equal(await settled, 1);
});
test('PRV-13 stalled optional thumbnails preserve search and detail metadata', async t => {
 const timers = clock(); const {client} = setup(t, async url => url.hostname === 'api.pexels.com' ? json(url.pathname.endsWith('search') ? {photos: [{...row(1), src: {...row(1).src, medium: 'https://images.pexels.com/thumb.jpg'}}]} : {...row(1), src: {...row(1).src, medium: 'https://images.pexels.com/thumb.jpg'}}) : new Promise(() => {}), timers);
 for (const start of [() => client.search('photo', 'studio', 1), () => client.load('photo', 1)]) { const pending = start(); await turn(); timers.fire(1500); const result = await pending; assert.equal((result.results?.[0] ?? result).id, 1); assert.equal((result.results?.[0] ?? result).thumbnailUrl, 'https://images.pexels.com/thumb.jpg'); }
});
test('PRV-11 stalled media connection and body time out and clean up', async t => {
 for (const body of [false, true]) {const timers = clock(); const events = []; const {client, root} = setup(t, async () => body ? new Response(new ReadableStream({start(c) {c.enqueue(new Uint8Array([1]));}, pull() {return new Promise(() => {});}}), {headers: {'content-type': 'video/mp4'}}) : new Promise(() => {}), timers);
 const pending = client.download('stall', {url: 'https://videos.pexels.com/1.mp4', mime: 'video/mp4'}, e => events.push(e)); const outcome = assert.rejects(pending, /timed out/); await turn(); timers.fire(30000); await outcome;  assert.deepEqual(readdirSync(root), []); assert.equal(client.isDownloading(), false); }
});
test('PRV-19 metadata coalesces, caches pristine data, expires and bounds entries', async t => {
 let calls = 0, now = 0; const {client} = setup(t, async url => {calls++; return json(url.pathname.includes('search') ? {photos: [row(1)]} : row(Number(url.pathname.split('/').at(-1))));}, {now: () => now});
 const pages = await Promise.all([client.search('photo', 'studio', 1), client.search('photo', 'studio', 1)]); pages[0].results[0].files[0].url = 'mutated'; assert.equal(calls, 1); assert.equal((await client.search('photo', 'studio', 1)).results[0].files[0].url, 'https://images.pexels.com/1.jpg');
 now = 60001; await client.search('photo', 'studio', 1); assert.equal(calls, 2); for(let id=1; id<=61; id++) await client.load('photo', id); const before=calls; await client.search('photo', 'studio', 1); assert.equal(calls, before+1);
 client.setKey('Q'.repeat(20), false); await client.search('photo', 'studio', 1); assert.equal(calls, before+2);
});
test('PRV-19 and PRV-21 quota cooldown respects headers and cancels rejected body', async t => {
 let calls = 0, cancelled = 0, now = 1000; const {client} = setup(t, async () => {calls++; return new Response(new ReadableStream({cancel() {cancelled++;}}), {status: 429, headers: {'retry-after': '2', 'x-ratelimit-reset': '4'}});}, {now: () => now});
 await assert.rejects(client.search('photo', 'studio', 1), /quota/); await assert.rejects(client.load('photo', 1), /quota/); assert.equal(calls, 1); assert.equal(cancelled, 1); now=4001; await assert.rejects(client.load('photo', 1), /quota/); assert.equal(calls, 2);
});
test('PRV-21 rejected headers, oversized bodies and redirects cancel body ownership', async t => {
 let cancelled = 0; const response = (headers, status=200) => new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));}, cancel(){cancelled++;}}), {status, headers});
 for(const headers of [{'content-type': 'text/html'}, {'content-type': 'application/json', 'content-length': '2000000'}, {'content-type': 'application/json'}]) {const {client}=setup(t, async()=>response(headers)); await assert.rejects(client.load('photo', 1));}
 assert.equal(cancelled,3);
});
test('PRV-23 duplicate IDs normalize to first unique result', () => {assert.deepEqual(parsePexelsPage({photos:[row(1), row(1), row(2)]},'photo','studio',2).results.map(x=>x.id),[1,2]);});

test('PRV-11 media progress renews idle deadline while overall deadline stays bounded', async t => {
 const timers=clock(); let stream;
 const {client,root}=setup(t,async()=>new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'content-type':'video/mp4'}}),timers);
 const pending=client.download('overall',{url:'https://videos.pexels.com/1.mp4',mime:'video/mp4'},()=>{});
 const outcome=assert.rejects(pending,/timed out/);
 await turn(); const firstIdle=[...timers.timers].find(([,timer])=>timer.ms===30000)[0];
 stream.enqueue(new Uint8Array([1,2,3])); await turn();
 assert.equal(timers.timers.has(firstIdle),false);
 assert.equal([...timers.timers.values()].filter(timer=>timer.ms===30000).length,1);
 timers.fire(30*60*1000); await outcome; assert.deepEqual(readdirSync(root),[]); assert.equal(timers.timers.size,0);
});

test('PRV-19 cooldown accepts reset-only and HTTP date headers and stays account scoped', async t => {
 for(const headers of [{'x-ratelimit-reset':'3'},{'retry-after':new Date(3000).toUTCString()}]) {
 let now=1000,calls=0; const {client}=setup(t,async()=>{calls++; return calls===1?new Response('quota',{status:429,headers}):json(row(1));},{now:()=>now});
 await assert.rejects(client.load('photo',1),/quota/); now=2999; await assert.rejects(client.load('photo',1),/quota/); assert.equal(calls,1);
 client.setKey('Q'.repeat(20),false); assert.equal((await client.load('photo',1)).id,1); assert.equal(calls,2);
 client.setKey('P'.repeat(20),false); await assert.rejects(client.load('photo',1),/quota/); now=3000; assert.equal((await client.load('photo',1)).id,1); assert.equal(calls,3);
 }
});

test('PRV-21 cancelling a hostile rejected body does not block an API error', async t => {
 let cancelled=0; const {client}=setup(t,async()=>new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{status:403}));
 await assert.rejects(client.load('photo',1),/rejected the API key/); assert.equal(cancelled,1);
});

for (const observer of ['job', 'inspector']) {
  test(`shared metadata survives owner cancellation for a live ${observer}`, async t => {
    let respond, upstream, aborts = 0, requests = 0, detached = false;
    const {client} = setup(t, async (_url, {signal}) => {
      requests++; upstream = signal;
      return new Promise((resolve, reject) => {
        respond = () => resolve(json(row(7)));
        signal.addEventListener('abort', () => {aborts++; reject(signal.reason);}, {once: true});
      });
    });
    const a = client.load('photo', 7, {jobId: 'A'}).then(result => result.id, error => {detached = true; return error.message;});
    const b = client.load('photo', 7, observer === 'job' ? {jobId: 'B'} : undefined).then(result => result.id, error => error.message);
    const cancelling = client.cancel('A');
    await turn();
    // Capture before asserting so even the red run releases the shared response.
    const aborted = upstream.aborted, detachedBeforeResponse = detached;
    respond();
    assert.equal(await a, 'Pexels request cancelled.'); await cancelling;
    assert.equal(await b, 7, 'a cancelled consumer must not poison the shared fetch');
    assert.equal(aborted, false);
    assert.equal(detachedBeforeResponse, true);
    assert.equal(aborts, 0);
    assert.equal((await client.load('photo', 7)).id, 7);
    assert.equal(requests, 1, 'the surviving result must populate the cache');
  });
}

test('shared metadata aborts once after the last consumer detaches and retry gets a fresh fetch', async t => {
  const signals = []; let aborts = 0;
  const {client} = setup(t, async (_url, {signal}) => {
    signals.push(signal);
    if (signals.length > 1) return json(row(7));
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {aborts++; reject(signal.reason);}, {once: true}));
  });
  const a = client.load('photo', 7, {jobId: 'A'}).catch(error => error.message);
  const b = client.load('photo', 7, {jobId: 'B'}).catch(error => error.message);
  const cancellingA = client.cancel('A');
  const aliveAfterA = !signals[0].aborted;
  const cancellingB = client.cancel('B');
  const retry = client.load('photo', 7, {jobId: 'retry'});
  assert.deepEqual(await Promise.all([a, b]), ['Pexels request cancelled.', 'Pexels request cancelled.']);
  await Promise.all([cancellingA, cancellingB]);
  assert.equal((await retry).id, 7);
  assert.equal(aliveAfterA, true);
  assert.equal(aborts, 1);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, false]);
});
