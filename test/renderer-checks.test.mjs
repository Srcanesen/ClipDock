import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createFakeDom } from './helpers/fake-dom.mjs';
import { REQUIRED_HTML_IDS_FLAT } from '../scripts/lib/contracts.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);
const focusedExpect = expect;
const fail = (message) => assert.fail(message);

test('compact metadata formatting and subtitle/chapter selections', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  const formatContext = { window: { addEventListener: () => undefined, matchMedia: () => ({ matches: false }) }, document: {}, console, Date, Intl, setTimeout, clearTimeout, queueMicrotask };
  runInNewContext(renderer, formatContext);
  const formatMetaNow = formatContext.formatMeta;
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const [label, got, want] of [
    ['verified compact views and years', formatMetaNow({ channel: 'Channel', channelVerified: true, viewCount: 1_234_567, publishedAt: nowSeconds - 2 * 365 * 86400 }), 'Channel ✓ · 1.2M views · 2 years ago'],
    ['near-year values stay in months', formatMetaNow({ channel: 'Channel', channelVerified: false, viewCount: 980, publishedAt: nowSeconds - 360 * 86400 }), 'Channel · 980 views · 12 months ago'],
    ['future publish dates clamp', formatMetaNow({ channel: null, channelVerified: false, viewCount: null, publishedAt: nowSeconds + 3600 }), 'just now'],
  ]) assert.equal(Boolean(got === want), true, `current renderer ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const subtitleCues = [{ start: 1, end: 2, text: 'Hello World' }, { start: 4, end: 5.5, text: 'HELLO again' }, { start: 8, end: 9, text: 'Other' }];
  focusedExpect('renderer: subtitle query filters text case-insensitively', formatContext.filterSubtitleCues(subtitleCues, 'hello').map(({ index }) => index), [0, 1]);
  focusedExpect('renderer: multi-cue selection spans first start through last end', formatContext.subtitleSelectionRange(subtitleCues, [1, 0]), { start: 1, end: 5.5, label: '2 subtitle cues' });
  const chapters = [{ start: 0, end: 12, title: 'Intro' }, { start: 12, end: 30, title: 'Main' }, { start: 30, end: 40, title: 'End' }];
  focusedExpect('renderer: chapter selection spans earliest start through latest end', [formatContext.chapterSelectionRange(chapters, [2, 0]), formatContext.chapterSelectionRange(chapters, [1]), formatContext.chapterSelectionRange(chapters, [])], [{ start: 0, end: 40, label: '2 chapters' }, { start: 12, end: 30, label: 'Main' }, null]);
});

test('history action menu keyboard and direct handoff', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const list = { children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } }; let focused = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { focused = node; }, bounds: { right: 500, top: 400 } });
    const record = { id: 'h1', provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', project: 'P', fileName: 'clip.mp4', bytes: 5, assetId: 'dQw4w9WgXcQ', title: 'Clip', creator: 'Channel', profile: 'original', quality: '1080p', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: [] }, createdAt: 1, lastUsedAt: 1, available: true };
    const elements = new Map([['history-list', list], ['youtube-target-bin', makeElement('select')], ['message', makeElement('p')]]); elements.get('youtube-target-bin').value = 'clipdock'; let timelineCall = null;
    const document = { get activeElement() { return focused; }, getElementById: (id) => elements.get(id) ?? null, createElement: makeElement };
    const context = { window: { innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, clipdockAPI: { historyList: async () => [record], historyReuse: async () => ({ cardId: 'restored-card', fileName: 'clip.mp4' }), importToMediaPool: async (...args) => { timelineCall = args; return { ok: true, kind: 'imported', message: 'Imported.' }; }, addToTimeline: async (...args) => { timelineCall = args; return { ok: true, kind: 'timeline-appended', message: 'Added.' }; } } }, document, console, Date, Intl, Math, Number, WeakMap, Set, Map };
    runInNewContext(`${renderer}\nhostStatus = { phase: 'ready', project: { loaded: true }, timeline: { loaded: true } }; outputSession.edit('inspector', { targetBin: 'clipdock' });`, context); await context.refreshHistory(); const row = list.children[0], more = row.children[1], menu = row.children[2]; more.click(); const visibleFromMore = !menu.classList.contains('hidden') && more.getAttribute('aria-expanded') === 'true' && focused === menu.children[0]; context.closeHistoryActions(true); row.listeners.contextmenu({ preventDefault() {} }); const visibleFromContext = !menu.classList.contains('hidden'); context.closeHistoryActions(); row.listeners.keydown({ key: 'F10', shiftKey: true, preventDefault() {} }); focusedExpect('history: More/contextmenu/Shift+F10 open real button menu', [visibleFromMore, visibleFromContext, !menu.classList.contains('hidden'), menu.children.map((item) => item.textContent)], [true, true, true, ['Add to Media Pool', 'Add at playhead', 'Add to timeline end', 'Reveal in Finder', 'Open source', 'Copy path', 'Relink…', 'Delete']]);
    const menuKey = (key) => menu.listeners.keydown({ key, preventDefault() {}, stopPropagation() {} }); menuKey('ArrowDown'); const arrowDown = focused === menu.children[1]; menuKey('End'); const end = focused === menu.children.at(-1); menuKey('ArrowDown'); const wrappedDown = focused === menu.children[0]; menuKey('Home'); const home = focused === menu.children[0]; menuKey('ArrowUp'); const wrappedUp = focused === menu.children.at(-1); menuKey('Escape'); focusedExpect('history: menu arrows/Home/End wrap and Escape restores More focus', [arrowDown, end, wrappedDown, home, wrappedUp, menu.classList.contains('hidden'), more.getAttribute('aria-expanded'), focused === more], [true, true, true, true, true, true, 'false', true]);
    await context.useHistoryRecord(record, 'end'); focusedExpect('history: direct Add to timeline reuses card through transfer seam', [timelineCall, elements.get('message').textContent], [['restored-card', 'active', 'end'], 'Added.']);
  }
});

test('search races, metadata loading and truthful rows', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','youtube-quality','youtube-media-mode','youtube-audio-format','youtube-subtitles','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-profile','prores-warning','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-formats','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','youtube-search-form','pin-on-top-btn'];
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'download'; elements.get('destination').value = 'active'; elements.get('timeline-placement').value = 'end'; elements.get('youtube-quality').value = 'best';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : null };
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const rows = () => elements.get('youtube-search-results').children;
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const searchResolvers = []; const loadResolvers = []; let loadCalls = 0;
    const pageOf = (query, results) => ({ query, page: 1, pageSize: 10, results, hasPrevious: false, hasNext: false, totalResults: results.length, pageCount: 1 });
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: () => undefined,
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }), addToTimeline: async () => ({ ok: true, kind: 'timeline-appended', message: 'Added.' }),
      searchYoutube: (query, page) => new Promise((resolve, reject) => searchResolvers.push({ resolve, reject, query, page })),
      loadYoutube: () => { loadCalls += 1; return new Promise((resolve, reject) => loadResolvers.push({ resolve, reject })); },
      downloadYoutube: async () => ({ cardId: 'c', fileName: 'x.mp4' }), cancelYoutube: async () => true, onYoutubeEvent: () => () => undefined,
    };
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout, location: { search: '' } };
    runInNewContext(renderer, { window: fakeWindow, document, crypto: { randomUUID: () => 'ui-' + Math.random(), getRandomValues: (x) => x }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    windowListeners.DOMContentLoaded();
    await flush();
    snapshot.phase = 'no-timeline'; snapshot.project.name = null; snapshot.timeline.loaded = false; snapshot.timeline.name = null;
    elements.get('refresh-btn').click(); await flush();
    expect('loaded unnamed project is never labeled closed and missing timeline is explicit', [elements.get('project-name').textContent, elements.get('timeline-name').textContent], ['Untitled project', 'No active timeline/comp']);
    snapshot.phase = 'ready'; snapshot.project.name = 'p'; snapshot.timeline.loaded = true; snapshot.timeline.name = 't';

    // --- Search race: a generation token lets only the newest success/error/finally mutate state ---
    elements.get('youtube-search-input').value = 'alpha';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    elements.get('youtube-search-input').value = 'beta';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await flush();
    expect('overlapping searches stay in flight', searchResolvers.length, 2);
    searchResolvers[1].resolve(pageOf('beta', [{ id: 'bbbbbbbbbbb', title: 'Beta result 1', channel: null, duration: null, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false }]));
    await flush();
    searchResolvers[0].resolve(pageOf('alpha', [{ id: 'aaaaaaaaaaa', title: 'Stale alpha result', channel: null, duration: null, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false }]));
    await flush();
    expect('stale search success cannot clobber the newest page', [rows().length, rows()[0].children[1].children[0].textContent, elements.get('youtube-search-status').textContent], [1, 'Beta result 1', 'Page 1 of 1 · 1 results']);
    expect('search busy resets exactly once after the newest settles', elements.get('youtube-search-btn').disabled, false);

    // --- Search race: a stale error cannot clobber newer success ---
    elements.get('youtube-search-input').value = 'gamma';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    elements.get('youtube-search-input').value = 'delta';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await flush();
    searchResolvers[3].resolve(pageOf('delta', [{ id: 'ddddddddddd', title: 'Delta result', channel: null, duration: null, url: 'https://www.youtube.com/watch?v=ddddddddddd', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false }]));
    await flush();
    searchResolvers[2].reject(new Error('stale search failure'));
    await flush();
    expect('stale search error is dropped', [rows()[0].children[1].children[0].textContent, elements.get('youtube-search-status').textContent.includes('stale search failure')], ['Delta result', false]);

    // --- Selecting a video clears the stale inspector, shows explicit loading, blocks stale enqueue ---
    const pickItems = [
      { id: 'pickaaaaaaa', title: 'Pick A', channel: 'C', duration: 60, url: 'https://www.youtube.com/watch?v=pickaaaaaaa', thumbnailUrl: 'data:image/jpeg;base64,AQ==', viewCount: 5, publishedAt: null, channelVerified: false },
      { id: 'pickbbbbbbb', title: 'Pick B', channel: 'C', duration: 61, url: 'https://www.youtube.com/watch?v=pickbbbbbbb', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false },
    ];
    elements.get('youtube-search-input').value = 'pick';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await flush();
    searchResolvers[4].resolve(pageOf('pick', pickItems));
    await flush();
    const cardAction = (root, action) => { for (const child of root.children ?? []) { if (child.dataset?.cardAction === action) return child; const nested = cardAction(child, action); if (nested) return nested; } return null; };
    cardAction(rows()[0], 'advanced').click(); await flush();
    expect('selecting a video shows its row before metadata resolves', [elements.get('youtube-metadata').classList.contains('hidden'), elements.get('inspector-loading').classList.contains('hidden'), elements.get('inspector-empty').classList.contains('hidden'), elements.get('youtube-status').textContent], [false, false, true, 'Loading video…']);
    expect('selected title appears while metadata is pending', elements.get('youtube-title').textContent, 'Pick A');
    expect('quality area is a skeleton', elements.get('quality-chips').children.map(child => child.className), ['skeleton-chip', 'skeleton-chip', 'skeleton-chip']);
    expect('a stale video cannot be enqueued while loading', [elements.get('youtube-download-queue').children.length, elements.get('download-youtube-btn').disabled], [0, true]);
    cardAction(rows()[1], 'advanced').click(); await flush();
    expect('two metadata loads race behind a generation token', loadResolvers.length, 2);
    loadResolvers[0].resolve({ id: 'pickaaaaaaa', title: 'Stale meta A', duration: 60, channel: 'C', thumbnailUrl: null, heights: [720], formatSummary: ['720p'] });
    await flush();
    expect('stale metadata result is dropped (no stale enqueue source)', elements.get('youtube-title').textContent, 'Pick B');
    loadResolvers[1].resolve({ id: 'pickbbbbbbb', title: 'Meta B', duration: 61, channel: 'C', thumbnailUrl: 'data:image/jpeg;base64,AQ==', heights: [720, 2160], formatSummary: ['720p', '2160p'] });
    await flush();
    expect('newest metadata wins and restores the inspector', [elements.get('youtube-title').textContent, elements.get('youtube-metadata').classList.contains('hidden'), elements.get('inspector-loading').classList.contains('hidden'), elements.get('youtube-thumbnail').alt], ['Meta B', false, true, 'Meta B']);

    // --- Metadata failure restores the empty inspector with the controlled error ---
    cardAction(rows()[0], 'advanced').click(); await flush();
    loadResolvers[2].reject(new Error('metadata unavailable'));
    await flush();
    expect('metadata failure clears loading and shows the controlled error', [elements.get('youtube-metadata').classList.contains('hidden'), elements.get('inspector-loading').classList.contains('hidden'), elements.get('inspector-empty').classList.contains('hidden'), elements.get('youtube-status').textContent], [true, true, false, 'metadata unavailable']);

    // --- Search row content: long titles, null metadata, verified/age, duration badges, alt text ---
    const now = Math.floor(Date.now() / 1000);
    const rich = { id: 'aaaaaaaaaaa', title: `Long title ${'that keeps going '.repeat(8)}with a final tail for the clamp`, channel: 'Channel', duration: 7541, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', thumbnailUrl: 'data:image/jpeg;base64,AQ==', viewCount: 1234567, publishedAt: now - 2 * 365 * 86400, channelVerified: true };
    const bare = { id: 'bbbbbbbbbbb', title: 'Bare result', channel: null, duration: null, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false };
    const viewsK = { id: 'ccccccccccc', title: 'Small views', channel: 'C', duration: 61, url: 'https://www.youtube.com/watch?v=ccccccccccc', thumbnailUrl: 'data:image/jpeg;base64,AQ==', viewCount: 980, publishedAt: now - 360 * 86400, channelVerified: false };
    const views45k = { id: 'ddddddddddd', title: 'Forty five K', channel: 'D', duration: 3601, url: 'https://www.youtube.com/watch?v=ddddddddddd', thumbnailUrl: 'data:image/jpeg;base64,AQ==', viewCount: 45000, publishedAt: now - 3 * 86400, channelVerified: false };
    elements.get('youtube-search-input').value = 'rich';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await flush();
    searchResolvers[5].resolve(pageOf('rich', [rich, bare, viewsK, views45k]));
    await flush();
    const contentRows = rows();
    expect('long title stays full text in the DOM (CSS clamps)', contentRows[0].children[1].children[0].textContent, rich.title);
    const richMeta = contentRows[0].children[1].children[1].textContent;
    expect('meta line carries verified mark, compact views, relative age', [richMeta.includes('Channel ✓'), richMeta.includes('1.2M views'), richMeta.includes('2 years ago')], [true, true, true]);
    expect('duration badge formats h:mm:ss', contentRows[0].children[0].children[1].textContent, '2:05:41');
    {
      const thumb = contentRows[1].children[0];
      const metaText = contentRows[1].children[1].children[1].textContent;
      const hasDurationBadge = thumb.children.some((child) => child.dataset?.field === 'duration' || String(child.className).includes('youtube-duration'));
      const findPlay = (node) => { for (const child of node.children ?? []) { if (child.dataset?.cardAction === 'play') return true; if (findPlay(child)) return true; } return false; };
      const hasPlay = findPlay(thumb);
      const hasFallback = thumb.textContent.includes('Thumbnail unavailable') || thumb.children.some((child) => String(child.className).includes('thumbnail-fallback-label') || String(child.textContent).includes('Thumbnail unavailable'));
      expect('null metadata omits duration badge, keeps card play, leaves meta empty and shows fallback label', [hasDurationBadge, hasPlay, metaText, hasFallback], [false, true, '', true]);
    }
    const kMeta = contentRows[2].children[1].children[1].textContent;
    expect('small view counts and month bucket', [kMeta.includes('980 views'), kMeta.includes('12 months ago')], [true, true]);
    expect('thousands use K and hours use h:mm:ss', [contentRows[3].children[1].children[1].textContent.includes('45K views'), contentRows[3].children[0].children[1].textContent], [true, '1:00:01']);
    expect('search thumbnails carry the video title as alt text', contentRows[0].children[0].children[0].alt, rich.title);
  }
});

test('result keyboard navigation and preview isolation', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','youtube-quality','youtube-media-mode','youtube-audio-format','youtube-subtitles','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-profile','prores-warning','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-formats','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','youtube-search-form','pin-on-top-btn'];
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'download'; elements.get('destination').value = 'active'; elements.get('timeline-placement').value = 'end'; elements.get('youtube-quality').value = 'best';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : null };
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const rows = () => elements.get('youtube-search-results').children;
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    let loadCalls = 0;
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: () => undefined,
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }), addToTimeline: async () => ({ ok: true, kind: 'timeline-appended', message: 'Added.' }),
      searchYoutube: async (query, page) => ({ query, page, pageSize: 10, results: Array.from({ length: 10 }, (_, i) => ({ id: `result${String(i + 1).padStart(5, '0')}`, title: `Result ${i + 1}`, channel: null, duration: null, url: `https://www.youtube.com/watch?v=result${String(i + 1).padStart(5, '0')}`, thumbnailUrl: null, viewCount: null, publishedAt: null, channelVerified: false })), hasPrevious: false, hasNext: false, totalResults: 10, pageCount: 1 }),
      loadYoutube: () => { loadCalls += 1; return new Promise(() => {}); },
      downloadYoutube: async () => ({ cardId: 'c', fileName: 'x.mp4' }), cancelYoutube: async () => true, onYoutubeEvent: () => () => undefined,
    };
    let narrowResults = false;
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: (query) => ({ matches: narrowResults && query === '(max-width: 559px)' }), setTimeout, clearTimeout, location: { search: '' } };
    runInNewContext(renderer, { window: fakeWindow, document, crypto: { randomUUID: () => 'ui-' + Math.random(), getRandomValues: (x) => x }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    windowListeners.DOMContentLoaded();
    elements.get('youtube-search-input').value = 'q';
    elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    await flush();
    const resultRows = rows();
    let downFromInput = false;
    elements.get('youtube-search-input').listeners.keydown({ key: 'ArrowDown', preventDefault() { downFromInput = true; } });
    expect('ArrowDown from the search input focuses the first result', [downFromInput, activeElement === resultRows[0]], [true, true]);
    let down1 = false;
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowDown', preventDefault() { down1 = true; } });
    expect('ArrowDown in results moves to the next DOM row', [down1, activeElement === resultRows[1]], [true, true]);
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
    expect('ArrowDown again moves to the third row', activeElement === resultRows[2], true);
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    expect('ArrowUp moves back to the second row', activeElement === resultRows[1], true);
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    expect('ArrowUp at the first row clamps (no wrap)', activeElement === resultRows[0], true);
    narrowResults = true;
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
    expect('narrow single-column results use ArrowDown on the visual axis', activeElement === resultRows[1], true);
    elements.get('youtube-search-results').listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    expect('narrow single-column results use ArrowUp on the visual axis', activeElement === resultRows[0], true);
    expect('keyboard navigation never opens preview media', loadCalls, 0);
    resultRows[0].click();
    expect('card body activation stays inline', [elements.get('youtube-url').value, loadCalls], ['', 0]);
    const findCardAction = (root, action) => { for (const child of root.children ?? []) { if (child.dataset?.cardAction === action) return child; const nested = findCardAction(child, action); if (nested) return nested; } return null; };
    findCardAction(resultRows[0], 'advanced').click();
    expect('explicit advanced action loads the detail fallback', [elements.get('youtube-url').value, loadCalls], ['https://www.youtube.com/watch?v=result00001', 1]);
  }
});

