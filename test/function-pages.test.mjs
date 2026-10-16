// Fixed function-page and staged-selection coverage. The harness stays renderer-only:
// no Electron, Resolve, network, or filesystem paths cross the test boundary.
import assert from 'node:assert/strict';
import { createHarness } from './helpers/renderer-harness.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const styles = readFileSync(path.join(root, 'static', 'css', 'styles.css'), 'utf8');

test('result-card card-thumb CSS preserves aspect ratio without stretching the grid item', () => {
  const cardThumbEntries = Array.from(styles.matchAll(/([^{}]*\.result-card-thumbnail\.card-thumb[^{}]*)\{([^{}]*)\}/g), (match) => [match[1], match[2]]);
  assert.ok(cardThumbEntries.length > 0, 'card-thumb rules exist');
  for (const [, rule] of cardThumbEntries) assert.doesNotMatch(rule, /align-self\s*:\s*stretch/i);
  const outer = cardThumbEntries.find(([sel, rule]) => !/::before/.test(sel) && !/ img/.test(sel) && !/thumbnail-fallback/.test(sel) && /aspect-ratio/.test(rule));
  assert.ok(outer, 'outer card-thumb keeps 16:9 aspect');
  assert.match(outer[1], /position\s*:\s*relative/i, 'outer thumb stays position:relative');
  assert.match(outer[1], /overflow\s*:\s*hidden/i, 'outer thumb keeps overflow clipping');
  assert.match(outer[1], /aspect-ratio\s*:\s*16\s*\/\s*9/i, 'outer thumb keeps 16:9');
  const beforeMatches = cardThumbEntries.filter(([sel]) => /::before/.test(sel));
  assert.ok(beforeMatches.length > 0, 'card-thumb ::before rule exists');
  for (const [, rule] of beforeMatches) {
    assert.match(rule, /content\s*:\s*none/i, '::before pseudo is disabled');
    assert.match(rule, /display\s*:\s*none/i, '::before pseudo is disabled');
    assert.doesNotMatch(rule, /padding-top\s*:\s*56\.25%/i, 'no legacy 56.25% spacer');
  }
  const imgEntry = cardThumbEntries.find(([sel]) => /\.result-card-thumbnail\.card-thumb\s+img/.test(sel));
  const fallbackEntry = cardThumbEntries.find(([sel]) => /thumbnail-fallback-label/.test(sel));
  assert.ok(imgEntry, 'card image rule exists');
  assert.ok(fallbackEntry, 'card fallback rule exists');
  for (const [label, rule] of [['img', imgEntry[1]], ['fallback', fallbackEntry[1]]]) {
    assert.match(rule, /position\s*:\s*static/i, `${label} is normal-flow`);
    assert.match(rule, /aspect-ratio\s*:\s*16\s*\/\s*9/i, `${label} establishes 16:9 in normal flow`);
    assert.doesNotMatch(rule, /position\s*:\s*absolute/i, `${label} must not be absolute positioned`);
    assert.doesNotMatch(rule, /inset\s*:\s*0/i, `${label} must not be inset-stretched`);
  }
  assert.match(styles, /\.result-card-thumbnail\.card-thumb\s+\.result-play-control[\s\S]*?position\s*:\s*absolute/i, 'play overlay stays absolute');
  assert.match(styles, /\.result-card-thumbnail\.card-thumb\s+\.youtube-duration[\s\S]*?position\s*:\s*absolute/i, 'duration badge stays absolute');
});

