import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const record = (id, extra = {}) => ({ id, provider: 'youtube', source: `https://www.youtube.com/watch?v=${id}`, project: 'Project', fileName: `${id}.mp4`, bytes: 1024, title: id, creator: null, createdAt: 1, available: true, ...extra });
const rows = h => h.elements.get('history-list').children;
const checkbox = row => row.children.find(child => child.className === 'history-selection');
const selected = h => rows(h).filter(row => checkbox(row).checked).map(row => row.dataset.recordId);
const toggle = (row, shiftKey = false) => {
  const input = checkbox(row); input.checked = !input.checked;
  input.listeners.click({ shiftKey });
};
async function history(records) {
  const h = createHarness(); h.api.historyList = async () => records;
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  return h;
}
function selectAll(h, checked = true) {
  const input = h.elements.get('history-select-all'); input.checked = checked; input.listeners.change();
}
function openDelete(h) { h.elements.get('history-delete-selected-btn').click(); }
function confirmDelete(h) { h.elements.get('history-delete-confirm').click(); }

// Drive the actual row inputs: changes must keep the exact row/control instances.
test('History click and Shift+click select/deselect ranges without rebuilding rows or losing focus', async () => {
  const h = await history(['a', 'b', 'c', 'd'].map(id => record(id)));
  const before = [...rows(h)]; checkbox(before[0]).focus();
  toggle(before[0]); toggle(before[2], true);
  assert.deepEqual(selected(h), ['a', 'b', 'c']);
  assert.equal(h.elements.get('history-selection-count').textContent, '3 selected');
  assert.equal(h.elements.get('history-selection-bar').hidden, false);
  assert.equal(h.elements.get('history-header-actions').hidden, true);
  assert.equal(h.elements.get('history-select-all').indeterminate, true);
  assert.equal(rows(h)[0], before[0]); assert.equal(rows(h)[2], before[2]);
  assert.equal(h.activeElement, checkbox(before[0]));
  toggle(before[0], true);
  assert.deepEqual(selected(h), []);
  assert.equal(h.elements.get('history-selection-bar').hidden, true);
  assert.equal(h.elements.get('history-header-actions').hidden, false);
});

test('History prunes selection on search/filter changes so bulk delete cannot remove hidden files', async () => {
  const records = Array.from({ length: 25 }, (_, i) => record(`keep-${i}`));
  records.push(record('keep-other-provider', { provider: 'pexels' }), record('keep-missing', { available: false }), record('unrelated'));
  const h = await history(records);
  h.elements.get('history-search-input').value = 'keep';
  h.elements.get('history-search-input').listeners.input();
  h.elements.get('history-provider-filter').value = 'youtube';
  h.elements.get('history-provider-filter').listeners.change();
  h.elements.get('history-availability-filter').value = 'available';
  h.elements.get('history-availability-filter').listeners.change();
  selectAll(h);
  assert.equal(h.elements.get('history-selection-count').textContent, '20 selected');
  assert.deepEqual(selected(h), Array.from({ length: 20 }, (_, i) => `keep-${i}`));
  assert.equal(h.elements.get('history-select-all').checked, true);
  h.elements.get('history-show-more').click();
  assert.equal(rows(h).length, 25);
  assert.equal(checkbox(rows(h)[20]).checked, false);
  assert.equal(h.elements.get('history-select-all').indeterminate, true);
  selectAll(h);
  assert.equal(h.elements.get('history-selection-count').textContent, '25 selected');
  h.elements.get('history-search-input').value = '';
  h.elements.get('history-search-input').listeners.input();
  h.elements.get('history-provider-filter').value = 'all'; h.elements.get('history-provider-filter').listeners.change();
  h.elements.get('history-availability-filter').value = 'all'; h.elements.get('history-availability-filter').listeners.change();
  h.elements.get('history-show-more').click();
  assert.equal(h.elements.get('history-selection-count').textContent, '20 selected', 'resetting the batch prunes rows outside the visible batch');
  assert.deepEqual(rows(h).slice(25).map(row => [row.dataset.recordId, checkbox(row).checked]), [['keep-other-provider', false], ['keep-missing', false], ['unrelated', false]]);
  h.elements.get('history-search-input').value = 'unrelated'; h.elements.get('history-search-input').listeners.input();
  assert.equal(h.elements.get('history-select-all').checked, false);
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
  selectAll(h);
  assert.equal(h.elements.get('history-selection-count').textContent, '1 selected');
  const calls = []; h.api.historyDelete = async id => { calls.push(id); return { deleted: false, removed: false }; };
  openDelete(h); confirmDelete(h); await h.flush();
  assert.deepEqual(calls, ['unrelated'], 'the delete count and IDs match exactly the visible selection');
  selectAll(h, false);
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
});

