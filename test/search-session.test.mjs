import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGenerationGuard } = require('../dist/renderer-state/search-session.js');

test('generation guard next() increments and current() tracks', () => {
  const g = createGenerationGuard();
  assert.equal(g.current(), 0);
  assert.equal(g.next(), 1);
  assert.equal(g.current(), 1);
  assert.equal(g.next(), 2);
  assert.equal(g.current(), 2);
});

test('isStale / isCurrent correctly identify stale vs current', () => {
  const g = createGenerationGuard();
  const r1 = g.next(); // 1
  const r2 = g.next(); // 2
  assert.equal(g.isStale(r1), true);
  assert.equal(g.isCurrent(r1), false);
  assert.equal(g.isStale(r2), false);
  assert.equal(g.isCurrent(r2), true);
});

test('invalidate bumps generation without returning', () => {
  const g = createGenerationGuard();
  const r1 = g.next(); // 1
  g.invalidate(); // 2
  assert.equal(g.isStale(r1), true);
  assert.equal(g.current(), 2);
  const r3 = g.next(); // 3
  assert.equal(g.isCurrent(r3), true);
});

test('multiple guards are independent', () => {
  const a = createGenerationGuard();
  const b = createGenerationGuard();
  a.next(); a.next();
  b.next();
  assert.equal(a.current(), 2);
  assert.equal(b.current(), 1);
});

test('initial value can be seeded', () => {
  const g = createGenerationGuard(5);
  assert.equal(g.current(), 5);
  assert.equal(g.next(), 6);
});
