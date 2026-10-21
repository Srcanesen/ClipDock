// UX polish phase 3 — behavior-aware checks for Findings 3, 7, 2.
// Deterministic fake DOM/API harness against built renderer (dist/renderer.js).
// No Electron/Resolve/network. Focused assertions for the three behaviors.
import assert from 'node:assert/strict';
import { createFakeDom } from './helpers/fake-dom.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const renderer = readFileSync(path.join(root, 'dist', 'renderer.js'), 'utf8');
const html = readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'static', 'css', 'styles.css'), 'utf8');

function createHarness() {
  const elements = new Map();
  let activeElement = null;
  const { makeElement } = createFakeDom({ onFocus: (element) => { activeElement = element; }, bounds: { right: 800, bottom: 500, width: 800, height: 500 } });

  const ids = [
    'refresh-btn', 'bridge-state', 'module-version', 'resolve-version', 'project-name', 'timeline-name', 'message', 'refresh-hint', 'last-updated',
    'common-output-summary', 'effective-output-summary',
    'selection-toolbar', 'selection-count', 'selection-status', 'select-all-results-btn', 'clear-selection-btn', 'enqueue-selected-btn',
    'youtube-search-results', 'youtube-search-status', 'youtube-search-input', 'youtube-search-btn', 'youtube-search-prev', 'youtube-search-next',
    'youtube-profile', 'profile-controls', 'youtube-quality', 'quality-chips', 'youtube-media-mode', 'video-controls', 'audio-controls',
    'youtube-audio-format', 'youtube-subtitles', 'youtube-subtitle-language', 'youtube-intent', 'youtube-target-bin',
    'youtube-status', 'youtube-progress', 'youtube-metadata', 'youtube-thumbnail', 'youtube-title', 'youtube-channel', 'youtube-duration', 'metadata-verified', 'pinterest-item-list', 'pinterest-original-note',
    'workspace', 'search-surface', 'inspector-pane', 'back-to-results', 'browser-title',
    'provider-youtube', 'provider-pexels', 'provider-social', 'provider-pinterest', 'pexels-kind-switch', 'stock-source-switch', 'stock-source-pexels', 'stock-source-pixabay', 'stock-credit-lead', 'pixabay-setup', 'pixabay-setup-summary', 'pixabay-connection-status', 'pixabay-api-key', 'pixabay-connect-btn', 'pixabay-disconnect-btn', 'pixabay-key-link', 'pixabay-save-note',
    'youtube-search-form', 'pexels-credit', 'pexels-link', 'youtube-paste-url', 'social-url-panel', 'pinterest-url-panel', 'youtube-url', 'load-youtube-btn', 'social-url', 'load-social-btn', 'pinterest-url', 'load-pinterest-btn',
    'youtube-download-queue', 'youtube-queue-status',
    'common-profile', 'common-quality', 'common-media-mode', 'common-audio-format', 'common-intent', 'common-target-bin', 'common-subtitles', 'common-subtitle-language',
  ];
  for (const id of ids) elements.set(id, makeElement('div', id));
  // select specifics
  for (const id of ['common-profile', 'common-quality', 'common-media-mode', 'common-audio-format', 'common-intent', 'common-target-bin', 'youtube-profile', 'youtube-quality', 'youtube-media-mode', 'youtube-audio-format', 'youtube-intent', 'youtube-target-bin']) elements.get(id).tagName = 'SELECT';
  for (const id of ['clear-selection-btn', 'enqueue-selected-btn', 'select-all-results-btn', 'refresh-btn']) elements.get(id).tagName = 'BUTTON';
  // add bridge-pill element for querySelector
  const bridgePill = makeElement('span', '');
  bridgePill.className = 'bridge-pill';
  elements.set('__bridge-pill', bridgePill);
  // Provide youtube-search-results rect
  elements.get('youtube-search-results').getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 });

  const windowListeners = {};
  const fakeWindow = {
    clipdockAPI: {
      getStatus: async () => ({ phase: 'ready', bridge: { connected: true, moduleVersion: 'test', resolveVersion: 'test', error: null }, project: { loaded: true, name: 'My Project' }, timeline: { loaded: true, name: 'My Timeline' }, message: 'Ready', refreshHint: null }),
      downloadFolderStatus: async () => ({ folder: '/tmp', userSelected: false }),
      chooseDownloadFolder: async () => ({ folder: '/tmp', userSelected: false }),
      onResolveQuit: () => () => undefined,
        searchYoutube: async () => ({ query: '', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }),
      loadYoutube: async () => ({ id: 'aaaaaaaaaaa', title: 'T', duration: 60, channel: 'C', thumbnailDataUrl: null, heights: [1080], formatSummary: [], chapters: [] }),
      downloadYoutube: async () => ({ cardId: 'c', fileName: 'f.mp4' }),
      cancelYoutube: async () => true,
      onYoutubeEvent: () => () => undefined,
      onSocialEvent: () => () => undefined,
      onPexelsEvent: () => () => undefined,
      onPinterestEvent: () => () => undefined,
      setAlwaysOnTop: async (v) => v,
      pexelsKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), pixabayKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), onPixabayEvent: () => () => undefined,
      searchPexels: async () => ({ query: '', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0 }),
      loadPexels: async () => { throw new Error('unused'); },
      downloadPexels: async () => { throw new Error('unused'); },
      cancelPexels: async () => true,
      cancelPexelsRequests: async () => true,
      loadSocial: async () => { throw new Error('unused'); },
      downloadSocial: async () => { throw new Error('unused'); },
      cancelSocial: async () => true,
      loadPinterest: async () => { throw new Error('unused'); },
      searchPinterest: async () => ({ query: '', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }),
      downloadPinterest: async () => { throw new Error('unused'); },
      cancelPinterest: async () => true,
      onYoutubePreviewState: () => () => undefined,
      openYoutubePreview: async () => true,
      closeYoutubePreview: async () => true,
      setYoutubePreviewBounds: async () => true,
      openYoutubeExternal: async () => true,
      openPexelsExternal: async () => true,
      workspaceStatus: async () => ({ fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0 }),
      openWorkspace: async () => true,
      cleanupWorkspace: async () => ({ deletedFileCount: 0, deletedBytes: 0, fileCount: 0, totalBytes: 0 }),
      historyList: async () => [],
      historyReuse: async () => null,
      historyReveal: async () => true,
      historyRevealSubtitle: async () => true,
      historySource: async () => true,
      historyCopy: async () => true,
      historyRelink: async () => null,
      historyDelete: async () => ({ deleted: false, removed: false }),
      queueDelete: async () => ({ deleted: false, message: 'Not deleted.' }),
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Added.' }),
      addToTimeline: async () => ({ ok: true, kind: 'timeline', message: 'Added.' }),
    },
    innerWidth: 960, innerHeight: 720,
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false }),
    addEventListener: (t, cb) => { (windowListeners[t] ??= []).push(cb); },
    removeEventListener: () => undefined,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
  };
  const documentObj = {
    visibilityState: 'visible',
    body: { dataset: {}, classList: { add() {}, remove() {} } },
    get activeElement() { return activeElement; },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: text, tagName: '#TEXT', children: [] }),
    querySelector: (selector) => {
      if (selector === '.bridge-pill') return bridgePill;
      if (selector === '.advanced-options') return makeElement('details');
      if (selector === '.feed-toolbar') return makeElement('div');
      if (selector === '.inspector-thumb') return makeElement('div');
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector !== '#youtube-search-results .result-card-thumbnail.card-thumb') return [];
      const thumbs = [];
      const visit = (el) => { for (const ch of el.children ?? []) { if (/\bresult-card-thumbnail\b/.test(ch.className) && /\bcard-thumb\b/.test(ch.className)) thumbs.push(ch); visit(ch); } };
      visit(elements.get('youtube-search-results'));
      return thumbs;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  const sandbox = {
    window: fakeWindow, document: documentObj, console, Date, Intl, Math, Number, Promise, URL, WeakMap, Set, Map, queueMicrotask,
    crypto: { randomUUID: (() => { let i = 0; return () => `p3-${++i}`; })(), getRandomValues: (v) => v },
    setTimeout, clearTimeout,
  };
  runInNewContext(`${renderer}\nglobalThis.__p3 = {\n  renderEffectiveOutputSummary: () => renderEffectiveOutputSummary(),\n  renderSelectionToolbar: () => renderSelectionToolbar(),\n  commitCardOutput: (k,v) => outputSession.edit(k,v),\n  cardEffectiveOutput: (k) => outputSession.output(k),\n  setSelectedDetailKey: (k) => { outputSession.select(k ? { key: k, resultId: k.split(':').at(-1), thumbnailDataUrl: null } : null); },\n  getSelectedDetailKey: () => outputSession.selected?.key ?? null,\n  session: outputSession,\n  setProvider: (v) => setProvider(v),\n  refresh: () => refresh(),\n  // expose bridge pill for inspection\n  bridgePill: () => document.querySelector('.bridge-pill'),\n};`, sandbox);
  const p3 = sandbox.__p3;
  const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { elements, bridgePill, p3, flush, fakeWindow, documentObj };
}

