// Renderer history search, filtering, pagination, accessibility and opaque drag payloads.
// Main-process ownership behaviour is covered directly in download-ledger.test.mjs.
// The renderer remains a browser script, exercised here through its DOM/API entry points.
import { createFakeDom } from './helpers/fake-dom.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const rendererSource = readFileSync(path.join(dist, 'renderer.js'), 'utf8');

function historyRecord(over = {}) {
  return {
    id: 'h1',
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    project: null,
    fileName: 'clip.mp4',
    bytes: 1234,
    assetId: 'dQw4w9WgXcQ',
    title: 'Title',
    creator: 'Channel',
    profile: 'original',
    quality: '1080p',
    mediaMode: 'video',
    selection: null,
    automation: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: [] },
    createdAt: 1,
    lastUsedAt: 1,
    available: true,
    ...over,
  };
}

const { makeElement } = createFakeDom({ onFocus: node => { focused = node; } });

let focused = null;

// Loads dist/renderer.js in a vm with a fake DOM + API and returns the context
// plus the fake elements. `hostPhase` seeds hostStatus (null = bridge-error-ish
// fixture states are expressed through the replacement).
function loadRenderer({ records = [], hostStatus = null, historyListImpl = null, historyDeleteImpl = null } = {}) {
  const elements = new Map();
  focused = null;
  const document = {
    get activeElement() { return focused; },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
  };
  const nativeDragCalls = [];
  const api = {
    getStatus: async () => ({ phase: 'ready', bridge: { connected: true }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null }),
    onResolveQuit: () => () => undefined,
    selectFile: async () => ({ canceled: true }),
    startNativeDrag: (cardId) => { nativeDragCalls.push(cardId); },
    importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }),
    addToTimeline: async () => ({ ok: true, kind: 'timeline-appended', message: 'Added.' }),
    searchYoutube: async () => ({ results: [] }),
    loadYoutube: async () => ({}),
    downloadYoutube: async () => ({ cardId: 'c', fileName: 'f.mp4' }),
    cancelYoutube: async () => false,
    searchSubtitles: async () => [],
    onYoutubeEvent: () => () => undefined,
    setAlwaysOnTop: async (pinned) => pinned,
    pexelsKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }),
    setPexelsKey: async () => ({ connected: true, persisted: true, message: 'Connected' }),
    clearPexelsKey: async () => ({ connected: false, persisted: false, message: 'Disconnected' }),
    searchPexels: async () => ({ results: [] }),
    loadPexels: async () => ({}),
    downloadPexels: async () => ({ cardId: 'c', fileName: 'f.mp4' }),
    cancelPexels: async () => false,
    cancelPexelsRequests: async () => true,
    onPexelsEvent: () => () => undefined,
    openPexelsExternal: async () => true,
    openYoutubeExternal: async () => true,
    workspaceStatus: async () => ({ fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0 }),
    openWorkspace: async () => true,
    cleanupWorkspace: async () => ({ deletedFileCount: 0, deletedBytes: 0, fileCount: 0, totalBytes: 0 }),
    historyList: historyListImpl ?? (async () => records),
    historyReuse: async () => null,
    historyReveal: async () => false,
    historySource: async () => false,
    historyCopy: async () => false,
    historyRelink: async () => null,
    historyDelete: historyDeleteImpl ?? (async () => ({ deleted: false, removed: false })),
    queueDelete: async () => ({ deleted: false, message: 'kept' }),
  };
  const fakeWindow = {
    clipdockAPI: api,
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem: () => undefined },
    innerWidth: 960,
    innerHeight: 720,
    confirm: () => true,
  };
  for (const id of ['message', 'history-list', 'history-status', 'history-show-more', 'history-search-input', 'history-provider-filter', 'history-availability-filter', 'history-refresh-btn', 'youtube-target-bin']) {
    const tag = id === 'history-status' ? 'p' : id === 'history-search-input' ? 'input' : id === 'history-provider-filter' || id === 'history-availability-filter' ? 'select' : id === 'history-show-more' || id === 'history-refresh-btn' ? 'button' : 'div';
    elements.set(id, makeElement(tag));
  }
  elements.get('history-provider-filter').value = 'all';
  elements.get('history-availability-filter').value = 'all';
  elements.get('youtube-target-bin').value = 'active';
  let source = rendererSource;
  if (hostStatus !== null) {
    const replaced = source.replace('let hostStatus = null;', `let hostStatus = ${JSON.stringify(hostStatus)};`);
    assert.notEqual(replaced, source, 'hostStatus seed must exist in renderer');
    source = replaced;
  }
  let uuid = 0;
  const sandbox = {
    window: fakeWindow,
    document,
    URL,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    Date,
    Math,
    Number,
    Intl,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  runInNewContext(source, sandbox);
  sandbox.wireHistoryControls();
  return { context: sandbox, elements, nativeDragCalls, api };
}

