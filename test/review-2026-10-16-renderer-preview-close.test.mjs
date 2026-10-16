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
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
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


for (const replacement of ['youtube', 'pexels']) {
  test(`old native close notification preserves the replacement ${replacement} preview`, async () => {
    const h = createHarness(); h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: false, message: '' }); await h.fireReady();
    await h.test.startYoutubePreview('aaaaaaaaaaa');
    const close = deferred(); h.api.closeYoutubePreview = () => { h.previewCalls.close++; return close.promise; };
    if (replacement === 'youtube') await h.test.startYoutubePreview('bbbbbbbbbbb');
    else {
      await pexelsDetail(h);
      // Native media is represented entirely in-process.
      const video = h.elements.get('pexels-preview-video'); video.play = async () => {}; video.pause = () => {}; video.load = () => {};
      asset.previewUrl = 'https://videos.pexels.com/preview.mp4';
      h.elements.get('preview-selected-btn').click(); asset.previewUrl = null;
    }
    assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'true');
    h.previewState({ state: 'closed', reason: 'closed' }); close.resolve(true); await h.flush();
    assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(h.elements.get('workspace').classList.contains('theater'), true);
    assert.equal(h.previewCalls.close, 1);
    if (replacement === 'youtube') {
      h.previewState({ state: 'closed', reason: 'escape' });
      assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'false');
      assert.equal(h.activeElement, h.elements.get('preview-selected-btn'));
    }
  });
}