test('result-card thumbnails rely on CSS aspect-ratio and leave inline heights absent across resizes', async () => {
  // CSS aspect-ratio owns 16:9 since D Home Grid port - verify CSS rule exists
  assert.match(styles, /\.result-card-thumbnail\.card-thumb[^{]*\{[^}]*aspect-ratio\s*:\s*16\s*\/\s*9/, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  // CSS aspect-ratio owns 16:9 since D Home Grid port - card must be stacked single-column
  assert.match(styles, /\.youtube-search-result\.clipdock-result-card[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  // CSS aspect-ratio owns 16:9 since D Home Grid port - legacy horizontal template must be gone
  assert.doesNotMatch(styles, /grid-template-columns:\s*clamp\(280px,\s*42%,\s*430px\)/, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  const h = createHarness();
  await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page);
  await h.flush();

  const rows = h.elements.get('youtube-search-results').children;
  const thumbs = rows.map((row) => row.children.find((child) => child.dataset.field === 'thumbnail'));
  thumbs[0].getBoundingClientRect = () => ({ width: 722 });
  thumbs[1].getBoundingClientRect = () => ({ width: 406 });
  h.test.scheduleResultCardThumbnailHeights();
  // CSS aspect-ratio owns 16:9 since D Home Grid port - inline heights must stay absent
  assert.equal(thumbs[0].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(thumbs[1].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(rows[0].style.minHeight, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(rows[1].style.minHeight, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');

  thumbs[0].getBoundingClientRect = () => ({ width: 1316 });
  thumbs[1].getBoundingClientRect = () => ({ width: 740 });
  for (const callback of h.windowListeners.resize ?? []) callback();
  for (const callback of h.windowListeners.resize ?? []) callback();
  // CSS aspect-ratio owns 16:9 since D Home Grid port - resize must not inject inline heights
  assert.equal(thumbs[0].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(thumbs[1].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(rows[0].style.minHeight, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(rows[1].style.minHeight, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');

  thumbs[0].getBoundingClientRect = () => ({ width: 0 });
  thumbs[1].getBoundingClientRect = () => ({ width: Number.NaN });
  h.test.syncResultCardThumbnailHeights();
  // CSS aspect-ratio owns 16:9 since D Home Grid port - invalid widths must not create stale inline heights
  assert.equal(thumbs[0].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  assert.equal(rows[0].style.minHeight, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
  h.test.syncResultCardThumbnailHeights();
  assert.equal(thumbs[0].style.height, undefined, 'CSS aspect-ratio owns 16:9 since D Home Grid port');
});

test('fixed navigation and staged selections preserve common snapshots and queue FIFO', async () => {
  const h = createHarness();
  await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page);
  await h.flush();

  const first = h.elements.get('youtube-search-results').children[0];
  const firstCheck = first.children.find((child) => child.className === 'result-selection');
  assert.ok(firstCheck, 'result has a native checkbox beside its row content');
  assert.notEqual(first.tagName, 'BUTTON');
  h.elements.get('common-profile').value = 'editing';
  h.elements.get('common-target-bin').value = 'clipdock';
  h.elements.get('common-profile').listeners.change();
  firstCheck.checked = true;
  firstCheck.listeners.change();

  h.elements.get('common-profile').value = 'fast';
  h.elements.get('common-profile').listeners.change();
  const second = h.elements.get('youtube-search-results').children[1];
  const secondCheck = second.children.find((child) => child.className === 'result-selection');
  secondCheck.checked = true;
  secondCheck.listeners.change();
  assert.equal(h.elements.get('selection-count').textContent, '2 selected');
  const staged = h.test.staged();
  assert.equal(staged.find((entry) => entry.key === 'youtube:aaaaaaaaaaa').snapshot.profile, 'editing');
  assert.equal(staged.find((entry) => entry.key === 'youtube:bbbbbbbbbbb').snapshot.profile, 'fast');

  // The explicit advanced action opens the legacy detail fallback without making
  // the card body itself a second navigation target.
  openAdvancedCard(h.elements.get('youtube-search-results').children[0]);
  await h.flush();
  h.elements.get('youtube-profile').value = 'original';
  h.elements.get('youtube-profile').listeners.change();
  assert.equal(h.test.staged().find((entry) => entry.key === 'youtube:aaaaaaaaaaa').overrides.profile, 'original');

  const enqueue = h.test.enqueueSelected();
  await h.flush();
  assert.equal(h.downloads.length, 1, 'one active download starts immediately');
  // Chip removed per user decision - verify queue state via queue model instead.
  assert.equal(h.test.queue().filter((item) => item.status === 'downloading').length, 1);
  assert.equal(h.test.queue().filter((item) => item.status === 'queued').length, 1);
  h.downloads[0].resolve({ cardId: 'card-a', fileName: 'a.mp4' });
  await h.flush(); await h.flush();
  assert.equal(h.downloads.length, 2, 'FIFO starts the second staged item after the first resolves');
  assert.equal(h.downloads[0].profile, 'original');
  assert.equal(h.downloads[1].profile, 'fast');
  h.downloads[1].resolve({ cardId: 'card-b', fileName: 'b.mp4' });
  await enqueue; await h.flush(); await h.flush();
  assert.equal(h.test.queue().filter((item) => item.status === 'completed').length, 2);
  assert.equal(h.test.staged().length, 0, 'successfully accepted snapshot entries leave staging');

  h.elements.get('surface-nav-queue').click();
  assert.equal(h.elements.get('surface-nav-queue').getAttribute('aria-current'), 'page');
  assert.equal(h.elements.get('surface-nav-search').getAttribute('aria-current'), null);
  h.elements.get('surface-nav-library').click();
  assert.equal(h.elements.get('completed-downloads').children.length, 2);
  h.elements.get('settings-btn').focus();
  h.elements.get('settings-btn').click();
  await h.flush();
  assert.equal(h.elements.get('settings-panel').hidden, false);
  assert.equal(h.elements.get('settings-btn').getAttribute('aria-current'), 'page');
  assert.equal(h.elements.get('settings-download-folder').textContent, '/Downloads/ClipDock');
  h.elements.get('settings-close').click();
  assert.equal(h.elements.get('surface-nav-library').getAttribute('aria-current'), 'page');
  assert.equal(h.activeElement, h.elements.get('settings-btn'));
});

test('Search detail opens on demand and Back or Escape restores the result context', async () => {
  const h = createHarness(); await h.fireReady();
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'true');

  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const list = h.elements.get('youtube-search-results');
  const workspace = h.elements.get('workspace');
  list.scrollTop = 91; list.scrollLeft = 7; workspace.scrollTop = 55;
  list.children[0].click(); await h.flush();
  assert.equal(workspace.classList.contains('inspector-open'), false, 'card body stays inline');
  openAdvancedCard(list.children[0]); await h.flush();
  assert.equal(workspace.classList.contains('inspector-open'), true);
  assert.equal(h.elements.get('search-surface').classList.contains('detail-open'), true);
  assert.equal(workspace.scrollTop, 0);
  assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'false');
  list.scrollTop = 300; list.scrollLeft = 40;
  h.elements.get('back-to-results').click();
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), false);
  assert.equal(h.elements.get('search-surface').classList.contains('detail-open'), false);
  assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'true');
  assert.equal(list.scrollTop, 91); assert.equal(list.scrollLeft, 7); assert.equal(workspace.scrollTop, 55);
  assert.equal(h.activeElement.dataset.resultId, 'aaaaaaaaaaa');

  list.children[0].click(); await h.flush();
  assert.equal(workspace.classList.contains('inspector-open'), false, 'repeated card-body activation never opens the detail rail');
  openAdvancedCard(list.children[0]); await h.flush();
  list.scrollTop = 400;
  h.keydown({ key: 'Escape' });
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), false);
  assert.equal(list.scrollTop, 91);
  assert.equal(h.activeElement.dataset.resultId, 'aaaaaaaaaaa');
});

test('YouTube Preview owns one native player while fallback, staging, selection, Back, and Escape stay independent', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots'; h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} }); h.searches[0].entry.resolve(h.page); await h.flush();
  const first = h.elements.get('youtube-search-results').children[0];
  const firstCheck = first.children.find((child) => child.className === 'result-selection'); firstCheck.checked = true; firstCheck.listeners.change();
  openAdvancedCard(h.elements.get('youtube-search-results').children[0]); await h.flush();
  h.elements.get('preview-selected-btn').click(); await h.flush();
  assert.equal(JSON.stringify(h.previewCalls.open), JSON.stringify([{ id: 'aaaaaaaaaaa', bounds: { x: 120, y: 160, width: 480, height: 270 } }]));
  assert.equal(h.elements.get('preview-selected-btn').textContent, 'Stop preview');
  assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'true');
  for (const callback of h.windowListeners.resize ?? []) callback();
  await new Promise((resolve) => setTimeout(resolve, 25)); await h.flush();
  assert.equal(JSON.stringify(h.previewCalls.bounds.at(-1)), JSON.stringify({ x: 120, y: 160, width: 480, height: 270 }), 'resize updates native view bounds');
  assert.equal(h.test.staged().length, 1, 'preview does not mutate staging');
  h.elements.get('open-youtube-external-btn').click(); await h.flush();
  assert.deepEqual(h.previewCalls.external, [{ id: 'aaaaaaaaaaa', start: undefined }], 'external fallback is explicit and separate');

  openAdvancedCard(h.elements.get('youtube-search-results').children[1]); await h.flush();
  assert.equal(h.previewCalls.close, 1, 'changing the advanced selection closes the native player');
  assert.equal(h.test.staged().length, 1, 'changing preview selection does not clear staging');
  h.elements.get('preview-selected-btn').click(); await h.flush();
  h.elements.get('back-to-results').click(); await h.flush();
  assert.equal(h.previewCalls.close, 2, 'Back closes the player');

  openAdvancedCard(h.elements.get('youtube-search-results').children[1]); await h.flush(); h.elements.get('preview-selected-btn').click(); await h.flush();
  h.previewState({ state: 'closed', reason: 'escape' });
  assert.equal(h.elements.get('preview-selected-btn').textContent, 'Preview');
  assert.equal(h.elements.get('preview-selected-btn').getAttribute('aria-pressed'), 'false');
  assert.equal(h.activeElement, h.elements.get('preview-selected-btn'), 'view-focused Escape restores renderer focus/state');
  h.elements.get('preview-selected-btn').click(); await h.flush(); h.keydown({ key: 'Escape' }); await h.flush();
  // The native close event already disposed its player; only renderer-owned stops send close IPC.
  assert.equal(h.previewCalls.close, 3, 'renderer-focused Escape closes the player before closing detail');
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), true);
});

test('Cmd/Ctrl+K routes Settings to visible Search and subtitle language follows its checkbox', async () => {
  const h = createHarness(); await h.fireReady();
  const language = h.elements.get('common-subtitle-language');
  const languageLabel = h.elements.get('common-subtitle-language-label');
  assert.equal(language.disabled, true);
  assert.equal(languageLabel.classList.contains('hidden'), true);
  h.elements.get('common-subtitles').checked = true;
  h.elements.get('common-subtitles').listeners.change();
  assert.equal(language.disabled, false);
  assert.equal(languageLabel.classList.contains('hidden'), false);

  h.elements.get('surface-nav-library').click();
  h.elements.get('settings-btn').focus(); h.elements.get('settings-btn').click(); await h.flush();
  h.keydown({ key: 'k', ctrlKey: true });
  assert.equal(h.elements.get('search-surface').hidden, false);
  assert.equal(h.elements.get('settings-panel').hidden, true);
  assert.equal(h.elements.get('surface-nav-search').getAttribute('aria-current'), 'page');
  assert.equal(h.elements.get('settings-btn').getAttribute('aria-current'), null);
  assert.equal(h.activeElement, h.elements.get('youtube-search-input'));
});

test('direct single-item enqueue uses the selected item handoff', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  h.elements.get('load-youtube-btn').click(); await h.flush();
  h.elements.get('youtube-intent').value = 'import';
  h.elements.get('youtube-intent').listeners.change();
  assert.equal(h.elements.get('download-youtube-btn').textContent, 'Add to Media Pool');
  h.elements.get('download-youtube-btn').click(); await h.flush();
  h.downloads[0].resolve({ cardId: 'direct-card', fileName: 'direct.mp4' }); await h.flush();
  assert.deepEqual(h.transfers, [{ action: 'import', cardId: 'direct-card', bin: 'active' }]);
});


test('batch enqueue snapshots selection, disables mutation, clears accepted entries, and retains metadata failures', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots'; h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} }); h.searches[0].entry.resolve(h.page); await h.flush();
  for (const row of h.elements.get('youtube-search-results').children) { const check = row.children.find((child) => child.className === 'result-selection'); check.checked = true; check.listeners.change(); }
  let releaseFirst;
  h.api.loadYoutube = (url) => url.includes('aaaaaaaaaaa') ? new Promise((resolve) => { releaseFirst = resolve; }) : Promise.reject(new Error('metadata unavailable'));
  const run = h.test.enqueueSelected(); await h.flush();
  const busyChecks = h.elements.get('youtube-search-results').children.map((row) => row.children.find((child) => child.className === 'result-selection'));
  assert.ok(busyChecks.every((check) => check.disabled), 'result selection controls expose native disabled truth while busy');
  busyChecks[0].checked = false; busyChecks[0].listeners.change();
  h.test.stage({ key: 'youtube:new', provider: 'youtube', resultId: 'new', source: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'New', channel: null, thumbnailDataUrl: null, snapshot: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null }, overrides: {} });
  releaseFirst({ id: 'aaaaaaaaaaa', title: 'A', duration: 1, channel: null, thumbnailDataUrl: null, heights: [1080], formatSummary: [], chapters: [] });
  await run; await h.flush();
  assert.deepEqual(Array.from(h.test.queue(), (item) => item.videoId), ['aaaaaaaaaaa'], 'newly staged work cannot leak into the in-flight snapshot');
  assert.deepEqual(Array.from(h.test.staged(), (entry) => entry.key).sort(), ['youtube:bbbbbbbbbbb', 'youtube:new']);
  assert.match(h.elements.get('selection-status').textContent, /retained for retry/);
  assert.equal(h.elements.get('selection-toolbar').getAttribute('aria-busy'), 'false');
});

