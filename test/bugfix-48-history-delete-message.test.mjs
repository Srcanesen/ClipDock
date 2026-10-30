import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DownloadHistory } from '../dist/history.js';
import { DownloadLedger } from '../dist/download-ledger.js';
import { ManagedRoot } from '../dist/managed-root.js';

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
  const message = await deleteFromHistory({ deleted: true, removed: true, historyWriteFailed: true });
  assert.equal(message.textContent, 'File deleted, but download history could not be updated.');
  assert.equal(message.classList.contains('err'), true);
});

test('combined subtitle and persistence failures retain both diagnostics without claiming persistence', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-warning-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const surface of ['history', 'queue']) {
    const root = ManagedRoot.prepare(path.join(dir, surface));
    const media = path.join(root.providerPath('youtube'), 'clip.mp4');
    const subtitle = path.join(root.providerPath('youtube'), 'clip.srt');
    fs.writeFileSync(media, 'media'); fs.writeFileSync(subtitle, 'captions');
    const store = path.join(dir, `${surface}.json`);
    const history = new DownloadHistory(store, root);
    const ledger = new DownloadLedger(history, () => false);
    const saved = ledger.record({ ...record, filePath: media, subtitle: { filePath: subtitle } }).record;
    const card = surface === 'history' ? ledger.bindHistory(saved.id) : ledger.register({ path: media, historyId: saved.id }, root);
    fs.renameSync(subtitle, `${subtitle}.original`); fs.writeFileSync(subtitle, 'replacement');
    fs.rmSync(store); fs.mkdirSync(store);
    let message;
    if (surface === 'history') {
      const result = ledger.deleteHistory(saved.id);
      assert.deepEqual(result, { deleted: true, removed: true, historyWriteFailed: true, warning: 'Media deleted, but its subtitle could not be deleted.', removedCardIds: [card] });
      message = (await deleteFromHistory(result)).textContent;
    } else {
      const result = ledger.deleteCard(card);
      assert.equal(result.deleted, true);
      message = result.message;
    }
    assert.equal(message, 'File deleted, but download history could not be updated. Media deleted, but its subtitle could not be deleted.');
    assert.equal(fs.existsSync(media), false);
    assert.equal(fs.readFileSync(subtitle, 'utf8'), 'replacement');
    await history.dispose();
  }
});

test('persistence diagnostics use the typed field independently of warning wording', async () => {
  const message = await deleteFromHistory({ deleted: true, removed: true, historyWriteFailed: true, warning: 'Additional diagnostic.' });
  assert.equal(message.textContent, 'File deleted, but download history could not be updated. Additional diagnostic.');
  assert.equal(message.classList.contains('err'), true);
});
