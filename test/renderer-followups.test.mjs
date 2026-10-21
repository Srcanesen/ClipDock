// Renderer follow-ups — deterministic fake DOM/API checks against the BUILT
// renderer (dist/renderer.js). No Electron, no Resolve. Covers the Wave-1
// renderer follow-ups that do not belong in the status-refresh contract file:
//   - Audio mode hides the video output-profile control.
//   - Returning to video mode restores the prior visible video profile.
//   - History subtitle companions expose a Reveal subtitle action ONLY while the
//     companion is available, and the action dispatches to historyRevealSubtitle.
import assert from 'node:assert/strict';
import { createFakeDom } from './helpers/fake-dom.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const renderer = readFileSync(path.join(root, 'dist', 'renderer.js'), 'utf8');

// Element ids touched by renderMediaMode / renderProfile / renderQueue /
// updateControls / showYoutubeStatus / renderHistory / historyAction. Kept to the
// exact minimum so a missing element fails loudly.
const ELEMENT_IDS = [
  'refresh-btn', 'message',
  'youtube-media-mode', 'youtube-audio-format', 'youtube-profile', 'profile-controls',
  'quality-chips', 'youtube-quality', 'video-controls', 'audio-controls',
  'youtube-subtitles', 'youtube-subtitle-language', 'youtube-placement', 'youtube-target-bin',
  'youtube-search-input', 'youtube-search-btn', 'youtube-search-prev', 'youtube-search-next',
  'youtube-search-results', 'youtube-search-status', 'load-youtube-btn', 'youtube-url',
  'social-url', 'pinterest-url', 'pexels-api-key', 'download-youtube-btn', 'preview-selected-btn',
  'source-monitor', 'preview-note', 'youtube-download-queue', 'youtube-queue-status',
  'youtube-status', 'youtube-progress', 'youtube-metadata', 'youtube-thumbnail', 'youtube-title',
  'youtube-channel', 'youtube-duration', 'metadata-verified', 'pexels-attribution',
  'pinterest-item-list', 'pinterest-original-note', 'range-in', 'range-out', 'chapter-list', 'subtitle-results',
  'history-empty-state', 'history-provider-chips', 'history-availability-chips', 'history-list', 'history-status', 'history-show-more', 'history-search-input',
  'history-provider-filter', 'history-availability-filter', 'history-refresh-btn',
  // Pinterest search surface: shared search form/pager plus provider-switch chrome.
  // Phase 2: provider hint removed — single live status line (youtube-search-status) carries provider context
  'youtube-search-form', 'pexels-credit',
  'provider-youtube', 'provider-pexels', 'provider-social', 'provider-pinterest',
  'pexels-kind-switch', 'stock-source-switch', 'stock-source-pexels', 'stock-source-pixabay', 'stock-credit-lead', 'pixabay-setup', 'pixabay-setup-summary', 'pixabay-connection-status', 'pixabay-api-key', 'pixabay-connect-btn', 'pixabay-disconnect-btn', 'pixabay-key-link', 'pixabay-save-note', 'youtube-paste-url', 'social-url-panel', 'pinterest-url-panel',
  'youtube-mode-controls', 'youtube-subtitle-controls', 'youtube-selection-controls',
  'inspector-loading', 'inspector-empty',
  // Inspector chrome: the detail rail, its backdrop workspace, and the Back control.
  'search-surface', 'workspace', 'workspace-splitter', 'inspector-pane', 'back-to-results',
  'pexels-preview-overlay', 'pexels-preview-video',
];

const YOUTUBE = {
  id: 'dQw4w9WgXcQ', title: 'Clip', duration: 60, channel: 'Channel',
  thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: [],
};

function historyRecord(overrides = {}) {
  return {
    id: 'r1', provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    project: 'Alpha', fileName: 'clip.mp4', bytes: 1_024_000, assetId: null,
    title: 'Clip', creator: 'Channel', profile: 'original', quality: '1080p',
    mediaMode: 'video', selection: null,
    automation: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: [] },
    createdAt: 1, lastUsedAt: 1, available: true, cardId: 'c1',
    subtitle: { fileName: 'clip.en.srt', bytes: 4096, available: true },
    ...overrides,
  };
}