test('History selection, shown batch and checkbox focus survive refresh; records removed elsewhere are pruned', async () => {
  let records = Array.from({ length: 25 }, (_, i) => record(`r${i}`));
  const h = await history(records); h.api.historyList = async () => records;
  h.elements.get('history-show-more').click();
  toggle(rows(h)[23]); checkbox(rows(h)[23]).focus();
  // Surface entry and a focus-triggered host refresh exercise the real refresh paths.
  h.test.setSurface('library', false); await h.flush();
  for (const callback of h.windowListeners.focus) callback();
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(rows(h).length, 25);
  assert.deepEqual(selected(h), ['r23']);
  assert.equal(h.activeElement, checkbox(rows(h)[23]));
  h.api.historyList = async () => { throw new Error('History is busy.'); };
  h.test.setSurface('library', false); await h.flush();
  assert.equal(h.elements.get('history-status').textContent, 'History is busy.');
  assert.deepEqual(selected(h), ['r23']);
  records = records.filter(record => record.id !== 'r23'); h.api.historyList = async () => records;
  h.test.setSurface('library', false); await h.flush();
  assert.equal(rows(h).length, 24);
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
});

test('Escape clears selection only on visible History; clear button returns focus to a visible control', async () => {
  const h = await history([record('a')]); toggle(rows(h)[0]);
  h.test.setSurface('queue'); h.keydown({ key: 'Escape' }); await h.flush();
  h.test.setSurface('library'); await h.flush();
  assert.deepEqual(selected(h), ['a'], 'Escape on another surface cannot change hidden History controls');
  h.keydown({ key: 'Escape' });
  assert.deepEqual(selected(h), []);
  assert.equal(h.elements.get('library-surface').hidden, false);
  toggle(rows(h)[0]);
  const more = rows(h)[0].children.find(child => child.className === 'history-actions'); more.click();
  const menu = rows(h)[0].children.find(child => child.className.includes('history-menu'));
  menu.listeners.keydown({ key: 'Escape' });
  assert.deepEqual(selected(h), [], 'Escape also clears selection from the row menu');
  assert.equal(h.activeElement, more);
  toggle(rows(h)[0]); h.elements.get('history-clear-selection-btn').focus(); h.elements.get('history-clear-selection-btn').click();
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
  assert.equal(h.activeElement, h.elements.get('history-select-all'));
});