test('radiogroups and session quality preference', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','youtube-quality','youtube-media-mode','youtube-audio-format','youtube-subtitles','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-profile','prores-warning','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-formats','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','youtube-search-form','pin-on-top-btn'];
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'download'; elements.get('destination').value = 'active'; elements.get('timeline-placement').value = 'end'; elements.get('youtube-quality').value = 'best';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : null };
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const loadResolvers = [];
    let metadata = { id: 'dQw4w9WgXcQ', title: 'Video', duration: 60, channel: 'C', thumbnailUrl: null, heights: [360, 720, 1080, 2160], formatSummary: ['360p', '720p', '1080p', '2160p'] };
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: () => undefined,
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }), addToTimeline: async () => ({ ok: true, kind: 'timeline-appended', message: 'Added.' }),
      searchYoutube: async () => ({ query: 'q', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }),
      loadYoutube: () => new Promise((resolve, reject) => loadResolvers.push({ resolve, reject })),
      downloadYoutube: async () => ({ cardId: 'c', fileName: 'x.mp4' }), cancelYoutube: async () => true, onYoutubeEvent: () => () => undefined,
    };
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout, location: { search: '' } };
    runInNewContext(renderer, { window: fakeWindow, document, crypto: { randomUUID: () => 'ui-' + Math.random(), getRandomValues: (x) => x }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    windowListeners.DOMContentLoaded();
    const load = async () => { elements.get('load-youtube-btn').click(); await flush(); loadResolvers.at(-1).resolve(metadata); await flush(); };
    const chips = () => Array.from(elements.get('quality-chips').children);
    const profileButtons = () => Array.from(elements.get('profile-controls').children);
    await load();
    // Chips render highest-first (2160p … 360p), mirroring the select options.
    expect('quality defaults to actual 2160p when 4K is available', [elements.get('youtube-quality').value, chips().length], ['2160p', 4]);
    expect('quality radiogroup roving tabindex keeps exactly one stop', [chips().map((chip) => chip.tabIndex), chips()[0].getAttribute('aria-checked'), chips()[0].classList.contains('selected')], [[0, -1, -1, -1], 'true', true]);
    let down = false;
    chips()[0].listeners.keydown({ key: 'ArrowDown', preventDefault() { down = true; } });
    expect('quality ArrowDown moves to and selects the next chip', [down, elements.get('youtube-quality').value, activeElement === chips()[1], chips()[1].getAttribute('aria-checked'), chips()[0].getAttribute('aria-checked'), chips()[1].tabIndex], [true, '1080p', true, 'true', 'false', 0]);
    chips()[1].listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    expect('quality ArrowUp returns to the previous chip', [elements.get('youtube-quality').value, activeElement === chips()[0]], ['2160p', true]);
    chips()[0].listeners.keydown({ key: 'End', preventDefault() {} });
    expect('quality End selects the last chip (360p)', [elements.get('youtube-quality').value, activeElement === chips()[3]], ['360p', true]);
    chips()[3].listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
    expect('quality ArrowRight at the end clamps', elements.get('youtube-quality').value, '360p');
    chips()[3].listeners.keydown({ key: 'Home', preventDefault() {} });
    expect('quality Home selects the first chip (2160p)', elements.get('youtube-quality').value, '2160p');
    chips()[2].click();
    expect('chip click selects the clicked quality', elements.get('youtube-quality').value, '720p');
    await load();
    expect('preference reapplies when the new video offers it', elements.get('youtube-quality').value, '720p');
    metadata = { ...metadata, heights: [360, 1080, 2160] };
    await load();
    expect('preference falls back to actual 2160p when unavailable', elements.get('youtube-quality').value, '2160p');
    metadata = { ...metadata, heights: [360, 1080] };
    await load();
    expect('no-4K video never shows or selects 2160p', [elements.get('youtube-quality').value, Array.from(elements.get('youtube-quality').children).some((option) => option.value === '2160p')], ['1080p', false]);
    metadata = { ...metadata, heights: [] };
    await load();
    expect('empty heights fall back to best', elements.get('youtube-quality').value, 'best');
    expect('profile radiogroup starts with Original selected and one tab stop', [elements.get('youtube-profile').value, profileButtons()[0].getAttribute('aria-checked'), profileButtons().map((button) => button.tabIndex)], ['original', 'true', [0, -1, -1]]);
    let pDown = false;
    profileButtons()[0].listeners.keydown({ key: 'ArrowDown', preventDefault() { pDown = true; } });
    expect('profile ArrowDown moves to and selects Fast MP4', [pDown, elements.get('youtube-profile').value, profileButtons()[1].getAttribute('aria-checked'), activeElement === profileButtons()[1], profileButtons()[1].tabIndex], [true, 'fast', 'true', true, 0]);
    profileButtons()[1].listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
    expect('profile ProRes shows the size warning', [elements.get('youtube-profile').value, elements.get('prores-warning').classList.contains('hidden')], ['editing', false]);
    profileButtons()[2].listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    expect('profile ArrowUp returns to Fast MP4', elements.get('youtube-profile').value, 'fast');
    profileButtons()[1].listeners.keydown({ key: 'Home', preventDefault() {} });
    expect('profile Home returns to Original', elements.get('youtube-profile').value, 'original');
  }
});