// ---- Finding 3: effective-output-summary gated on overrides ----
test('Finding 3: effective summary hidden while overrides empty, shown when any override exists, reverts on clear', async () => {
  const h = createHarness();
  const summary = h.elements.get('effective-output-summary');
  // Initially no selection => hidden with Using common defaults
  h.p3.renderEffectiveOutputSummary();
  assert.equal(summary.hidden, true, 'hidden when no selected detail');
  assert.equal(summary.getAttribute('aria-hidden'), 'true');
  assert.match(summary.textContent, /Using common defaults/);
  assert.ok(summary.classList.contains('hidden'), 'has hidden class when no selection');

  // Select a detail with no overrides => still hidden (duplicate gate)
  const key = 'youtube:aaaaaaaaaaa';
  h.p3.setSelectedDetailKey(key);
  // Ensure overrides empty: cardStateFor defaults to empty overrides
  h.p3.renderEffectiveOutputSummary();
  assert.equal(summary.hidden, true, 'hidden when overrides empty');
  assert.match(summary.textContent, /Using common defaults/);

  // Add an override => should become visible with override count and effective values
  h.p3.commitCardOutput(key, { profile: 'editing', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null });
  h.p3.renderEffectiveOutputSummary();
  assert.equal(summary.hidden, false, 'visible when overrides exist');
  assert.equal(summary.getAttribute('aria-hidden'), 'false');
  assert.ok(!summary.classList.contains('hidden'));
  assert.match(summary.textContent, /1 item override/);
  // should contain effective summary (profile label Fast/Edit-ready etc)
  assert.match(summary.textContent, /Edit-ready|Original|Best/);

  // Clear overrides (simulate clearing via remembering common defaults)
  // Use commit with common defaults snapshot (no diff)
  h.p3.commitCardOutput(key, { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null });
  h.p3.renderEffectiveOutputSummary();
  assert.equal(summary.hidden, true, 'reverts to hidden after overrides cleared');
  assert.match(summary.textContent, /Using common defaults/);

  // Instant swap on override change: set again and check immediately
  h.p3.commitCardOutput(key, { profile: 'fast', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'import', targetBin: 'clipdock', subtitles: false, subtitleLanguage: 'en', selection: null });
  h.p3.renderEffectiveOutputSummary();
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /Fast|ClipDock|Media Pool/);
});