test('bulk deletion confirms known size in-panel, calls the existing delete API sequentially, and keeps failures selected', async () => {
  let records = [record('a'), record('b', { bytes: 2048 }), record('c', { bytes: 0 })];
  const h = await history(records); h.api.historyList = async () => records;
  const calls = []; let completeFirst;
  h.api.historyDelete = id => {
    calls.push(id);
    if (id === 'a') return new Promise(resolve => { completeFirst = () => { records = records.filter(record => record.id !== id); resolve({ deleted: true, removed: true, removedCardIds: [] }); }; });
    if (id === 'b') throw new Error('File is busy.');
    return Promise.resolve({ deleted: false, removed: false, warning: 'Media changed or was replaced; preserved.' });
  };
  selectAll(h); openDelete(h);
  assert.equal(h.elements.get('history-delete-dialog').open, true);
  assert.equal(h.elements.get('history-delete-summary').textContent, 'Remove 3 History entries? Up to 3 available files (3 KB known size) may be deleted from disk.');
  assert.equal(h.activeElement, h.elements.get('history-delete-cancel'));
  assert.deepEqual(calls, [], 'opening the dialog cannot delete anything');
  confirmDelete(h); await h.flush();
  assert.deepEqual(calls, ['a'], 'later IDs must wait for the first deletion');
  assert.equal(h.elements.get('history-delete-confirm').disabled, true);
  confirmDelete(h); h.keydown({ key: 'Escape' });
  assert.equal(h.elements.get('history-delete-dialog').open, true, 'active deletion cannot be dismissed or submitted twice');
  completeFirst(); await h.flush();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(rows(h).map(row => row.dataset.recordId), ['b', 'c']);
  assert.deepEqual(selected(h), ['b', 'c']);
  assert.equal(h.elements.get('message').textContent, '1 deleted, 2 failed: File is busy.');
  assert.equal(h.elements.get('history-selection-count').textContent, '2 selected');
  assert.equal(h.elements.get('history-delete-dialog').open, false);
  assert.equal(h.activeElement, h.elements.get('history-delete-selected-btn'));
  h.elements.get('refresh-btn').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, '1 deleted, 2 failed: File is busy.');
});

test('bulk delete counts kept-file History removals separately from failures, so every selected entry is counted once', async () => {
  let records = [record('kept'), record('deleted')];
  const h = await history(records); h.api.historyList = async () => records;
  h.api.historyDelete = async id => { records = records.filter(record => record.id !== id); return { deleted: id === 'deleted', removed: true }; };
  selectAll(h); openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('message').textContent, '1 deleted, 1 removed from History.');
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
  assert.equal(rows(h).length, 0);
  assert.equal(h.elements.get('history-select-all').disabled, true);
  assert.equal(h.activeElement, h.elements.get('history-search-input'));
  records = [record('deleted')]; h.test.setSurface('library'); await h.flush();
  selectAll(h); openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('message').textContent, '1 deleted.');
  assert.equal(h.elements.get('message').classList.contains('ok'), true);
});

test('cancel and Escape dismiss bulk confirmation without deleting files or firing background shortcuts', async () => {
  const h = await history([record('a')]); let deletions = 0;
  h.api.historyDelete = async () => { deletions += 1; return { deleted: true, removed: true }; };
  toggle(rows(h)[0]); openDelete(h);
  h.keydown({ key: 'k', metaKey: true });
  assert.equal(h.elements.get('library-surface').hidden, false);
  h.elements.get('history-delete-cancel').click();
  assert.deepEqual(selected(h), ['a']);
  openDelete(h); h.elements.get('history-delete-dialog').listeners.cancel();
  assert.equal(h.elements.get('history-delete-dialog').open, false);
  assert.deepEqual(selected(h), []);
  assert.equal(deletions, 0);
});

