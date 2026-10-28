import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createHarness } from './helpers/renderer-harness.mjs';
import { transpilePreviewAdapter } from '../scripts/lib/preview-adapter.mjs';

test('History paints artwork by opaque id without replacing a row, falls back on failure, and clears through its button', async () => {
  const h = createHarness(); let resolve;
  const calls = [];
  let records = [{ id: 'first', provider: 'social', title: 'Clip', fileName: 'clip.mp4', available: true, createdAt: 1, bytes: 1 }];
  h.api.historyList = async () => records;
  h.api.historyThumbnail = id => { calls.push(id); return new Promise(done => { resolve = done; }); };
  let clears = 0;
  h.api.historyClear = async () => { clears++; records = []; return 1; };
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  const row = h.elements.get('history-list').children[0];
  const poster = row.children.find(child => child.className === 'mini').children[0];
  const fallback = poster.src;
  const image = 'data:image/jpeg;base64,/9j/fixture';
  assert.deepEqual(calls, ['first']);
  resolve(image); await h.flush();
  assert.equal(poster.src, image);
  assert.equal(h.elements.get('history-list').children[0], row);
  poster.listeners.error(); assert.equal(poster.src, fallback);
  h.elements.get('history-clear-btn').click(); await h.flush();
  assert.equal(clears, 1); assert.equal(h.elements.get('history-list').children.length, 0);
});

test('preview History supplies artwork and models delete and clear', async () => {
  const window = { location: { search: '?preview=ready' }, addEventListener() {} };
  runInNewContext(transpilePreviewAdapter(process.cwd()), { window, URLSearchParams, setTimeout() {}, document: { getElementById: () => null }, console });
  const api = window.clipdockAPI;
  const rows = await api.historyList(); assert.equal(rows.length, 4);
  assert.match(await api.historyThumbnail(rows[0].id), /^data:image\//);
  assert.equal(await api.historyThumbnail('/private/file.jpg'), null);
  assert.equal((await api.historyDelete(rows[0].id)).removed, true);
  assert.equal((await api.historyList()).length, 3);
  assert.equal(await api.historyThumbnail(rows[0].id), null);
  assert.equal(await api.historyClear(), 3);
  assert.equal((await api.historyList()).length, 0);
});
