import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';
const fire = (element, type, event = {}) => element.listeners[type]?.({ type, ...event });
const find = (root, predicate) => {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = find(child, predicate); if (nested) return nested;
  }
};
const ready = { phase: 'ready', bridge: { connected: true, moduleVersion: 'test', resolveVersion: 'test', error: null }, project: { loaded: true, name: 'P' }, timeline: { loaded: true, name: 'T' }, message: 'Ready', refreshHint: null };
const disconnected = { ...ready, phase: 'bridge-error', bridge: { ...ready.bridge, connected: false }, project: { loaded: false, name: null }, timeline: { loaded: false, name: null } };

test('History updates host handoffs and drag in both directions without replacing its open menu', async () => {
  const h = createHarness(); let quit;
  h.api.onResolveQuit = callback => { quit = callback; return () => {}; };
  h.api.getStatus = async () => disconnected;
  h.api.historyList = async () => [{ id: 'record', provider: 'youtube', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Clip', fileName: 'clip.mp4', bytes: 1, createdAt: 1, available: true, cardId: 'card' }];
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  const row = h.elements.get('history-list').children[0];
  const quick = find(row, el => el.dataset.icon === 'pool');
  const more = find(row, el => el.classList.contains('history-actions'));
  const menu = find(row, el => el.getAttribute('role') === 'menu');
  const pool = menu.children.find(el => el.textContent === 'Add to Media Pool');
  const timeline = menu.children.find(el => el.textContent === 'Add at playhead');
  more.click();
  const focused = menu.children.find(el => el.textContent === 'Reveal in Finder'); focused.focus();
  const drags = []; h.api.startNativeDrag = cardId => drags.push(cardId);
  const check = (disabled) => {
    assert.equal(quick.disabled, disabled); assert.equal(pool.disabled, disabled); assert.equal(timeline.disabled, disabled);
    assert.equal(row.draggable, !disabled);
    drags.length = 0; let prevented = false;
    row.listeners.dragstart({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(drags, disabled ? [] : ['card']);
    assert.equal(menu.classList.contains('hidden'), false); assert.equal(h.activeElement, focused);
    assert.equal(h.elements.get('history-list').children[0], row);
    assert.equal(!!find(row, el => el.classList.contains('history-drag-hint')), !disabled);
    assert.equal(!!find(row, el => el.classList.contains('history-drag-reason')), disabled);
    assert.equal(row.getAttribute('aria-label').includes('Drag to Resolve.'), !disabled);
  };
  check(true);
  h.api.getStatus = async () => ready; h.elements.get('refresh-btn').click(); await h.flush(); check(false);
  h.api.getStatus = async () => disconnected; h.elements.get('refresh-btn').click(); await h.flush(); check(true);
  h.api.getStatus = async () => ready; h.elements.get('refresh-btn').click(); await h.flush(); check(false);
  quit(); check(true); // synchronous disconnect must not wait for the next poll
});