test('redesign retains Search splitter keyboard/pointer behavior and truthful pin state', async () => {
  // Lab layout: one seam between the contact sheet and the clip detail. Its value is
  // the detail width; moving the seam left (ArrowLeft or a leftward drag) grows it.
  const h = createHarness(); await h.fireReady();
  const splitter = h.elements.get('workspace-splitter');
  assert.equal(splitter.getAttribute('aria-valuenow'), '352');
  assert.equal(splitter.getAttribute('aria-valuemin'), '320');
  assert.equal(splitter.getAttribute('aria-valuemax'), '440', 'the detail max keeps a 360px sheet beside it');
  let prevented = false;
  splitter.listeners.keydown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(splitter.getAttribute('aria-valuenow'), '368');
  assert.equal(h.elements.get('workspace').style.values['--detail-w'], '368px');
  assert.equal(h.preferences.get('clipdock.detail-width'), '368');
  splitter.listeners.keydown({ key: 'End', preventDefault() {} });
  assert.equal(splitter.getAttribute('aria-valuenow'), '440', 'End clamps to the live maximum');
  splitter.listeners.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(splitter.getAttribute('aria-valuenow'), '320');
  splitter.listeners.pointerdown({ pointerId: 1, clientX: 500, currentTarget: splitter, preventDefault() {} });
  splitter.listeners.pointermove({ pointerId: 1, clientX: 450, currentTarget: splitter, preventDefault() {} });
  assert.equal(splitter.getAttribute('aria-valuenow'), '370');
  splitter.listeners.pointercancel({ pointerId: 1, clientX: 450, currentTarget: splitter, preventDefault() {} });
  splitter.listeners.pointermove({ pointerId: 1, clientX: 300, currentTarget: splitter, preventDefault() {} });
  assert.equal(splitter.getAttribute('aria-valuenow'), '370', 'pointer movement is inert after cancellation');
  assert.equal(h.preferences.get('clipdock.detail-width'), '370', 'the dragged width persists on release');

  const pin = h.elements.get('pin-on-top-btn'); pin.setAttribute('aria-pressed', 'false');
  pin.click(); await h.flush();
  assert.equal(pin.getAttribute('aria-pressed'), 'true');
  assert.equal(pin.getAttribute('aria-label'), 'Unpin ClipDock');
  assert.equal(pin.disabled, false);
});