test('queue accessibility and live transitions', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','youtube-quality','youtube-media-mode','youtube-audio-format','youtube-subtitles','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-profile','prores-warning','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-formats','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','youtube-search-form','pin-on-top-btn'];
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'download'; elements.get('destination').value = 'active'; elements.get('timeline-placement').value = 'end'; elements.get('youtube-quality').value = 'best';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : null };
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const queueRows = () => elements.get('youtube-download-queue').children;
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const metadata = { id: 'dQw4w9WgXcQ', title: '<Queue title>', duration: 65, channel: '<Channel>', thumbnailUrl: null, heights: [720, 2160], formatSummary: ['720p', '2160p'] };
    const loadResolvers = []; const pending = new Map(); let youtubeListener;
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: () => undefined,
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }), addToTimeline: async () => ({ ok: true, kind: 'timeline-appended', message: 'Added.' }),
      searchYoutube: async () => ({ query: 'q', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }),
      loadYoutube: () => new Promise((resolve, reject) => loadResolvers.push({ resolve, reject })),
      downloadYoutube: (url, quality, profile, jobId) => { const promise = new Promise((resolve, reject) => { pending.set(jobId, { resolve, reject }); }); return promise; },
      cancelYoutube: async () => true,
      onYoutubeEvent: (callback) => { youtubeListener = callback; return () => undefined; },
    };
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout, location: { search: '' } };
    let uuid = 0;
    runInNewContext(renderer, { window: fakeWindow, document, crypto: { randomUUID: () => `queue-id-${++uuid}`, getRandomValues: (x) => x }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    windowListeners.DOMContentLoaded();
    elements.get('load-youtube-btn').click(); await flush();
    loadResolvers[0].resolve(metadata); await flush();
    elements.get('download-youtube-btn').click();
    expect('queue image carries the video title as alt text', queueRows()[0].children[0].alt, '<Queue title>');
    expect('queue live region announces the downloading transition', elements.get('youtube-queue-status').textContent, 'Downloading: <Queue title>');
    elements.get('youtube-intent').value = 'playhead'; elements.get('youtube-intent').listeners.change(); elements.get('download-youtube-btn').click();
    expect('queue live region announces a queued item (stays queued)', elements.get('youtube-queue-status').textContent, 'Queued: <Queue title>');
    expect('newest-first display: fresh queued item is the first DOM row', [queueRows()[0].dataset.state, queueRows()[1].dataset.state], ['queued', 'downloading']);
    const firstJob = pending.keys().next().value;
    const activeRow = queueRows().find((row) => row.className.includes('state-downloading'));
    expect('download progress carries a useful accessible label', activeRow?.children[1].children[3].getAttribute('aria-label'), 'Download progress for <Queue title>');
    youtubeListener({ jobId: firstJob, state: 'downloading', percent: 55, message: 'Downloading…', speedBytesPerSecond: 1500000, etaSeconds: 5 });
    expect('percent ticks do not re-announce (not noisy)', elements.get('youtube-queue-status').textContent, 'Queued: <Queue title>');
    pending.get(firstJob).resolve({ cardId: 'c1', fileName: 'one.mp4' }); await flush();
    expect('FIFO advances: the queued item starts downloading', [elements.get('youtube-queue-status').textContent, queueRows().some((row) => row.className.includes('state-completed'))], ['Downloading: <Queue title>', true]);
    const secondJob = [...pending.keys()].find((id) => id !== firstJob);
    pending.get(secondJob).resolve({ cardId: 'c2', fileName: 'two.mp4' }); await flush();
    expect('the last job announces completion in the live region', elements.get('youtube-queue-status').textContent, 'Completed: <Queue title>');
  }

});

