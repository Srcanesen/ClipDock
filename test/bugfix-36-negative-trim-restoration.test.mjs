import assert from 'node:assert/strict';
import { createFakeDom } from './helpers/fake-dom.mjs';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

const renderer = readFileSync(new URL('../dist/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');

// Execute the built renderer with the same DOM-free VM seam as renderer-followups.
function harness() {
  const { makeElement } = createFakeDom({ bounds: { right: 800, bottom: 600, width: 800, height: 600 } });
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, makeElement()]));
  elements.get('profile-controls').parentElement = makeElement();
  const context = createContext({
    console, URL, queueMicrotask, crypto: { randomUUID: () => 'regression-id' },
    window: {
      innerWidth: 800, innerHeight: 600, addEventListener() {},
      localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
      setTimeout: () => 1, clearTimeout() {},
      clipdockAPI: { closeYoutubePreview: async () => true, cancelPexelsRequests: async () => true },
    },
    document: {
      body: makeElement(), getElementById: id => elements.get(id) ?? null,
      createElement: makeElement, createTextNode: text => ({ textContent: text }),
      querySelector: () => null,
    },
  });
  runInContext(renderer, context);
  return { run: code => runInContext(code, context), el: id => elements.get(id), context };
}

test('reopening a staged negative trim keeps it invalid and prevents a full download', async () => {
  const h = harness();
  h.context.window.clipdockAPI.loadYoutube = async () => ({ id: 'abcdefghijk', title: 'Clip', duration: 60, channel: null, thumbnailUrl: null, heights: [1080], chapters: [] });
  const downloads = [];
  h.context.window.clipdockAPI.downloadYoutube = (...args) => { downloads.push(args); return new Promise(() => {}); };
  h.run(`
    outputSession.select({ key: 'youtube:abcdefghijk', resultId: 'abcdefghijk', thumbnailUrl: null });
    outputSession.edit('inspector', { selectionPlan: { source: 'abcdefghijk', mode: 'manual', start: '-2', end: '-1', indices: [], ranges: [] } });
    outputSession.stage('youtube:abcdefghijk', { provider: 'youtube', resultId: 'abcdefghijk', source: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Clip', channel: null, thumbnailDataUrl: null });
  `);
  await h.run(`loadYoutube('https://www.youtube.com/watch?v=abcdefghijk')`);
  h.run(`enqueue('download')`);
  assert.equal(downloads.length, 0, 'an invalid saved trim must not start a full-video download');
  assert.equal(h.run('queue.length'), 0);
  assert.equal(h.el('range-in').value, '-2');
  assert.equal(h.el('range-out').value, '-1');
  assert.equal(h.el('youtube-status').textContent, 'In/Out must be a valid range within the source duration.');
});