test('production markup exposes one fixed function shell with no duplicate IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
  assert.match(html, /id="surface-nav-search"[^>]*aria-current="page"/);
  assert.match(html, /id="settings-panel"[^>]*class="surface-page surface-page-settings hidden"/);
  // User decision: top-right queue chip removed as redundant with left sidebar Queue nav.
  assert.doesNotMatch(html, /id="global-queue-status"/);
  assert.match(html, /id="common-intent"[^>]*>[\s\S]*?Download only[\s\S]*?Add to Media Pool[\s\S]*?Timeline end[\s\S]*?At playhead/);
  assert.match(html, /id="youtube-intent"/);
  assert.doesNotMatch(html, /downloads-splitter|downloads-toggle/);
});

// Depth-first descendant lookup matching findResultDescendant in the renderer, so
// inline-card tests can locate dynamically built controls by dataset shape.
function findDescendant(root, predicate) {
  for (const child of root.children ?? []) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}
function openAdvancedCard(row) {
  const advanced = findDescendant(row, (element) => element.dataset?.cardAction === 'advanced');
  assert.ok(advanced, 'card exposes an explicit advanced fallback');
  advanced.click();
}

test('inline result cards keep per-card options/disclosure across rerenders and route them into the tail enqueue', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const list = h.elements.get('youtube-search-results');
  const rowA = list.children[0];
  const keyA = rowA.dataset.resultKey;
  assert.equal(rowA.dataset.cardPhoto, 'false');

  // Always-visible card actions: enqueue/now live in a dedicated group that stays
  // present even while the per-card options disclosure is closed.
  const actions = findDescendant(rowA, (el) => el.dataset?.field === 'card-actions');
  assert.ok(actions, 'card shows an always-rendered actions group');
  const enqueue = findDescendant(rowA, (el) => el.dataset?.cardAction === 'enqueue');
  const now = findDescendant(rowA, (el) => el.dataset?.cardAction === 'now');
  assert.ok(enqueue && now, 'enqueue and now actions are always rendered');
  assert.match(enqueue.getAttribute('aria-label'), /Add to queue: A/);
  assert.equal(now.textContent, 'Download now');
  assert.equal(now.getAttribute('aria-label'), 'Download now: A');
  const options = findDescendant(rowA, (el) => el.dataset?.field === 'options');
  assert.equal(options.hidden, true);
  assert.equal(options.getAttribute('aria-hidden'), 'true');
  assert.ok(options.className.includes(' hidden'));
  const advanced = findDescendant(rowA, (el) => el.dataset?.cardAction === 'advanced');
  assert.equal(advanced.getAttribute('aria-label'), 'Open advanced options for A');

  // The disclosure opens per card and toggles the native hidden/aria state.
  const toggle = findDescendant(rowA, (el) => el.dataset?.cardAction === 'options');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(options.hidden, false);
  assert.equal(options.getAttribute('aria-hidden'), 'false');
  assert.equal(h.test.optionsOpen(keyA), true);

  // A per-card output edit commits to card-local state and the card's output line.
  const profile = findDescendant(rowA, (el) => el.dataset?.field === 'profile');
  profile.value = 'editing';
  profile.listeners.change({ stopPropagation() {} });
  assert.equal(h.test.cardOutputOverrides(keyA).profile, 'editing');
  assert.equal(findDescendant(rowA, (el) => el.dataset?.field === 'output-line').textContent, 'Best available · Edit-ready · Active bin');
  assert.equal(findDescendant(rowA, (el) => el.dataset?.field === 'output-source').textContent, 'Override');

  // A rerender (staging another card re-renders every row) keeps this card's
  // disclosure, output override, and select choices.
  const checkB = list.children[1].children.find((child) => child.className === 'result-selection');
  checkB.checked = true; checkB.listeners.change();
  const renderedA = list.children[0];
  assert.equal(renderedA.dataset.resultKey, keyA);
  assert.equal(findDescendant(renderedA, (el) => el.dataset?.field === 'profile').value, 'editing');
  assert.equal(findDescendant(renderedA, (el) => el.dataset?.cardAction === 'options').getAttribute('aria-expanded'), 'true');
  assert.equal(findDescendant(renderedA, (el) => el.dataset?.field === 'options').hidden, false);
  assert.equal(findDescendant(renderedA, (el) => el.dataset?.field === 'output-line').textContent, 'Best available · Edit-ready · Active bin');
  checkB.checked = false; checkB.listeners.change();
  const renderedA2 = list.children[0];
  assert.equal(findDescendant(renderedA2, (el) => el.dataset?.field === 'profile').value, 'editing', 'override survives staging/unstaging other cards');

  // The card-local enqueue uses the per-card override and starts immediately
  // because the queue is idle (tail enqueue + idle pump).
  const selectionA = { provider: 'youtube', resultId: 'aaaaaaaaaaa', source: h.page.results[0].url, title: 'A', channel: 'One', thumbnailDataUrl: null };
  const run = h.test.enqueueResultCard(keyA, selectionA, 'tail');
  assert.equal(list.children[0].getAttribute('aria-busy'), 'true', 'card exposes native aria-busy while enqueue metadata loads');
  assert.equal(findDescendant(list.children[0], (el) => el.dataset?.cardAction === 'enqueue').disabled, true);
  await run; await h.flush();
  assert.equal(h.downloads.length, 1, 'idle queue starts the card download immediately');
  assert.equal(h.downloads[0].profile, 'editing');
  assert.equal(h.test.queue()[0].status, 'downloading');
  // Chip removed - verify downloading state via queue model.
  assert.equal(h.test.queue().filter((item) => item.status === 'downloading').length, 1);
  assert.equal(list.children[0].getAttribute('aria-busy'), 'false', 'busy clears after the card job lands');
  h.downloads[0].resolve({ cardId: 'card-a', fileName: 'a.mp4' });
  await h.flush(); await h.flush();
  assert.equal(h.test.queue()[0].status, 'completed');
  assert.equal(h.test.queue()[0].profile, 'editing');
});