test('FIFO queue, immutable snapshots, handoff, cancellation and deletion', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null; let queueRenderExecutions = 0;
    const controlledTimers = new Map(); let controlledTimerId = 0;
    const controlledSetTimeout = (callback) => { const id = ++controlledTimerId; controlledTimers.set(id, callback); return id; };
    const controlledClearTimeout = (id) => controlledTimers.delete(id);
    const flushControlledTimers = () => { const callbacks = [...controlledTimers.values()]; controlledTimers.clear(); callbacks.forEach((callback) => callback()); };
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','youtube-quality','youtube-media-mode','youtube-audio-format','youtube-subtitles','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-profile','prores-warning','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-formats','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','youtube-search-form','pin-on-top-btn'];
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'download'; elements.get('destination').value = 'active'; elements.get('timeline-placement').value = 'end';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : null };
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const metadata = { id: 'dQw4w9WgXcQ', title: '<Queue title>', duration: 65, channel: '<Channel>', thumbnailUrl: null, heights: [720, 2160], formatSummary: ['720p', '2160p'] };
    let youtubeListener; let concurrent = 0; let peak = 0; let sequence = 0; let pendingTransferResolve = null; let deleteResolve = null; let deleteOutcome = { deleted: false, message: 'File was not deleted safely. It remains in the queue.' }; let confirmCalls = 0; let confirmMessage = '';
    const downloadCalls = []; const pending = new Map(); const transferCalls = []; const dragCalls = []; const cancelCalls = []; const queueDeleteCalls = [];
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: (cardId) => dragCalls.push(cardId),
      importToMediaPool: async (cardId, targetBin) => { transferCalls.push(['import', cardId, targetBin]); return { ok: true, kind: 'imported', message: 'Imported.' }; },
      addToTimeline: async (cardId, targetBin, placement) => { transferCalls.push(['timeline', cardId, targetBin, placement]); if (cardId === 'card-2' && placement === 'playhead' && transferCalls.filter((call) => call[1] === cardId).length === 1) return { ok: false, kind: 'append-failed', message: 'Auto transfer failed.' }; if (cardId === 'card-transfer') return new Promise((resolve) => { pendingTransferResolve = resolve; }); return { ok: true, kind: 'timeline-appended', message: 'Added.' }; },
      searchYoutube: async () => { throw new Error('not used'); }, loadYoutube: async () => metadata,
      downloadYoutube: (url, quality, profile, jobId) => { downloadCalls.push({ url, quality, profile, jobId }); concurrent += 1; peak = Math.max(peak, concurrent); let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }).finally(() => { concurrent -= 1; }); pending.set(jobId, { resolve, reject }); return promise; },
      cancelYoutube: async (jobId) => { cancelCalls.push(jobId); youtubeListener?.({ jobId, state: 'cancelled', percent: null, message: 'Download cancelled.' }); pending.get(jobId)?.reject(new Error('Download cancelled.')); return true; },
      onYoutubeEvent: (callback) => { youtubeListener = callback; return () => undefined; },
      queueDelete: (cardId) => { queueDeleteCalls.push(cardId); return new Promise((resolve) => { deleteResolve = () => resolve(deleteOutcome); }); },
    };
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: () => ({ matches: false }), setTimeout: controlledSetTimeout, clearTimeout: controlledClearTimeout, confirm: (message) => { confirmCalls += 1; confirmMessage = message; return true; }, location: { search: '' } };
    let uuid = 0; runInNewContext(renderer, { window: fakeWindow, document, crypto: { randomUUID: () => `queue-id-${++uuid}` }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    windowListeners.DOMContentLoaded(); elements.get('load-youtube-btn').click(); await flush();
    const rows = () => elements.get('youtube-download-queue').children;
    const buttons = (node) => { const found = []; const visit = (child) => { if (child.tagName === 'BUTTON') found.push(child); child.children.forEach(visit); }; visit(node); return found; };
    const texts = (node) => { const found = []; const visit = (child) => { if (child.textContent) found.push(child.textContent); child.children.forEach(visit); }; visit(node); return found; };
    const clickNamed = (row, label) => buttons(row).find((entry) => entry.textContent === label);

    elements.get('download-youtube-btn').click();
    elements.get('youtube-profile').value = 'fast'; elements.get('youtube-profile').listeners.change(); elements.get('youtube-target-bin').value = 'clipdock'; elements.get('youtube-target-bin').listeners.change(); elements.get('youtube-intent').value = 'playhead'; elements.get('youtube-intent').listeners.change(); elements.get('download-youtube-btn').click();
    elements.get('youtube-profile').value = 'editing'; elements.get('youtube-profile').listeners.change(); elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-target-bin').listeners.change(); elements.get('youtube-intent').value = 'end'; elements.get('youtube-intent').listeners.change(); elements.get('download-youtube-btn').click();
    elements.get('youtube-target-bin').value = 'clipdock'; elements.get('youtube-target-bin').listeners.change(); elements.get('download-youtube-btn').click();
    expect('queue starts only the first of four FIFO jobs', [downloadCalls.length, peak, rows().length], [1, 1, 4]);
    expect('newest-first display: last enqueued row first, active download last', [rows()[0].dataset.state, rows().at(-1).dataset.state], ['queued', 'downloading']);
    elements.get('download-youtube-btn').click();
    expect('queue prevents exact active/queued duplicate and focuses it', [rows().length, elements.get('youtube-status').textContent, activeElement?.classList.contains('duplicate-highlight')], [4, 'Already in downloads.', true]);
    clickNamed(rows()[0], 'Remove from queue')?.click(); expect('queued Remove uses no IPC and removes row', [rows().length, cancelCalls.length], [3, 0]);
    elements.get('download-youtube-btn').click(); expect('removed queued snapshot may be enqueued again', rows().length, 4);
    queueRenderExecutions = 0;
    for (let tick = 1; tick <= 100; tick += 1) youtubeListener({ jobId: downloadCalls[0].jobId, state: 'downloading', percent: tick === 100 ? 42.5 : tick / 2, message: `Downloading ${tick}`, speedBytesPerSecond: tick === 100 ? 1500000 : 1000000, etaSeconds: tick === 100 ? 65 : 100 - tick });
    expect('100 nonterminal progress events render zero times before the controlled deadline', queueRenderExecutions, 0);
    flushControlledTimers();
    expect('100 nonterminal progress events batch to at most two renders', queueRenderExecutions <= 2, true);
    expect('batched render keeps final percent, speed, ETA, and message', rows().some((row) => texts(row).some((text) => text.includes('Downloading 100 42.5% · 1.5 MB/s · 1m 5s'))), true);
    queueRenderExecutions = 0;
    youtubeListener({ jobId: downloadCalls[0].jobId, state: 'downloading', percent: 43, message: 'Pending terminal', speedBytesPerSecond: 1500000, etaSeconds: 64 });
    youtubeListener({ jobId: downloadCalls[0].jobId, state: 'failed', percent: 43, message: 'Terminal failure' });
    expect('terminal event cancels the pending timer and renders promptly once', [queueRenderExecutions, controlledTimers.size, rows().some((row) => texts(row).some((text) => text.includes('Terminal failure')))], [1, 0, true]);
    flushControlledTimers();
    expect('terminal event has no duplicate trailing render', queueRenderExecutions, 1);
    pending.get(downloadCalls[0].jobId).resolve({ cardId: 'card-1', fileName: 'one.mp4' }); await flush();
    expect('plain completion starts second and performs no transfer', [downloadCalls.length, peak, transferCalls.length], [2, 1, 0]);
    expect('queued snapshot is immutable after inspector controls change', [downloadCalls[0].url, downloadCalls[0].quality, downloadCalls[0].profile, downloadCalls[1].profile], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2160p', 'original', 'fast']);
    pending.get(downloadCalls[1].jobId).resolve({ cardId: 'card-2', fileName: 'two.mp4' }); await flush();
    const card2Ready = rows().find((row) => row.className.includes('state-completed') && texts(row).some((text) => text.includes('Fast · 2160p · Add at playhead')));
    expect('automatic handoff uses the snapshotted playhead intent', [!!card2Ready, transferCalls[0]], [true, ['timeline', 'card-2', 'clipdock', 'playhead']]);
    const failedTransferRow = rows().find((row) => texts(row).some((text) => text.includes('Auto transfer failed.')));
    expect('auto-transfer failure retains completed card with error', [failedTransferRow?.className.includes('state-completed'), failedTransferRow?.draggable], [true, true]);
    pending.get(downloadCalls[2].jobId).reject(new Error('Download failed.')); await flush();
    expect('failed job cannot deadlock queue; next FIFO job starts', [downloadCalls.length, !!rows().find((row) => row.className.includes('state-failed'))], [4, true]);
    clickNamed(rows().find((row) => row.className.includes('state-downloading')), 'Stop')?.click(); await flush();
    expect('active Stop uses its jobId and preserves cancelled row', [cancelCalls.length, !!rows().find((row) => row.className.includes('state-cancelled'))], [1, true]);
    clickNamed(rows().find((row) => row.className.includes('state-failed')), 'Retry')?.click(); await flush(); expect('failed Retry creates a new jobId and requeues snapshot', [downloadCalls.length, downloadCalls[4].jobId !== downloadCalls[2].jobId], [5, true]);
    expect('retry creates a new top row (newest-first)', [rows()[0].dataset.state, rows().at(-1).dataset.state], ['downloading', 'completed']);
    pending.get(downloadCalls[4].jobId).resolve({ cardId: 'card-3', fileName: 'three.mp4' }); await flush();
    clickNamed(rows()[0], 'Add to timeline')?.click(); await flush();
    expect('completed card uses snapshotted timeline-end preference', transferCalls.at(-1), ['timeline', 'card-3', 'active', 'end']);
    const completed = rows().filter((row) => row.className.includes('state-completed'));
    for (const row of completed) row.listeners.dragstart?.({ preventDefault() {} });
    expect('multiple completed cards remain draggable with separate cardIds', [completed.length, dragCalls.slice().sort()], [3, ['card-1', 'card-2', 'card-3']]);
    const card2 = completed.find((row) => texts(row).includes('<Queue title>') && row.draggable && buttons(row).some((entry) => entry.textContent === 'Add to timeline') && texts(row).some((text) => text.includes('Auto transfer failed.')));
    const before = transferCalls.length;
    clickNamed(card2, 'Add to timeline')?.click(); clickNamed(card2, 'Add to timeline')?.click(); await flush();
    expect('completed timeline handoff ignores a second rapid trigger', transferCalls.length - before, 1);
    expect('completed timeline handoff uses item bin and previous placement', transferCalls.at(-1), ['timeline', 'card-2', 'clipdock', 'playhead']);
    expect('completed timeline handoff announces its result in the live region', elements.get('youtube-queue-status').textContent, 'Added.');

    const cancelled = rows().find((row) => row.className.includes('state-cancelled')); const cancelledId = cancelled?.dataset.queueId; const cancelledRemove = cancelled && clickNamed(cancelled, 'Remove from queue');
    expect('cancelled row exposes UI-only Remove from queue', [cancelledRemove?.textContent, cancelCalls.length], ['Remove from queue', 1]); cancelledRemove?.click();
    expect('cancelled Remove from queue only removes the row', [rows().some((row) => row.dataset.queueId === cancelledId), cancelCalls.length], [false, 1]);

    elements.get('youtube-profile').value = 'original'; elements.get('youtube-profile').listeners.change(); elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-target-bin').listeners.change(); elements.get('youtube-intent').value = 'playhead'; elements.get('youtube-intent').listeners.change(); elements.get('download-youtube-btn').click();
    const transferJob = downloadCalls.at(-1).jobId; pending.get(transferJob).resolve({ cardId: 'card-transfer', fileName: 'transfer.mp4' }); await flush();
    const transferring = rows()[0]; clickNamed(transferring, 'Add to timeline')?.click();
    const transferButtons = buttons(transferring).map((entry) => entry.textContent);
    expect('handoff in flight has no inert Stop or Cancel action', [transferButtons.includes('Stop'), transferButtons.includes('Cancel')], [false, false]);
    pendingTransferResolve?.({ ok: true, kind: 'timeline-appended', message: 'Added.' }); await flush();

    const deletable = rows()[0]; const deleteQueueId = deletable.dataset.queueId; const deleteCardId = 'card-transfer'; const deleteButton = clickNamed(deletable, 'Delete file');
    deleteButton?.click(); deleteButton?.click();
    expect('Delete file confirms the irreversible ClipDock-managed-only warning and sends one cardId', [queueDeleteCalls, confirmCalls, confirmMessage], [[deleteCardId], 1, 'Only a safe ClipDock-managed file will be deleted from your computer. This action cannot be undone. Continue?']); deleteResolve?.(); await flush();
    expect('failed Delete file keeps the row and reports an actionable status', [rows().some((row) => row.dataset.queueId === deleteQueueId), elements.get('youtube-queue-status').textContent], [true, deleteOutcome.message]);
    deleteOutcome = { deleted: true, message: 'File deleted.' }; const retryDelete = rows().find((row) => row.dataset.queueId === deleteQueueId); clickNamed(retryDelete, 'Delete file')?.click(); deleteResolve?.(); await flush();
    expect('successful Delete file removes the row only after truthful deleted result', [queueDeleteCalls, rows().some((row) => row.dataset.queueId === deleteQueueId), elements.get('youtube-queue-status').textContent], [[deleteCardId, deleteCardId], false, 'File deleted.']);

    elements.get('youtube-profile').value = 'fast'; elements.get('youtube-profile').listeners.change(); elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-target-bin').listeners.change(); elements.get('youtube-intent').value = 'end'; elements.get('youtube-intent').listeners.change(); elements.get('download-youtube-btn').click();
    const stopJob = downloadCalls.at(-1).jobId; const activeDownloading = rows()[0]; const stopQueueId = activeDownloading.dataset.queueId; const stop = clickNamed(activeDownloading, 'Stop');
    expect('active downloading row exposes Stop before invoking the correct job', [stop?.textContent, cancelCalls.length], ['Stop', 1]); stop?.click(); await flush();
    const stoppedRow = rows().find((row) => row.dataset.queueId === stopQueueId);
    expect('Stop preserves cancelled state and passes its jobId', [cancelCalls.at(-1), stoppedRow?.className.includes('state-cancelled')], [stopJob, true]);
    expect('renderer queue fixture never receives a raw path', downloadCalls.every((call) => !call.url.includes('/tmp/')) && transferCalls.every((call) => !String(call[1]).includes('/')), true);
  }
});