test('Clear finished uses queue removal, preserves running/queued/handoff items and all files and History', async () => {
  const h = await history([record('stored')]); let fileDeletions = 0, historyDeletions = 0;
  h.api.queueDelete = async () => { fileDeletions += 1; return { deleted: true, message: 'deleted' }; };
  h.api.historyDelete = async () => { historyDeletions += 1; return { deleted: true, removed: true }; };
  h.test.setSurface('queue');
  assert.equal(h.elements.get('clear-finished-btn').disabled, true);
  const stage = { key: 'youtube:aaaaaaaaaaa', provider: 'youtube', resultId: 'aaaaaaaaaaa', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Active', channel: null, thumbnailDataUrl: null, snapshot: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null }, overrides: {} };
  h.test.enqueueStagedSelection(stage, { id: 'aaaaaaaaaaa', title: 'Active', channel: null, duration: 60, heights: [1080], formatSummary: [], chapters: [] });
  await h.flush();
  const queue = h.test.queue(), active = queue[0];
  for (const status of ['completed', 'failed', 'cancelled', 'queued', 'preparing', 'transferring']) queue.push({ ...active, queueId: status, status, cardId: status === 'completed' ? 'finished-card' : undefined, fileName: status === 'completed' ? 'finished.mp4' : undefined });
  queue.push({ ...active, queueId: 'handoff', status: 'completed', handingOff: true }, { ...active, queueId: 'deleting', status: 'completed', deleting: true });
  h.test.renderQueue();
  assert.equal(h.elements.get('clear-finished-btn').disabled, false);
  h.elements.get('clear-finished-btn').click(); await h.flush();
  assert.deepEqual(Array.from(queue, item => item.queueId), [active.queueId, 'queued', 'preparing', 'transferring', 'handoff', 'deleting']);
  assert.equal(queue[0].status, 'downloading');
  assert.equal(h.test.activeQueueId(), active.queueId);
  assert.equal(h.elements.get('clear-finished-btn').disabled, true);
  h.elements.get('clear-finished-btn').click(); await h.flush();
  assert.equal(queue.length, 6, 'repeated clearing leaves ongoing work intact');
  assert.equal(fileDeletions, 0); assert.equal(historyDeletions, 0);
  h.test.setSurface('library'); await h.flush();
  assert.deepEqual(rows(h).map(row => row.dataset.recordId), ['stored']);
});


test('Space on History cannot activate the preview control in a hidden Search Inspector', async () => {
  const h = await history([record('stored')]);
  h.test.setSurface('search');
  h.elements.get('youtube-search-input').value = 'shots'; h.elements.get('youtube-search-form').listeners.submit();
  await h.flush(); h.searches[0].entry.resolve(h.page); await h.flush();
  const find = element => element.className?.includes('youtube-details') ? element : (element.children ?? []).map(find).find(Boolean);
  find(h.elements.get('youtube-search-results').children[0]).click(); await h.flush();
  h.test.setSurface('library'); await h.flush(); rows(h)[0].focus();
  h.keydown({ key: ' ' }); await h.flush();
  assert.equal(h.previewCalls.open.length, 0);
  assert.equal(h.elements.get('library-surface').hidden, false);
});


for (const action of ['Remove from queue', 'Clear finished']) test(`${action} preserves completed files in History's This session until panel close`, async () => {
  const h = await history([record('stored')]); let deletes = 0;
  h.api.queueDelete = async () => { deletes++; return { deleted: true }; };
  const stage = { key: 'youtube:aaaaaaaaaaa', provider: 'youtube', resultId: 'aaaaaaaaaaa', source: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Finished clip', channel: null, thumbnailDataUrl: null, snapshot: { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null }, overrides: {} };
  h.test.enqueueStagedSelection(stage, { id: 'aaaaaaaaaaa', title: 'Finished clip', channel: null, duration: 60, heights: [1080], formatSummary: [], chapters: [] });
  await h.flush(); h.downloads[0].resolve({ cardId: 'finished-card', fileName: 'finished.mp4' }); await h.flush();
  assert.equal(h.elements.get('completed-downloads').children[0].getAttribute('aria-label'), 'Finished clip. File finished.mp4. Completed.');
  h.test.setSurface('queue');
  if (action === 'Clear finished') h.elements.get('clear-finished-btn').click();
  else {
    const find = element => element.textContent === 'Remove from queue' ? element : (element.children ?? []).map(find).find(Boolean);
    find(h.elements.get('youtube-download-queue')).click();
  }
  await h.flush(); h.test.setSurface('library'); await h.flush();
  assert.equal(h.elements.get('youtube-download-queue').children.length, 0);
  assert.equal(h.elements.get('completed-download-count').textContent, '1 completed');
  assert.equal(h.elements.get('completed-downloads').children[0].getAttribute('aria-label'), 'Finished clip. File finished.mp4. Completed.');
  assert.equal(h.elements.get('completed-downloads-status').textContent, 'Session downloads stay available here until ClipDock closes.');
  assert.equal(deletes, 0);
  assert.deepEqual(rows(h).map(row => row.dataset.recordId), ['stored']);
});

test('bulk result stays readable in the History header until selection changes or another delete', async () => {
  const h = await history([record('busy')]);
  h.api.historyDelete = async () => { throw new Error('File is busy.'); };
  toggle(rows(h)[0]); openDelete(h); confirmDelete(h); await h.flush();
  const status = h.elements.get('history-status');
  assert.equal(status.textContent, '0 deleted, 1 failed: File is busy.');
  assert.equal(status.classList.contains('err'), true);
  openDelete(h);
  assert.equal(status.textContent, 'Showing 1 of 1 download.', 'starting the next delete clears the previous result');
  h.elements.get('history-delete-cancel').click();
  h.api.historyList = async () => [record('busy')];
  openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(status.textContent, '0 deleted, 1 failed: File is busy.');
  toggle(rows(h)[0]);
  assert.equal(status.textContent, 'Showing 1 of 1 download.');
  assert.equal(status.classList.contains('err'), false);
});


test('History filter chips prune hidden selections so Delete files counts only visible rows', async () => {
  const h = await history([record('youtube'), record('stock', { provider: 'pexels' }), record('missing', { available: false })]);
  selectAll(h);
  h.elements.get('history-provider-chips').children.find(chip => chip.dataset.value === 'youtube').click();
  assert.equal(h.elements.get('history-selection-count').textContent, '2 selected');
  assert.deepEqual(selected(h), ['youtube', 'missing']);
  h.elements.get('history-availability-chips').children.find(chip => chip.dataset.value === 'available').click();
  assert.equal(h.elements.get('history-selection-count').textContent, '1 selected');
  assert.deepEqual(selected(h), ['youtube']);
  const calls = []; h.api.historyDelete = async id => { calls.push(id); return { deleted: false, removed: false }; };
  openDelete(h);
  assert.equal(h.elements.get('history-delete-summary').textContent, 'Remove 1 History entry? Up to 1 available file (1 KB) may be deleted from disk.');
  confirmDelete(h); await h.flush();
  assert.deepEqual(calls, ['youtube']);
  assert.equal(h.elements.get('history-status').textContent, '0 deleted, 1 failed: The file could not be deleted safely.');
  h.elements.get('history-provider-chips').children.find(chip => chip.dataset.value === 'pexels').click();
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
  assert.equal(h.elements.get('history-status').textContent, 'Showing 1 of 1 download.');
});


for (const trigger of ['Refresh click', 'History surface entry']) test(`${trigger} clears the bulk result so newer loading and error status are visible`, async () => {
  let records = [record('deleted'), record('remaining')];
  const h = await history(records); h.api.historyList = async () => records;
  h.api.historyDelete = async id => { records = records.filter(record => record.id !== id); return { deleted: true, removed: true }; };
  toggle(rows(h)[0]); openDelete(h); confirmDelete(h); await h.flush();
  const status = h.elements.get('history-status');
  assert.equal(status.textContent, '1 deleted.');
  let rejectLoad; h.api.historyList = () => new Promise((_resolve, reject) => { rejectLoad = reject; });
  if (trigger === 'Refresh click') h.elements.get('history-refresh-btn').click();
  else h.test.setSurface('library', false);
  assert.equal(status.textContent, 'Loading history…', 'new loading status must replace the previous deletion result');
  assert.equal(status.classList.contains('err'), false);
  rejectLoad(new Error('History could not be loaded.')); await h.flush();
  assert.equal(status.textContent, 'History could not be loaded.');
  assert.equal(status.classList.contains('err'), true);
  h.api.historyList = async () => records; h.elements.get('history-refresh-btn').click(); await h.flush();
  assert.equal(status.textContent, 'Showing 1 of 1 download.', 'the old result cannot return after a successful retry');
});

test('a post-delete History load error takes precedence over the completed bulk result', async () => {
  const h = await history([record('busy')]);
  h.api.historyDelete = async () => { throw new Error('File is busy.'); };
  h.api.historyList = async () => { throw new Error('History load failed after deletion.'); };
  toggle(rows(h)[0]); openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('message').textContent, '0 deleted, 1 failed: File is busy.');
  assert.equal(h.elements.get('history-status').textContent, 'History load failed after deletion.');
  assert.equal(h.elements.get('history-status').classList.contains('err'), true);
});


test('bulk delete counts a deleted file with a warning only once and preserves the warning text', async () => {
  let records = [record('clean'), record('warning')];
  const h = await history(records); h.api.historyList = async () => records;
  h.api.historyDelete = async id => {
    records = records.filter(record => record.id !== id);
    return { deleted: true, removed: true, ...(id === 'warning' ? { warning: 'Subtitle could not be deleted.' } : {}) };
  };
  selectAll(h); openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('history-status').textContent, '2 deleted (1 with a warning: Subtitle could not be deleted).');
  assert.equal(h.elements.get('message').textContent, '2 deleted (1 with a warning: Subtitle could not be deleted).');
  assert.equal(h.elements.get('history-status').classList.contains('err'), true);
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
});