test('card Play opens the inspector monitor with exactly one active preview', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const list = h.elements.get('youtube-search-results');
  const play = index => findDescendant(list.children[index], el => el.dataset?.cardAction === 'play');
  assert.equal(play(0).textContent, 'Play');
  play(0).click(); await h.flush();
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), true);
  assert.equal(h.elements.get('workspace').classList.contains('theater'), true);
  assert.equal(JSON.stringify(h.previewCalls.open), JSON.stringify([{ id: 'aaaaaaaaaaa', bounds: { x: 120, y: 160, width: 480, height: 270 } }]), 'native preview opens at the inspector monitor bounds');
  assert.equal(play(0).textContent, 'Stop preview');
  assert.equal(play(0).getAttribute('aria-pressed'), 'true');
  assert.equal(play(1).textContent, 'Play');
  assert.equal(list.children.filter(row => row.classList.contains('is-playing')).length, 1);
  assert.equal(list.children.some(row => row.classList.contains('has-player')), false);

  play(1).click(); await h.flush();
  assert.equal(h.previewCalls.close, 1, 'switching cards closes the previous native player');
  assert.equal(h.previewCalls.open.length, 2);
  assert.equal(h.previewCalls.open[1].id, 'bbbbbbbbbbb');
  assert.equal(play(1).textContent, 'Stop preview');
  assert.equal(play(0).textContent, 'Play');
  assert.equal(list.children.filter(row => row.classList.contains('is-playing')).length, 1);

  play(1).click(); await h.flush();
  assert.equal(h.previewCalls.close, 2);
  assert.equal(play(1).textContent, 'Play');
  assert.equal(h.elements.get('workspace').classList.contains('theater'), false);
  assert.equal(list.children.some(row => row.classList.contains('is-playing')), false);
});

