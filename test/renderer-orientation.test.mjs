import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const submit = h => h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
const orient = h => h.elements.get('orientation-filter').listeners.click({ target: { closest: () => h.elements.get('orientation-vertical') }, preventDefault() {} });
const pin = { pinId: '123456789', source: 'https://www.pinterest.com/pin/123456789/', title: 'Pin', creator: 'Creator', kind: 'video', thumbnailUrl: null,
  items: [{ index: 1, kind: 'video', title: 'Pin', creator: 'Creator', extension: 'mp4' }] };

for (const [provider, url] of [
  ['youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
  ['youtube', 'https://youtu.be/aaaaaaaaaaa'],
  ['pinterest', pin.source],
  ['pinterest', 'https://pin.it/abc123'],
]) {
  test(`orientation preserves the loaded direct URL: ${url}`, async () => {
    const h = createHarness();
    const loads = [], searches = [];
    h.api.loadPinterest = async source => { loads.push(source); return pin; };
    h.api.searchPinterest = async (...args) => { searches.push(args); return { ...h.page, results: [] }; };
    await h.fireReady();
    h.elements.get(`provider-${provider}`).click();
    h.elements.get('youtube-search-input').value = url;
    submit(h); await h.flush();
    assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'false');
    assert.equal(h.elements.get('youtube-title').textContent, provider === 'youtube' ? 'A metadata' : 'Pin');
    if (provider === 'youtube') {
      h.elements.get('quality-chips').children.find(chip => chip.dataset.quality === '1080p').click();
      h.elements.get('youtube-subtitles').checked = true;
      h.elements.get('youtube-subtitles').listeners.change();
      h.elements.get('youtube-subtitle-language').value = 'tr';
      h.elements.get('youtube-subtitle-language').listeners.change();
    }
    const chips = [...h.elements.get('quality-chips').children];
    const results = [...h.elements.get('youtube-search-results').children];
    const closeCount = h.previewCalls.close;
    orient(h); await h.flush();
    assert.equal(h.test.orientation(), 'vertical');
    assert.equal(h.elements.get('orientation-vertical').getAttribute('aria-pressed'), 'true');
    assert.equal(h.elements.get('orientation-all').getAttribute('aria-pressed'), 'false');
    assert.equal(h.metadataCalls.length + loads.length, 1, 'orientation must not reload metadata');
    assert.equal(h.searches.length + searches.length, 0, 'direct URLs must not search');
    assert.equal(h.previewCalls.close, closeCount, 'orientation must not start a search transition');
    assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'false');
    assert.equal(h.elements.get('youtube-metadata').classList.contains('hidden'), false);
    assert.deepEqual(h.elements.get('youtube-search-results').children, results, 'results are not reset');
    assert.deepEqual(h.elements.get('quality-chips').children, chips, 'quality controls are not rebuilt');
    if (provider === 'youtube') {
      assert.equal(h.elements.get('youtube-quality').value, '1080p');
      assert.equal(h.elements.get('youtube-subtitles').checked, true);
      assert.equal(h.elements.get('youtube-subtitle-language').value, 'tr');
      h.elements.get('download-youtube-btn').click(); await h.flush();
      assert.equal(h.downloads[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
      assert.equal(h.downloads[0].quality, '1080p');
      assert.equal(h.downloads[0].options.subtitles, true);
      assert.equal(h.downloads[0].options.subtitleLanguage, 'tr');
    }
  });
}

for (const provider of ['youtube', 'pinterest']) {
  test(`${provider} keyword orientation still resets detail and submits with the new orientation`, async () => {
    const h = createHarness();
    const searches = [];
    h.api.loadPinterest = async () => pin;
    h.api.searchPinterest = async (...args) => { searches.push(args); return { ...h.page, results: [] }; };
    h.api.searchYoutube = async (...args) => { searches.push(args); return h.page; };
    await h.fireReady();
    h.elements.get(`provider-${provider}`).click();
    h.elements.get('youtube-search-input').value = provider === 'youtube' ? 'https://youtu.be/aaaaaaaaaaa' : pin.source;
    submit(h); await h.flush();
    h.elements.get('youtube-search-input').value = 'shots';
    orient(h); await h.flush();
    assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'true');
    assert.equal(searches.length, 1);
    assert.equal(searches[0][0], 'shots');
    assert.equal(searches[0][1], 1);
    assert.equal(searches[0].at(-1).orientation, 'vertical');
  });
}