test('Finding 3: effective summary instant swap via selection toolbar integration', async () => {
  const h = createHarness();
  const summary = h.elements.get('effective-output-summary');
  const key = 'youtube:bbbbbbbbbbb';
  h.p3.setSelectedDetailKey(key);
  h.p3.renderSelectionToolbar(); // should delegate to renderEffectiveOutputSummary
  assert.equal(summary.hidden, true);
  h.p3.commitCardOutput(key, { profile: 'editing', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null });
  h.p3.renderSelectionToolbar();
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /1 item override/);
});

// ---- Finding 7: selection toolbar collapses at zero ----
test('Finding 7: at zero selections Clear is hidden and Enqueue is visible-disabled; Select all remains', () => {
  const h = createHarness();
  const toolbar = h.elements.get('selection-toolbar');
  const countEl = h.elements.get('selection-count');
  const clear = h.elements.get('clear-selection-btn');
  const enqueue = h.elements.get('enqueue-selected-btn');
  const selectAll = h.elements.get('select-all-results-btn');

  // ensure staged is empty
  h.p3.session.unstage();
  h.p3.renderSelectionToolbar();

  assert.equal(toolbar.getAttribute('data-has-selection'), 'false');
  assert.equal(toolbar.classList.contains('has-selection'), false);
  // Count remains visible but muted (not hidden)
  assert.equal(countEl.textContent, '0 selected');
  assert.equal(countEl.hidden, false);
  assert.equal(countEl.classList.contains('hidden'), false);

  // Clear remains hidden at zero; Enqueue stays visible but disabled per redesign acceptance C
  assert.equal(clear.hidden, true, 'Clear hidden at zero');
  assert.equal(clear.classList.contains('hidden'), true);
  assert.equal(clear.getAttribute('aria-hidden'), 'true');
  assert.equal(clear.disabled, true);
  assert.equal(enqueue.hidden, false, 'Enqueue visible at zero');
  assert.equal(enqueue.classList.contains('hidden'), false);
  assert.equal(enqueue.getAttribute('aria-hidden'), 'false');
  assert.equal(enqueue.disabled, true);
  assert.equal(enqueue.getAttribute('aria-disabled'), 'true');
  assert.match(enqueue.textContent, /Enqueue selected/);

  // Select all remains reachable (not hidden)
  assert.equal(selectAll.hidden, false);
  assert.equal(selectAll.classList.contains('hidden'), false);
});