test('preview invalidation closes the native view once on surface switch and bounds failure', async () => {
  const h = createHarness(); await h.fireReady();
  h.test.startYoutubePreview('aaaaaaaaaaa', undefined, 'youtube:aaaaaaaaaaa');
  await h.flush();
  h.test.setSurface('queue', false);
  await h.flush();
  assert.equal(h.previewCalls.close, 1, 'leaving Search closes the native player exactly once');
  h.test.stopPreview(); await h.flush();
  assert.equal(h.previewCalls.close, 1, 'repeated stop does not double-close');

  const second = createHarness(); await second.fireReady();
  second.test.startYoutubePreview('aaaaaaaaaaa', undefined, 'youtube:aaaaaaaaaaa');
  await second.flush();
  second.setPreviewBoundsVisible(false);
  second.test.updateYoutubePreviewBounds();
  await second.flush();
  assert.equal(second.previewCalls.close, 1, 'failed bounds update closes the native player');
});

test('card enqueue keeps FIFO tail order and after-active priority inserts behind the running job without interrupting it', async () => {
  const h = createHarness(); await h.fireReady();
  h.page.results.push({ id: 'ccccccccccc', title: 'C', channel: 'Three', duration: 30, url: 'https://www.youtube.com/watch?v=ccccccccccc', thumbnailDataUrl: null, viewCount: null, publishedAt: null, channelVerified: false });
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const list = h.elements.get('youtube-search-results');
  const selectionBy = (row) => { const item = h.page.results.find((entry) => entry.id === row.dataset.resultId); return { provider: 'youtube', resultId: item.id, source: item.url, title: item.title, channel: item.channel, thumbnailDataUrl: item.thumbnailDataUrl }; };
  const rows = () => list.children;
  const key = (row) => row.dataset.resultKey;

  // Tail enqueue starts the first card immediately on an idle queue; a second
  // tail enqueue waits at the FIFO tail behind the running job.
  await h.test.enqueueResultCard(key(rows()[0]), selectionBy(rows()[0]), 'tail');
  await h.flush();
  assert.equal(h.downloads.length, 1, 'idle queue starts immediately');
  const active = h.test.queue()[0];
  assert.equal(active.status, 'downloading');
  await h.test.enqueueResultCard(key(rows()[1]), selectionBy(rows()[1]), 'tail');
  await h.flush();
  assert.deepEqual(Array.from(h.test.queue(), (item) => item.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 'tail enqueue appends behind the active job');
  assert.equal(h.test.queue()[1].status, 'queued');
  assert.equal(h.downloads.length, 1, 'the active job is never duplicated or interrupted');
  // Chip removed - verify pending count via queue model.
  assert.equal(h.test.queue().filter((item) => item.status === 'queued').length, 1);

  // While a job is active the card now-button switches to the priority label.
  assert.equal(findDescendant(rows()[0], (el) => el.dataset?.cardAction === 'now').textContent, 'Download next');

  // after-active insertion lands immediately behind the running job, ahead of the
  // FIFO tail, without canceling or re-queuing the active item.
  await h.test.enqueueResultCard(key(rows()[2]), selectionBy(rows()[2]), 'after-active');
  await h.flush();
  assert.deepEqual(Array.from(h.test.queue(), (item) => item.videoId), ['aaaaaaaaaaa', 'ccccccccccc', 'bbbbbbbbbbb'], 'priority insert lands behind the active job');
  assert.equal(h.test.queue()[0], active, 'the active item object is untouched');
  assert.equal(h.test.queue()[0].status, 'downloading');
  assert.equal(h.downloads.length, 1, 'priority insertion does not interrupt the active download');

  h.downloads[0].resolve({ cardId: 'card-a', fileName: 'a.mp4' });
  await h.flush(); await h.flush();
  assert.equal(h.downloads[1].url, 'https://www.youtube.com/watch?v=ccccccccccc', 'priority job starts next after the active one completes');
  assert.deepEqual(Array.from(h.test.queue(), (item) => item.status), ['completed', 'downloading', 'queued']);
  h.downloads[1].resolve({ cardId: 'card-c', fileName: 'c.mp4' });
  await h.flush(); await h.flush();
  assert.equal(h.downloads[2].url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'FIFO tail resumes for the remaining queued card');
  h.downloads[2].resolve({ cardId: 'card-b', fileName: 'b.mp4' });
  await h.flush(); await h.flush();
  assert.equal(h.test.queue().every((item) => item.status === 'completed'), true);
});

test('inline card overrides flow into the legacy detail Inspector and sync back two ways', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const list = h.elements.get('youtube-search-results');
  const rowA = list.children[0];
  const keyA = rowA.dataset.resultKey;
  const profileA = findDescendant(rowA, (el) => el.dataset?.field === 'profile');
  profileA.value = 'editing'; profileA.listeners.change({ stopPropagation() {} });

  // Only the explicit advanced action opens the legacy Inspector fallback.
  rowA.click(); await h.flush();
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), false, 'card body remains inline');
  openAdvancedCard(rowA); await h.flush();
  assert.equal(h.elements.get('workspace').classList.contains('inspector-open'), true);
  assert.equal(h.elements.get('inspector-pane').getAttribute('aria-hidden'), 'false');
  assert.equal(h.elements.get('youtube-profile').value, 'editing', 'detail Inspector mirrors the inline card override');
  assert.match(h.elements.get('effective-output-summary').textContent, /1 item override/);

  // A detail edit commits back through the same card-local state (no loss on Back).
  h.elements.get('youtube-profile').value = 'fast';
  h.elements.get('youtube-profile').listeners.change();
  assert.equal(h.test.cardOutputOverrides(keyA).profile, 'fast');
  h.elements.get('back-to-results').click();
  const restored = list.children.find((row) => row.dataset.resultKey === keyA);
  assert.equal(findDescendant(restored, (el) => el.dataset?.field === 'profile').value, 'fast', 'card retains the detail edit after Back');
});

