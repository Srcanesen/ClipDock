import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { StatusRefreshSession, MetadataSession } = require('../dist/renderer-state/status-session.js');

test('status session: a refresh during a flight folds into one trailing refresh', () => {
  const session = new StatusRefreshSession();
  const flight = session.begin();
  assert.deepEqual(flight, { generation: 0, epoch: 1 });
  assert.equal(session.begin(), null);
  assert.equal(session.begin(), null);
  assert.equal(session.inFlight, true);
  assert.equal(session.release(), true);
  assert.equal(session.inFlight, false);
  assert.deepEqual(session.begin(), { generation: 0, epoch: 2 });
  assert.equal(session.release(), false);
});

test('status session: a response from before ResolveQuit is rejected but still holds the slot', () => {
  const session = new StatusRefreshSession();
  const flight = session.begin();
  session.invalidate();
  assert.equal(session.accepts(flight), false);
  assert.equal(session.holds(flight), true);
  assert.equal(session.release(), false);
  const next = session.begin();
  assert.deepEqual(next, { generation: 1, epoch: 2 });
  assert.equal(session.accepts(next), true);
});

test('status session: a timed-out flight can neither update state nor release the newer flight', () => {
  const session = new StatusRefreshSession();
  const late = session.begin();
  session.expire();
  session.release();
  const current = session.begin();
  assert.equal(session.accepts(late), false);
  assert.equal(session.holds(late), false);
  assert.equal(session.accepts(current), true);
  assert.equal(session.inFlight, true);
});

test('metadata session: busy is retained when an older request settles after a newer one began', () => {
  const session = new MetadataSession();
  const older = session.begin();
  const newer = session.begin();
  assert.equal(session.isStale(older), true);
  assert.equal(session.finish(older), false);
  assert.equal(session.busy, true);
  assert.equal(session.finish(newer), true);
  assert.equal(session.busy, false);
});

test('metadata session: reset drops busy and makes the in-flight request stale', () => {
  const session = new MetadataSession();
  const request = session.begin();
  session.reset();
  assert.equal(session.busy, false);
  assert.equal(session.isCurrent(request), false);
  const next = session.begin();
  assert.equal(session.finish(request), false);
  assert.equal(session.busy, true);
  assert.equal(session.isCurrent(next), true);
});
