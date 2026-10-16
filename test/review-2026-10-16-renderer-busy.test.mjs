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
const metadata = (id = 'aaaaaaaaaaa') => ({ id, title: 'Clip', duration: 60, channel: null, thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: [] });
async function search(h) {
  h.elements.get('youtube-search-input').value = 'shots'; fire(h.elements.get('youtube-search-form'), 'submit');
  h.searches.at(-1).entry.resolve(h.page); await h.flush();
}

for (const newer of ['social', 'youtube']) for (const outcome of ['success', 'failure']) {
  test(`older inline enqueue ${outcome} preserves newer ${newer} metadata busy state and status`, async () => {
    const h = createHarness(); await h.fireReady(); await search(h);
    const inline = deferred(); const detail = deferred(); let calls = 0;
    h.api.loadYoutube = () => ++calls === 1 ? inline.promise : detail.promise;
    find(h.elements.get('youtube-search-results').children[0], el => el.dataset.cardAction === 'enqueue').click();
    assert.equal(h.elements.get('load-youtube-btn').disabled, true);
    if (newer === 'social') {
      h.elements.get('provider-social').click(); h.api.loadSocial = () => detail.promise;
      h.elements.get('social-url').value = 'https://www.instagram.com/reel/example/'; h.elements.get('load-social-btn').click();
    } else find(h.elements.get('youtube-search-results').children[1], el => el.dataset.cardAction === 'advanced').click();
    const status = h.elements.get('youtube-status').textContent;
    if (outcome === 'success') inline.resolve(metadata()); else inline.reject(new Error('Old source failed'));
    await h.flush();
    assert.equal(h.elements.get(`load-${newer}-btn`).disabled, true);
    assert.equal(h.elements.get(`${newer === 'social' ? 'social' : 'youtube'}-url`).disabled, true);
    assert.equal(h.elements.get('transfer-console').getAttribute('aria-busy'), 'true');
    assert.equal(h.elements.get('youtube-status').textContent, status);
    detail.resolve(newer === 'social' ? { ...metadata('social-id'), platform: 'instagram', source: 'https://www.instagram.com/reel/example/' } : metadata('bbbbbbbbbbb'));
    await h.flush();
    assert.equal(h.elements.get(`load-${newer}-btn`).disabled, false);
    assert.equal(h.elements.get('transfer-console').getAttribute('aria-busy'), 'false');
  });
}
