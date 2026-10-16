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
const asset = { id: 1, kind: 'video', title: 'Pexels clip', creator: null, creatorUrl: null, sourceUrl: 'https://www.pexels.com/video/1/', duration: 10, width: 1920, height: 1080, thumbnailUrl: null, previewUrl: null, files: [
  { id: 'large', url: 'https://videos.pexels.com/large.mp4', width: 1920, height: 1080, label: '1080p', mime: 'video/mp4', size: 2 },
  { id: 'small', url: 'https://videos.pexels.com/small.mp4', width: 1280, height: 720, label: '720p', mime: 'video/mp4', size: 1 },
] };
async function pexelsDetail(h) {
  h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: false, message: '' });
  h.api.searchPexels = async () => ({ query: 'shots', page: 1, pageSize: 10, results: [asset], hasPrevious: false, hasNext: false, totalResults: 1 });
  h.api.loadPexels = async () => asset;
  h.elements.get('youtube-search-input').value = 'shots';
  fire(h.elements.get('provider-pexels'), 'click');
  h.elements.get('youtube-search-input').value = 'shots';
  fire(h.elements.get('youtube-search-form'), 'submit'); await h.flush();
  find(h.elements.get('youtube-search-results').children[0], el => el.dataset.cardAction === 'advanced').click(); await h.flush();
}


test('Pexels rendition radios support arrows, Home and End and queue the focused file', async () => {
  const h = createHarness(); h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: false, message: '' }); await h.fireReady(); await pexelsDetail(h);
  const chips = h.elements.get('quality-chips').children;
  const check = index => {
    assert.equal(h.elements.get('youtube-quality').value, index ? 'small' : 'large');
    assert.equal(h.activeElement, chips[index]);
    assert.deepEqual(chips.map(el => el.tabIndex), index ? [-1, 0] : [0, -1]);
    assert.deepEqual(chips.map(el => el.getAttribute('aria-checked')), index ? ['false', 'true'] : ['true', 'false']);
  };
  chips[0].focus(); check(0);
  for (const [from, key, to] of [[0, 'ArrowRight', 1], [1, 'ArrowLeft', 0], [0, 'End', 1], [1, 'Home', 0], [0, 'ArrowDown', 1], [1, 'ArrowUp', 0], [0, 'End', 1]]) {
    fire(chips[from], 'keydown', { key }); check(to);
  }
  const calls = []; h.api.downloadPexels = async (_asset, fileId) => { calls.push(fileId); return { cardId: 'card', fileName: 'small.mp4' }; };
  h.elements.get('download-youtube-btn').click(); await h.flush();
  assert.deepEqual(calls, ['small']);
});