test('Finding 7: when staged count >0 count chip appears with sage intent and Clear/Enqueue reappear', () => {
  const h = createHarness();
  const toolbar = h.elements.get('selection-toolbar');
  const clear = h.elements.get('clear-selection-btn');
  const enqueue = h.elements.get('enqueue-selected-btn');
  const countEl = h.elements.get('selection-count');

  h.p3.session.stage('youtube:aaaaaaaaaaa', {
    key: 'youtube:aaaaaaaaaaa', provider: 'youtube', resultId: 'aaaaaaaaaaa', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    title: 'A', channel: null, thumbnailDataUrl: null,
    snapshot: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null },
    overrides: {},
  });
  h.p3.renderSelectionToolbar();

  assert.equal(toolbar.getAttribute('data-has-selection'), 'true');
  assert.equal(toolbar.classList.contains('has-selection'), true);
  assert.equal(countEl.textContent, '1 selected');
  // Count chip should be visible; sage chip is via CSS :has, but harness checks not hidden
  assert.equal(countEl.hidden, false);

  assert.equal(clear.hidden, false, 'Clear visible when >0');
  assert.equal(clear.classList.contains('hidden'), false);
  assert.equal(clear.getAttribute('aria-hidden'), 'false');
  assert.equal(clear.disabled, false);

  assert.equal(enqueue.hidden, false, 'Enqueue visible when >0');
  assert.equal(enqueue.classList.contains('hidden'), false);
  assert.equal(enqueue.textContent, 'Enqueue selected (1)');
  assert.equal(enqueue.disabled, false);

  // Adding second increases count text
  h.p3.session.stage('youtube:bbbbbbbbbbb', {
    key: 'youtube:bbbbbbbbbbb', provider: 'youtube', resultId: 'bbbbbbbbbbb', source: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    title: 'B', channel: null, thumbnailDataUrl: null,
    snapshot: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null },
    overrides: {},
  });
  h.p3.renderSelectionToolbar();
  assert.equal(countEl.textContent, '2 selected');
  assert.equal(enqueue.textContent, 'Enqueue selected (2)');

  // Clearing returns to collapsed state but Enqueue stays visible disabled
  h.p3.session.unstage();
  h.p3.renderSelectionToolbar();
  assert.equal(clear.hidden, true);
  assert.equal(enqueue.hidden, false);
  assert.equal(enqueue.disabled, true);
  assert.equal(enqueue.getAttribute('aria-disabled'), 'true');
  assert.equal(toolbar.getAttribute('data-has-selection'), 'false');
});

