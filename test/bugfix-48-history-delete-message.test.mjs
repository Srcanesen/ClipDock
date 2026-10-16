import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const record = {
  id: 'replacement', provider: 'youtube', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  project: null, fileName: 'clip.mp4', bytes: 10, assetId: null, title: 'Clip', creator: null,
  profile: 'original', quality: 'best', mediaMode: 'video', selection: null,
  automation: { provider: 'youtube', source: '', selection: null, chapters: [] },
  createdAt: 1, lastUsedAt: 1, available: true,
};

function findDelete(element) {
  for (const child of element.children ?? []) {
    if (child.textContent === 'Delete') return child;
    const found = findDelete(child);
    if (found) return found;
  }
  return null;
}

async function deleteFromHistory(result) {
  const h = createHarness();
  const calls = [];
  h.api.historyList = async () => [record];
  h.api.historyDelete = async (id) => { calls.push(id); return result; };
  await h.fireReady();
  h.test.setSurface('library');
  await h.flush();
  const button = findDelete(h.elements.get('history-list'));
  assert.ok(button, 'History renders a Delete control');
  button.listeners.click({ type: 'click' });
  await h.flush();
  assert.deepEqual(calls, ['replacement']);
  return h.elements.get('message');
}

for (const [deleted, removed, expected] of [
  [false, true, 'Removed from history. The file was kept.'],
  [false, false, 'Nothing was removed. The file was kept.'],
  [true, true, 'Removed from history and deleted the managed file.'],
  [true, false, 'The managed file was deleted. The history entry was kept.'],
]) {
  for (const warning of [undefined, 'Media changed or was replaced; preserved.', 'Media deleted, but its subtitle could not be deleted.']) {
    test(`History deletion reports deleted=${deleted}, removed=${removed}, warning=${warning ?? 'none'}`, async () => {
      const message = await deleteFromHistory({ deleted, removed, ...(warning ? { warning } : {}) });
      assert.equal(message.textContent, warning ? `${expected} ${warning}` : expected);
      assert.equal(message.classList.contains('ok'), deleted && removed && !warning);
      assert.equal(message.classList.contains('err'), !(deleted && removed && !warning));
    });
  }
}

test('History retains the specific persistence-failure diagnostic when media was deleted', async () => {
  const message = await deleteFromHistory({ deleted: true, removed: true, warning: 'Download history could not be updated.' });
  assert.equal(message.textContent, 'File deleted, but download history could not be updated.');
  assert.equal(message.classList.contains('err'), true);
});