test('pure history search is trimmed, case-insensitive, and spans every indexed field in order', () => {
  const { context } = loadRenderer();
  const youtube = historyRecord({ id: 'r1', title: 'Sunset City Drone', fileName: 'sunset.mp4', provider: 'youtube', source: 'https://www.youtube.com/watch?v=aaa', assetId: 'aaa', creator: 'Aerial Films' });
  const pexels = historyRecord({ id: 'r2', title: 'Tutorial', fileName: 'TUTORIAL-FINAL.mov', provider: 'pexels', source: 'https://www.pexels.com/video/1/', assetId: 'video:1', creator: 'Stock Co' });
  const social = historyRecord({ id: 'r3', title: 'Interview', fileName: 'interview.mp4', provider: 'social', source: 'https://www.instagram.com/reel/ABC/', assetId: 'instagram:xx', creator: 'Newsroom' });
  const records = [youtube, pexels, social];
  const all = (q) => context.filterHistoryRecords(records, q, 'all', 'all').map((r) => r.id);
  assert.deepEqual(all('tutorial'), ['r2'], 'title matches case-insensitively');
  assert.deepEqual(all('TUTORIAL'), ['r2'], 'uppercase query matches lowercase title');
  assert.deepEqual(all('  sunset  '), ['r1'], 'query is trimmed');
  assert.deepEqual(all('aerial'), ['r1'], 'creator is indexed');
  assert.deepEqual(all('pexels'), ['r2'], 'provider label is indexed');
  assert.deepEqual(all('youtube'), ['r1'], 'raw provider is indexed');
  assert.deepEqual(all('instagram:xx'), ['r3'], 'assetId is indexed');
  assert.deepEqual(all('watch?v=aaa'), ['r1'], 'source is indexed');
  assert.deepEqual(all('final'), ['r2'], 'fileName is indexed');
  assert.deepEqual(all('zzz-no-match'), [], 'no match returns empty');
  assert.deepEqual(all(''), ['r1', 'r2', 'r3'], 'empty query keeps backend order');
});

