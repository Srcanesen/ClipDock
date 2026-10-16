import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const find = (root, predicate) => {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = find(child, predicate); if (nested) return nested;
  }
};

for (const provider of ['youtube', 'social', 'pinterest', 'pexels']) {
  test(`${provider} metadata load ignores a deferred failure from the previous preview`, async () => {
    const h = createHarness({ eventsOnly: true });
    h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: false, message: '' });
    await h.fireReady();
    h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
    h.elements.get('load-youtube-btn').click(); await h.flush();
    let finishPreview;
    h.api.openYoutubePreview = () => new Promise(resolve => { finishPreview = resolve; });
    h.elements.get('preview-selected-btn').click();
    assert.equal(h.elements.get('workspace').classList.contains('theater'), true);
    assert.equal(typeof finishPreview, 'function');
    let metadataCalls = 0;
    const pendingMetadata = () => { metadataCalls++; return new Promise(() => {}); };
    if (provider === 'youtube') {
      h.api.loadYoutube = pendingMetadata;
      h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
      h.elements.get('load-youtube-btn').click();
    } else {
      h.elements.get(`provider-${provider}`).click();
      if (provider === 'pexels') {
        const asset = { id: 1, kind: 'video', title: 'Pexels', sourceUrl: 'https://www.pexels.com/video/1/', thumbnailUrl: null, files: [] };
        h.api.searchPexels = async () => ({ query: 'shots', page: 1, pageSize: 10, results: [asset], hasPrevious: false, hasNext: false, totalResults: 1 });
        h.api.loadPexels = pendingMetadata;
        h.elements.get('youtube-search-input').value = 'shots';
        h.elements.get('youtube-search-form').listeners.submit(); await h.flush();
        find(h.elements.get('youtube-search-results').children[0], el => el.dataset.cardAction === 'advanced').click();
      } else {
        h.api[provider === 'social' ? 'loadSocial' : 'loadPinterest'] = pendingMetadata;
        h.elements.get(`${provider}-url`).value = provider === 'social' ? 'https://www.instagram.com/reel/example/' : 'https://www.pinterest.com/pin/111/';
        h.elements.get(`load-${provider}-btn`).click();
      }
    }
    assert.equal(metadataCalls, 1, 'the new metadata load reached its provider boundary');
    assert.equal(h.elements.get('transfer-console').getAttribute('aria-busy'), 'true');
    const message = h.elements.get('message').textContent;
    const status = h.elements.get('youtube-status').textContent;
    const boundsCalls = h.previewCalls.bounds.length;
    const closeCalls = h.previewCalls.close;
    finishPreview(false); await h.flush();
    assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'false');
    assert.equal(h.elements.get('workspace').classList.contains('theater'), false);
    assert.equal(h.elements.get('message').textContent, message, 'an obsolete failure cannot replace the current host message');
    assert.equal(h.elements.get('youtube-status').textContent, status);
    assert.equal(h.previewCalls.bounds.length, boundsCalls, 'no obsolete bounds are applied');
    assert.equal(h.previewCalls.close, closeCalls, 'the obsolete response does not close a new player');
    assert.equal(h.elements.get('transfer-console').getAttribute('aria-busy'), 'true');
  });
}
