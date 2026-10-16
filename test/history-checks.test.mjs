import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);
const focusedExpect = expect;
const fail = (message) => assert.fail(message);

test('history persistence, reuse, deletion and source boundaries', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const { DownloadHistory, recordHistoryWarning, safeHistorySource, supportedHistoryMediaPath } = await import(path.join(dist, 'history.js'));
  {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-history-')); const managed = path.join(temp, 'managed'); mkdirSync(managed); const media = path.join(managed, 'one.mp4'); writeFileSync(media, 'video');
    const store = path.join(temp, 'userData', 'download-history.json'); let project = 'Project A'; const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; const automation = { provider: 'youtube', source, selection: { start: 2, end: 8, label: 'Intro' }, chapters: [{ start: 2, end: 8, title: 'Intro' }] }; const input = { provider: 'youtube', source, filePath: media, assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'original', quality: '1080p', mediaMode: 'video', selection: automation.selection, automation };
    const history = new DownloadHistory(store, managed, () => project); const first = history.add(input); const second = history.add(input); const restarted = new DownloadHistory(store, managed).list()[0];
    focusedExpect('history: structured roundtrip/project/automation/bytes without paths', [restarted.project, restarted.title, restarted.creator, restarted.assetId, restarted.quality, restarted.mediaMode, restarted.selection, restarted.automation, restarted.bytes, Object.hasOwn(restarted, 'filePath'), restarted.available], ['Project A', 'Title', 'Channel', 'dQw4w9WgXcQ', '1080p', 'video', automation.selection, automation, 5, false, true]);
    project = 'Project B'; const beforeUse = first.lastUsedAt; const reused = history.reuse(first.id); const afterReuseRestart = new DownloadHistory(store, managed); const afterUse = afterReuseRestart.get(first.id);
    focusedExpect('history: reuse restores automation, updates project/lastUsedAt, and persists recency at the front', [reused?.record.automation, afterUse?.project, (afterUse?.lastUsedAt ?? 0) >= beforeUse, history.list()[0]?.id, afterReuseRestart.list()[0]?.id], [automation, 'Project B', true, first.id, first.id]);
    let busyMessage = ''; try { history.delete(first.id, [], true); } catch (error) { busyMessage = error.message; }
    focusedExpect('history: delete busy guard preserves record and file', [busyMessage, history.get(first.id) !== null, existsSync(media)], ['Wait for active downloads or media preparation to finish.', true, true]);
    focusedExpect('history: referenced managed file survives first delete', history.delete(first.id, []).deleted, false);
    focusedExpect('history: final managed reference deletes regular contained file', [history.delete(second.id, []).deleted, existsSync(media)], [true, false]);
    const rootA = path.join(temp, 'managed-root-a'); const rootB = path.join(temp, 'managed-root-b'); mkdirSync(rootA); mkdirSync(rootB); const oldRootMedia = path.join(rootA, 'old-root.mp4'); writeFileSync(oldRootMedia, 'old root'); const rootSwitchStore = path.join(temp, 'root-switch', 'history.json'); const rootSwitchHistory = new DownloadHistory(rootSwitchStore, rootA); const oldRootRecord = rootSwitchHistory.add({ ...input, filePath: oldRootMedia }); rootSwitchHistory.setManagedRoot(rootB); const listedAfterSwitch = rootSwitchHistory.list().find((record) => record.id === oldRootRecord.id); const reusedAfterSwitch = rootSwitchHistory.reuse(oldRootRecord.id); const persistedAfterReuse = new DownloadHistory(rootSwitchStore, rootB);
    const oldRootReal = reusedAfterSwitch?.path ?? realpathSync(oldRootMedia);
    const removedAfterSwitch = rootSwitchHistory.delete(oldRootRecord.id, []); const removedAfterSwitchRestart = new DownloadHistory(rootSwitchStore, rootB);
    focusedExpect('history: switching managed roots keeps old records reusable, persists ordering, and removes old media via stored trustedRoot', [listedAfterSwitch?.id, reusedAfterSwitch?.path, persistedAfterReuse.list()[0]?.id, removedAfterSwitch, removedAfterSwitchRestart.get(oldRootRecord.id), existsSync(oldRootMedia)], [oldRootRecord.id, oldRootReal, oldRootRecord.id, { deleted: true, removed: true }, null, false]);
    const external = path.join(temp, 'external.mov'); writeFileSync(external, 'external'); const managedAgain = path.join(managed, 'again.mp4'); writeFileSync(managedAgain, 'x'); const relinked = history.add({ ...input, filePath: managedAgain }); history.add({ ...input, filePath: managedAgain }); history.relink(relinked.id, external); const relinkRestart = new DownloadHistory(store, managed);
    focusedExpect('history: relink moves the existing record to the persisted front without changing its ID', [history.list()[0]?.id, relinkRestart.list()[0]?.id, history.list().filter((record) => record.id === relinked.id).length], [relinked.id, relinked.id, 1]);
    focusedExpect('history: externally relinked file is never physically deleted', [history.delete(relinked.id, []).deleted, existsSync(external)], [false, true]);
    const retryFile = path.join(managed, 'retry.mp4'); writeFileSync(retryFile, 'retry'); const retryRecord = history.add({ ...input, filePath: retryFile }); const preservedFailure = history.delete(retryRecord.id, [retryFile], false, true);
    focusedExpect('history: queue delete preserves its record when safety rejects deletion', [preservedFailure, history.get(retryRecord.id) !== null, existsSync(retryFile)], [{ deleted: false, removed: false }, true, true]);
    const saveFailStore = path.join(temp, 'save-fail', 'history.json'); const saveFailFile = path.join(managed, 'save-fail.mp4'); writeFileSync(saveFailFile, 'gone'); const saveFailHistory = new DownloadHistory(saveFailStore, managed); const saveFailRecord = saveFailHistory.add({ ...input, filePath: saveFailFile }); rmSync(saveFailStore); mkdirSync(saveFailStore); let saveFailResult; try { saveFailResult = saveFailHistory.delete(saveFailRecord.id, [], false, true); } catch (error) { saveFailResult = { error: error.message }; }
    focusedExpect('history: successful managed delete stays truthful when persistence rename fails', [saveFailResult, existsSync(saveFailFile)], [{ deleted: true, removed: true, warning: 'Download history could not be updated.' }, false]);
    const noDeleteStore = path.join(temp, 'no-delete-save-fail', 'history.json'); const noDeleteFile = path.join(temp, 'no-delete.mov'); writeFileSync(noDeleteFile, 'remains'); const noDeleteHistory = new DownloadHistory(noDeleteStore, managed); const noDeleteRecord = noDeleteHistory.add({ ...input, filePath: noDeleteFile }); rmSync(noDeleteStore); mkdirSync(noDeleteStore); let noDeleteThrew = false; try { noDeleteHistory.delete(noDeleteRecord.id, []); } catch { noDeleteThrew = true; }
    focusedExpect('history: persistence failure without physical deletion still throws and preserves the file', [noDeleteThrew, existsSync(noDeleteFile)], [true, true]);
    const corruptStore = path.join(temp, 'userData', 'corrupt.json'); writeFileSync(corruptStore, '{bad'); const corrupt = new DownloadHistory(corruptStore, managed); const quarantined = readdirSync(path.dirname(corruptStore)).find((name) => name.startsWith('corrupt.json.corrupt-')); corrupt.add({ ...input, filePath: external }); focusedExpect('history: corrupt JSON is quarantined before a new save', [new DownloadHistory(corruptStore, managed).list().length, existsSync(corruptStore), !!quarantined, quarantined ? readFileSync(path.join(path.dirname(corruptStore), quarantined), 'utf8') : ''], [1, true, true, '{bad']);
    focusedExpect('history: source and relink media allowlists', [!!safeHistorySource('youtube', source), safeHistorySource('youtube', 'https://evil.example/watch?v=x'), !!safeHistorySource('pexels', 'https://www.pexels.com/video/1/'), safeHistorySource('pexels', 'https://youtube.com/watch?v=x'), supportedHistoryMediaPath('clip.MOV'), supportedHistoryMediaPath('clip.txt')], [true, null, true, null, true, false]);
    focusedExpect('history: social source keeps canonical allowlisted URL only', [safeHistorySource('social', 'https://www.instagram.com/reel/ABC_def-123/?utm_source=share'), safeHistorySource('social', 'https://www.instagram.com/stories/me/123'), safeHistorySource('social', 'https://evil.example/reel/ABC_def-123')], ['https://www.instagram.com/reel/ABC_def-123', null, null]);
    const socialMedia = path.join(managed, 'social.mp4'); writeFileSync(socialMedia, 'social'); const socialSource = 'https://www.instagram.com/reel/ABC_def-123/?utm_source=share'; const socialAutomation = { provider: 'social', source: socialSource, selection: null, chapters: [{ start: 1, end: 2, title: 'Ignored' }] }; const socialRecord = history.add({ ...input, provider: 'social', source: socialSource, filePath: socialMedia, assetId: 'instagram:social-video-1', creator: 'Social creator', automation: socialAutomation, selection: null });
    focusedExpect('history: social record persists canonical source without chapter automation', [socialRecord.provider, socialRecord.source, socialRecord.automation, socialRecord.selection], ['social', 'https://www.instagram.com/reel/ABC_def-123', { provider: 'social', source: 'https://www.instagram.com/reel/ABC_def-123', selection: null, chapters: [] }, null]);
    focusedExpect('history: add failure becomes a warning instead of a download failure', [recordHistoryWarning({ add: () => { throw new Error('disk full'); } }, input), recordHistoryWarning({ add: () => first }, input)], ['Download history could not be updated.', undefined]);
    rmSync(temp, { recursive: true, force: true });
  }
});
