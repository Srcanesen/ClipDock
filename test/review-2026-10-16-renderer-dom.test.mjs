import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeDom } from './helpers/fake-dom.mjs';
import { createHarness } from './helpers/renderer-harness.mjs';

const find = (root, predicate) => {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = find(child, predicate);
    if (nested) return nested;
  }
};

test('fake DOM shares class tokens across className, classList and the class attribute', () => {
  const element = createFakeDom().makeElement('div');
  element.className = 'result-options hidden hidden';
  assert.equal(element.classList.contains('hidden'), true);
  assert.equal(element.getAttribute('class'), 'result-options hidden');
  element.classList.remove('hidden');
  element.classList.add('open', 'active');
  assert.equal(element.className, 'result-options open active');
  assert.equal(element.classList.toggle('hidden'), true);
  assert.equal(element.getAttribute('class'), 'result-options open active hidden');
  element.setAttribute('class', 'replacement hidden');
  assert.equal(element.className, 'replacement hidden');
  assert.equal(element.classList.contains('open'), false);
  element.removeAttribute('class');
  assert.equal(element.className, '');
  assert.equal(element.classList.contains('hidden'), false);
  assert.equal(element.getAttribute('class'), null);
});

test('result options disclosure removes and restores its CSS hidden class', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-form').listeners.submit();
  h.searches.at(-1).entry.resolve(h.page); await h.flush();
  const row = h.elements.get('youtube-search-results').children[0];
  const options = find(row, el => el.dataset.field === 'options');
  const toggle = find(row, el => el.dataset.cardAction === 'options');
  assert.equal(options.classList.contains('hidden'), true);
  toggle.click();
  assert.equal(options.classList.contains('hidden'), false);
  assert.equal(options.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.equal(options.classList.contains('hidden'), true);
  assert.equal(options.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});