function createHarness() {
  const elements = new Map();
  const { makeElement } = createFakeDom({ bounds: { right: 0, bottom: 0, width: 0, height: 0 } });
  for (const id of ELEMENT_IDS) elements.set(id, makeElement(id));
  Object.defineProperty(elements.get('youtube-quality'), 'options', { get() { return this.children; } });
  elements.get('profile-controls').parentElement = makeElement('profile-output');

  let nextTimerId = 1;
  const timers = new Map();
  const windowListeners = new Map();
  const preferenceWrites = [];
  const fakeWindow = {
    innerWidth: 800, innerHeight: 600,
    localStorage: { getItem: () => null, setItem: (...args) => preferenceWrites.push(args) },
    matchMedia: () => ({ matches: false }),
    addEventListener: (event, fn) => { const handlers = windowListeners.get(event) ?? []; handlers.push(fn); windowListeners.set(event, handlers); },
    removeEventListener: () => undefined,
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.set(id, {fn, ms}); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  const documentObj = {
    visibilityState: 'visible',
    body: { dataset: {} },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  const previewOpens = [];
  const previewBounds = [];
  elements.get('pexels-preview-video').play = async () => {};
  elements.get('pexels-preview-video').pause = () => {};
  elements.get('pexels-preview-video').load = () => {};
  const revealSubtitleCalls = [];
  const revealCalls = [];
  const nativeDragCalls = [];
  const youtubeDownloads = [];
  const youtubeSearches = [];
  const youtubeLoads = [];
  const pexelsSearches = [];
  const pexelsLoads = [];
  const pinterestDownloads = [];
  const pinterestSearches = [];
  const pinterestLoads = [];
  fakeWindow.clipdockAPI = {
    historyList: async () => [],
    startNativeDrag: (cardIds) => { nativeDragCalls.push(cardIds); },
    historyRevealSubtitle: async (id) => { revealSubtitleCalls.push(id); return true; },
    historyReveal: async (id) => { revealCalls.push(id); return true; },
    // Controllable YouTube download: tests resolve to drive queue rendering.
    downloadYoutube: (url, quality, profile, jobId, options) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); youtubeDownloads.push({ url, quality, profile, jobId, options, resolve, reject, promise }); return promise; },
    // Controllable YouTube search/load: tests resolve/reject to drive renderer flow.
    searchYoutube: (query, page) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); youtubeSearches.push({query, page, resolve, reject, promise}); return promise; },
    loadYoutube: (url) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); youtubeLoads.push({url, resolve, reject, promise}); return promise; },
    // Controllable Pexels search/load: tests resolve/reject to drive renderer flow.
    searchPexels: (kind, query, page) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pexelsSearches.push({kind, query, page, resolve, reject, promise}); return promise; },
    loadPexels: (kind, id) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pexelsLoads.push({kind, id, resolve, reject, promise}); return promise; },
    downloadPinterest: (url, itemIndex, profile, jobId) => new Promise((resolve, reject) => pinterestDownloads.push({url, itemIndex, profile, jobId, resolve, reject})),
    // Controllable Pinterest search/load: tests resolve/reject to drive renderer flow.
    searchPinterest: (query, page) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pinterestSearches.push({query, page, resolve, reject, promise}); return promise; },
    loadPinterest: (url) => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pinterestLoads.push({url, resolve, reject, promise}); return promise; },
    openYoutubePreview: async (...args) => { previewOpens.push(args); return true; },
    closeYoutubePreview: async () => true,
    setYoutubePreviewBounds: async (bounds) => { previewBounds.push(bounds); return true; },
    openYoutubeExternal: async () => true,
    onYoutubePreviewState: () => () => undefined,
    onYoutubeEvent: () => () => undefined,
    onSocialEvent: () => () => undefined,
    onPexelsEvent: () => () => undefined,
    onPinterestEvent: () => () => undefined,
    onResolveQuit: () => () => undefined,
  };

  const sandbox = {
    window: fakeWindow,
    document: documentObj,
    console, Date, Intl, Math, Number, Promise, URL, WeakMap, Set, Map, queueMicrotask,
    crypto: { randomUUID: () => `followup-${Math.random()}`, getRandomValues: () => new Uint8Array(0) },
    timers,
  };
  runInNewContext(`${renderer}\nglobalThis.__followupTest = {
  setYoutube: (value) => { youtube = value; },
  setPinterest: (value) => { provider = 'pinterest'; pinterest = value; },
  setHostStatus: (value) => { hostStatus = value; },
  setHistoryRecords: (records) => { historyRecords = records; },
  setQueue: (items) => { queue.splice(0, queue.length, ...items); },
  wirePreviewControls: () => wirePreviewControls(),
  setInspectorOpen, setSurface, handleYoutubePreviewState,
  getPreviewTarget: () => previewSession.target,
  setDetailWidth: (width) => { detailWidthPx = width; applySplits(); },
  getDetailWidth: () => detailWidthPx,
  renderMediaMode,
  renderQueue,
  renderHistory, refreshHistory, wireHistoryControls,
  renderPinterestMetadata,
  loadYoutube,
  applyDetailOutput: (value) => { outputSession.edit('inspector', value); applyDetailOutput(); },
  detailOutputFromControls: detailOutput,
  selectManualRange: () => selectManualRange(),
  enqueue,
  historyAction,
  queue: () => queue,
  setProvider: (value) => setProvider(value),
  searchYoutube: (page) => searchYoutube(page),
  searchPexels: (page) => searchPexels(page),
  searchPinterest: (page) => searchPinterest(page),
  searchPageRelative: (delta) => searchPageRelative(delta),
  submitSourceSearch: () => submitSourceSearch(),
  pinterestUrlFromSearch: (input) => pinterestUrlFromSearch(input),
  loadPinterest: (url, poster) => loadPinterest(url, poster),
  getPinterestSearch: () => pinterestSearch,
  getPinterest: () => pinterest,
  getYoutubeSearch: () => searchPage,
  getYoutube: () => youtube,
  getPexelsSearch: () => pexelsSearch,
  getPexels: () => pexels,
  getSelectedDetailKey: () => outputSession.selected?.key ?? null,
  getInspectorOpen: () => inspectorOpen,
  setPexelsConnected: (value) => { stockConnected.pexels = value; },
  getSelectedSearchId: () => outputSession.selected?.resultId ?? null,
  getSelectedThumbnailDataUrl: () => outputSession.selected?.thumbnailDataUrl ?? null,
  getPreviewStopTimer: () => previewStopTimer,
  getPreviewActive: () => previewSession.youtubeActive,
  schedulePreviewStop: () => schedulePreviewStop(),
  startPreview: (id) => startYoutubePreview(id),
  clearPreview: () => clearPreviewState(),
  enqueueResultCard: (key, sel, mode) => enqueueResultCard(key, sel, mode),
  getStaged: (key) => outputSession.staged.get(key),
  setStaged: (key, v) => (outputSession.edit('defaults', v.snapshot), outputSession.stage(key, v), outputSession.edit(key, v.overrides)),
  getCommonDefaults: () => outputSession.defaults,
  setCommonDefaults: (v) => outputSession.edit('defaults', v),
  getTimers: () => timers,
};`, sandbox);
  const followupTest = sandbox.__followupTest;

  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

  return {
    el: (id) => elements.get(id),
    profileOutput: () => elements.get('profile-controls').parentElement,
    flush,
    setYoutube: (value) => followupTest.setYoutube(value),
    setPinterest: (value) => followupTest.setPinterest(value),
    setHostStatus: (value) => followupTest.setHostStatus(value),
    setHistoryRecords: (records) => followupTest.setHistoryRecords(records),
    setQueue: (items) => followupTest.setQueue(items),
    renderMediaMode: () => followupTest.renderMediaMode(),
    renderQueue: () => followupTest.renderQueue(),
    renderHistory: () => followupTest.renderHistory(),
    refreshHistory: () => followupTest.refreshHistory(),
    wireHistoryControls: () => followupTest.wireHistoryControls(),
    api: fakeWindow.clipdockAPI, makeElement,
    previewOpens, previewBounds, preferenceWrites,
    setViewport: (width, height) => { fakeWindow.innerWidth = width; fakeWindow.innerHeight = height; },
    wirePreviewControls: () => followupTest.wirePreviewControls(),
    setInspectorOpen: (value) => followupTest.setInspectorOpen(value),
    setSurface: (value) => followupTest.setSurface(value),
    previewState: (value) => followupTest.handleYoutubePreviewState(value),
    getPreviewTarget: () => followupTest.getPreviewTarget(),
    setDetailWidth: (value) => followupTest.setDetailWidth(value),
    getDetailWidth: () => followupTest.getDetailWidth(),
    windowEvent: (event, payload = {}) => { for (const fn of windowListeners.get(event) ?? []) fn({ preventDefault() {}, ...payload }); },
    renderPinterestMetadata: () => followupTest.renderPinterestMetadata(),
    loadYoutube: (url) => followupTest.loadYoutube(url),
    applyDetailOutput: (value) => followupTest.applyDetailOutput(value),
    detailOutputFromControls: () => followupTest.detailOutputFromControls(),
    selectManualRange: () => followupTest.selectManualRange(),
    enqueue: (intent) => followupTest.enqueue(intent),
    historyAction: (record, action) => followupTest.historyAction(record, action),
    setProvider: (value) => followupTest.setProvider(value),
    searchYoutube: (query, page) => { elements.get('youtube-search-input').value = query; followupTest.searchYoutube(page); return youtubeSearches.at(-1); },
    searchPexels: (query, page) => { elements.get('youtube-search-input').value = query; followupTest.searchPexels(page); return pexelsSearches.at(-1); },
    searchPinterest: (query, page) => { elements.get('youtube-search-input').value = query; const result = followupTest.searchPinterest(page); const record = pinterestSearches.at(-1); return record ?? result; },
    pager: (delta) => followupTest.searchPageRelative(delta),
    submitSourceSearch: () => followupTest.submitSourceSearch(),
    pinterestUrlFromSearch: (input) => followupTest.pinterestUrlFromSearch(input),
    loadPinterest: (url, poster) => followupTest.loadPinterest(url, poster),
    getPinterestSearch: () => followupTest.getPinterestSearch(),
    getPinterest: () => followupTest.getPinterest(),
    getYoutubeSearch: () => followupTest.getYoutubeSearch(),
    getYoutube: () => followupTest.getYoutube(),
    getPexelsSearch: () => followupTest.getPexelsSearch(),
    getPexels: () => followupTest.getPexels(),
    getSelectedDetailKey: () => followupTest.getSelectedDetailKey(),
    getInspectorOpen: () => followupTest.getInspectorOpen(),
    setPexelsConnected: (value) => followupTest.setPexelsConnected(value),
    getSelectedSearchId: () => followupTest.getSelectedSearchId(),
    getSelectedThumbnailDataUrl: () => followupTest.getSelectedThumbnailDataUrl(),
    queue: () => followupTest.queue(),
    get pinterestDownloads() { return pinterestDownloads; },
    get pinterestSearches() { return pinterestSearches; },
    get pinterestLoads() { return pinterestLoads; },
    get youtubeSearches() { return youtubeSearches; },
    get youtubeLoads() { return youtubeLoads; },
    get pexelsSearches() { return pexelsSearches; },
    get pexelsLoads() { return pexelsLoads; },
    get nativeDragCalls() { return nativeDragCalls; },
    get revealSubtitleCalls() { return revealSubtitleCalls; },
    get revealCalls() { return revealCalls; },
    get youtubeDownloads() { return youtubeDownloads; },
    getPreviewStopTimer: () => followupTest.getPreviewStopTimer(),
    getPreviewActive: () => followupTest.getPreviewActive(),
    schedulePreviewStop: () => followupTest.schedulePreviewStop(),
    startPreview: (id, target) => followupTest.startPreview(id, target),
    clearPreview: () => followupTest.clearPreview(),
    enqueueResultCard: (key, sel, mode) => followupTest.enqueueResultCard(key, sel, mode),
    getStaged: (key) => followupTest.getStaged(key),
    setStaged: (key, v) => followupTest.setStaged(key, v),
    getCommonDefaults: () => followupTest.getCommonDefaults(),
    setCommonDefaults: (v) => followupTest.setCommonDefaults(v),
    getTimers: () => followupTest.getTimers(),
    triggerTimer: (id) => { const t = followupTest.getTimers().get(id); if (t) { followupTest.getTimers().delete(id); t.fn(); } },
    runAllTimers: () => { for (const [id, t] of [...followupTest.getTimers()]) { followupTest.getTimers().delete(id); t.fn(); } },
  };
}

