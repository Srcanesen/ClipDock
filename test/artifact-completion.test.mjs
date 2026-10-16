// Focused unit tests for the shared download-completion artifact service
// (src/main-process.ts). The service must stay Electron-free and runnable
// in-process with fakes: every dependency (file validation, project refresh,
// history record creation, card registry binding, provider event emission) is
// injected, so the orchestration order and payload shapes are test-locked here
// without Electron, WorkflowIntegration.node, or live downloads.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

import {createArtifactCompletionService} from '../dist/main-process.js';

const automation = {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []};
const history = {
  provider: 'youtube',
  source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  filePath: '/tmp/clipdock/clip.mp4',
  assetId: 'dQw4w9WgXcQ',
  title: 'Title',
  creator: 'Channel',
  profile: 'original',
  quality: 'best',
  mediaMode: 'video',
  selection: null,
  automation,
};
const artifact = {filePath: '/tmp/clipdock/clip.mp4', fileName: 'clip.mp4'};
const jobId = 'job-1';

function setup(overrides = {}) {
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const deps = {
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-1'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
    emitCompleted: (event) => { calls.events.push(event); },
    ...overrides,
  };
  return {service: createArtifactCompletionService(deps), calls};
}

test('completion binds the card with automation/historyId, records history, emits the completed event, and returns the opaque payload', async () => {
  const {service, calls} = setup();
  const result = await service.completeDownload({jobId, automation, artifact, history});
  assert.deepEqual(result, {cardId: 'card-1', fileName: 'clip.mp4', subtitle: undefined, warning: undefined});
  assert.deepEqual(calls.history, [history]);
  assert.deepEqual(calls.cards, [{path: artifact.filePath, automation, historyId: 'history-1'}]);
  assert.deepEqual(calls.events, [{
    jobId, state: 'completed', percent: 100, message: 'Ready for Resolve.',
    cardId: 'card-1', fileName: 'clip.mp4', subtitle: undefined, warning: undefined,
  }]);
});

test('completion merges artifact and history warnings into the event, message, and result', async () => {
  const {service, calls} = setup({recordHistory: () => ({record: {id: 'history-2'}, warning: 'Download history could not be updated.'})});
  const result = await service.completeDownload({jobId, automation, artifact: {...artifact, warning: 'Subtitles were unavailable; the media download is ready.'}, history});
  assert.equal(result.warning, 'Subtitles were unavailable; the media download is ready. Download history could not be updated.');
  assert.equal(calls.events[0].message, 'Ready for Resolve with a warning.');
  assert.equal(calls.events[0].warning, result.warning);
});

test('completion rejects an unsafe artifact before any history, card, or event side effect', async () => {
  const {service, calls} = setup({isSafeMediaFile: () => false});
  await assert.rejects(() => service.completeDownload({jobId, automation, artifact, history}), /Prepared file is no longer available/);
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
});

test('completion still completes when history persistence fails, binding the card without a history id', async () => {
  const {service, calls} = setup({recordHistory: () => ({record: null, warning: 'Download history could not be updated.'})});
  const result = await service.completeDownload({jobId, automation, artifact, history});
  assert.equal(result.warning, 'Download history could not be updated.');
  assert.equal(calls.events[0].message, 'Ready for Resolve with a warning.');
  assert.deepEqual(calls.cards, [{path: artifact.filePath, automation, historyId: undefined}]);
});

test('completion preserves main ordering: project refresh, history record, card binding, then event emission', async () => {
  const order = [];
  const {service} = setup({
    refreshHistoryProject: async () => { order.push('refresh'); },
    recordHistory: () => { order.push('history'); return {record: {id: 'history-3'}}; },
    registerCard: () => { order.push('card'); return 'card-9'; },
    emitCompleted: () => { order.push('event'); },
  });
  const result = await service.completeDownload({jobId, automation, artifact, history});
  assert.deepEqual(order, ['refresh', 'history', 'card', 'event']);
  assert.equal(result.cardId, 'card-9');
});

test('completion carries the subtitle artifact through the event and result', async () => {
  const {service, calls} = setup();
  const subtitle = {cardId: 'sub-1', fileName: 'clip.srt'};
  const result = await service.completeDownload({jobId, automation, artifact: {...artifact, subtitle}, history});
  assert.deepEqual(result.subtitle, subtitle);
  assert.deepEqual(calls.events[0].subtitle, subtitle);
});

test('completion propagates preparation failure for editing without fallback or side effects', async () => {
  const prepareError = new Error('Media preparation failed: ffmpeg failed.');
  const calls = {refresh: 0, history: [], cards: [], events: []};
  let prepareCalls = 0;
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-1'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
    prepareMedia: async () => { prepareCalls += 1; throw prepareError; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  let result;
  await assert.rejects(
    async () => { result = await service.completeDownload({jobId, automation, artifact, history: {...history, profile: 'editing'}, prepare: {jobId, inputPath: artifact.filePath, allowedRoot: '/tmp/clipdock', profile: 'editing', emit: () => undefined}}); },
    (error) => error === prepareError,
  );
  assert.equal(result, undefined);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
  assert.equal(calls.history.length, 0);
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.events.length, 0);
});

test('completion propagates unsafe prepared output for fast without fallback or side effects', async () => {
  const safe = new Set(['/tmp/clipdock/clip.mp4']);
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: (filePath) => safe.has(filePath),
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-1'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
    prepareMedia: async () => ({filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}),
    emitCompleted: (event) => { calls.events.push(event); },
  });
  let result;
  await assert.rejects(
    async () => { result = await service.completeDownload({jobId, automation, artifact: {...artifact, warning: 'Download warning.'}, history: {...history, profile: 'fast'}, prepare: {jobId, inputPath: artifact.filePath, allowedRoot: '/tmp/clipdock', profile: 'fast', emit: () => undefined}}); },
    (error) => error instanceof Error && error.message === 'Prepared file is no longer available.',
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, {refresh: 0, history: [], cards: [], events: []});
  assert.equal(calls.history.length, 0);
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.events.length, 0);
});

test('completion completes explicitly requested original artifact without invoking preparation', async () => {
  let prepareCalls = 0;
  const calls = {refresh: 0, history: [], cards: [], events: []};
  const service = createArtifactCompletionService({
    isSafeMediaFile: () => true,
    refreshHistoryProject: async () => { calls.refresh += 1; },
    recordHistory: (input) => { calls.history.push(input); return {record: {id: 'history-1'}}; },
    registerCard: (card) => { calls.cards.push(card); return 'card-1'; },
    prepareMedia: async () => { prepareCalls += 1; return {filePath: '/tmp/clipdock/prepared.mp4', fileName: 'prepared.mp4'}; },
    emitCompleted: (event) => { calls.events.push(event); },
  });
  const result = await service.completeDownload({jobId, automation, artifact, history: {...history, profile: 'original'}});
  assert.equal(prepareCalls, 0);
  assert.deepEqual(result, {cardId: 'card-1', fileName: 'clip.mp4', subtitle: undefined, warning: undefined});
  assert.equal(calls.history[0].profile, 'original');
  assert.equal(calls.history[0].filePath, artifact.filePath);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.events.length, 1);
});

test('completion service ships Electron-free in the built artifact', () => {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const source = readFileSync(path.join(dist, 'main-process.js'), 'utf8');
  assert.equal(/require\(['"]electron/.test(source), false);
  assert.ok(source.includes('createArtifactCompletionService'));
});
