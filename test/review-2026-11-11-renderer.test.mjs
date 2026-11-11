// Renderer regressions from the 2026-11-11 review, driven through the shipped bundle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const fire = (element, type) => element.listeners[type]?.({ type });
const find = (element, predicate) => {
  for (const child of element.children ?? []) {
    if (predicate(child)) return child;
    const found = find(child, predicate); if (found) return found;
  }
  return null;
};
const cue = (h) => find(h.elements.get('subtitle-results'), (e) => e.dataset?.field === 'cue-selection');
const change = (h, id, value) => {
  const control = h.elements.get(id);
  if (typeof value === 'boolean') control.checked = value; else control.value = value;
  fire(control, 'change');
};
async function boot(api = {}) {
  const h = createHarness(); Object.assign(h.api, api); await h.fireReady();
  h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  h.elements.get('load-youtube-btn').click(); await h.flush(); return h;
}
async function loadCues(h) { h.elements.get('search-subtitles-btn').click(); await h.flush(); }
function toggle(control) { control.focus(); control.checked = !control.checked; fire(control, 'change'); }

test('replacing or failing the cue corpus commits a cleared cue selection', async () => {
  for (const fail of [false, true]) {
    let loads = 0;
    const h = await boot({ searchSubtitles: async () => {
      if (++loads === 1) return [{ start: 2, end: 4, text: 'Old cue' }];
      if (fail) throw new Error('Cue load failed');
      return [{ start: 20, end: 25, text: 'New cue' }];
    } });
    await loadCues(h); toggle(cue(h));
    change(h, 'youtube-subtitle-language', 'tr'); await loadCues(h);
    change(h, 'youtube-target-bin', 'clipdock');
    if (!fail) assert.equal(cue(h).checked, false, 'a later inspector edit cannot restore old cue indices');
    h.elements.get('download-youtube-btn').click(); await h.flush();
    assert.equal(h.downloads[0].options.selection, null, 'the old cue range is no longer queued');
  }
});