test('Pinterest metadata renders its bounded data thumbnail without exposing a CDN URL', () => {
  const h = createHarness();
  const thumbnailUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`;
  h.setPinterest({
    pinId: '123456789', source: 'https://www.pinterest.com/pin/123456789/', title: 'Pin', creator: 'Creator', kind: 'image', thumbnailUrl,
    items: [{index: 1, kind: 'image', title: 'One', creator: null, extension: 'jpg'}],
  });
  h.renderPinterestMetadata();
  assert.equal(h.el('youtube-thumbnail').src, thumbnailUrl);
  assert.equal(h.el('youtube-thumbnail').alt, 'Pin');
});

test('completed queue rows use native selection, selected multi-drag, single unselected drag, and pruning', () => {
  const h = createHarness();
  h.setHostStatus({ phase: 'ready', project: { loaded: true }, timeline: { loaded: true } });
  const item = (queueId, cardId, title) => ({
    queueId, provider: 'youtube', jobId: `job-${queueId}`, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', title, channel: 'Channel', thumbnailDataUrl: null,
    quality: 'best', profile: 'original', options: { mediaMode: 'video', audioFormat: 'mp3', subtitles: false, subtitleLanguage: 'en' }, targetBin: 'active', placement: 'end', intent: 'download',
    status: 'completed', percent: 100, speedBytesPerSecond: null, etaSeconds: null, message: 'Download complete.', cardId, fileName: `${cardId}.mp4`,
  });
  h.setQueue([item('q1', 'card-1', 'One'), item('q2', 'card-2', 'Two'), item('q3', 'card-3', 'Three')]);
  h.renderQueue();
  const rowFor = (queueId) => h.el('youtube-download-queue').children.find((row) => row.dataset.queueId === queueId);
  const checkboxFor = (queueId) => rowFor(queueId).children.find((child) => child.dataset.field === 'selection');
  const hintFor = (queueId) => rowFor(queueId).children.find((child) => child.className.includes('dock-actions'))?.children.find((child) => child.className.includes('operation-drag-hint'));
  const drag = (queueId) => rowFor(queueId).listeners.dragstart({ preventDefault() {} });
  assert.ok(checkboxFor('q1') && checkboxFor('q2') && checkboxFor('q3'), 'ready rows expose native checkboxes');
  assert.equal(rowFor('q2').getAttribute('aria-selected'), 'false');
  assert.equal(hintFor('q2').textContent, 'Drag to Resolve');       // unselected keeps the canonical hint
  checkboxFor('q2').checked = true; checkboxFor('q2').listeners.change();
  assert.equal(rowFor('q2').classList.contains('selected'), true);
  assert.equal(rowFor('q2').getAttribute('aria-selected'), 'true');
  assert.equal(hintFor('q2').textContent, 'Drag to Resolve');       // single selection carries no count
  checkboxFor('q1').checked = true; checkboxFor('q1').listeners.change();
  assert.equal(rowFor('q2').classList.contains('selected'), true);
  assert.equal(hintFor('q2').textContent, 'Drag 2 selected to Resolve'); // multi states the exact count
  assert.ok(rowFor('q2').getAttribute('aria-label').includes('Drag 2 selected to Resolve'));
  assert.equal(hintFor('q3').textContent, 'Drag to Resolve');
  drag('q2');
  drag('q3');
  assert.deepEqual(JSON.parse(JSON.stringify(h.nativeDragCalls)), [['card-2', 'card-1'], 'card-3']);
  h.queue().splice(h.queue().findIndex((entry) => entry.queueId === 'q1'), 1);
  h.renderQueue();
  assert.equal(hintFor('q2').textContent, 'Drag to Resolve');       // pruned selection falls back to single
  drag('q2');
  assert.deepEqual(JSON.parse(JSON.stringify(h.nativeDragCalls)), [['card-2', 'card-1'], 'card-3', 'card-2'], 'removed rows are pruned before the next drag');
});

test('audio mode hides the video output-profile control', async () => {
  const h = createHarness();
  h.setYoutube(YOUTUBE);
  h.applyDetailOutput({ profile: 'editing' });
  h.renderMediaMode();
  assert.equal(h.profileOutput().classList.contains('hidden'), false); // visible in video mode
  h.applyDetailOutput({ mediaMode: 'audio' });
  h.renderMediaMode();
  assert.equal(h.profileOutput().classList.contains('hidden'), true);   // hidden in audio mode
  assert.equal(h.el('youtube-profile').value, 'original');              // presented audio profile
});

test('returning to video mode restores the prior visible video profile and keeps video jobs on it', async () => {
  const h = createHarness();
  h.setYoutube(YOUTUBE);
  h.applyDetailOutput({ profile: 'editing' });
  h.renderMediaMode();
  h.applyDetailOutput({ mediaMode: 'audio' });
  h.renderMediaMode();
  h.applyDetailOutput({ mediaMode: 'video' });
  h.renderMediaMode();
  assert.equal(h.profileOutput().classList.contains('hidden'), false); // control back
  assert.equal(h.el('youtube-profile').value, 'editing');               // prior profile restored
  h.enqueue('download');
  assert.equal(h.queue().length, 1);
  assert.equal(h.queue()[0].profile, 'editing');                        // video jobs keep the choice
});

test('a History record with an available subtitle companion gets a Reveal subtitle action dispatching to historyRevealSubtitle', async () => {
  const h = createHarness();
  h.setHistoryRecords([historyRecord()]);
  await h.renderHistory();
  const row = h.el('history-list').children[0];
  const more = row.children[1];
  more.click(); // open the More menu
  const labels = row.children[2].children.map((item) => item.textContent);
  assert.ok(labels.includes('Reveal in Finder')); // existing media reveal stays
  assert.ok(labels.includes('Reveal subtitle'));  // companion action present
  const item = row.children[2].children.find((entry) => entry.textContent === 'Reveal subtitle');
  item.click();
  await h.flush();
  assert.deepEqual(h.revealSubtitleCalls, ['r1']);
  assert.deepEqual(h.revealCalls, []); // media reveal not triggered
});

test('the Reveal subtitle action is omitted when the companion is missing or unavailable', async () => {
  const h = createHarness();
  h.setHistoryRecords([historyRecord({ subtitle: { fileName: 'clip.en.srt', bytes: 0, available: false } })]);
  await h.renderHistory();
  const row = h.el('history-list').children[0];
  row.children[1].click();
  const labels = row.children[2].children.map((item) => item.textContent);
  assert.ok(!labels.includes('Reveal subtitle'));

  const h2 = createHarness();
  h2.setHistoryRecords([historyRecord({ subtitle: undefined })]);
  await h2.renderHistory();
  const row2 = h2.el('history-list').children[0];
  row2.children[1].click();
  const labels2 = row2.children[2].children.map((item) => item.textContent);
  assert.ok(!labels2.includes('Reveal subtitle'));
  assert.ok(labels2.includes('Relink…')); // other actions remain intact
  assert.ok(labels2.includes('Reveal in Finder'));
});

// ---- Pinterest search renderer follow-ups ------------------------------------
// Deterministic 25-result Pinterest corpus (three pages of ten) mirroring the
// preview fixture shape: canonical Pin URLs, data-URL thumbnails, Image/Video/
// Carousel kinds, and missing-creator/missing-thumbnail fallbacks.
const PINTEREST_THUMB = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`;
const PINTEREST_PAGE_1 = {
  query: 'moodboard', page: 1, pageSize: 10,
  results: [
    { id: '9000000001', title: 'Pin One', creator: 'Studio A', kind: 'image', url: 'https://www.pinterest.com/pin/9000000001/', thumbnailUrl: PINTEREST_THUMB },
    { id: '9000000002', title: 'Pin Two', creator: null, kind: 'carousel', url: 'https://www.pinterest.com/pin/9000000002/', thumbnailUrl: null },
    { id: '9000000003', title: 'Pin Three', creator: 'Studio C', kind: 'video', url: 'https://www.pinterest.com/pin/9000000003/', thumbnailUrl: PINTEREST_THUMB },
  ],
  hasPrevious: false, hasNext: true, totalResults: 25, pageCount: 3,
  thumbnailDiagnostic: { failed: 6, total: 10, reason: 'request-error', node: 'v22.1.0' },
};

// Collect every rendered string (text, aria labels, img src) below a node so tests
// can prove no raw CDN/path/URL escapes into the Pinterest results surface.
function collectStrings(node, out = []) {
  if (node.textContent) out.push(node.textContent);
  if (node.src) out.push(node.src);
  if (node.getAttribute) { const label = node.getAttribute('aria-label'); if (label) out.push(label); }
  for (const child of node.children ?? []) collectStrings(child, out);
  return out;
}

// Rows render the kind badge inside the thumbnail frame; rows without a data-URL
// thumbnail have no <img>, so tests locate both children by shape, not index.
const badgeOf = (row) => row.children[0].children.find((child) => child.className.includes('source-row-duration'));
const imgOf = (row) => row.children[0].children.find((child) => child.tagName === 'IMG');

function pinterestMetadata(id, kind) {
  return { pinId: id, source: `https://www.pinterest.com/pin/${id}/`, title: `Pin ${id}`, creator: 'Studio C', kind, thumbnailUrl: null, items: [{ index: 1, kind: kind === 'carousel' ? 'image' : kind, title: `Pin ${id}`, creator: null, extension: kind === 'video' ? 'mp4' : 'jpg' }] };
}

test('Pinterest search rows render data-URL thumbnails, badges, and status without raw CDN or paths', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const p = h.searchPinterest('moodboard', 1);
  p.resolve(PINTEREST_PAGE_1);
  await h.flush();
  const rows = h.el('youtube-search-results').children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].dataset.provider, 'pinterest');
  const title0 = rows[0].children[1].children[0];
  const meta0 = rows[0].children[1].children[1];
  assert.equal(title0.textContent, 'Pin One');
  // The visible meta line names the creator; the source rides in the rebate edge code
  // (▸ PN) and stays in the row's accessible name.
  assert.equal(meta0.textContent, 'Studio A');
  assert.equal(badgeOf(rows[0]).textContent, 'Image');                    // kind badge
  assert.equal(imgOf(rows[0]).src, PINTEREST_THUMB);                       // data-URL thumbnail
  assert.ok(rows[0].getAttribute('aria-label').includes('Source: Pinterest'));
  // Missing creator and thumbnail fall back without rendering a raw URL.
  assert.equal(rows[1].children[1].children[1].textContent, 'Creator unavailable');
  assert.equal(badgeOf(rows[1]).textContent, 'Carousel');
  assert.ok(rows[1].children[0].classList.contains('thumbnail-fallback'));
  assert.ok(rows[1].children[0].textContent.includes('Thumbnail unavailable'));
  // Status carries page/total parity plus the thumbnail diagnostic.
  assert.equal(h.el('youtube-search-status').textContent, 'Page 1 of 3 · 25 results · Thumbnails 4/10 · request-error · Node v22.1.0');
  assert.equal(h.el('youtube-search-prev').disabled, true);
  assert.equal(h.el('youtube-search-next').disabled, false);
  // The canonical Pin URLs never cross into row markup: only data: thumbnails.
  const strings = collectStrings(h.el('youtube-search-results'));
  assert.ok(strings.every((value) => !/pinimg|https?:/i.test(value)), 'no CDN/path/URL may leak into Pinterest rows');
});