test('preview teardown and scroll debounce', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    let videoAssignments = 0; let pauseCalls = 0; let loadCalls = 0; let playCalls = 0; let removeSrcCalls = 0;
    const classList = () => ({ values: [], add(value) { if (!this.values.includes(value)) this.values.push(value); }, remove(value) { this.values = this.values.filter((item) => item !== value); }, toggle(value, on) { on ? this.add(value) : this.remove(value); }, contains(value) { return this.values.includes(value); } });
    const element = () => ({ disabled: false, textContent: '', title: '', attributes: {}, dataset: {}, style: {}, classList: classList(), setAttribute(name, value) { this.attributes[name] = String(value); }, removeAttribute(name) { delete this.attributes[name]; } });
    let previewFocusCalls = 0; const previewButton = element(); previewButton.getAttribute = name => previewButton.attributes[name] ?? null; previewButton.focus = () => { previewFocusCalls += 1; }; const youtubeOverlay = element(); const pexelsOverlay = element();
    const video = { ...element(), pause() { pauseCalls += 1; }, load() { loadCalls += 1; }, play() { playCalls += 1; return Promise.resolve(); }, removeAttribute(name) { if (name === 'src') removeSrcCalls += 1; delete this.attributes[name]; } };
    Object.defineProperty(video, 'src', { get: () => '', set: () => { videoAssignments += 1; } });
    const elements = new Map([['preview-selected-btn', previewButton], ['pexels-preview-overlay', pexelsOverlay], ['pexels-preview-video', video]]);
    const pendingStops = new Map(); let stopTimerId = 0;
    const sandbox = { window: { addEventListener() {}, matchMedia: () => ({ matches: false }), setTimeout(callback, delay) { const id = ++stopTimerId; pendingStops.set(id, { callback, delay }); return id; }, clearTimeout(id) { pendingStops.delete(id); } }, document: { getElementById: (id) => elements.get(id) ?? null }, console, Date, Math, Number, Promise, crypto: { randomUUID: () => 'preview-test' }, setTimeout, clearTimeout, queueMicrotask };
    runInNewContext(`${renderer}
  globalThis.__previewTest = { stopPreview, startPexelsPreview, schedulePreviewStop, setFixture(asset) { provider = 'pexels'; pexels = asset; } };`, sandbox);
    for (let call = 0; call < 50; call += 1) sandbox.__previewTest.stopPreview();
    expect('50 closed stopPreview calls perform no media DOM work', [videoAssignments, pauseCalls, loadCalls, removeSrcCalls], [0, 0, 0, 0]);
    const asset = { id: 1, kind: 'video', title: 'Preview', previewUrl: 'https://videos.pexels.com/preview.mp4' };
    const monitor = { ...element(), getBoundingClientRect: () => ({ left: 1, top: 2, width: 320, height: 180 }) };
    elements.set('source-monitor', monitor);
    sandbox.__previewTest.setFixture(asset);
    sandbox.__previewTest.startPexelsPreview(asset);
    sandbox.__previewTest.stopPreview();
    for (let call = 0; call < 50; call += 1) sandbox.__previewTest.stopPreview();
    expect('one opened Pexels preview closes once and later stops remain no-ops', [videoAssignments, playCalls, pauseCalls, loadCalls, removeSrcCalls], [1, 1, 1, 1, 1]);
    videoAssignments = 0; pauseCalls = 0; loadCalls = 0; playCalls = 0; removeSrcCalls = 0;
    sandbox.__previewTest.startPexelsPreview(asset);
    videoAssignments = 0; pauseCalls = 0; loadCalls = 0; playCalls = 0; removeSrcCalls = 0;
    for (let event = 0; event < 30; event += 1) sandbox.__previewTest.schedulePreviewStop();
    const burstTimer = [...pendingStops.entries()][0];
    expect('30-event scroll burst performs no synchronous media teardown and keeps one debounce', [pendingStops.size, burstTimer[1].delay, pauseCalls, loadCalls, removeSrcCalls], [1, 120, 0, 0, 0]);
    pendingStops.delete(burstTimer[0]); burstTimer[1].callback();
    expect('scroll burst flush performs exactly one teardown and no further debounce runs', [pauseCalls, loadCalls, removeSrcCalls, pendingStops.size], [1, 1, 1, 0]);
    sandbox.__previewTest.schedulePreviewStop();
    expect('closed preview never schedules a scroll debounce', [pendingStops.size], [0]);
    sandbox.__previewTest.startPexelsPreview(asset); sandbox.__previewTest.stopPreview(true);
    expect('explicit preview close restores focus to Preview without changing automatic close behavior', previewFocusCalls, 1);
  }
});

test('single-flight host refresh and trailing requests', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map();
    for (const id of ['refresh-btn', 'bridge-state', 'module-version', 'resolve-version', 'project-name', 'timeline-name', 'message', 'refresh-hint', 'last-updated']) elements.set(id, { disabled: false, textContent: '', classList: { toggle() {} } });
    const status = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const pending = []; let calls = 0; let active = 0; let peak = 0; const timers = new Map(); let timerId = 0;
    const api = { getStatus: () => { calls += 1; active += 1; peak = Math.max(peak, active); return new Promise((resolve, reject) => pending.push({ resolve, reject })).finally(() => { active -= 1; }); } };
    const fakeWindow = { clipdockAPI: api, addEventListener() {}, setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
    const sandbox = { window: fakeWindow, document: { body: { dataset: {} }, getElementById: (id) => elements.get(id) ?? null }, console, Date, Math, Number, Promise, crypto: { randomUUID: () => 'status-test' }, setTimeout, clearTimeout, queueMicrotask };
    runInNewContext(`${renderer}
  globalThis.__statusTest = { refresh, scheduleHostRefresh };`, sandbox);
    // This test drives only the 120ms debounce. The bounded 10s bridge timeout
    // has dedicated deterministic fake-clock coverage in host-status-refresh.test.mjs.
    const flushTimers = () => { const due = [...timers.entries()].filter(([, timer]) => timer.delay <= 120); for (const [id] of due) timers.delete(id); due.forEach(([, timer]) => timer.callback()); };
    sandbox.__statusTest.scheduleHostRefresh(); flushTimers();
    for (let event = 0; event < 20; event += 1) sandbox.__statusTest.scheduleHostRefresh();
    flushTimers();
    expect('20 host events during an in-flight status request do not overlap', [calls, peak, active], [1, 1, 1]);
    pending[0].resolve(status); await new Promise((resolve) => setTimeout(resolve, 0));
    expect('in-flight host burst produces exactly one trailing getStatus', [calls, peak, active], [2, 1, 1]);
    pending[1].reject(new Error('host unavailable')); await new Promise((resolve) => setTimeout(resolve, 0));
    sandbox.__statusTest.refresh(true);
    expect('status error releases in-flight guard for manual refresh', [calls, peak, active], [3, 1, 1]);
    pending[2].resolve(status); await new Promise((resolve) => setTimeout(resolve, 0));
    expect('manual refresh completes and re-enables its control', [active, elements.get('refresh-btn').disabled], [0, false]);
  }
});

