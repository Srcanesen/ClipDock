import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

async function boot() {
  const h = createHarness({ eventsOnly: true }); await h.fireReady();
  h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  h.elements.get('youtube-url').listeners.input();
  h.elements.get('load-youtube-btn').click(); await h.flush();
  return h;
}
function choose(h, intent) {
  const trigger = h.elements.get('intent-menu-btn');
  assert.ok(trigger, 'visible handoff caret exists');
  trigger.click();
  const menu = h.elements.get('intent-menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.classList.contains('hidden'), false);
  const item = menu.children.find(child => child.dataset.intent === intent);
  item.click();
  assert.equal(item.getAttribute('aria-checked'), 'true');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(h.activeElement, h.elements.get('download-youtube-btn'));
}

for (const intent of ['import', 'playhead', 'end']) {
  test(`visible handoff menu queues ${intent} and transfers the completed card`, async () => {
    const h = await boot(); choose(h, intent);
    h.elements.get('download-youtube-btn').click(); await h.flush();
    assert.equal(h.downloads.length, 1);
    assert.equal(h.test.queue()[0].intent, intent);
    h.downloads[0].resolve({ cardId: 'downloaded-card', fileName: 'clip.mp4' }); await h.flush();
    assert.deepEqual(h.transfers, [intent === 'import'
      ? { action: 'import', cardId: 'downloaded-card', bin: 'active' }
      : { action: 'timeline', cardId: 'downloaded-card', bin: 'active', placement: intent }]);
  });
}

test('visible Download only overrides the previously chosen Resolve handoff', async () => {
  const h = await boot(); choose(h, 'playhead');
  const downloadOnly = h.elements.get('download-only-btn');
  assert.equal(downloadOnly.classList.contains('hidden'), false);
  assert.equal(downloadOnly.disabled, false);
  downloadOnly.click(); await h.flush();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.test.queue()[0].intent, 'download');
  h.downloads[0].resolve({ cardId: 'downloaded-card', fileName: 'clip.mp4' }); await h.flush();
  assert.deepEqual(h.transfers, []);
  assert.equal(h.test.queue()[0].status, 'completed');
});