test('provider and availability filters compose deterministically', () => {
  const { context } = loadRenderer();
  const records = [
    historyRecord({ id: 'a', provider: 'youtube', available: true }),
    historyRecord({ id: 'b', provider: 'youtube', available: false }),
    historyRecord({ id: 'c', provider: 'pexels', available: true }),
    historyRecord({ id: 'd', provider: 'pexels', available: false }),
    historyRecord({ id: 'e', provider: 'social', available: true }),
    historyRecord({ id: 'f', provider: 'social', available: false }),
  ];
  const ids = (q, p, a) => context.filterHistoryRecords(records, q, p, a).map((r) => r.id);
  assert.deepEqual(ids('', 'all', 'all'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids('', 'youtube', 'all'), ['a', 'b']);
  assert.deepEqual(ids('', 'pexels', 'all'), ['c', 'd']);
  assert.deepEqual(ids('', 'social', 'all'), ['e', 'f']);
  assert.deepEqual(ids('', 'all', 'available'), ['a', 'c', 'e']);
  assert.deepEqual(ids('', 'all', 'missing'), ['b', 'd', 'f']);
  assert.deepEqual(ids('', 'pexels', 'available'), ['c']);
  assert.deepEqual(ids('', 'social', 'missing'), ['f']);
  assert.deepEqual(ids('', 'youtube', 'available'), ['a']);
});

test('history shows 20 then 40 rows and a truthful count status; Show more hides when exhausted', async () => {
  const records = Array.from({ length: 45 }, (_, i) => historyRecord({ id: `h${i + 1}`, title: `Record ${i + 1}`, fileName: `clip-${i + 1}.mp4`, bytes: i }));
  const { context, elements } = loadRenderer({ records });
  await context.refreshHistory();
  assert.equal(elements.get('history-list').children.length, 20, 'initial visible batch is 20');
  assert.equal(elements.get('history-status').textContent, 'Showing 20 of 45 downloads.');
  assert.equal(elements.get('history-show-more').classList.contains('hidden'), false);
  elements.get('history-show-more').listeners.click();
  assert.equal(elements.get('history-list').children.length, 40, 'Show more adds exactly 20');
  assert.equal(elements.get('history-status').textContent, 'Showing 40 of 45 downloads.');
  elements.get('history-show-more').listeners.click();
  assert.equal(elements.get('history-list').children.length, 45);
  assert.equal(elements.get('history-status').textContent, 'Showing 45 of 45 downloads.');
  assert.equal(elements.get('history-show-more').classList.contains('hidden'), true, 'Show more hides once everything is visible');
  // Order stays newest-first (backend order), not reordered by the library.
  assert.equal(elements.get('history-list').children[0].dataset.recordId, 'h1');
  assert.equal(elements.get('history-list').children[44].dataset.recordId, 'h45');
});

test('query and filter changes reset the visible batch back to 20', async () => {
  const records = Array.from({ length: 45 }, (_, i) => historyRecord({ id: `h${i + 1}`, title: `Record ${i + 1}`, fileName: `clip-${i + 1}.mp4`, bytes: i }));
  const { context, elements } = loadRenderer({ records });
  await context.refreshHistory();
  elements.get('history-show-more').listeners.click(); // 40 visible
  assert.equal(elements.get('history-list').children.length, 40);
  elements.get('history-search-input').value = 'Record 33';
  elements.get('history-search-input').listeners.input();
  assert.equal(elements.get('history-list').children.length, 1, 'query change resets batch and filters');
  elements.get('history-show-more').listeners.click();
  assert.equal(elements.get('history-list').children.length, 1, 'all matches visible, Show more no-op');
  elements.get('history-search-input').value = '';
  elements.get('history-search-input').listeners.input();
  assert.equal(elements.get('history-list').children.length, 20, 'clearing query resets batch to 20');
  elements.get('history-show-more').listeners.click(); // 40
  elements.get('history-provider-filter').value = 'youtube';
  elements.get('history-provider-filter').listeners.change();
  assert.equal(elements.get('history-list').children.length, 20, 'provider change resets batch');
  elements.get('history-show-more').listeners.click(); // 40
  elements.get('history-availability-filter').value = 'missing';
  elements.get('history-availability-filter').listeners.change();
  assert.equal(elements.get('history-list').children.length, 0, 'availability change resets batch and filters');
  assert.equal(elements.get('history-status').textContent, 'No history entries match the current search or filters.');
});

test('aria-live status covers loading, empty, and no-match states', async () => {
  const { context, elements, api } = loadRenderer({ records: [] });
  let resolveList = null;
  api.historyList = () => new Promise((resolve) => { resolveList = resolve; });
  const pending = context.refreshHistory();
  assert.equal(elements.get('history-status').textContent, 'Loading history…');
  resolveList([]);
  await pending;
  assert.equal(elements.get('history-status').textContent, 'No downloads in history yet.');
  api.historyList = async () => [historyRecord({ id: 'only', title: 'Solo' })];
  await context.refreshHistory();
  elements.get('history-search-input').value = 'nothing matches';
  elements.get('history-search-input').listeners.input();
  assert.equal(elements.get('history-status').textContent, 'No history entries match the current search or filters.');
  assert.equal(elements.get('history-status').getAttribute('role'), null, 'role lives on the static markup');
  elements.get('history-search-input').value = '';
  elements.get('history-search-input').listeners.input();
  assert.equal(elements.get('history-status').textContent, 'Showing 1 of 1 download.');
});

test('history delete reports file and record outcomes without claiming false success', async () => {
  let result = { deleted: false, removed: true };
  const record = historyRecord({ id: 'delete-me', fileName: 'managed.mp4' });
  const { context, elements } = loadRenderer({ records: [record], historyDeleteImpl: async () => result });
  const message = elements.get('message');

  await context.historyAction(record, 'delete');
  assert.equal(message.textContent, 'Removed from history. The file was kept.');
  assert.equal(message.classList.contains('err'), true, 'kept-file outcome is visible as attention, not success');

  result = { deleted: false, removed: false };
  await context.historyAction(record, 'delete');
  assert.equal(message.textContent, 'Nothing was removed. The file was kept.');
  assert.equal(message.classList.contains('err'), true);

  result = { deleted: true, removed: true };
  await context.historyAction(record, 'delete');
  assert.equal(message.textContent, 'Removed from history and deleted the managed file.');
  assert.equal(message.classList.contains('ok'), true);

  result = { deleted: true, removed: true, warning: 'Download history could not be updated.' };
  await context.historyAction(record, 'delete');
  assert.equal(message.textContent, 'File deleted, but download history could not be updated.');
  assert.equal(message.classList.contains('err'), true, 'persistence warning is never presented as full success');
});

test('long titles and file names stay contained and searchable end-to-end', async () => {
  const longTitle = 'A'.repeat(600);
  const longFileName = `${'B'.repeat(300)}.mp4`;
  const record = historyRecord({ id: 'long', title: longTitle, fileName: longFileName });
  const { context, elements } = loadRenderer({ records: [record] });
  await context.refreshHistory();
  const summary = elements.get('history-list').children[0].children[0];
  assert.ok(summary.textContent.includes(longTitle), 'full long title stays in the row');
  assert.ok(summary.textContent.includes(longFileName), 'full long file name stays in the row');
  assert.deepEqual(context.filterHistoryRecords([record], 'BBB', 'all', 'all').map((r) => r.id), ['long'], 'long text is searchable');
  const css = readFileSync(path.join(dist, 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.history-row\s*>\s*span\s*\{[^}]*text-overflow:\s*ellipsis[^}]*}/, 'history rows must ellipsize long text');
  assert.match(css, /\.history-toolbar[^}]*\{[^}]*min-width:\s*0[^}]*}/, 'history toolbar input must contain long queries');
});