test('social metadata, provider queue and recovery', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  {
    const elements = new Map(); const windowListeners = {}; let activeElement = null;
    const { makeElement } = createFakeDom({ onFocus: (node) => { activeElement = node; }, onReplaceChildren: (node) => { if (node.id === 'youtube-download-queue' && typeof queueRenderExecutions !== 'undefined') queueRenderExecutions += 1; } });
    const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','load-social-btn','social-url','youtube-quality','youtube-profile','youtube-media-mode','youtube-audio-format','youtube-subtitles','prores-warning','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','preview-note','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-search-form','youtube-paste-url','social-url-panel','social-platform-instagram','social-platform-twitter','social-platform-facebook','social-platform-hint','social-platform-hint','pexels-setup','pexels-setup-summary','pexels-api-key','pexels-connection-status','pexels-kind-switch','pexels-credit','pexels-attribution','metadata-verified','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','profile-controls','source-monitor','provider-youtube','provider-pexels','provider-social','pexels-photo-kind','pexels-video-kind','pexels-connect-btn','pexels-disconnect-btn','pexels-key-link','stock-source-switch','stock-source-pexels','stock-source-pixabay','stock-credit-lead','pixabay-setup','pixabay-setup-summary','pixabay-connection-status','pixabay-api-key','pixabay-connect-btn','pixabay-disconnect-btn','pixabay-key-link','pixabay-save-note','pexels-link','advanced-options','youtube-selection-controls','youtube-subtitle-controls','youtube-mode-controls','pin-on-top-btn']; // Phase 2: provider hint node removed — single live status line now carries provider context
    for (const id of ids) elements.set(id, makeElement(id.includes('btn') ? 'button' : id.includes('quality') || id.includes('profile') || id.includes('destination') || id.includes('target-bin') || id.includes('placement') ? 'select' : 'div', id));
    elements.get('youtube-profile').value = 'original'; elements.get('youtube-media-mode').value = 'video'; elements.get('youtube-audio-format').value = 'mp3'; elements.get('youtube-subtitles').checked = false; elements.get('youtube-subtitle-language').value = 'en'; elements.get('youtube-target-bin').value = 'active'; elements.get('youtube-intent').value = 'end'; elements.get('youtube-quality').value = 'best';
    for (const profile of ['original', 'fast', 'editing']) { const choice = makeElement('button'); choice.dataset.profile = profile; elements.get('profile-controls').append(choice); }
    elements.get('profile-controls').parentElement = makeElement('div');
    const feedToolbar = makeElement('div'); const advanced = elements.get('advanced-options');
    const document = { body: { dataset: {} }, get activeElement() { return activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: (tag) => makeElement(tag), querySelector: (selector) => selector === '.inspector-thumb' ? makeElement('div') : selector === '.feed-toolbar' ? feedToolbar : selector === '.advanced-options' ? advanced : null };
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const snapshot = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
    const loadResolvers = []; const downloadCalls = []; const pendingDownloads = new Map(); const socialCancelCalls = []; const timelineCalls = []; const deleteCalls = []; let socialListener; let deleteResolve;
    const api = {
      getStatus: async () => snapshot, onResolveQuit: () => () => undefined, selectFile: async () => ({ canceled: true }), startNativeDrag: () => undefined,
      importToMediaPool: async () => ({ ok: true, kind: 'imported', message: 'Imported.' }), addToTimeline: async (cardId, bin, placement) => { timelineCalls.push([cardId, bin, placement]); return { ok: true, kind: 'timeline-appended', message: 'Added.' }; },
      searchYoutube: async () => ({ query: 'q', page: 1, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 }), loadYoutube: async () => { throw new Error('not used'); },
      downloadYoutube: async () => { throw new Error('YouTube route used'); }, cancelYoutube: async () => false, onYoutubeEvent: () => () => undefined,
      loadSocial: () => new Promise((resolve, reject) => loadResolvers.push({ resolve, reject })),
      downloadSocial: (url, quality, profile, jobId) => { downloadCalls.push({ url, quality, profile, jobId }); return new Promise((resolve, reject) => pendingDownloads.set(jobId, { resolve, reject })); },
      cancelSocial: async (jobId) => { socialCancelCalls.push(jobId); socialListener?.({ jobId, state: 'cancelled', percent: null, message: 'Download cancelled.' }); pendingDownloads.get(jobId)?.reject(new Error('Download cancelled.')); return true; },
      onSocialEvent: (callback) => { socialListener = callback; return () => undefined; },
      pexelsKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), pixabayKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), onPixabayEvent: () => () => undefined, onPexelsEvent: () => () => undefined,
      searchPexels: async () => { throw new Error('not used'); }, loadPexels: async () => { throw new Error('not used'); }, downloadPexels: async () => { throw new Error('not used'); }, cancelPexels: async () => false, cancelPexelsRequests: async () => false,
      openPexelsExternal: async () => false, setAlwaysOnTop: async (pinned) => pinned, workspaceStatus: async () => ({ fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0 }), openWorkspace: async () => false, cleanupWorkspace: async () => ({ deletedFileCount: 0, deletedBytes: 0, fileCount: 0, totalBytes: 0 }),
      historyList: async () => [], historyReuse: async () => null, historyReveal: async () => false, historySource: async () => false, historyCopy: async () => false, historyRelink: async () => null, historyDelete: async () => ({ deleted: false, removed: false }),
      queueDelete: (cardId) => { deleteCalls.push(cardId); return new Promise((resolve) => { deleteResolve = () => resolve({ deleted: true, message: 'File deleted.' }); }); },
    };
    const fakeWindow = { clipdockAPI: api, addEventListener: (type, callback) => { windowListeners[type] = callback; }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout, confirm: () => true, location: { search: '' } };
    let uuid = 0; runInNewContext(renderer, { window: fakeWindow, document, URL, crypto: { randomUUID: () => `social-${++uuid}` }, Date, Math, Number, console, setTimeout, clearTimeout, queueMicrotask });
    windowListeners.DOMContentLoaded();
    elements.get('provider-social').click();
    elements.get('social-url').value = 'https://www.instagram.com/reel/ABC_def-123/?utm_source=share'; elements.get('social-url').listeners.input();
    expect('social tab auto-detects Instagram before load', [elements.get('social-platform-instagram').classList.contains('selected'), elements.get('social-platform-hint').textContent], [true, 'Instagram URL detected.']);
    elements.get('load-social-btn').click(); await flush();
    expect('social actions stay disabled until metadata arrives', [elements.get('load-social-btn').disabled, elements.get('download-youtube-btn').disabled, elements.get('preview-selected-btn').disabled], [true, true, true]);
    loadResolvers[0].resolve({ id: 'social-video-1', platform: 'instagram', source: 'https://www.instagram.com/reel/ABC_def-123', title: 'Social video', duration: 42, channel: 'Creator', thumbnailDataUrl: null, heights: [720], formatSummary: ['720p'] }); await flush();
    expect('social metadata restores actions, platform indicator, and disabled preview reason', [elements.get('download-youtube-btn').disabled, elements.get('social-platform-instagram').dataset.state, elements.get('preview-selected-btn').disabled, elements.get('preview-note').textContent, elements.get('preview-selected-btn').title], [false, 'detected', true, 'Preview is unavailable for pasted links.', 'Preview is unavailable for pasted links.']);
    elements.get('download-youtube-btn').click();
    expect('social queue routes canonical URL to downloadSocial and labels the real platform', [downloadCalls.length, downloadCalls[0].url, downloadCalls[0].quality, downloadCalls[0].profile, elements.get('youtube-download-queue').children[0].children[1].children[1].textContent.includes('Instagram')], [1, 'https://www.instagram.com/reel/ABC_def-123', '720p', 'original', true]);
    const firstRow = elements.get('youtube-download-queue').children[0]; const firstQueueId = firstRow.dataset.queueId; const stop = (() => { const find = (node) => node.children.flatMap((child) => [child, ...find(child)]); return find(firstRow).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Stop'); })(); stop.click(); await flush();
    expect('social Stop uses cancelSocial and preserves cancelled row', [socialCancelCalls.length, Array.from(elements.get('youtube-download-queue').children).find((row) => row.dataset.queueId === firstQueueId)?.className.includes('state-cancelled')], [1, true]);
    elements.get('download-youtube-btn').click(); await flush();
    elements.get('youtube-profile').value = 'fast'; elements.get('youtube-profile').listeners.change(); elements.get('download-youtube-btn').click();
    const rows = () => elements.get('youtube-download-queue').children; const findButton = (row, label) => { const visit = (node) => { for (const child of node.children) { if (child.tagName === 'BUTTON' && child.textContent === label) return child; const hit = visit(child); if (hit) return hit; } return null; }; return visit(row); };
    const queued = Array.from(rows()).find((row) => row.className.includes('state-queued')); const beforeRemoveCancels = socialCancelCalls.length; findButton(queued, 'Remove from queue').click();
    expect('social queued Remove is UI-only', [rows().includes(queued), socialCancelCalls.length], [false, beforeRemoveCancels]);
    const secondJob = downloadCalls[1].jobId; pendingDownloads.get(secondJob).resolve({ cardId: 'social-card', fileName: 'social.mp4' }); await flush();
    const completed = Array.from(rows()).find((row) => row.className.includes('state-completed') && row !== firstRow); findButton(completed, 'Add to timeline').click(); await flush();
    expect('social completed timeline handoff reuses card, bin, and placement', timelineCalls.at(-1), ['social-card', 'active', 'end']);
    findButton(completed, 'Delete file').click(); deleteResolve(); await flush();
    expect('social Delete file uses cardId and removes only after success', [deleteCalls, rows().includes(completed)], [['social-card'], false]);
    const cancelled = Array.from(rows()).find((row) => row.dataset.queueId === firstQueueId); findButton(cancelled, 'Retry').click(); await flush(); const retryJob = downloadCalls.at(-1).jobId;
    expect('social Retry keeps the provider route and canonical source', [downloadCalls.length, downloadCalls.at(-1).url, downloadCalls.at(-1).quality], [3, 'https://www.instagram.com/reel/ABC_def-123', '720p']); pendingDownloads.get(retryJob).reject(new Error('Retry failed.')); await flush();
    expect('social Retry failure leaves a recoverable failed row', Array.from(rows()).some((row) => row.className.includes('state-failed')), true);
  }
});

