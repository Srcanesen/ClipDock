import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
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

test('artifact completion preparation, fallback, cancellation and safety', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  {
    const { createArtifactCompletionService } = await import(path.join(dist, 'main-process.js'));
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-completion-'));
    const originalPath = path.join(rootDir, 'original-download.mp4'); const preparedPath = path.join(rootDir, 'prepared.resolve.mp4');
    writeFileSync(originalPath, 'original'); writeFileSync(preparedPath, 'prepared');
    const safeChecks = [];
    const calls = { prepare: 0, refresh: 0, history: [], cards: [], events: [] };
    const deps = {
      isSafeMediaFile: (filePath) => { safeChecks.push(filePath); return path.isAbsolute(filePath) && existsSync(filePath) && statSync(filePath).isFile(); },
      refreshHistoryProject: async () => { calls.refresh += 1; },
      recordHistory: (input) => { calls.history.push(input); return { record: { id: 'history-1' } }; },
      registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
      prepareMedia: async () => { calls.prepare += 1; return { filePath: preparedPath, fileName: 'prepared.resolve.mp4' }; },
      emitCompleted: (event) => { calls.events.push(event); },
    };
    const service = createArtifactCompletionService(deps);
    const automation = { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: [] };
    const request = (overrides = {}) => ({
      jobId: 'job-1',
      automation,
      artifact: { filePath: originalPath, fileName: 'original-download.mp4', warning: 'Subtitles were unavailable; the media download is ready.' },
      prepare: { jobId: 'job-1', inputPath: originalPath, allowedRoot: rootDir, profile: 'fast', emit: () => undefined },
      history: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: originalPath, assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'fast', quality: 'best', mediaMode: 'video', selection: null, automation },
      ...overrides,
    });
    const success = await service.completeDownload(request());
    focusedExpect('completion service keeps successful prepared output and records/binds the prepared artifact truthfully', [success.fileName, calls.history[0].filePath, calls.history[0].profile, calls.cards[0].path, calls.events[0].fileName, success.warning, safeChecks], ['prepared.resolve.mp4', preparedPath, 'fast', preparedPath, 'prepared.resolve.mp4', 'Subtitles were unavailable; the media download is ready.', [preparedPath, preparedPath]]);

    const prepareError = new Error('Media preparation failed: ffmpeg failed.');
    deps.prepareMedia = async () => { throw prepareError; };
    const refreshBeforeFallback = calls.refresh;
    calls.history.length = 0; calls.cards.length = 0; calls.events.length = 0; safeChecks.length = 0;
    let fallbackError = null; try { await service.completeDownload(request({ jobId: 'job-2' })); } catch (error) { fallbackError = error; }
    focusedExpect('completion service propagates preparation failure with no fallback or side effects', [fallbackError === prepareError, calls.refresh === refreshBeforeFallback, calls.history.length, calls.cards.length, calls.events.length, safeChecks], [true, true, 0, 0, 0, []]);

    const cancellation = new Error('Media preparation cancelled.'); deps.prepareMedia = async () => { throw cancellation; };
    const refreshBefore = calls.refresh; calls.history.length = 0; calls.cards.length = 0; calls.events.length = 0; safeChecks.length = 0;
    let cancelledError = null; try { await service.completeDownload(request({ jobId: 'job-3' })); } catch (error) { cancelledError = error; }
    focusedExpect('completion service propagates cancellation with no fallback or side effects', [cancelledError === cancellation, calls.refresh === refreshBefore, calls.history.length, calls.cards.length, calls.events.length, safeChecks], [true, true, 0, 0, 0, []]);

    deps.prepareMedia = async () => { calls.prepare += 1; return { filePath: preparedPath, fileName: 'prepared.resolve.mp4' }; };
    calls.prepare = 0; calls.history.length = 0; calls.cards.length = 0; calls.events.length = 0; safeChecks.length = 0;
    const direct = await service.completeDownload(request({ jobId: 'job-4', prepare: undefined, artifact: { filePath: originalPath, fileName: 'original-download.mp4' }, history: { ...request().history, provider: 'pexels', source: 'https://www.pexels.com/photo/2', assetId: 'photo:2', mediaMode: 'photo' } }));
    focusedExpect('completion service keeps the provider-declared profile when no preparation applies', [calls.prepare, direct.fileName, calls.history[0].profile, calls.history[0].filePath, direct.warning, calls.events[0].message, safeChecks], [0, 'original-download.mp4', 'fast', originalPath, undefined, 'Ready for Resolve.', [originalPath]]);
    rmSync(rootDir, { recursive: true, force: true });
  }
});