test('bulk confirmation separates available files from Missing entry-only removals and lists all three selected titles', async () => {
  const h = await history([record('a', { title: 'First available' }), record('missing', { title: 'Missing title', available: false, bytes: 10_000 }), record('b', { title: '<b>Second available</b>' })]);
  selectAll(h); openDelete(h);
  assert.equal(h.elements.get('history-delete-summary').textContent, 'Remove 3 History entries? Up to 2 available files (2 KB) may be deleted from disk. 1 missing entry will only be removed from History.');
  assert.deepEqual(h.elements.get('history-delete-titles')?.children.map(item => item.textContent), ['First available', 'Missing title', '<b>Second available</b>']);
  assert.equal(h.elements.get('history-delete-titles').children[2].children.length, 0, 'titles are literal text, never markup');
});

test('bulk confirmation names the first five selected titles and the remaining count even across scrolled rows', async () => {
  const h = await history(Array.from({ length: 7 }, (_, i) => record(`r${i}`, { title: `Selected title ${i + 1}` })));
  selectAll(h); openDelete(h);
  assert.deepEqual(h.elements.get('history-delete-titles')?.children.map(item => item.textContent), ['Selected title 1', 'Selected title 2', 'Selected title 3', 'Selected title 4', 'Selected title 5', 'and 2 more']);
});

test('Missing-only selection confirms History removal and reports removed entries without failed file deletions', async () => {
  let records = [record('missing', { available: false })];
  const h = await history(records); h.api.historyList = async () => records;
  h.api.historyDelete = async () => { records = []; return { deleted: false, removed: true }; };
  selectAll(h); openDelete(h);
  assert.equal(h.elements.get('history-delete-summary').textContent, 'Remove 1 History entry? 1 missing entry will only be removed from History.');
  assert.equal(h.elements.get('history-delete-confirm').textContent, 'Remove entries');
  confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('history-status').textContent, '1 removed from History.');
  assert.equal(h.elements.get('history-status').classList.contains('err'), false);
});

test('an available unmanaged file kept by main is reported as a History removal, with any warning retained', async () => {
  let records = [record('external')];
  const h = await history(records); h.api.historyList = async () => records;
  h.api.historyDelete = async () => { records = []; return { deleted: false, removed: true, warning: 'External file kept.' }; };
  selectAll(h); openDelete(h); confirmDelete(h); await h.flush();
  assert.equal(h.elements.get('history-status').textContent, '1 removed from History (1 with a warning: External file kept).');
  assert.equal(h.elements.get('history-selection-count').textContent, '0 selected');
});
