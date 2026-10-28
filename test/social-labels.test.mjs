import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

test('Social source names supported sites and uses the same label in metadata and History', async () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="provider-social"[^>]*>Social<\/button>/);
  assert.match(html, /id="social-url"[^>]*placeholder="Paste an Instagram, X or Facebook link"/);
  const h = createHarness();
  h.api.historyList = async () => [{ id: 'social', provider: 'social', title: 'A social clip', fileName: 'clip.mp4', bytes: 1, createdAt: 1, available: true }];
  await h.fireReady();
  h.elements.get('provider-social').click();
  assert.equal(h.elements.get('metadata-verified').textContent, 'Social');
  h.test.setSurface('library'); await h.flush();
  const texts = [];
  const visit = node => { texts.push(node.textContent); for (const child of node.children ?? []) visit(child); };
  visit(h.elements.get('history-list'));
  assert.ok(texts.some(text => text?.includes('Social')));
  assert.equal(texts.some(text => text?.includes('Social media') || text?.includes('Paste link')), false);
});