for (const [inputId, url] of [
  ['social-url', 'https://www.instagram.com/reel/new/'],
  ['youtube-url', 'https://www.youtube.com/watch?v=bbbbbbbbbbb'],
  ['pinterest-url', 'https://www.pinterest.com/pin/222/'],
]) {
  test(`${inputId} input clears the selected result identity and protects staged output`, async () => {
    const h = createHarness(); await h.fireReady();
    h.elements.get('youtube-search-input').value = 'shots';
    h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
    h.searches[0].entry.resolve(h.page); await h.flush();
    const row = h.elements.get('youtube-search-results').children[0];
    const checkbox = findDescendant(row, (el) => el.dataset?.field === 'selection');
    checkbox.checked = true; checkbox.listeners.change();
    openAdvancedCard(row); await h.flush();
    h.elements.get('youtube-profile').value = 'editing'; h.elements.get('youtube-profile').listeners.change();
    h.elements.get(inputId).value = url;
    h.elements.get(inputId).listeners.input();
    h.elements.get('youtube-profile').value = 'fast'; h.elements.get('youtube-profile').listeners.change();
    assert.equal(h.elements.get('youtube-search-results').children[0].getAttribute('aria-pressed'), 'false');
    assert.equal(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa').profile, 'editing');
  });
}

test('ade2131: staged inspector edits survive provider round trips, unstage and reopen', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const row = h.elements.get('youtube-search-results').children[0];
  const checkbox = findDescendant(row, (el) => el.dataset?.field === 'selection');
  checkbox.checked = true; checkbox.listeners.change();
  openAdvancedCard(row); await h.flush();
  h.elements.get('youtube-profile').value = 'editing'; h.elements.get('youtube-profile').listeners.change();
  h.elements.get('range-in').value = '10'; h.elements.get('range-in').listeners.input();
  h.elements.get('range-out').value = '20'; h.elements.get('range-out').listeners.input();
  h.elements.get('provider-social').click(); h.elements.get('provider-youtube').click();
  h.elements.get('clear-selection-btn').click();
  openAdvancedCard(h.elements.get('youtube-search-results').children[0]); await h.flush();
  assert.equal(h.elements.get('youtube-profile').value, 'editing');
  assert.equal(h.elements.get('range-in').value, '0:10');
  assert.equal(h.elements.get('range-out').value, '0:20');
  h.elements.get('download-youtube-btn').click(); await h.flush();
  assert.equal(h.downloads[0].profile, 'editing');
  assert.deepEqual(JSON.parse(JSON.stringify(h.downloads[0].options.selection)), { start: 10, end: 20, label: 'Custom range' });
});

