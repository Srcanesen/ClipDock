// Execute the shipped browser bundle in a deterministic DOM/API fixture.
import { createFakeDom } from './fake-dom.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const renderer = readFileSync(new URL('../../dist/renderer.js', import.meta.url), 'utf8');

export function createHarness({ eventsOnly = false, preferencesInit = {} } = {}) {
  const elements = new Map();
  let activeElement = null;
  const { makeElement } = createFakeDom({ onFocus: (element) => { activeElement = element; }, bounds: { right: 800, bottom: 500, width: 800, height: 500 } });
  const ids = [
    'refresh-btn', 'bridge-state', 'module-version', 'resolve-version', 'project-name', 'timeline-name', 'message', 'refresh-hint', 'last-updated', 'pin-on-top-btn', 'settings-btn',
    'surface-nav-search', 'surface-nav-queue', 'surface-nav-library', 'search-surface', 'queue-surface', 'library-surface', 'settings-panel', 'search-surface-title', 'queue-title', 'library-title', 'settings-title',
    'common-profile', 'common-quality', 'common-media-mode', 'common-audio-format', 'common-audio-format-label', 'common-intent', 'common-target-bin', 'common-subtitles', 'common-subtitle-language-label', 'common-subtitle-language', 'common-output-summary', 'selection-toolbar', 'selection-count', 'selection-status', 'select-all-results-btn', 'clear-selection-btn', 'enqueue-selected-btn', 'completed-downloads', 'completed-download-count', 'completed-downloads-status',
    'workspace', 'feed-pane', 'inspector-pane', 'monitor-pane', 'transfer-console', 'workspace-splitter', 'browser-title', 'provider-youtube', // Phase 2: provider hint removed — feed toolbar now has single live status line (youtube-search-status) carrying provider context
    'provider-pexels', 'provider-social', 'provider-pinterest', 'pexels-kind-switch', 'pexels-video-kind', 'pexels-photo-kind', 'youtube-search-form', 'youtube-search-input', 'youtube-search-btn', 'youtube-search-prev', 'youtube-search-next', 'youtube-search-results', 'youtube-search-status', 'pexels-credit', 'pexels-link', 'youtube-paste-url', 'social-url-panel', 'pinterest-url-panel', 'youtube-url', 'load-youtube-btn', 'social-url', 'load-social-btn', 'pinterest-url', 'load-pinterest-btn',
    'back-to-results', 'inspector-title', 'youtube-status', 'youtube-metadata', 'source-monitor', 'youtube-thumbnail', 'preview-selected-btn', 'open-youtube-external-btn', 'preview-note', 'youtube-title', 'youtube-channel', 'pexels-attribution', 'youtube-duration', 'metadata-verified', 'pinterest-item-list', 'inspector-empty', 'inspector-loading', 'transfer-title', 'effective-output-summary', 'profile-output', 'youtube-profile', 'profile-controls', 'prores-warning', 'pinterest-original-note', 'youtube-media-controls', 'youtube-media-mode', 'video-controls', 'youtube-quality', 'quality-chips', 'audio-controls', 'youtube-audio-format', 'youtube-subtitle-controls', 'youtube-subtitles', 'youtube-subtitle-language', 'search-subtitles-btn', 'subtitle-search-query', 'subtitle-results', 'youtube-selection-controls', 'range-in', 'range-out', 'range-full-btn', 'chapter-list', 'intent-menu-btn', 'intent-menu', 'download-only-btn', 'youtube-intent', 'youtube-target-bin', 'timeline-placement-warning', 'download-youtube-btn', 'youtube-progress',
    'download-dock', 'youtube-download-queue', 'youtube-queue-status', 'workspace-status', 'open-downloads-folder-btn', 'history-panel', 'history-search-input', 'history-provider-filter', 'history-availability-filter', 'history-refresh-btn', 'history-status', 'history-list', 'history-show-more',
    'settings-close', 'pexels-setup', 'pexels-setup-summary', 'pexels-connection-status', 'pexels-api-key', 'pexels-connect-btn', 'pexels-disconnect-btn', 'pexels-key-link', 'pexels-save-note', 'settings-workspace-status', 'settings-download-folder', 'settings-folder-note', 'choose-download-folder-btn', 'open-workspace-btn', 'cleanup-workspace-btn', 'first-use-dialog', 'first-use-ack', 'pexels-preview-overlay', 'pexels-preview-video',
  ];
  for (const id of ids) elements.set(id, makeElement('div', id));
  for (const id of ['common-profile', 'common-quality', 'common-media-mode', 'common-audio-format', 'common-intent', 'common-target-bin', 'common-subtitle-language', 'youtube-profile', 'youtube-quality', 'youtube-media-mode', 'youtube-audio-format', 'youtube-subtitle-language', 'youtube-intent', 'youtube-target-bin', 'history-provider-filter', 'history-availability-filter']) elements.get(id).tagName = 'SELECT';
  for (const id of ['refresh-btn', 'settings-btn', 'pin-on-top-btn', 'surface-nav-search', 'surface-nav-queue', 'surface-nav-library', 'youtube-search-btn', 'youtube-search-prev', 'youtube-search-next', 'load-youtube-btn', 'load-social-btn', 'load-pinterest-btn', 'back-to-results', 'source-monitor', 'preview-selected-btn', 'open-youtube-external-btn', 'search-subtitles-btn', 'range-full-btn', 'download-youtube-btn', 'intent-menu-btn', 'download-only-btn', 'open-downloads-folder-btn', 'history-refresh-btn', 'history-show-more', 'settings-close', 'pexels-connect-btn', 'pexels-disconnect-btn', 'pexels-key-link', 'choose-download-folder-btn', 'open-workspace-btn', 'cleanup-workspace-btn', 'first-use-ack', 'select-all-results-btn', 'clear-selection-btn', 'enqueue-selected-btn']) elements.get(id).tagName = 'BUTTON';
  for (const id of ['youtube-subtitles', 'common-subtitles']) { elements.get(id).tagName = 'INPUT'; elements.get(id).type = 'checkbox'; }
  const intentMenu = elements.get('intent-menu');
  intentMenu.className = 'menu hidden'; intentMenu.setAttribute('role', 'menu');
  const intentTrigger = elements.get('intent-menu-btn');
  intentTrigger.setAttribute('aria-haspopup', 'menu'); intentTrigger.setAttribute('aria-expanded', 'false'); intentTrigger.setAttribute('aria-controls', 'intent-menu');
  elements.get('download-only-btn').className = 'btn sm hidden';
  for (const [intent, label] of [['download', 'Download only'], ['import', 'Add to Media Pool'], ['playhead', 'At playhead'], ['end', 'Timeline end']]) {
    const item = makeElement('button'); item.dataset.intent = intent; item.className = 'mi'; item.textContent = label; item.tabIndex = -1;
    item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(intent === 'download')); intentMenu.append(item);
  }
  elements.get('profile-controls').parentElement = elements.get('profile-output');
  for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
  for (const [id, value] of [['common-profile', 'original'], ['common-quality', 'best'], ['common-media-mode', 'video'], ['common-audio-format', 'mp3'], ['common-intent', 'download'], ['common-target-bin', 'active'], ['common-subtitle-language', 'en'], ['youtube-profile', 'original'], ['youtube-quality', 'best'], ['youtube-media-mode', 'video'], ['youtube-audio-format', 'mp3'], ['youtube-subtitle-language', 'en'], ['youtube-intent', 'download'], ['youtube-target-bin', 'active']]) elements.get(id).value = value;
  elements.get('youtube-search-results').getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 });
  elements.get('source-monitor').getBoundingClientRect = () => ({ left: 120, top: 160, right: 600, bottom: 430, width: 480, height: 270 });
  elements.get('inspector-pane').setAttribute('aria-hidden', 'true');

  const windowListeners = {};
  let animationFrameRequests = 0;
  const searches = [];
  const metadataCalls = [];
  const downloads = [];
  const transfers = [];
  const previewCalls = { open: [], close: 0, bounds: [], external: [] };
  let previewBoundsVisible = true;
  let previewListener = null;
  const page = {
    query: 'shots', page: 1, pageSize: 10,
    results: [
      { id: 'aaaaaaaaaaa', title: 'A', channel: 'One', duration: 10, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', thumbnailDataUrl: null, viewCount: null, publishedAt: null, channelVerified: false },
      { id: 'bbbbbbbbbbb', title: 'B', channel: 'Two', duration: 20, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', thumbnailDataUrl: null, viewCount: null, publishedAt: null, channelVerified: false },
    ], hasPrevious: false, hasNext: false, totalResults: 2, pageCount: 1,
  };
  const api = {
    getStatus: async () => ({ phase: 'ready', bridge: { connected: true, moduleVersion: 'test', resolveVersion: 'test', error: null }, project: { loaded: true, name: 'P' }, timeline: { loaded: true, name: 'T' }, message: 'Ready', refreshHint: null }),
    downloadFolderStatus: async () => ({ folder: '/Downloads/ClipDock', userSelected: false }), chooseDownloadFolder: async () => ({ folder: '/Downloads/ClipDock', userSelected: false }),
    onResolveQuit: () => () => undefined,
    setAlwaysOnTop: async (value) => value,
    searchYoutube: (query, number) => { const entry = {}; searches.push({ query, number, entry }); return new Promise((resolve) => { entry.resolve = resolve; }); },
    loadYoutube: async (url) => { metadataCalls.push(url); const id = new URL(url).searchParams.get('v') ?? 'aaaaaaaaaaa'; return { id, title: id === 'aaaaaaaaaaa' ? 'A metadata' : 'B metadata', duration: 60, channel: id === 'aaaaaaaaaaa' ? 'One' : 'Two', thumbnailDataUrl: null, heights: [1080], formatSummary: ['1080p'], chapters: [] }; },
    downloadYoutube: (url, quality, profile, jobId, options) => { const entry = { url, quality, profile, jobId, options }; entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; }); downloads.push(entry); return entry.promise; },
    cancelYoutube: async () => true, onYoutubeEvent: () => () => undefined,
    importToMediaPool: async (cardId, bin) => { transfers.push({ action: 'import', cardId, bin }); return { ok: true, kind: 'imported', message: 'Added to Media Pool.' }; },
    addToTimeline: async (cardId, bin, placement) => { transfers.push({ action: 'timeline', cardId, bin, placement }); return { ok: true, kind: 'timeline', message: placement === 'playhead' ? 'Added at playhead.' : 'Added to timeline end.' }; },
    pexelsKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), onPexelsEvent: () => () => undefined, onSocialEvent: () => () => undefined, onPinterestEvent: () => () => undefined,
    searchPexels: async () => ({ query: '', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0 }), loadPexels: async () => { throw new Error('unused'); }, downloadPexels: async () => { throw new Error('unused'); }, cancelPexels: async () => true, cancelPexelsRequests: async () => true,
    loadSocial: async () => { throw new Error('unused'); }, downloadSocial: async () => { throw new Error('unused'); }, cancelSocial: async () => true,
    loadPinterest: async () => { throw new Error('unused'); }, searchPinterest: async () => ({ query: '', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }), downloadPinterest: async () => { throw new Error('unused'); }, cancelPinterest: async () => true,
    openPexelsExternal: async () => true, openYoutubeExternal: async (id, start) => { previewCalls.external.push({ id, start }); return true; },
    openYoutubePreview: async (id, start, bounds) => { previewCalls.open.push({ id, start, bounds }); return true; }, closeYoutubePreview: async () => { previewCalls.close += 1; return true; }, setYoutubePreviewBounds: async (bounds) => { previewCalls.bounds.push(bounds); return previewBoundsVisible; }, onYoutubePreviewState: (callback) => { previewListener = callback; return () => { previewListener = null; }; },
    workspaceStatus: async () => ({ fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0 }), openWorkspace: async () => true, cleanupWorkspace: async () => ({ deletedFileCount: 0, deletedBytes: 0, fileCount: 0, totalBytes: 0 }),
    historyList: async () => [], historyReuse: async () => null, historyReveal: async () => true, historyRevealSubtitle: async () => true, historySource: async () => true, historyCopy: async () => true, historyRelink: async () => null, historyDelete: async () => ({ deleted: false, removed: false }), queueDelete: async () => ({ deleted: false, message: 'Not deleted.' }),
  };
  const document = {
    visibilityState: 'visible', body: { dataset: {}, classList: { add() {}, remove() {} } },
    get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeElement(tag), createTextNode: (text) => ({ textContent: text, tagName: '#TEXT', children: [] }),
    querySelector: (selector) => selector === '.advanced-options' ? makeElement('details') : selector === '.feed-toolbar' ? makeElement('div') : selector === '.inspector-thumb' ? makeElement('div') : null,
    querySelectorAll: (selector) => {
      if (selector !== '#youtube-search-results .result-card-thumbnail.card-thumb') return [];
      const thumbnails = [];
      const visit = (element) => { for (const child of element.children ?? []) { if (/\bresult-card-thumbnail\b/.test(child.className) && /\bcard-thumb\b/.test(child.className)) thumbnails.push(child); visit(child); } };
      visit(elements.get('youtube-search-results'));
      return thumbnails;
    }, addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  const preferences = new Map(Object.entries(preferencesInit));
  const preferenceWrites = [];
  const fakeWindow = { clipdockAPI: api, innerWidth: 960, innerHeight: 720, localStorage: { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => { preferences.set(key, String(value)); preferenceWrites.push([key, String(value)]); } }, matchMedia: () => ({ matches: false }), addEventListener: (type, callback) => { (windowListeners[type] ??= []).push(callback); }, removeEventListener: () => undefined, requestAnimationFrame: () => { animationFrameRequests += 1; return animationFrameRequests; }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined, confirm: () => true };
  const sandbox = { window: fakeWindow, document, console, Date, Intl, Math, Number, Promise, URL, WeakMap, Set, Map, queueMicrotask, crypto: { randomUUID: (() => { let i = 0; return () => `test-${++i}`; })(), getRandomValues: (value) => value }, setTimeout, clearTimeout };
  runInNewContext(eventsOnly ? `${renderer}\nglobalThis.__functionTest = { queue: () => queue };` : `${renderer}\nglobalThis.__functionTest = {\n  staged: () => Array.from(outputSession.staged.values()).map((entry) => ({ key: entry.key, snapshot: entry.snapshot, overrides: entry.overrides })),\n  stage: (entry) => (outputSession.edit('defaults', entry.snapshot), outputSession.stage(entry.key, entry), outputSession.edit(entry.key, entry.overrides)),\n  queue: () => queue,\n  enqueueSelected,\n  enqueueStagedSelection,\n  setSurface,\n  // Inline result-card seams for deterministic card UX checks. These are the exact\n  // functions the built renderer wires to the per-card controls (enqueue/now buttons,\n  // thumbnail play button, options disclosure, advanced -> detail Inspector).\n  enqueueResultCard: (key, selection, mode) => enqueueResultCard(key, selection, mode),\n  startYoutubePreview: (id, startAt, target, resultKey) => startYoutubePreview(id, startAt, target, resultKey),\n  stopPreview: () => stopPreview(),\n  updateYoutubePreviewBounds: () => updateYoutubePreviewBounds(),\n  openInspectorForSelection: (keyboardActivation) => openInspectorForSelection(keyboardActivation),\n  renderSearchResults: () => renderSearchResults(),\n  paintOutput: () => { renderProfile(); renderQuality(); },\n  syncResultCardThumbnailHeights,\n  scheduleResultCardThumbnailHeights,\n  optionsOpen: (key) => cardOptionsOpen.get(key),\n  cardEffectiveOutput: (key) => outputSession.output(key),\n  cardOutputOverrides: (key) => outputSession.overrides(key),\n  commitCardOutput: (key, value) => outputSession.edit(key, value),\n  activeQueueId: () => downloadQueue.activeId,\n};`, sandbox);
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
  const fireReady = async () => { for (const callback of windowListeners.DOMContentLoaded ?? []) callback(); await flush(); };
  return { elements, api, page, searches, metadataCalls, downloads, transfers, previewCalls, setPreviewBoundsVisible: (visible) => { previewBoundsVisible = visible; }, previewState: (state) => previewListener?.(state), preferences, preferenceWrites, windowListeners, get animationFrameRequests() { return animationFrameRequests; }, get activeElement() { return activeElement; }, keydown: (event) => { for (const callback of windowListeners.keydown ?? []) callback({ preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...event }); }, flush, fireReady, test: sandbox.__functionTest };
}