test('a stale Pinterest search cannot render after a newer request', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const stale = h.searchPinterest('moodboard', 1);
  const newest = h.searchPinterest('newer', 1);
  stale.resolve(PINTEREST_PAGE_1);
  await h.flush();
  assert.equal(h.getPinterestSearch(), null);                               // stale result discarded
  assert.equal(h.el('youtube-search-results').children.length, 0);
  assert.equal(h.el('youtube-search-status').textContent, 'Searching Pinterest…');
  const { thumbnailDiagnostic, ...cleanPage } = PINTEREST_PAGE_1;
  newest.resolve({ ...cleanPage, query: 'newer' });
  await h.flush();
  assert.equal(h.getPinterestSearch().query, 'newer');                      // only the newest may render
  assert.equal(h.el('youtube-search-status').textContent, 'Page 1 of 3 · 25 results');
});

test('Pinterest prev/next page through the shared pager with generation suppression', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const p1 = h.searchPinterest('moodboard', 1);
  p1.resolve(PINTEREST_PAGE_1);
  await h.flush();
  h.pager(1); // the exact handler wired to the shared Previous/Next buttons
  assert.equal(h.pinterestSearches.length, 2);
  assert.equal(h.pinterestSearches[1].page, 2);
  const { thumbnailDiagnostic, ...cleanPage } = PINTEREST_PAGE_1;
  h.pinterestSearches[1].resolve({ ...cleanPage, page: 2, hasPrevious: true, hasNext: true });
  await h.flush();
  assert.equal(h.el('youtube-search-status').textContent, 'Page 2 of 3 · 25 results');
  h.pager(-1);
  assert.equal(h.pinterestSearches.length, 3);
  assert.equal(h.pinterestSearches[2].page, 1);
  h.pinterestSearches[2].resolve({ ...cleanPage, page: 1, hasPrevious: false, hasNext: true });
  await h.flush();
  assert.equal(h.el('youtube-search-status').textContent, 'Page 1 of 3 · 25 results');
});