test('Pexels connection states, recovery and disclosure focus', async (t) => {
  const renderer = readFileSync(path.join(dist, 'renderer.js'), 'utf8');
  const formatContext = { window: { addEventListener: () => undefined, matchMedia: () => ({ matches: false }) }, document: {}, console, Date, Intl, setTimeout, clearTimeout, queueMicrotask };
  runInNewContext(renderer, formatContext);
  const TEST_KEY = 'test_key_12345678901234567890';
  const pexelsTest = (name, run) => t.test(name, run);
  for (const [label, got, want] of [
    ['renderer Pexels checking state', formatContext.pexelsStatusView(null), { text: 'Checking…', state: 'checking' }],
    ['renderer Pexels connecting state', formatContext.pexelsStatusView(null, true), { text: 'Connecting…', state: 'connecting' }],
    ['renderer Pexels saved state', formatContext.pexelsStatusView({ connected: true, persisted: true, message: '' }), { text: 'Connected · saved securely', state: 'connected' }],
    ['renderer Pexels session state', formatContext.pexelsStatusView({ connected: true, persisted: false, message: '' }), { text: 'Connected for this session', state: 'session' }],
    ['renderer Pexels disconnected/error states', [formatContext.pexelsStatusView({ connected: false, persisted: false, message: 'Disconnected.' }), formatContext.pexelsStatusView(null, false, 'Pexels rejected the API key.')], [{ text: 'Disconnected.', state: 'disconnected' }, { text: 'Pexels rejected the API key.', state: 'error' }]],
  ]) focusedExpect(label, got, want);
  await pexelsTest('renderer failed replacement and disconnect retain actual connected controls with safe errors', async () => {
    const elements = new Map(['pexels-connection-status', 'pexels-api-key', 'pexels-connect-btn', 'pexels-disconnect-btn', 'pexels-setup'].map((id) => [id, { id, textContent: '', value: id === 'pexels-api-key' ? 'candidate_key_123456789012345' : '', open: false, disabled: false, dataset: {}, classList: { toggle() {} } }]));
    const connected = { connected: true, persisted: true, message: 'Connected · saved securely' }; let statusCalls = 0;
    const context = { window: { addEventListener: () => undefined, matchMedia: () => ({ matches: false }), clipdockAPI: { setPexelsKey: async () => { throw new Error(`rejected ${TEST_KEY}`); }, clearPexelsKey: async () => { throw new Error(`/private/${TEST_KEY}`); }, pexelsKeyStatus: async () => { statusCalls += 1; return connected; } } }, document: { getElementById: (id) => elements.get(id) ?? null }, console, Date, Intl, setTimeout, clearTimeout, queueMicrotask, crypto: { randomUUID: () => 'id' } };
    runInNewContext(renderer, context);
    await context.connectPexels();
    const replacement = [elements.get('pexels-connect-btn').disabled, elements.get('pexels-disconnect-btn').disabled, elements.get('pexels-connection-status').textContent, elements.get('pexels-api-key').value, elements.get('pexels-setup').open];
    await context.disconnectPexels();
    const disconnect = [elements.get('pexels-connect-btn').disabled, elements.get('pexels-disconnect-btn').disabled, elements.get('pexels-connection-status').textContent, elements.get('pexels-setup').open];
    if (JSON.stringify(replacement) !== JSON.stringify([true, false, 'The new Pexels API key was rejected. Your existing connection was kept.', '', true]) || JSON.stringify(disconnect) !== JSON.stringify([true, false, 'Could not disconnect Pexels. The saved credential was not removed.', true]) || statusCalls !== 2 || JSON.stringify([replacement, disconnect]).includes(TEST_KEY) || JSON.stringify([replacement, disconnect]).includes('/private/')) throw new Error('renderer connection recovery lied about state, kept the disclosure closed, or exposed an error detail');
  });
  await pexelsTest('renderer disclosure is just-in-time: disconnected search opens/focuses and successful connect closes with summary focus', async () => {
    const makeElement = (id) => ({ id, textContent: '', value: '', open: false, disabled: false, dataset: {}, classList: { toggle() {} }, focus() { active = this; } });
    const elements = new Map(['pexels-setup','pexels-setup-summary','pexels-api-key','pexels-connect-btn','pexels-disconnect-btn','pexels-connection-status','youtube-search-input','youtube-search-status','youtube-status','youtube-progress'].map((id) => [id, makeElement(id)]));
    let active = null;
    const context = { window: { addEventListener: () => undefined, matchMedia: () => ({ matches: false }), clipdockAPI: { pexelsKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), pixabayKeyStatus: async () => ({ connected: false, persisted: false, message: 'Disconnected' }), onPixabayEvent: () => () => undefined, setPexelsKey: async () => ({ connected: true, persisted: true, message: 'Connected · saved securely' }), searchPexels: async () => { throw new Error('not used'); } } }, document: { get activeElement() { return active; }, getElementById: (id) => elements.get(id) ?? null }, console, Date, Intl, setTimeout, clearTimeout, queueMicrotask, crypto: { randomUUID: () => 'id' } };
    runInNewContext(renderer, context);
    await context.searchPexels(1);
    const revealed = [elements.get('pexels-setup').open, active === elements.get('pexels-api-key'), elements.get('youtube-status').textContent];
    await context.connectPexels();
    const connected = [elements.get('pexels-setup').open, active === elements.get('pexels-setup-summary'), elements.get('pexels-api-key').value, elements.get('pexels-connection-status').textContent, elements.get('pexels-connect-btn').disabled];
    if (JSON.stringify(revealed) !== JSON.stringify([true, true, 'Connect a Pexels API key for this session.']) || JSON.stringify(connected) !== JSON.stringify([false, true, '', 'Connected · saved securely', true])) throw new Error(`disclosure JIT contract broken: ${JSON.stringify([revealed, connected])}`);
  });
});

