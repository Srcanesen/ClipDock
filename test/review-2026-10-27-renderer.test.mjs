// Renderer regressions from the 2026-10-27 review, driven through the shipped bundle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const fire = (element, type, event = {}) => element.listeners[type]?.({ type, ...event });
const find = (element, predicate) => {
  for (const child of element.children ?? []) {
    if (predicate(child)) return child;
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
};
const rows = (h) => h.elements.get('youtube-search-results').children;
const attached = (list, element) => !!element && !!find(list, (e) => e === element);
const record = (id) => ({ id, provider: 'youtube', source: `https://www.youtube.com/watch?v=${id}`, project: null, fileName: `${id}.mp4`, bytes: 1234, assetId: id, title: id, creator: 'Channel', createdAt: 1, lastUsedAt: 1, available: true, cardId: `card-${id}` });
async function boot(api = {}) {
  const h = createHarness();
  Object.assign(h.api, api);
  await h.fireReady();
  return h;
}
async function search(h) {
  h.elements.get('youtube-search-input').value = 'shots';
  fire(h.elements.get('youtube-search-form'), 'submit');
  await h.flush();
  h.searches.at(-1).entry.resolve(h.page);
  await h.flush();
}
async function open(h, index = 0) {
  fire(find(rows(h)[index], (e) => e.className?.includes('youtube-details')), 'click', { detail: 1 });
  await h.flush();
}

test('a host status refresh keeps an action result readable until the host message changes', async () => {
  let hostMessage = 'Ready';
  const h = await boot({ historyList: async () => [record('one')] });
  const status = h.api.getStatus;
  h.api.getStatus = async () => ({ ...(await status()), message: hostMessage });
  h.test.setSurface('library'); await h.flush();
  const list = h.elements.get('history-list');
  find(list.children[0], (e) => e.tagName === 'BUTTON' && e.textContent === 'Media Pool').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, 'one.mp4 is missing. Relink it first.');
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, 'one.mp4 is missing. Relink it first.', 'an unchanged host message must not repaint over the action result');
  hostMessage = 'Open a timeline.';
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, 'Open a timeline.');
});

test('a host status refresh after a failed status call replaces the failure text', async () => {
  const h = await boot();
  const status = h.api.getStatus;
  h.api.getStatus = async () => { throw new Error('bridge down'); };
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, 'Renderer call failed: bridge down');
  h.api.getStatus = status;
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, 'Ready');
});

test('a History action keeps the shown batch and focus on a row past the first batch', async () => {
  const records = Array.from({ length: 45 }, (_, index) => record(`r${index + 1}`));
  const h = await boot({ historyList: async () => records });
  h.test.setSurface('library'); await h.flush();
  const list = h.elements.get('history-list');
  h.elements.get('history-show-more').click(); h.elements.get('history-show-more').click(); await h.flush();
  assert.equal(list.children.length, 45);
  const reveal = find(list.children[39], (e) => e.tagName === 'BUTTON' && e.textContent === 'Reveal in Finder' && e.className.includes('reveal'));
  reveal.focus(); reveal.click(); await h.flush();
  assert.equal(list.children.length, 45, 'the batch resets only for a query or filter change');
  assert.equal(attached(list, h.activeElement), true, 'focus stays inside the rebuilt list');
  assert.equal(h.activeElement.getAttribute('aria-label'), 'Reveal in Finder: r40.mp4');
  fire(h.elements.get('history-search-input'), 'input'); await h.flush();
  assert.equal(list.children.length, 20, 'a query change still resets the batch');
});

test('Cmd+Enter downloads only while the clip detail with its download control is visible', async () => {
  const h = await boot();
  await search(h); await open(h, 0);
  h.test.setSurface('queue'); await h.flush();
  h.keydown({ key: 'Enter', metaKey: true }); await h.flush();
  assert.equal(h.downloads.length, 0, 'hidden Search surface: no download');
  h.test.setSurface('search'); await h.flush();
  fire(h.elements.get('back-to-results'), 'click'); await h.flush();
  h.keydown({ key: 'Enter', ctrlKey: true }); await h.flush();
  assert.equal(h.downloads.length, 0, 'closed clip detail: no download');
  await open(h, 0);
  h.keydown({ key: 'Enter', metaKey: true }); await h.flush();
  assert.deepEqual(h.downloads.map((entry) => entry.url), ['https://www.youtube.com/watch?v=aaaaaaaaaaa']);
});