// ---- Finding 2: bridge compact pill at narrow ----
test('Finding 2: HTML keeps bridge ids and wraps project/timeline in pill with dot', () => {
  assert.ok(html.includes('id="bridge-state"'), 'keeps #bridge-state');
  assert.ok(html.includes('id="project-name"'), 'keeps #project-name');
  assert.ok(html.includes('id="timeline-name"'), 'keeps #timeline-name');
  assert.ok(html.includes('class="bridge-pill"'), 'bridge pill wrapper present');
  assert.ok(html.includes('class="bridge-dot"') || html.includes('bridge-dot'), 'dot indicator present');
  assert.ok(html.includes('class="bridge-sep"'), 'sep for pill present');
  // Must not expose absolute paths - ensure no path-like content in template, only names
  // Check that static/index.html placeholder does not contain slash paths besides placeholder text
  assert.ok(!/\/Users\//.test(html), 'no absolute system paths leaked');
  assert.ok(!html.includes('file://'), 'no file paths leaked');
});

// Lab header: the host pill is one rounded capsule whose project/timeline names truncate
// instead of pushing the header. (Replaces the old <=650px Variant D pill block.)
test('Finding 2: host pill truncates project and timeline names and adds no motion', () => {
  assert.match(css, /\.bridge-summary\s*\{[^}]*min-width:\s*0[^}]*max-width:/, 'pill is bounded');
  assert.match(css, /\.bridge-pill\s*\{[^}]*overflow:\s*hidden/, 'names clip inside the pill');
  assert.match(css, /#project-name\s*\{[^}]*text-overflow:\s*ellipsis/, 'project name ellipsizes');
  assert.match(css, /#timeline-name\s*\{[^}]*text-overflow:\s*ellipsis/, 'timeline name ellipsizes');
  assert.match(css, /\.bridge-dot\s*\{[^}]*width:\s*8px/, 'dot has fixed size');
  assert.match(css, /\.bridge-dot\.ok/, 'dot reflects connected state');
  assert.doesNotMatch(css.match(/\.bridge-pill\s*\{[^}]*\}/)?.[0] ?? '', /transition:/, 'pill has no motion transition');
  assert.ok(!/\/Users\//.test(css), 'no path leak in CSS');
});

test('Finding 2: CSS hides old divider and keeps pill accessible', () => {
  assert.ok(css.includes('.bridge-sep'), 'bridge-sep style exists');
  // The text separator stays in the DOM for the accessible name; the pill draws its own.
  assert.match(css, /\.bridge-sep\s*\{\s*display:\s*none/, 'text separator hidden');
  assert.match(css, /#timeline-name::before\s*\{[^}]*content:\s*"\/"/, 'pill draws the project / timeline divider');
});

test('Finding 2: renderer syncs dot aria-label and pill title without exposing paths', async () => {
  const h = createHarness();
  // Simulate refresh with project/timeline names (not paths)
  const status = {
    phase: 'ready',
    bridge: { connected: true, moduleVersion: '1', resolveVersion: '1', error: null },
    project: { loaded: true, name: 'My Project' },
    timeline: { loaded: true, name: 'My Timeline' },
    message: 'Ready', refreshHint: null,
  };
  // Directly call the logic that refresh would: set texts and aria
  const bridgeState = h.elements.get('bridge-state');
  const projectName = h.elements.get('project-name');
  const timelineName = h.elements.get('timeline-name');
  // Simulate setText via renderer refresh: we invoke refresh path via p3.refresh which uses getStatus stub
  // Our stub getStatus returns My Project / My Timeline already, but ensure harness elements start empty
  await h.p3.refresh();
  // Wait microtasks for getStatus promise
  await h.flush();
  // Now pill should have aria-label and title combining names
  const pill = h.bridgePill;
  assert.equal(pill.getAttribute('aria-label'), 'My Project - My Timeline');
  assert.equal(pill.getAttribute('title'), 'My Project - My Timeline');
  assert.equal(bridgeState.getAttribute('aria-label'), 'Connected');
  assert.equal(bridgeState.getAttribute('title'), 'Connected');
  // Ensure no absolute path leaked into pill title
  assert.ok(!pill.getAttribute('title').includes('/'), 'pill title contains names only, no path slashes beyond separator');
  assert.ok(!pill.getAttribute('title').includes('\\'), 'no windows path');
});

test('Redesign: provider buttons keep pressed state, enqueue stays present, empty state is CSS-driven', () => {
  assert.ok(html.includes('id="provider-youtube"') && html.includes('aria-pressed="true"'), 'provider buttons retain aria-pressed');
  assert.match(css, /\.provider-switch button\[aria-pressed="true"\]\s*\{[^}]*background:/, 'selected provider has a filled state, not color text alone');
  assert.ok(html.includes('id="enqueue-selected-btn"'), 'enqueue button exists');
  assert.ok(html.includes('id="search-empty-state"'), 'empty state element present');
  assert.ok(html.includes('class="search-empty-state"'), 'empty state class present');
  assert.match(css, /#youtube-search-results:empty\s*\+\s*\.search-empty-state\s*\{[^}]*display:\s*grid/, 'empty state shows via :empty sibling');
  assert.match(css, /#youtube-search-results:not\(:empty\)\s*\+\s*\.search-empty-state\s*\{[^}]*display:\s*none/, 'empty state hides when results present');
  assert.match(css, /#feed-pane\[data-search-state="loading"\][^{]*\.search-empty-state[^{]*\{[^}]*display:\s*none/, 'loading never shows the empty copy');
});

test('ClipDock feed collapse fix: the contact sheet owns scrolling and cannot collapse', () => {
  assert.match(css, /\.feed-pane\s*\{[^}]*min-height:\s*0/, 'feed pane may shrink inside the grid row');
  assert.match(css, /\.sheet-scroll\s*\{[^}]*overflow:\s*auto/, 'sheet scrolls instead of clipping');
  assert.match(css, /\.feed-pane > \.sheet-scroll\s*\{[^}]*flex:\s*1 1 auto/, 'sheet takes the remaining height');
});

test('Staged selection bar keeps its status on one visible line (audit bug 2)', () => {
  assert.match(css, /\.selection-status\s*\{[^}]*white-space:\s*nowrap/, 'status single-line nowrap');
  assert.match(css, /\.selection-status\s*\{[^}]*overflow:\s*hidden/, 'status overflow hidden');
  assert.match(css, /\.selection-status\s*\{[^}]*text-overflow:\s*ellipsis/, 'status ellipsis');
  assert.doesNotMatch(css, /\.selection-status\s*\{[^}]*display:\s*none/, 'status never display:none');
  assert.match(css, /\.selection-toolbar\s*\{[^}]*flex-wrap:\s*wrap/, 'bar wraps instead of stacking a blank column');
});

test('Results toolbar wraps its controls instead of overflowing a 320px feed column', () => {
  assert.match(css, /\.feed-toolbar\s*\{[^}]*flex-wrap:\s*wrap/, 'toolbar controls wrap');
  assert.match(css, /\.feed-toolbar \.edgecode\s*\{[^}]*flex:\s*1 1 0/, 'status absorbs free space without forcing a wrap');
});

test('Responsive cascade: one fluid contact sheet; detail beside it at 760px and over it below', () => {
  assert.match(css, /#youtube-search-results\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(176px,\s*1fr\)\)/, 'results are a fluid grid at every width');
  assert.doesNotMatch(css, /#youtube-search-results\s*\{[^}]*display:\s*block/, 'results never fall back to block');
  assert.match(css, /@media\s*\(min-width:\s*760px\)\s*\{[\s\S]*?\.workspace\.inspector-open\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--detail-w\)/, 'detail sits beside the sheet at 760px+');
  assert.match(css, /@media\s*\(max-width:\s*759px\)\s*\{[\s\S]*?\.inspector-pane\s*\{[^}]*position:\s*absolute;\s*inset:\s*0/, 'detail covers the sheet below 760px');
});