for (const kinds of [['video'], ['image', 'video']]) {
  test(`5c3245f: Pinterest ${kinds.join('/')} metadata paints and queues the selected profile`, async () => {
    const h = createHarness(); await h.fireReady();
    h.api.loadPinterest = async () => ({ pinId: '111', source: 'https://www.pinterest.com/pin/111/', title: 'Pin', creator: null, kind: kinds.length > 1 ? 'carousel' : 'video', thumbnailDataUrl: null, items: kinds.map((kind, index) => ({ index: index + 1, kind, title: 'Pin', creator: null, extension: kind === 'image' ? 'jpg' : 'mp4' })) });
    const downloads = [];
    h.api.downloadPinterest = (...args) => { downloads.push(args); return new Promise(() => {}); };
    h.elements.get('provider-pinterest').click();
    h.elements.get('common-profile').value = 'editing'; h.elements.get('common-profile').listeners.change();
    h.elements.get('pinterest-url').value = 'https://www.pinterest.com/pin/111/';
    h.elements.get('load-pinterest-btn').click(); await h.flush();
    assert.equal(h.elements.get('youtube-profile').value, 'editing');
    h.elements.get('download-youtube-btn').click(); await h.flush();
    assert.deepEqual(Array.from(h.test.queue(), (item) => item.profile), kinds.map((kind) => kind === 'image' ? 'original' : 'editing'));
    assert.equal(downloads.length, 1);
  });
}

test('profile and quality painting never commits transient controls to the selected staged item', async () => {
  const h = createHarness(); await h.fireReady();
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} });
  h.searches[0].entry.resolve(h.page); await h.flush();
  const row = h.elements.get('youtube-search-results').children[0];
  const checkbox = findDescendant(row, (el) => el.dataset?.field === 'selection');
  checkbox.checked = true; checkbox.listeners.change();
  openAdvancedCard(row); await h.flush();
  h.elements.get('youtube-profile').value = 'editing'; h.elements.get('youtube-profile').listeners.change();
  const saved = JSON.parse(JSON.stringify(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa')));
  h.elements.get('youtube-profile').value = 'fast';
  h.elements.get('youtube-quality').value = 'best';
  h.test.paintOutput();
  assert.equal(h.elements.get('prores-warning').classList.contains('hidden'), true);
  assert.equal(h.elements.get('profile-controls').children[1].getAttribute('aria-checked'), 'true');
  assert.deepEqual(JSON.parse(JSON.stringify(h.test.cardEffectiveOutput('youtube:aaaaaaaaaaa'))), saved);
});

test('Pexels card enqueue passes its resolved opaque rendition through the session and queue adapter', async () => {
  const h = createHarness();
  h.api.pexelsKeyStatus = async () => ({ connected: true, persisted: true, message: 'Connected' });
  await h.fireReady();
  const files = [
    { id: 'small-id', url: 'https://example.com/small.mp4', width: 1280, height: 720, label: 'HD', mime: 'video/mp4', size: 1 },
    { id: 'large-id', url: 'https://example.com/large.mp4', width: 1920, height: 1080, label: 'FHD', mime: 'video/mp4', size: 2 },
  ];
  const metadata = { id: 1, kind: 'video', title: 'Stock', creator: null, creatorUrl: null, sourceUrl: 'https://www.pexels.com/video/1/', duration: 10, width: 1920, height: 1080, thumbnailUrl: null, previewUrl: null, files };
  h.api.searchPexels = async () => ({ query: 'shots', page: 1, pageSize: 10, results: [metadata], hasPrevious: false, hasNext: false, totalResults: 1 });
  h.api.loadPexels = async () => metadata;
  const calls = [];
  h.api.downloadPexels = async (_asset, fileId, profile) => { calls.push([fileId, profile]); return { cardId: 'stock-card', fileName: 'stock.mp4' }; };
  h.elements.get('provider-pexels').click(); await h.flush();
  h.elements.get('youtube-search-input').value = 'shots';
  h.elements.get('youtube-search-form').listeners.submit({ preventDefault() {} }); await h.flush();
  const row = h.elements.get('youtube-search-results').children[0];
  openAdvancedCard(row); await h.flush();
  h.elements.get('youtube-quality').value = 'small-id'; h.elements.get('youtube-quality').listeners.change();
  h.elements.get('back-to-results').click();
  const findAction = node => node.dataset.cardAction === 'enqueue' ? node : node.children.map(findAction).find(Boolean);
  findAction(h.elements.get('youtube-search-results').children[0]).click(); await h.flush();
  assert.deepEqual(calls, [['small-id', 'original']]);
  assert.equal(h.elements.get('youtube-download-queue').children[0].dataset.state, 'completed');
});
