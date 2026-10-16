import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const urlA = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const urlB = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
const find = (root, predicate) => {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = find(child, predicate);
    if (nested) return nested;
  }
};
function change(h, id, value, type = 'change') {
  const el = h.elements.get(id);
  el.value = value;
  el.listeners[type]?.({ target: el, preventDefault() {}, stopPropagation() {} });
}
async function boot() {
  const h = createHarness({ eventsOnly: true });
  await h.fireReady();
  return h;
}
async function search(h) {
  change(h, 'youtube-search-input', 'shots', 'input');
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches.at(-1).entry.resolve(h.page);
  await h.flush();
}
const card = (h, index, action) => find(h.elements.get('youtube-search-results').children[index], (el) => el.dataset.cardAction === action);
async function load(h, url) {
  change(h, 'youtube-url', url, 'input');
  h.elements.get('load-youtube-btn').click();
  await h.flush();
}

for (const order of ['card first', 'inspector first']) {
  test(`duplicate default output is recognised whichever path queues it (${order})`, async () => {
    const h = await boot();
    await search(h);
    const viaCard = async () => { card(h, 0, 'enqueue').click(); await h.flush(); };
    const viaInspector = async () => { card(h, 0, 'advanced').click(); await h.flush(); h.elements.get('download-youtube-btn').click(); await h.flush(); };
    if (order === 'card first') { await viaCard(); await viaInspector(); } else { await viaInspector(); await viaCard(); }
    const queued = JSON.parse(JSON.stringify(h.test.queue().map((item) => [item.videoId, item.quality])));
    assert.deepEqual(queued, [['aaaaaaaaaaa', '1080p']]);
  });
}

test('an edited but unloaded link cannot download the previously loaded source', async () => {
  const h = await boot();
  await load(h, urlA);
  change(h, 'youtube-url', urlB, 'input');
  assert.equal(h.elements.get('download-youtube-btn').disabled, true);
  h.elements.get('download-youtube-btn').listeners.click?.({ preventDefault() {}, stopPropagation() {} });
  await h.flush();
  assert.deepEqual(h.downloads.map((entry) => entry.url), []);
  h.elements.get('load-youtube-btn').click();
  await h.flush();
  assert.equal(h.elements.get('download-youtube-btn').disabled, false);
  h.elements.get('download-youtube-btn').click();
  await h.flush();
  assert.deepEqual(h.downloads.map((entry) => entry.url), [urlB]);
});

test('restoring the loaded link text re-enables downloading that source', async () => {
  const h = await boot();
  await load(h, urlA);
  change(h, 'youtube-url', urlB, 'input');
  change(h, 'youtube-url', ` ${urlA} `, 'input');
  assert.equal(h.elements.get('download-youtube-btn').disabled, false);
  h.elements.get('download-youtube-btn').click();
  await h.flush();
  assert.deepEqual(h.downloads.map((entry) => entry.url), [urlA]);
});
