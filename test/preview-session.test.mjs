import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PreviewSession } = require('../dist/renderer-state/preview-session.js');

const closed = { state: 'closed', reason: 'closed' };

test('preview session: a YouTube open reply from a stopped lifecycle is stale', () => {
  const session = new PreviewSession();
  const first = session.beginYoutube('monitor', 'youtube:a');
  assert.equal(session.stop(), true);
  session.clear();
  const second = session.beginYoutube('monitor', 'youtube:b');
  assert.equal(session.isStale(first), true);
  assert.equal(session.isCurrent(second), true);
  assert.equal(session.resultKey, 'youtube:b');
  assert.equal(session.isManualFor('youtube:a'), false);
  assert.equal(session.isManualFor('youtube:b'), true);
});

test('preview session: stop is a no-op when nothing previews and keeps the generation', () => {
  const session = new PreviewSession();
  const before = session.current();
  assert.equal(session.stop(), false);
  assert.equal(session.current(), before);
});

test('preview session: clear asks for exactly one YouTube close per lifecycle', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  const first = session.clear();
  assert.equal(first.provider, 'youtube');
  assert.notEqual(first.closeToken, null);
  const again = session.clear();
  assert.equal(again.provider, null);
  assert.equal(again.closeToken, null);
  assert.equal(session.pendingCloseCount, 1);
  assert.equal(session.source, null);
  assert.equal(session.target, null);
});

test('preview session: a Pexels lifecycle never sends a YouTube close', () => {
  const session = new PreviewSession();
  session.beginPexels('monitor', 'pexels:1');
  assert.deepEqual(session.clear(), { provider: 'pexels', closeToken: null });
});

test('preview session: the ack for a stopped lifecycle does not end the new preview', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  session.clear();
  const current = session.beginYoutube('monitor', 'youtube:b');
  assert.equal(session.receiveYoutubeState(closed), 'acknowledged');
  assert.equal(session.youtubeActive, true);
  assert.equal(session.isCurrent(current), true);
  assert.equal(session.pendingCloseCount, 0);
  // The next main close now belongs to the running preview.
  assert.equal(session.receiveYoutubeState(closed), 'ended');
  assert.equal(session.youtubeActive, false);
  assert.equal(session.isStale(current), true);
});

test('preview session: a failed close expects no ack, so a later main close ends the live preview', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  const { closeToken } = session.clear();
  session.closeSettled(closeToken, false);
  assert.equal(session.pendingCloseCount, 0);
  session.beginYoutube('monitor', 'youtube:b');
  assert.equal(session.receiveYoutubeState(closed), 'ended');
});

test('preview session: a successful close keeps its pending ack', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  const { closeToken } = session.clear();
  session.closeSettled(closeToken, true);
  assert.equal(session.pendingCloseCount, 1);
});

test('preview session: an already-acked close that later fails cannot drop another pending ack', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  const a = session.clear().closeToken;
  session.beginYoutube('monitor', 'youtube:b');
  session.clear();
  assert.equal(session.receiveYoutubeState(closed), 'acknowledged');
  session.closeSettled(a, false);
  assert.equal(session.pendingCloseCount, 1);
});

test('preview session: main state is ignored without an active YouTube lifecycle', () => {
  const session = new PreviewSession();
  assert.equal(session.receiveYoutubeState({ state: 'failed', reason: 'load' }), 'ignored');
  session.beginPexels('monitor', 'pexels:1');
  assert.equal(session.receiveYoutubeState({ state: 'closed', reason: 'escape' }), 'ignored');
  assert.equal(session.failure, false);
});

test('preview session: a failed main state marks failure and a new YouTube open clears it', () => {
  const session = new PreviewSession();
  session.beginYoutube('monitor', 'youtube:a');
  assert.equal(session.receiveYoutubeState({ state: 'failed', reason: 'load' }), 'ended');
  assert.equal(session.failure, true);
  session.clear();
  session.beginPexels('monitor', 'pexels:1');
  assert.equal(session.failure, true);
  session.clear();
  session.beginYoutube('monitor', 'youtube:b');
  assert.equal(session.failure, false);
});