// Replaces the old sole text guards for keyboard submission, preferences,
// provider defaults and managed-folder actions with real event/API effects.
function controlsHarness(t) {
  const dom = createFakeDom();
  const elements = new Map();
  const ids = ['refresh-btn','bridge-state','module-version','resolve-version','project-name','timeline-name','message','refresh-hint','last-updated','youtube-search-input','youtube-search-btn','youtube-search-prev','youtube-search-next','load-youtube-btn','youtube-url','load-social-btn','social-url','youtube-quality','youtube-profile','youtube-media-mode','youtube-audio-format','youtube-subtitles','prores-warning','youtube-subtitle-language','video-controls','audio-controls','download-youtube-btn','youtube-intent','quality-chips','profile-controls','preview-selected-btn','preview-note','youtube-status','youtube-progress','youtube-search-results','youtube-search-status','youtube-search-form','youtube-paste-url','social-url-panel','social-platform-instagram','social-platform-twitter','social-platform-facebook','social-platform-hint','social-platform-hint','pexels-setup','pexels-setup-summary','pexels-api-key','pexels-connection-status','pexels-kind-switch','pexels-credit','pexels-attribution','metadata-verified','youtube-metadata','youtube-thumbnail','youtube-title','youtube-channel','youtube-duration','youtube-target-bin','youtube-download-queue','youtube-queue-status','inspector-empty','inspector-loading','media-card','card-name','select-file-btn','destination','timeline-placement','transfer-result','import-btn','timeline-btn','profile-controls','source-monitor','provider-youtube','provider-pexels','provider-social','pexels-photo-kind','pexels-video-kind','pexels-connect-btn','pexels-disconnect-btn','pexels-key-link','stock-source-switch','stock-source-pexels','stock-source-pixabay','stock-credit-lead','pixabay-setup','pixabay-setup-summary','pixabay-connection-status','pixabay-api-key','pixabay-connect-btn','pixabay-disconnect-btn','pixabay-key-link','pixabay-save-note','pexels-link','advanced-options','youtube-selection-controls','youtube-subtitle-controls','youtube-mode-controls','pin-on-top-btn'];
  for (const id of [...new Set([...ids, ...REQUIRED_HTML_IDS_FLAT, 'first-use-ack', 'settings-close', 'pexels-setup-summary', 'pexels-connection-status', 'workspace-status', 'settings-workspace-status', 'open-workspace-btn', 'open-downloads-folder-btn'])]) elements.set(id, dom.makeElement('div', id));
  for (const [id, value] of [['youtube-profile', 'original'], ['youtube-quality', 'best'], ['youtube-media-mode', 'video'], ['youtube-audio-format', 'mp3'], ['youtube-subtitle-language', 'en'], ['youtube-target-bin', 'active'], ['youtube-intent', 'download'], ['common-profile', 'original'], ['common-quality', 'best'], ['common-media-mode', 'video'], ['common-audio-format', 'mp3'], ['common-intent', 'download'], ['common-target-bin', 'active']]) elements.get(id).value = value;
  elements.get('profile-controls').parentElement = dom.makeElement('div');
  for (const profile of ['original', 'fast', 'editing']) { const button = dom.makeElement('button'); button.dataset.profile = profile; elements.get('profile-controls').append(button); }
  const listeners = {}; const calls = []; const preferences = new Map();
  const status = { phase: 'ready', bridge: { connected: true, moduleVersion: 'x', resolveVersion: 'x', error: null }, project: { name: 'p', loaded: true }, timeline: { name: 't', loaded: true }, message: 'ready', refreshHint: null };
  const api = {
    getStatus: async () => status, onResolveQuit: () => () => {}, onYoutubeEvent: () => () => {}, onSocialEvent: () => () => {}, onPinterestEvent: () => () => {}, onPexelsEvent: () => () => {},
    pexelsKeyStatus: async () => ({ connected: true, persisted: true, message: 'Connected' }), pixabayKeyStatus: async () => ({ connected: true, persisted: true, message: 'Connected' }), onPixabayEvent: () => () => undefined,
    setPexelsKey: async (key) => { calls.push(['key', key]); return { connected: true, persisted: true, message: 'Connected' }; },
    searchPexels: async (...args) => { calls.push(['pexels-search', ...args]); return { query: 'q', page: 1, results: [], pageCount: 1, totalResults: 0, hasPrevious: false, hasNext: false }; },
    loadYoutube: async (url) => { calls.push(['youtube-load', url]); return { id: 'dQw4w9WgXcQ', title: 'Clip', duration: 10, channel: 'Channel', thumbnailUrl: null, heights: [720], chapters: [] }; },
    loadSocial: async (url) => { calls.push(['social-load', url]); return { id: 'social1', platform: 'instagram', source: url, title: 'Social', duration: 10, channel: 'Creator', thumbnailDataUrl: null, heights: [720] }; },
    downloadYoutube: async (...args) => { calls.push(['download', ...args]); return { cardId: 'card', fileName: 'clip.mp4' }; },
    openWorkspace: async () => { calls.push(['open-workspace']); return false; },
    workspaceStatus: async () => ({ fileCount: 0, totalBytes: 0, cleanupFileCount: 0, cleanupBytes: 0 }),
    historyList: async () => [], cancelPexelsRequests: async () => false,
  };
  const document = { body: { dataset: {} }, get activeElement() { return dom.activeElement; }, getElementById: (id) => elements.get(id) ?? null, createElement: dom.makeElement, querySelector: () => null };
  const timers = new Map(); let timerId = 0;
  const window = { clipdockAPI: api, location: { search: '' }, matchMedia: () => ({ matches: false }), addEventListener: (type, listener) => { listeners[type] = listener; }, removeEventListener() {}, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id), localStorage: { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) } };
  const context = { window, document, console, Date, Math, Intl, URL, Number, Promise, crypto: { randomUUID: () => 'control-job' }, setTimeout, clearTimeout, queueMicrotask };
  runInNewContext(readFileSync(path.join(dist, 'renderer.js'), 'utf8'), context);
  listeners.DOMContentLoaded();
  t.after(() => { timers.clear(); });
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const key = (target, key, extra = {}) => target.listeners.keydown({ key, preventDefault() {}, ...extra });
  return { elements, listeners, calls, preferences, context, flush, key, dom };
}

test('plain Enter reuses enabled buttons and ignores composition and modifiers', async (t) => {
  const f = controlsHarness(t); await f.flush();
  for (const [inputId, buttonId] of [['youtube-url', 'load-youtube-btn'], ['social-url', 'load-social-btn'], ['pexels-api-key', 'pexels-connect-btn']]) {
    const input = f.elements.get(inputId); const button = f.elements.get(buttonId); let clicks = 0;
    button.listeners.click = () => { clicks += 1; }; button.disabled = false;
    f.key(input, 'Enter');
    for (const modifier of ['isComposing', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey']) f.key(input, 'Enter', { [modifier]: true });
    f.key(input, 'x'); button.disabled = true; f.key(input, 'Enter');
    assert.equal(clicks, 1, inputId);
  }
});

test('command shortcuts enqueue the selected item and open Settings; page keys use enabled pagination', async (t) => {
  const f = controlsHarness(t); await f.flush();
  let downloads = 0; f.elements.get('download-youtube-btn').listeners.click = () => { downloads += 1; };
  f.listeners.keydown({ key: 'Enter', metaKey: true, preventDefault() {} });
  f.listeners.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.equal(downloads, 2);
  f.listeners.keydown({ key: ',', metaKey: true, preventDefault() {} });
  assert.equal(f.elements.get('settings-panel').getAttribute('aria-hidden'), 'false');
  let previous = 0, next = 0;
  const prevButton = f.elements.get('youtube-search-prev'), nextButton = f.elements.get('youtube-search-next');
  prevButton.listeners.click = () => { previous += 1; }; nextButton.listeners.click = () => { next += 1; };
  prevButton.disabled = false; nextButton.disabled = false;
  f.key(f.elements.get('youtube-search-results'), 'PageUp'); f.key(f.elements.get('youtube-search-results'), 'PageDown');
  nextButton.disabled = true; f.key(f.elements.get('youtube-search-results'), 'PageDown');
  assert.deepEqual([previous, next], [1, 1]);
});

test('providers wrap roving focus and Pexels searches default to Video', async (t) => {
  const f = controlsHarness(t); await f.flush();
  const youtube = f.elements.get('provider-youtube'), social = f.elements.get('provider-social');
  f.key(youtube, 'ArrowLeft'); assert.equal(f.dom.activeElement.id, 'provider-social');
  f.key(social, 'ArrowRight'); assert.equal(f.dom.activeElement.id, 'provider-youtube');
  f.key(youtube, 'End'); assert.equal(f.dom.activeElement.id, 'provider-social');
  f.key(social, 'Home'); assert.equal(f.dom.activeElement.id, 'provider-youtube');
  assert.deepEqual(['provider-youtube', 'provider-pinterest', 'provider-pexels', 'provider-social'].map((id) => f.elements.get(id).tabIndex), [0, -1, -1, -1]);
  f.elements.get('provider-pexels').click(); f.elements.get('youtube-search-input').value = 'q'; await f.context.searchPexels(1);
  assert.deepEqual(f.calls.find((call) => call[0] === 'pexels-search'), ['pexels-search', 'video', 'q', 1]);
});

test('first-use acknowledgement and output preference persist without storing credentials', async (t) => {
  const f = controlsHarness(t); await f.flush();
  assert.equal(f.elements.get('first-use-dialog').getAttribute('open'), '');
  assert.equal(f.dom.activeElement.id, 'first-use-ack');
  f.elements.get('first-use-ack').click();
  assert.equal(f.elements.get('first-use-dialog').getAttribute('open'), null);
  assert.equal(f.preferences.get('clipdock.permitted-content-ack'), 'true');
  f.elements.get('common-profile').value = 'fast'; f.elements.get('common-profile').listeners.change();
  assert.equal(f.preferences.get('clipdock.output-intent'), 'fast');
  f.elements.get('pexels-api-key').value = 'candidate_key_123456789012345'; await f.context.connectPexels();
  assert.deepEqual(f.calls.find((call) => call[0] === 'key'), ['key', 'candidate_key_123456789012345']);
  assert.equal([...f.preferences.values()].includes('candidate_key_123456789012345'), false);
  assert.equal([...f.preferences.keys()].some((key) => /pexels|secret|api-key/i.test(key)), false);
});

test('Settings and Downloads open the managed folder and report bounded errors', async (t) => {
  const f = controlsHarness(t); await f.flush();
  f.elements.get('open-workspace-btn').click(); f.elements.get('open-downloads-folder-btn').click(); await f.flush();
  assert.deepEqual(f.calls.filter((call) => call[0] === 'open-workspace'), [['open-workspace'], ['open-workspace']]);
  assert.equal(f.elements.get('workspace-status').textContent, 'Could not open the managed ClipDock folder.');
  assert.equal(f.elements.get('settings-workspace-status').textContent, 'Could not open the managed ClipDock folder.');
});

test('Source Monitor lock respects reduced-motion preference', async (t) => {
  const f = controlsHarness(t); await f.flush();
  const monitor = f.elements.get('source-monitor');
  f.context.playSourceLock(); assert.equal(monitor.classList.contains('locking'), true);
  monitor.classList.remove('locking');
  f.context.window.matchMedia = () => ({ matches: true });
  f.context.playSourceLock(); assert.equal(monitor.classList.contains('locking'), false);
});

test('successful Pexels disconnect and failed startup status reveal connection setup', async (t) => {
  const f = controlsHarness(t); await f.flush();
  f.context.window.clipdockAPI.clearPexelsKey = async () => ({ connected: false, persisted: false, message: 'Disconnected.' });
  await f.context.disconnectPexels();
  assert.deepEqual([f.elements.get('pexels-setup').open, f.elements.get('pexels-connect-btn').disabled, f.elements.get('pexels-connection-status').textContent], [true, false, 'Disconnected.']);
  f.elements.get('pexels-setup').open = false;
  f.context.window.clipdockAPI.pexelsKeyStatus = async () => { throw new Error('provider detail must stay private'); };
  f.listeners.DOMContentLoaded(); await f.flush();
  assert.deepEqual([f.elements.get('pexels-setup').open, f.elements.get('pexels-connection-status').textContent], [true, 'Could not check Pexels connection.']);
});
