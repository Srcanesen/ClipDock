import assert from 'node:assert/strict';
import { test } from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { createProviderDownloadHandlers } from '../dist/main-process.js';

test('pinterest history profile for image is original, not user-selected', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pin-profile-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const media = name => {const filePath = join(directory, name); writeFileSync(filePath, 'media'); return {filePath, fileName: name};};
  let capturedHistory = null;
  const deps = {
    completion: {
      isSafeMediaFile: () => true,
      refreshHistoryProject: async () => {},
      recordHistory: (input) => { capturedHistory = input; return { record: { id: 'h1' } }; },
      registerCard: () => 'card1',
      prepareMedia: async () => media('prepared.mp4'),
    },
    ffprobeAvailable: true,
    registerSubtitle: () => ({ cardId: 's', fileName: 's.srt' }),
    youtube: { worker: { metadata: async () => ({}), download: async () => ({}) }, emit: () => {} },
    social: { worker: { metadataSocial: async () => ({}), downloadSocial: async () => ({}) }, emit: () => {} },
    pinterest: {
      worker: {
        metadata: async () => ({
          pinId: '123',
          source: 'https://www.pinterest.com/pin/123/',
          title: 'Pin',
          creator: 'Creator',
          kind: 'image',
          items: [{ index: 1, kind: 'image', title: 'Image', creator: null, extension: 'jpg' }],
          thumbnailDataUrl: null,
        }),
        download: async () => ({...media('pin.jpg'), kind: 'image'}),
      },
      snapshots: {
        get: () => null,
        remember: () => {},
      },
      emit: () => {},
    },
    pexels: { worker: { load: async () => ({}), download: async () => ({}) }, emit: () => {} },
  };
  const handlers = createProviderDownloadHandlers(deps);
  // Image fast is rejected (Original-only), image original stores original
  await assert.rejects(handlers.pinterest({ sender: {} }, 'https://www.pinterest.com/pin/123/', 1, 'fast', 'job1'), /Original-only/);
  assert.equal(capturedHistory, null, 'failed image download must not record history');
  const result = await handlers.pinterest({ sender: {} }, 'https://www.pinterest.com/pin/123/', 1, 'original', 'job1b');
  assert.equal(capturedHistory.profile, 'original', 'image history profile must be original');
  assert.equal(capturedHistory.quality, 'original');
  // Video with fast should keep fast
  capturedHistory = null;
  deps.pinterest.worker.metadata = async () => ({
    pinId: '124',
    source: 'https://www.pinterest.com/pin/124/',
    title: 'Pin',
    creator: 'Creator',
    kind: 'video',
    items: [{ index: 1, kind: 'video', title: 'Video', creator: null, extension: 'mp4' }],
    thumbnailDataUrl: null,
  });
  deps.pinterest.worker.download = async () => ({...media('pin.mp4'), kind: 'video'});
  await handlers.pinterest({ sender: {} }, 'https://www.pinterest.com/pin/124/', 1, 'fast', 'job2');
  assert.equal(capturedHistory.profile, 'fast');
});