test('cue replies belong to the requested source and effective language', async () => {
  for (const edit of ['youtube-subtitle-language', 'common-subtitle-language', 'source', 'unchanged']) {
    let resolve; const requests = [];
    const h = await boot({ searchSubtitles: (url, language) => { requests.push({ url, language }); return new Promise((done) => { resolve = done; }); } });
    h.elements.get('search-subtitles-btn').click();
    if (edit === 'source') {
      h.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
      h.elements.get('load-youtube-btn').click(); await h.flush();
    } else if (edit !== 'unchanged') change(h, edit, 'tr');
    resolve([{ start: 2, end: 4, text: 'English reply' }]); await h.flush();
    assert.deepEqual(requests, [{ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', language: 'en' }]);
    assert.equal(!!cue(h), edit === 'unchanged', 'only the current source and language may render');
  }
});

test('Next and Previous keep the submitted query and a new submit starts at page one', async () => {
  for (const provider of ['youtube', 'pinterest', 'pexels', 'pixabay']) {
    const h = createHarness(); const calls = [];
    const reply = (query, page) => { calls.push({ query, page }); return Promise.resolve({ ...h.page, query: 'provider echo', page, results: [], hasPrevious: page > 1, hasNext: true, pageCount: 3 }); };
    Object.assign(h.api, {
      searchYoutube: reply, searchPinterest: reply,
      searchPexels: (_kind, query, page) => reply(query, page), searchPixabay: (_kind, query, page) => reply(query, page),
      pexelsKeyStatus: async () => ({ connected: true }), pixabayKeyStatus: async () => ({ connected: true }),
    });
    await h.fireReady(); h.test.setProvider(provider); await h.flush();
    const input = h.elements.get('youtube-search-input'); input.value = 'old query';
    fire(h.elements.get('youtube-search-form'), 'submit'); await h.flush();
    input.value = 'new query'; fire(input, 'input');
    h.elements.get('youtube-search-next').click(); await h.flush();
    h.elements.get('youtube-search-prev').click(); await h.flush();
    fire(h.elements.get('youtube-search-form'), 'submit'); await h.flush();
    assert.deepEqual(calls, [{ query: 'old query', page: 1 }, { query: 'old query', page: 2 }, { query: 'old query', page: 1 }, { query: 'new query', page: 1 }], provider);
  }
});

test('chapter and cue toggles keep the same attached checkbox and keyboard focus', async () => {
  const h = await boot({ loadYoutube: async () => ({ id: 'aaaaaaaaaaa', title: 'A', duration: 60, heights: [1080], chapters: [{ start: 0, end: 10, title: 'Intro' }, { start: 10, end: 60, title: 'Main' }] }), searchSubtitles: async () => [{ start: 2, end: 4, text: 'Cue' }] });
  await loadCues(h);
  const chapterList = h.elements.get('chapter-list'); const chapter = chapterList.children[0].children[0];
  const cueList = h.elements.get('subtitle-results'); const checkbox = cue(h);
  for (const control of [chapter, checkbox, chapter]) {
    toggle(control);
    assert.equal(!!find(control === chapter ? chapterList : cueList, (e) => e === control), true, 'the focused control stays attached');
    assert.equal(h.activeElement, control);
    assert.equal(control.checked, true);
    assert.equal(control === chapter ? checkbox.checked : chapter.checked, false, 'the other selection updates in place');
  }
});

test('named preview fixtures drive real nested controls and enqueue the claimed output', async () => {
  for (const mode of ['queue', 'audio', 'download-failed', 'pinterest-search', 'pexels-photo', 'pexels-video']) {
    const h = createHarness({ previewMode: mode }); await h.fireReady();
    for (let turn = 0; turn < 40 && h.test.queue().length < (mode === 'queue' ? 2 : 1); turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10)); await h.flush();
    }
    const queued = h.test.queue();
    assert.equal(queued.length, mode === 'queue' ? 2 : 1, mode);
    assert.equal(h.downloads[0].provider, mode.startsWith('pexels') ? 'downloadPexels' : mode === 'pinterest-search' ? 'downloadPinterest' : 'downloadYoutube', mode);
    if (mode === 'queue') assert.deepEqual(Array.from(queued, (item) => item.quality), ['2160p', '2160p']);
    if (mode === 'audio') { assert.equal(h.downloads[0].args[4].mediaMode, 'audio'); assert.equal(h.downloads[0].args[4].subtitles, true); }
    if (mode === 'download-failed') assert.equal(queued[0].status, 'failed');
    if (mode.startsWith('pexels')) assert.equal(h.downloads[0].args[0].kind, mode === 'pexels-photo' ? 'photo' : 'video');
  }
});

test('cleanup completion survives inventory refresh until its bounded display window expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let scans = 0;
  const h = await boot({ workspaceStatus: async () => { scans += 1; return { fileCount: 1, totalBytes: 100, cleanupFileCount: scans === 1 ? 2 : 0, cleanupBytes: 200 }; }, cleanupWorkspace: async () => ({ deletedFileCount: 2, deletedBytes: 200, fileCount: 1, totalBytes: 100 }) });
  h.elements.get('cleanup-workspace-btn').click(); await h.flush();
  for (const id of ['workspace-status', 'settings-workspace-status']) assert.equal(h.elements.get(id).textContent, 'Deleted 2 files · 200 B freed');
  assert.equal(h.elements.get('cleanup-workspace-btn').disabled, true, 'inventory controls still refresh');
  t.mock.timers.tick(8_000); h.test.setSurface('settings'); await h.flush();
  assert.equal(h.elements.get('settings-workspace-status').textContent, 'Deleted 2 files · 200 B freed');
  t.mock.timers.tick(1_000); await h.flush();
  for (const id of ['workspace-status', 'settings-workspace-status']) assert.equal(h.elements.get(id).textContent, '1 stored files · 100 B');
});
