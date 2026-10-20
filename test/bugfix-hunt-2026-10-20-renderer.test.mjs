// Renderer regressions from the 2026-10-20 bug hunt, driven through the shipped bundle.
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
const queueRows = (h) => h.elements.get('youtube-download-queue').children;
const named = (row, label) => find(row, (e) => e.tagName === 'BUTTON' && e.textContent === label);
// A focus target is usable only while it is still inside the rendered list.
const attached = (list, element) => !!element && !!find(list, (e) => e === element);
const record = (id, over = {}) => ({ id, provider: 'youtube', source: `https://www.youtube.com/watch?v=${id}`, project: null, fileName: `${id}.mp4`, bytes: 1234, assetId: id, title: id, creator: 'Channel', createdAt: 1, lastUsedAt: 1, available: true, cardId: `card-${id}`, ...over });
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
async function completedDownload(h) {
  await search(h); await open(h);
  fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  h.downloads[0].resolve({ cardId: 'card-1', fileName: 'A.mp4' }); await h.flush();
}

test('queue row disables the handoff while its file is deleted, and Delete while it is handed off', async () => {
  let finishDelete, finishImport;
  const h = await boot({
    queueDelete: () => new Promise((resolve) => { finishDelete = resolve; }),
    importToMediaPool: () => new Promise((resolve) => { finishImport = resolve; }),
  });
  await completedDownload(h);
  named(queueRows(h)[0], 'Delete file').click(); await h.flush();
  assert.deepEqual(['Add to Media Pool', 'Add to timeline'].map((label) => named(queueRows(h)[0], label).disabled), [true, true]);
  finishDelete({ deleted: false, message: 'Still used.' }); await h.flush();
  named(queueRows(h)[0], 'Add to Media Pool').click(); await h.flush();
  assert.equal(named(queueRows(h)[0], 'Delete file').disabled, true);
  finishImport({ ok: true, kind: 'imported', message: 'Added to Media Pool.' }); await h.flush();
  assert.equal(named(queueRows(h)[0], 'Delete file').disabled, false);
});

test('a queue rebuild keeps keyboard focus on the same control of the same row', async () => {
  const h = await boot();
  await completedDownload(h);
  await open(h, 1); fire(h.elements.get('download-youtube-btn'), 'click'); await h.flush();
  const completed = Array.from(queueRows(h)).find((row) => row.dataset.state === 'completed');
  named(completed, 'Download again').focus();
  h.downloads[1].resolve({ cardId: 'card-2', fileName: 'B.mp4' }); await h.flush();
  const list = h.elements.get('youtube-download-queue');
  assert.equal(attached(list, h.activeElement), true, 'focus is inside the rebuilt queue');
  assert.equal(h.activeElement.textContent, 'Download again');
  assert.equal(h.activeElement.parentElement.parentElement.dataset.queueId, completed.dataset.queueId);
});

test('a History action keeps keyboard focus on its row, including actions from the More menu', async () => {
  const h = await boot({ historyList: async () => [record('one'), record('two')] });
  h.test.setSurface('library'); await h.flush();
  const list = h.elements.get('history-list');
  const reveal = (row) => find(row, (e) => e.tagName === 'BUTTON' && e.textContent === 'Reveal in Finder' && e.className.includes('reveal'));
  reveal(list.children[1]).focus(); reveal(list.children[1]).click(); await h.flush();
  assert.equal(attached(list, h.activeElement), true, 'quick action focus survives the refresh');
  assert.equal(h.activeElement.getAttribute('aria-label'), 'Reveal in Finder: two.mp4');
  named(list.children[0], 'More').click(); await h.flush();
  find(list.children[0], (e) => e.getAttribute?.('role') === 'menuitem' && e.textContent === 'Copy path').click(); await h.flush();
  assert.equal(attached(list, h.activeElement), true, 'menu action returns focus to its row');
  assert.equal(h.activeElement.getAttribute('aria-label'), 'Actions for one.mp4');
});

test('a History rebuild closes an open More menu instead of keeping a detached one', async () => {
  const h = await boot({ historyList: async () => [record('one')] });
  h.test.setSurface('library'); await h.flush();
  const list = h.elements.get('history-list');
  named(list.children[0], 'More').click(); await h.flush();
  fire(h.elements.get('history-search-input'), 'input'); await h.flush();
  h.keydown({ key: 'Escape' }); await h.flush();
  assert.notEqual(h.activeElement?.getAttribute?.('aria-label'), 'Actions for one.mp4', 'Escape must not focus the detached trigger');
  assert.equal(attached(list, h.activeElement) || !h.activeElement?.getAttribute?.('aria-haspopup'), true);
});

test('Space previews the focused result card, and the Inspector item only while the Inspector is open', async () => {
  const h = await boot();
  await search(h); await open(h, 0);
  fire(h.elements.get('back-to-results'), 'click'); await h.flush();
  h.elements.get('workspace').focus();
  h.keydown({ key: ' ' }); await h.flush();
  assert.deepEqual(h.previewCalls.open.map((call) => call.id), [], 'closed Inspector: no global preview');
  rows(h)[1].focus();
  h.keydown({ key: ' ' }); await h.flush();
  assert.deepEqual(h.previewCalls.open.map((call) => call.id), ['bbbbbbbbbbb']);
});

test('Escape on the first-use dialog records the acknowledgement', async () => {
  const h = await boot();
  fire(h.elements.get('first-use-dialog'), 'cancel');
  assert.equal(h.preferences.get('clipdock.permitted-content-ack'), 'true');
});
