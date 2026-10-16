import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

const renderer = readFileSync(new URL('../dist/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');

// Execute the built renderer with the same DOM-free VM seam as renderer-followups.
function harness() {
  const makeElement = (tag = 'div') => {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), value: '', checked: false, disabled: false,
      textContent: '', dataset: {}, style: { setProperty() {} }, children: [], attributes: {},
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      get options() { return this.children; },
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k] ?? null; }, removeAttribute(k) { delete this.attributes[k]; },
      addEventListener() {}, focus() {}, querySelector() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    };
  };
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

for (const [start, end, duration] of [[1.01, 1.04, 60], [10.01, 59.99, 60], [0, 60.06, 60.06]]) {
  test(`reopening a saved ${start}–${end} second trim preserves its exact download bounds`, async () => {
    const h = harness();
    h.context.window.clipdockAPI.loadYoutube = async () => ({ id: 'abcdefghijk', title: 'Clip', duration, channel: null, thumbnailUrl: null, heights: [1080], chapters: [] });
    const downloads = [];
    h.context.window.clipdockAPI.downloadYoutube = (...args) => { downloads.push(args); return new Promise(() => {}); };
    h.context.bounds = { start: String(start), end: String(end) };
    h.run(`
      outputSession.select({ key: 'youtube:abcdefghijk', resultId: 'abcdefghijk', thumbnailUrl: null });
      outputSession.edit('inspector', { selectionPlan: { source: 'abcdefghijk', mode: 'manual', ...bounds, indices: [], ranges: [] } });
      outputSession.stage('youtube:abcdefghijk', { provider: 'youtube', resultId: 'abcdefghijk', source: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Clip', channel: null, thumbnailDataUrl: null });
    `);
    await h.run(`loadYoutube('https://www.youtube.com/watch?v=abcdefghijk')`);
    h.run(`enqueue('download')`);
    assert.equal(downloads.length, 1, 'a valid saved trim must still start a download after reopening');
    const selection = downloads[0][4].selection;
    assert.equal(selection.start, start, 'formatting the In control must not change the download boundary');
    assert.equal(selection.end, end, 'formatting the Out control must not change the download boundary');
  });
}
