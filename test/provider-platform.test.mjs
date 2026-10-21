import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverBinary, LruCache, createSearchCache, spawnBounded } from '../dist/provider-platform.js';
import { EventEmitter } from 'node:events';

function tempRoot(prefix) { return mkdtempSync(path.join(tmpdir(), prefix)); }

test('discoverBinary finds PATH candidate and respects executable + versionIdentity', () => {
  const dir = tempRoot('clipdock-provider-discover-');
  const bin = path.join(dir, 'mybin');
  try {
    writeFileSync(bin, '#!/bin/sh\necho version 1.0\n');
    chmodSync(bin, 0o755);
    const env = { PATH: dir, CUSTOM_PATH: bin };
    // plain discovery without version
    const found = discoverBinary(['mybin'], null, { env, platform: 'linux', pathEntries: [dir], extraCandidates: [] });
    assert.equal(found, bin);
    // versionIdentity success
    const probeOk = () => ({ code: 0, text: 'mybin version 1.0' });
    const foundVersion = discoverBinary(['mybin'], ['--version'], { env, platform: 'linux', pathEntries: [dir], versionIdentity: 'mybin version', probe: probeOk });
    assert.equal(foundVersion, bin);
    // version mismatch -> null
    const probeBad = () => ({ code: 0, text: 'other version' });
    const notFound = discoverBinary(['mybin'], ['--version'], { env, platform: 'linux', pathEntries: [dir], versionIdentity: 'mybin version', probe: probeBad });
    assert.equal(notFound, null);
    // envKey override absolute executable takes precedence
    const env2 = { PATH: '', CUSTOM_PATH: bin, CLIPDOCK_CUSTOM_PATH: bin };
    const viaEnv = discoverBinary(['other'], null, { env: env2, platform: 'linux', pathEntries: [], envKey: 'CLIPDOCK_CUSTOM_PATH' });
    assert.equal(viaEnv, bin);
    // non-executable not found
    const dir2 = tempRoot('clipdock-provider-discover2-');
    const nonExec = path.join(dir2, 'mybin');
    writeFileSync(nonExec, '#!/bin/sh\n');
    chmodSync(nonExec, 0o644);
    const notExec = discoverBinary(['mybin'], null, { env: { PATH: dir2 }, platform: 'linux', pathEntries: [dir2] });
    assert.equal(notExec, null);
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LruCache pristine-get returns cloned copy; mutation does not pollute cache', () => {
  let now = 0;
  const cache = new LruCache(10, 5 * 60 * 1000, () => now);
  const entry = { query: 'hello', createdAt: now, results: [{ id: '1', title: 'A', thumbnailDataUrl: null }] };
  cache.set('hello', entry);
  const first = cache.get('hello');
  assert.notEqual(first, entry, 'get must return clone, not same object');
  assert.notEqual(first.results[0], entry.results[0], 'nested array items must be cloned');
  // mutate returned copy
  first.results[0].thumbnailDataUrl = 'data:image/jpeg;base64,xxx';
  const second = cache.get('hello');
  assert.equal(second.results[0].thumbnailDataUrl, null, 'cached pristine must stay null after mutation of previous get');
  assert.notEqual(second.results[0], first.results[0], 'second get returns fresh clone');
});

test('LruCache respects TTL and LRU eviction', async () => {
  let now = 0;
  const cache = new LruCache(2, 1000, () => now);
  cache.set('a', { createdAt: now, data: 'A' });
  cache.set('b', { createdAt: now, data: 'B' });
  assert.equal(cache.size, 2);
  // access a to make it MRU
  cache.get('a');
  cache.set('c', { createdAt: now, data: 'C' });
  assert.equal(cache.has('b'), false, 'LRU eviction should remove oldest (b) after accessing a');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);
  // TTL expiry
  now = 1001;
  assert.equal(cache.get('a'), null, 'expired entry returns null');
  assert.equal(cache.size, 1);
});

test('createSearchCache factory returns pristine LRU caches', () => {
  let now = 0;
  const { search, thumbnails } = createSearchCache(2, 2, { now: () => now });
  search.set('q', { query: 'q', createdAt: now, results: [{ id: '1', thumbnailDataUrl: null }] });
  const first = search.get('q');
  first.results[0].thumbnailDataUrl = 'mutated';
  const second = search.get('q');
  assert.equal(second.results[0].thumbnailDataUrl, null);
  thumbnails.set('t', { createdAt: now, data: 'data1' });
  thumbnails.get('t');
  thumbnails.set('t2', { createdAt: now, data: 'data2' });
  thumbnails.set('t3', { createdAt: now, data: 'data3' });
  assert.equal(thumbnails.size, 2);
});

test('spawnBounded is the single shell:false site with bounded capture', async () => {
  class FakeChild extends EventEmitter {
    constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
    kill() { this.emit('close', 143); return true; }
  }
  let captured = null;
  const spawn = (binary, args, opts) => {
    captured = opts;
    const child = new FakeChild();
    setImmediate(() => { child.stderr.emit('data', Buffer.from('err')); child.stdout.emit('data', Buffer.from('hello world\n')); child.emit('close', 0); });
    return child;
  };
  const result = await spawnBounded('/bin/echo', ['hello'], spawn, { maxStdout: 5, maxStderr: 10 });
  assert.equal(captured.shell, false);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, 'err');
  assert.equal(result.code, 143);
});