test('Pinterest advanced action reuses loadPinterest with the canonical URL and search thumbnail', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const p = h.searchPinterest('moodboard', 1);
  p.resolve(PINTEREST_PAGE_1);
  await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[2]);
  await h.flush();
  // Selection routes to the canonical Pin URL and the row thumbnail through loadPinterest.
  assert.equal(h.el('pinterest-url').value, 'https://www.pinterest.com/pin/9000000003/');
  assert.equal(h.pinterestLoads.length, 1);
  assert.equal(h.pinterestLoads[0].url, 'https://www.pinterest.com/pin/9000000003/');
  assert.equal(h.getSelectedThumbnailDataUrl(), PINTEREST_THUMB);
  assert.equal(h.getSelectedSearchId(), '9000000003');
  assert.equal(h.pinterestDownloads.length, 0);                             // selection never touches the download seam
  // Metadata without its own thumbnail keeps the search row data-URL poster.
  h.pinterestLoads[0].resolve(pinterestMetadata('9000000003', 'video'));
  await h.flush();
  assert.equal(h.getPinterest().pinId, '9000000003');
  assert.equal(h.el('youtube-thumbnail').src, PINTEREST_THUMB);
  assert.equal(h.el('youtube-duration').textContent, '1 item · Video');
});

test('Pinterest search state is captured and restored per provider', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const p = h.searchPinterest('moodboard', 1);
  p.resolve(PINTEREST_PAGE_1);
  await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[2]);
  await h.flush();
  h.pinterestLoads[0].resolve(pinterestMetadata('9000000003', 'video'));
  await h.flush();
  // Leave for YouTube and return: search page, selection, and metadata must all come back.
  h.setProvider('youtube');
  assert.equal(h.el('youtube-search-results').children.length, 0);
  h.setProvider('pinterest');
  assert.equal(h.getPinterestSearch().query, 'moodboard');
  assert.equal(h.getPinterest().pinId, '9000000003');
  assert.equal(h.getSelectedSearchId(), '9000000003');
  assert.equal(h.getSelectedThumbnailDataUrl(), PINTEREST_THUMB);
  assert.equal(h.el('pinterest-url').value, 'https://www.pinterest.com/pin/9000000003/');
  assert.equal(h.el('youtube-search-results').children.length, 3);
  assert.equal(h.el('youtube-search-status').textContent, 'Page 1 of 3 · 25 results · Thumbnails 4/10 · request-error · Node v22.1.0');
});

test('a direct public Pin URL in the Pinterest search box routes to the Pin loader; other inputs search', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  h.el('youtube-search-input').value = 'https://www.pinterest.com/pin/123456789/';
  h.submitSourceSearch();
  await h.flush();
  assert.equal(h.pinterestSearches.length, 0);                              // exact direct Pin URL never searches
  assert.equal(h.pinterestLoads.length, 1);
  assert.equal(h.pinterestLoads[0].url, 'https://www.pinterest.com/pin/123456789/');
  assert.equal(h.el('pinterest-url').value, 'https://www.pinterest.com/pin/123456789/');
  // Exact pin.it links reuse the existing main-owned redirect resolver.
  h.el('youtube-search-input').value = 'https://pin.it/abc123';
  h.submitSourceSearch();
  await h.flush();
  assert.equal(h.pinterestSearches.length, 0);
  assert.equal(h.pinterestLoads.length, 2);
  assert.equal(h.pinterestLoads[1].url, 'https://pin.it/abc123');
  // Plain search text still routes to the Pinterest search seam.
  h.el('youtube-search-input').value = 'moodboard';
  h.submitSourceSearch();
  assert.equal(h.pinterestSearches.length, 1);
  assert.equal(h.pinterestSearches[0].query, 'moodboard');
});

// ---- Search-transition seam regression (F2) ------------------------------------
// A new search/pagination pass must start by closing any open detail Inspector,
// dropping the selected detail identity, invalidating stale metadata/subtitle
// requests, and disabling the download controls. The seam is beginSearchTransition
// inside searchYoutube/searchPexels/searchPinterest; direct-URL/social/paste
// fallbacks bypass it and keep their Inspector open.
const YOUTUBE_PAGE = {
  query: 'shots', page: 1, pageSize: 10,
  results: [
    { id: 'aaaaaaaaaaa', title: 'First A', channel: 'One', duration: 10, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false },
    { id: 'bbbbbbbbbbb', title: 'First B', channel: 'Two', duration: 20, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false },
  ],
  hasPrevious: false, hasNext: true, totalResults: 25, pageCount: 3,
};
function youtubeMetadata(id, title) {
  return { id, title, duration: 60, channel: 'Channel', thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: [] };
}
const PEXELS_PAGE = {
  query: 'mountains', page: 1, pageSize: 10,
  results: [
    { id: 1, kind: 'video', title: 'Mountain One', creator: 'Studio', sourceUrl: 'https://www.pexels.com/video/1/', width: 1920, height: 1080, duration: 12, thumbnailUrl: null, previewUrl: null },
    { id: 2, kind: 'photo', title: 'Mountain Two', creator: null, sourceUrl: 'https://www.pexels.com/photo/2/', width: 4000, height: 3000, duration: null, thumbnailUrl: null, previewUrl: null },
  ],
  hasPrevious: false, hasNext: true, totalResults: 25, pageCount: 3,
};
const PEXELS_ASSET = {
  id: 1, kind: 'video', title: 'Mountain One', creator: 'Studio', creatorUrl: null, sourceUrl: 'https://www.pexels.com/video/1/', duration: 12, width: 1920, height: 1080, thumbnailUrl: null,
  files: [{ id: 'sd-id', url: '', width: 1280, height: 720, label: 'HD', mime: 'video/mp4', size: 10 }], previewUrl: null,
};
function openAdvancedResult(row) {
  const visit = (element) => {
    for (const child of element.children ?? []) {
      if (child.dataset?.cardAction === 'advanced') return child;
      const nested = visit(child);
      if (nested) return nested;
    }
    return null;
  };
  const advanced = visit(row);
  assert.ok(advanced, 'card exposes an explicit advanced fallback');
  advanced.click();
}