test('available history row drag sends exactly its opaque cardId and no path', async () => {
  const records = [historyRecord({ id: 'h1', cardId: 'hist-card-1', fileName: 'clip.mp4' })];
  const { context, elements, nativeDragCalls } = loadRenderer({ records, hostStatus: { phase: 'ready', project: { loaded: true }, timeline: { loaded: true } } });
  await context.refreshHistory();
  const row = elements.get('history-list').children[0];
  assert.equal(row.draggable, true);
  assert.match(row.getAttribute('aria-label'), /Drag to Resolve/);
  let prevented = false;
  row.listeners.dragstart({ preventDefault() { prevented = true; }, dataTransfer: null });
  assert.deepEqual(nativeDragCalls, ['hist-card-1'], 'drag sends exactly the opaque cardId');
  assert.equal(prevented, true, 'native drag path prevents the default browser drag');
  const payload = JSON.stringify(records[0]);
  assert.ok(!payload.includes('/tmp') && !payload.includes('filePath'), 'renderer fixture carries no paths');
});

test('missing rows never drag and expose a relink reason', async () => {
  const records = [historyRecord({ id: 'gone', available: false, cardId: 'hist-gone' })];
  const { context, elements } = loadRenderer({ records, hostStatus: { phase: 'ready', project: { loaded: true }, timeline: { loaded: true } } });
  await context.refreshHistory();
  const row = elements.get('history-list').children[0];
  assert.equal(row.draggable, false);
  assert.equal(row.listeners.dragstart, undefined, 'missing row has no dragstart listener');
  assert.match(row.getAttribute('aria-label'), /missing/i);
  assert.match(row.title, /Relink/i);
  const menu = row.children.find((child) => /\bhistory-menu\b/.test(child.className));
  assert.deepEqual(menu.children.map((item) => item.textContent), ['Open source', 'Relink…', 'Delete'], 'a missing file offers only actions that can work');
  assert.equal(menu.title, '', 'the row tooltip must not cover the open menu');
});

test('available rows without a bound cardId never drag and point at the More menu', async () => {
  const records = [historyRecord({ id: 'unbound' })];
  const { context, elements } = loadRenderer({ records, hostStatus: { phase: 'ready', project: { loaded: true }, timeline: { loaded: true } } });
  await context.refreshHistory();
  const row = elements.get('history-list').children[0];
  assert.equal(row.draggable, false);
  assert.match(row.getAttribute('aria-label'), /More menu/i);
});

test('host blockers disable drag while a ready local install allows it', async () => {
  const hostBlocked = loadRenderer({ records: [historyRecord({ id: 'nb', cardId: 'hist-nb' })], hostStatus: { phase: 'no-project', bridge: { connected: true }, project: { loaded: false }, timeline: { loaded: false } } });
  await hostBlocked.context.refreshHistory();
  const row1 = hostBlocked.elements.get('history-list').children[0];
  assert.equal(row1.draggable, false);
  assert.match(row1.title, /Open a project/i);

  const ready = loadRenderer({ records: [historyRecord({ id: 'lb', cardId: 'hist-lb' })], hostStatus: { phase: 'ready', project: { loaded: true }, timeline: { loaded: true } } });
  await ready.context.refreshHistory();
  const row2 = ready.elements.get('history-list').children[0];
  assert.equal(row2.draggable, true);
  assert.equal(row2.title, '');
});

test('history toolbar controls carry accessible labels in the shipped markup', () => {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /<label class="sr-only" for="history-search-input">/, 'search input has an accessible label');
  assert.match(html, /<label class="sr-only" for="history-provider-filter">/, 'provider select has an accessible label');
  assert.match(html, /<label class="sr-only" for="history-availability-filter">/, 'availability select has an accessible label');
  assert.match(html, /id="history-status"[^>]*role="status"[^>]*aria-live="polite"/, 'history status is an aria-live region');
});