test('a new YouTube query closes the open Inspector, drops the old detail, and disables download until the new page lands', async () => {
  const h = createHarness();
  const first = h.searchYoutube('first', 1);
  first.resolve(YOUTUBE_PAGE);
  await h.flush();
  h.el('youtube-search-results').children[0].click();
  assert.equal(h.getInspectorOpen(), false, 'card body stays inline');
  openAdvancedResult(h.el('youtube-search-results').children[0]); // explicit fallback for row A
  await h.flush();
  h.youtubeLoads[0].resolve(youtubeMetadata('aaaaaaaaaaa', 'First A metadata'));
  await h.flush();
  assert.equal(h.getInspectorOpen(), true);
  assert.equal(h.el('workspace').classList.contains('inspector-open'), true);
  assert.equal(h.el('inspector-pane').getAttribute('aria-hidden'), 'false');
  assert.equal(h.el('youtube-title').textContent, 'First A metadata');
  assert.equal(h.el('download-youtube-btn').disabled, false);

  const second = h.searchYoutube('second', 1); // search starts while the Inspector is open
  assert.equal(h.getInspectorOpen(), false, 'the transition closes the Inspector synchronously');
  assert.equal(h.getSelectedDetailKey(), null);
  assert.equal(h.getSelectedSearchId(), null);
  assert.equal(h.getYoutube(), null, 'old detail payload is dropped');
  assert.equal(h.el('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.el('search-surface').classList.contains('detail-open'), false);
  assert.equal(h.el('inspector-pane').getAttribute('aria-hidden'), 'true');
  assert.equal(h.el('youtube-metadata').classList.contains('hidden'), true);
  assert.equal(h.el('download-youtube-btn').disabled, true);

  second.resolve({ ...YOUTUBE_PAGE, query: 'second', results: [YOUTUBE_PAGE.results[1]], pageCount: 1, totalResults: 1, hasNext: false });
  await h.flush();
  assert.equal(h.getYoutubeSearch().query, 'second');
  assert.equal(h.getYoutube(), null);
  assert.equal(h.el('workspace').classList.contains('inspector-open'), false, 'no Inspector after the new results render');
  assert.equal(h.el('inspector-pane').getAttribute('aria-hidden'), 'true');
  assert.equal(h.el('download-youtube-btn').disabled, true);

  // Opening the new result through its explicit advanced action loads only that item.
  openAdvancedResult(h.el('youtube-search-results').children[0]);
  await h.flush();
  assert.equal(h.getSelectedSearchId(), 'bbbbbbbbbbb');
  assert.equal(h.el('youtube-metadata').classList.contains('hidden'), false, 'the selected row is visible while metadata loads');
  assert.equal(h.el('youtube-title').textContent, 'First B');
  h.youtubeLoads[1].resolve(youtubeMetadata('bbbbbbbbbbb', 'Second B metadata'));
  await h.flush();
  assert.equal(h.getYoutube().title, 'Second B metadata');
  assert.equal(h.el('youtube-title').textContent, 'Second B metadata');
  assert.equal(h.el('download-youtube-btn').disabled, false);
});

test('YouTube pagination through the shared pager closes the Inspector and invalidates the stale detail', async () => {
  const h = createHarness();
  const first = h.searchYoutube('shots', 1);
  first.resolve(YOUTUBE_PAGE);
  await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[0]);
  await h.flush();
  h.youtubeLoads[0].resolve(youtubeMetadata('aaaaaaaaaaa', 'First A metadata'));
  await h.flush();
  assert.equal(h.el('workspace').classList.contains('inspector-open'), true);

  h.pager(1); // next page routes through searchYoutube, the same seam as a fresh query
  assert.equal(h.youtubeSearches.length, 2);
  assert.equal(h.youtubeSearches[1].page, 2);
  assert.equal(h.getInspectorOpen(), false);
  assert.equal(h.getYoutube(), null);
  assert.equal(h.el('download-youtube-btn').disabled, true);

  h.youtubeSearches[1].resolve({ ...YOUTUBE_PAGE, page: 2, hasPrevious: true });
  await h.flush();
  assert.equal(h.getYoutubeSearch().page, 2);
  assert.equal(h.el('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.el('download-youtube-btn').disabled, true);
});

test('a Pexels search through the common seam closes the Inspector, drops the asset, and keeps download disabled after an error', async () => {
  const h = createHarness();
  h.setPexelsConnected(true);
  h.setProvider('pexels');
  const first = h.searchPexels('mountains', 1);
  first.resolve(PEXELS_PAGE);
  await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[0]); // explicit detail fallback
  await h.flush();
  h.pexelsLoads[0].resolve(PEXELS_ASSET);
  await h.flush();
  assert.equal(h.getInspectorOpen(), true);
  assert.equal(h.getPexels().title, 'Mountain One');
  assert.equal(h.el('download-youtube-btn').disabled, false);

  const failing = h.searchPexels('ocean', 1); // new search while the Inspector is open
  assert.equal(h.getInspectorOpen(), false);
  assert.equal(h.getSelectedDetailKey(), null);
  assert.equal(h.getPexels(), null, 'stale Pexels asset is dropped at transition');
  assert.equal(h.el('inspector-pane').getAttribute('aria-hidden'), 'true');
  assert.equal(h.el('download-youtube-btn').disabled, true);

  failing.reject(new Error('Pexels API error'));
  await h.flush();
  assert.equal(h.el('youtube-search-status').textContent, 'Pexels API error');
  assert.equal(h.getInspectorOpen(), false, 'a failed search never restores the old Inspector');
  assert.equal(h.getPexels(), null);
  assert.equal(h.el('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.el('download-youtube-btn').disabled, true);
});

test('a Pinterest search through the common seam closes the Inspector, and a direct Pin URL keeps the Inspector fallback open', async () => {
  const h = createHarness();
  h.setProvider('pinterest');
  const first = h.searchPinterest('moodboard', 1);
  first.resolve(PINTEREST_PAGE_1);
  await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[2]);
  await h.flush();
  h.pinterestLoads[0].resolve(pinterestMetadata('9000000003', 'video'));
  await h.flush();
  assert.equal(h.getInspectorOpen(), true);
  assert.equal(h.getPinterest().pinId, '9000000003');

  const second = h.searchPinterest('newer', 1); // search transition closes the detail
  assert.equal(h.getInspectorOpen(), false);
  assert.equal(h.getPinterest(), null);
  assert.equal(h.el('download-youtube-btn').disabled, true);
  second.resolve({ ...PINTEREST_PAGE_1, query: 'newer', results: [PINTEREST_PAGE_1.results[0]] });
  await h.flush();
  assert.equal(h.el('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.el('download-youtube-btn').disabled, true);

  // Direct Pin URL fallback after a search keeps the Inspector on the loaded Pin.
  h.el('youtube-search-input').value = 'https://www.pinterest.com/pin/123456789/';
  h.submitSourceSearch();
  await h.flush();
  assert.equal(h.pinterestSearches.length, 2, 'an exact Pin URL never triggers the search seam');
  assert.equal(h.pinterestLoads.length, 2);
  assert.equal(h.pinterestLoads[1].url, 'https://www.pinterest.com/pin/123456789/');
  assert.equal(h.getInspectorOpen(), true, 'the direct-URL fallback keeps its Inspector open');
  h.pinterestLoads[1].resolve(pinterestMetadata('123456789', 'image'));
  await h.flush();
  assert.equal(h.getPinterest().pinId, '123456789');
  assert.equal(h.el('workspace').classList.contains('inspector-open'), true);
});

test('stale preview-stop timer does not cancel a new YouTube preview', async () => {
  const h = createHarness();
  const target = h.el('source-monitor');
  target.getBoundingClientRect = () => ({left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300});
  h.el('workspace').getBoundingClientRect = () => ({left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600});
  h.setProvider('youtube');
  // Start first preview then schedule its 120ms stop timer
  await h.startPreview('dQw4w9WgXcQ', target);
  await h.flush();
  assert.equal(h.getPreviewActive(), true);
  h.schedulePreviewStop();
  const staleTimer = h.getPreviewStopTimer();
  assert.notEqual(staleTimer, null);
  // Before stale timer fires, start a new preview — fix clears stale timer in clearPreviewState
  await h.startPreview('aaaaaaaaaaa', target);
  await h.flush();
  assert.equal(h.getPreviewActive(), true);
  assert.equal(h.getTimers().has(staleTimer), false, 'stale preview-stop timer should have been cleared by new preview');
  // Triggering the old timer id (now deleted) must be a no-op and not stop the new preview
  h.triggerTimer(staleTimer);
  assert.equal(h.getPreviewActive(), true, 'stale timer must not stop new preview');
});

test('result-card enqueue captures click-time snapshot across delayed metadata', async () => {
  const h = createHarness();
  h.setProvider('youtube');
  // Ensure common defaults start at original profile
  h.setCommonDefaults({profile: 'original', quality: 'best'});
  const key = 'youtube:dQw4w9WgXcQ';
  const selection = {provider: 'youtube', resultId: 'dQw4w9WgXcQ', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Clip', channel: null, thumbnailDataUrl: null};
  // Pre-stage the card so enqueueResultCard has a known snapshot
  const snapshot = {...h.getCommonDefaults()};
  h.setStaged(key, {key, ...selection, snapshot, overrides: {}});
  const pending = h.enqueueResultCard(key, selection, 'tail');
  // While metadata is pending, mutate the common defaults — the queued item must retain click-time snapshot
  h.setCommonDefaults({profile: 'editing'});
  // Also mutate the live staged entry to simulate user changing card options after click
  const live = h.getStaged(key);
  if (live) live.snapshot.profile = 'editing';
  assert.equal(h.youtubeLoads.length, 1);
  h.youtubeLoads[0].resolve({id: 'dQw4w9WgXcQ', title: 'Clip', duration: 60, channel: null, thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: []});
  await pending;
  await h.flush();
  assert.equal(h.queue().length, 1);
  assert.equal(h.queue()[0].profile, 'original', 'queued item must use click-time snapshot, not mutated defaults');
});


function ytMetadata(id, title) { return { id, title, duration: 60, channel: null, thumbnailUrl: null, heights: [1080], formatSummary: [], chapters: [] }; }
const stateChapters = [{ start: 0, end: 10, title: 'Intro' }, { start: 20, end: 30, title: 'End' }];
async function loadStateVideo(h, id) {
  const pending = h.loadYoutube(`https://www.youtube.com/watch?v=${id}`);
  h.youtubeLoads.at(-1).resolve({ ...ytMetadata(id, id), chapters: stateChapters });
  await pending;
}
function checkStateChapter(h, index) {
  const check = h.el('chapter-list').children[index].children[0];
  check.checked = true; check.listeners.change();
}

test('STATE RND-1/RND-2: inspector chapter controls reach the queue', async () => {
  const h = createHarness();
  await loadStateVideo(h, 'aaaaaaaaaaa');
  checkStateChapter(h, 0); checkStateChapter(h, 1);
  h.enqueue('download');
  assert.deepEqual(Array.from(h.queue(), (job) => JSON.parse(JSON.stringify(job.options.selection))), [{ start: 0, end: 10, label: 'Intro' }, { start: 20, end: 30, label: 'End' }]);
});

test('STATE RND-2: new source clears chapter intent and manual input replaces chapters', async () => {
  const h = createHarness();
  await loadStateVideo(h, 'aaaaaaaaaaa'); checkStateChapter(h, 1);
  await loadStateVideo(h, 'bbbbbbbbbbb');
  h.enqueue('download');
  assert.equal(h.queue()[0].options.selection, null);
  checkStateChapter(h, 0);
  h.el('range-in').value = '40'; h.el('range-out').value = '50'; h.selectManualRange();
  h.enqueue('download');
  assert.deepEqual(JSON.parse(JSON.stringify(h.queue()[1].options.selection)), { start: 40, end: 50, label: 'Custom range' });
});

test('STATE RND-3: inspector reports invalid range input', async () => {
  const h = createHarness();
  await loadStateVideo(h, 'aaaaaaaaaaa');
  h.el('range-in').value = '20'; h.el('range-out').value = '10';
  h.selectManualRange();
  h.enqueue('download');
  assert.equal(h.queue().length, 0);
  assert.equal(h.el('youtube-status').textContent, 'In/Out must be a valid range within the source duration.');
});

test('STATE RND-4: applying best defaults to height-only detail keeps a supported quality', async () => {
  const h = createHarness();
  await loadStateVideo(h, 'aaaaaaaaaaa');
  h.applyDetailOutput({ ...h.getCommonDefaults(), quality: 'best' });
  assert.equal(h.el('youtube-quality').value, '1080p');
  h.enqueue('download');
  assert.equal(h.queue()[0].quality, '1080p');
});

test('history empty state waits for loading and chips filter through the native selects', async () => {
  const h = createHarness();
  let finish;
  h.api.historyList = () => new Promise((resolve) => { finish = resolve; });
  const loading = h.refreshHistory();
  assert.equal(h.el('history-empty-state').hidden, true);
  assert.equal(h.el('history-list').getAttribute('data-loading'), 'true');
  finish([]); await loading;
  assert.equal(h.el('history-empty-state').hidden, false);
  assert.equal(h.el('history-list').getAttribute('data-loading'), null);
  h.setHistoryRecords([historyRecord()]);
  const chip = h.makeElement('button'); chip.dataset.value = 'pinterest';
  h.el('history-provider-chips').append(chip); h.wireHistoryControls(); chip.click();
  assert.equal(h.el('history-provider-filter').value, 'pinterest');
  assert.equal(h.el('history-list').children.length, 0);
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(h.el('history-empty-state').hidden, false);
});

for (const source of ['youtube', 'pexels', 'pinterest']) test(`${source} inspector paints the selected row and quality skeleton before metadata resolves`, async () => {
  const h = createHarness();
  h.setProvider(source);
  if (source === 'pexels') h.setPexelsConnected(true);
  const page = source === 'youtube' ? YOUTUBE_PAGE : source === 'pexels' ? PEXELS_PAGE : PINTEREST_PAGE_1;
  const request = source === 'youtube' ? h.searchYoutube('shots', 1) : source === 'pexels' ? h.searchPexels('mountains', 1) : h.searchPinterest('moodboard', 1);
  request.resolve(page); await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[0]);
  // None of the provider metadata promises has resolved.
  assert.equal(h.el('youtube-title').textContent, page.results[0].title);
  assert.equal(h.el('youtube-channel').textContent, source === 'youtube' ? page.results[0].channel : page.results[0].creator);
  assert.equal(h.el('youtube-metadata').classList.contains('hidden'), false);
  assert.equal(h.el('download-youtube-btn').disabled, true);
  assert.deepEqual(Array.from(h.el('quality-chips').children, chip => chip.className), ['skeleton-chip', 'skeleton-chip', 'skeleton-chip']);
  const loads = source === 'youtube' ? h.youtubeLoads : source === 'pexels' ? h.pexelsLoads : h.pinterestLoads;
  assert.equal(loads.length, 1);
  loads[0].resolve(source === 'youtube' ? youtubeMetadata('aaaaaaaaaaa', 'Resolved') : source === 'pexels' ? PEXELS_ASSET : pinterestMetadata(page.results[0].id, 'image'));
  await h.flush();
  assert.equal(h.el('inspector-loading').classList.contains('hidden'), true);
});

test('failed Pexels metadata clears the loading skeleton and leaves download disabled', async () => {
  const h = createHarness(); h.setProvider('pexels'); h.setPexelsConnected(true);
  h.searchPexels('mountains', 1).resolve(PEXELS_PAGE); await h.flush();
  openAdvancedResult(h.el('youtube-search-results').children[0]);
  assert.equal(h.el('youtube-title').textContent, 'Mountain One');
  h.pexelsLoads[0].reject(new Error('Metadata unavailable')); await h.flush();
  assert.equal(h.el('quality-chips').children.length, 0);
  assert.equal(h.el('inspector-loading').classList.contains('hidden'), true);
  assert.equal(h.el('youtube-metadata').classList.contains('hidden'), true);
  assert.equal(h.el('download-youtube-btn').disabled, true);
  assert.equal(h.el('youtube-status').textContent, 'Metadata unavailable');
});


// Theater uses real renderer actions; geometry models the CSS switch. The built
// browser preview separately checks actual grid widths at desktop/narrow sizes.
async function theaterHarness() {
  const h = createHarness();
  h.setViewport(1280, 800);
  h.el('workspace').getBoundingClientRect = () => ({ width: 1200 });
  h.el('source-monitor').getBoundingClientRect = () => {
    const width = h.el('workspace').classList.contains('theater') ? 672 : 376;
    return { left: 1200 - width, top: 140, width, height: width * 9 / 16 };
  };
  // Cards intentionally have enough space for the OLD in-card player to start;
  // assertions must distinguish monitor playback from simply failing to play.
  const request = h.searchYoutube('mountains', 1);
  request.resolve(YOUTUBE_PAGE); await h.flush();
  h.setDetailWidth(400);
  h.wirePreviewControls();
  return h;
}
function cardAction(h, index, action) {
  const row = h.el('youtube-search-results').children[index];
  const visit = element => element.dataset?.cardAction === action ? element : (element.children ?? []).map(visit).find(Boolean);
  return visit(row);
}
function assertTheaterStopped(h) {
  assert.equal(h.el('workspace').classList.contains('theater'), false);
  assert.equal(h.getPreviewActive(), false);
  assert.equal(h.getDetailWidth(), 400);
  assert.equal(h.el('workspace').style.values['--detail-w'], '400px');
  assert.deepEqual(h.preferenceWrites.filter(([key]) => key === 'clipdock.detail-width'), [], 'playback never persists a layout preference');
}

test('card Play opens the immediate inspector and plays its widened monitor before metadata arrives', async () => {
  const h = await theaterHarness();
  cardAction(h, 0, 'play').click();
  assert.equal(h.getInspectorOpen(), true);
  assert.equal(h.getSelectedSearchId(), 'aaaaaaaaaaa');
  assert.equal(h.el('youtube-title').textContent, 'First A');
  assert.equal(h.el('youtube-metadata').classList.contains('hidden'), false);
  assert.equal(h.youtubeLoads.length, 1, 'uses the existing detail metadata path');
  assert.equal(h.getYoutube(), null, 'metadata is still pending');
  assert.equal(h.getPreviewTarget(), h.el('source-monitor'));
  assert.equal(h.previewOpens.length, 1, 'starts immediately, without waiting for metadata');
  assert.equal(h.previewOpens[0][0], 'aaaaaaaaaaa');
  assert.equal(h.previewOpens[0][2].width, 672);
  assert.equal(h.el('workspace').classList.contains('theater'), true);
  assert.equal(h.getDetailWidth(), 400);
  assert.equal(cardAction(h, 0, 'play').getAttribute('aria-pressed'), 'true');
  assert.equal(cardAction(h, 0, 'play').textContent, 'Stop preview');
  assert.equal(cardAction(h, 0, 'play').disabled, false, 'can stop while metadata loads');
  for (const row of h.el('youtube-search-results').children) assert.equal(row.classList.contains('has-player'), false);
  await h.flush();
  assert.equal(h.previewBounds.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.previewBounds[0])), { x: 528, y: 140, width: 672, height: 378 });
  h.youtubeLoads[0].resolve(youtubeMetadata('aaaaaaaaaaa', 'Verified A')); await h.flush();
  assert.equal(h.el('youtube-title').textContent, 'Verified A');
  assert.equal(h.getPreviewActive(), true, 'metadata refresh keeps the same preview running');
  cardAction(h, 0, 'play').click();
  assertTheaterStopped(h);
});

for (const [name, stop] of [
  ['Stop button while metadata loads', h => h.el('preview-selected-btn').click()],
  ['selecting another result', h => openAdvancedResult(h.el('youtube-search-results').children[1])],
  ['closing the inspector', h => h.el('back-to-results').click()],
  ['new search', async h => { h.youtubeLoads[0].resolve(youtubeMetadata('aaaaaaaaaaa', 'A')); await h.flush(); h.searchYoutube('another query', 1); }],
  ['provider tab change', h => h.setProvider('pinterest')],
  ['surface tab change', h => h.setSurface('queue')],
  ['Space toggle', h => h.windowEvent('keydown', { key: ' ' })],
  ['Escape', h => h.windowEvent('keydown', { key: 'Escape' })],
  ['native end', h => h.previewState({ state: 'closed', reason: 'ended' })],
  ['native error', h => h.previewState({ state: 'failed', reason: 'error' })],
]) test(`theater restores the saved width after ${name}`, async () => {
  const h = await theaterHarness();
  cardAction(h, 0, 'play').click(); await h.flush();
  assert.equal(h.el('workspace').classList.contains('theater'), true);
  await stop(h); await h.flush();
  assertTheaterStopped(h);
});

for (const outcome of ['false', 'reject', 'invisible']) test(`YouTube preview ${outcome} leaves theater`, async () => {
  const h = await theaterHarness();
  if (outcome === 'invisible') h.api.setYoutubePreviewBounds = async () => false;
  else h.api.openYoutubePreview = async () => { if (outcome === 'reject') throw new Error('fixture'); return false; };
  cardAction(h, 0, 'play').click(); await h.flush();
  assertTheaterStopped(h);
});

test('stopped preview opening late cannot restore theater or resync old bounds', async () => {
  const h = await theaterHarness(); let finish;
  h.api.openYoutubePreview = () => new Promise(resolve => { finish = resolve; });
  cardAction(h, 0, 'play').click();
  h.el('preview-selected-btn').click();
  finish(true); await h.flush();
  assertTheaterStopped(h);
  assert.deepEqual(h.previewBounds, []);
});

for (const end of ['stop', 'ended', 'error', 'pause', 'reject']) test(`Pexels card Play uses the inspector theater and restores it on ${end}`, async () => {
  const h = await theaterHarness();
  h.setProvider('pexels'); h.setPexelsConnected(true);
  const asset = { ...PEXELS_ASSET, previewUrl: 'https://videos.pexels.com/fixture.mp4' };
  h.searchPexels('mountains', 1).resolve({ ...PEXELS_PAGE, results: [asset] }); await h.flush();
  const video = h.el('pexels-preview-video');
  if (end === 'reject') video.play = async () => { throw new Error('play failed'); };
  cardAction(h, 0, 'play').click();
  assert.equal(h.getInspectorOpen(), true);
  assert.equal(h.getSelectedSearchId(), '1');
  assert.equal(h.pexelsLoads.length, 1);
  assert.equal(h.getPreviewTarget(), h.el('source-monitor'));
  assert.equal(h.el('workspace').classList.contains('theater'), true);
  assert.equal(h.el('pexels-preview-overlay').style.width, '672px');
  assert.equal(video.src, asset.previewUrl);
  assert.equal(cardAction(h, 0, 'play').getAttribute('aria-pressed'), 'true');
  h.pexelsLoads[0].resolve(asset); await h.flush();
  if (end !== 'reject') {
    assert.equal(h.el('workspace').classList.contains('theater'), true, 'metadata does not interrupt Pexels');
    if (end === 'stop') h.el('preview-selected-btn').click();
    else { video.paused = true; video.listeners[end](); }
  }
  assert.equal(h.el('pexels-preview-overlay').classList.contains('hidden'), true);
  assertTheaterStopped(h);
});

test('a stale bounds failure cannot stop a newer inspector preview', async () => {
  const h = await theaterHarness(); let finish;
  h.api.setYoutubePreviewBounds = () => new Promise(resolve => { finish = resolve; });
  cardAction(h, 0, 'play').click(); await h.flush();
  h.youtubeLoads[0].resolve(youtubeMetadata('aaaaaaaaaaa', 'A')); await h.flush();
  h.el('preview-selected-btn').click();
  h.api.setYoutubePreviewBounds = async () => true;
  h.el('preview-selected-btn').click(); await h.flush();
  finish(false); await h.flush();
  assert.equal(h.getPreviewActive(), true);
  assert.equal(h.el('workspace').classList.contains('theater'), true);
  h.el('preview-selected-btn').click();
  assertTheaterStopped(h);
});
