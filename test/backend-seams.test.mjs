import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {DownloadHistory} from '../dist/history.js';
import {parseFfprobe} from '../dist/media-prep.js';
import {buildStatus} from '../dist/status.js';
import {createStatusProvider} from '../dist/status-provider.js';
import {createTransfer} from '../dist/transfer.js';
import {cleanupWorkspace, inspectWorkspace} from '../dist/workspace.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('status shape and injected provider expose the connected project seam', async () => {
  const calls = [];
  const workflow = {
    Initialize: async id => { calls.push(['Initialize', id]); return true; },
    GetInfo: () => ({version: '2.0'}),
    GetResolve: async () => ({
      GetVersionString: async () => '21.0',
      GetProjectManager: async () => ({GetCurrentProject: async () => ({GetName: async () => '  Project  ', GetCurrentTimeline: async () => ({GetName: async () => 'Timeline'})})}),
    }),
  };
  const provider = createStatusProvider(workflow, 'com.clipdock.app');
  const status = await provider.getStatus();
  assert.equal(status.phase, 'ready');
  assert.deepEqual(status.project, {name: 'Project', loaded: true});
  assert.deepEqual(status.timeline, {name: 'Timeline', loaded: true});
  assert.deepEqual(calls, [['Initialize', 'com.clipdock.app']]);
  assert.equal(buildStatus({...status.bridge, initialized: true, resolveAvailable: true, initError: null, resolveError: null, projectName: null, timelineName: null}).phase, 'no-project');
});

test('transfer seam reuses an exact active-bin duplicate and never imports it again', async () => {
  const existing = {GetClipProperty: async property => property === 'File Path' ? 'C:/media/clip.mp4' : null};
  const folder = {GetClipList: async () => [existing]};
  let imports = 0;
  const workflow = {
    Initialize: async () => true,
    GetResolve: async () => ({
      GetProjectManager: async () => ({GetCurrentProject: async () => ({GetUniqueId: () => 'project', GetMediaPool: async () => ({GetCurrentFolder: async () => folder})})}),
      GetMediaStorage: async () => ({AddItemListToMediaPool: async () => { imports += 1; return [{id: 'new'}]; }}),
    }),
  };
  const transfer = createTransfer(workflow, 'com.clipdock.app', 'win32');
  const result = await transfer.importToMediaPool('C:\\media\\clip.mp4', 'active');
  assert.equal(result.kind, 'already-imported');
  assert.equal(imports, 0);
});

test('history stores public metadata without paths and safely deletes only the final managed reference', () => {
  const root = tempRoot('clipdock-history-');
  try {
    const mediaDir = path.join(root, 'youtube');
    mkdirSync(mediaDir);
    const media = path.join(mediaDir, 'clip.mp4');
    writeFileSync(media, 'media');
    const history = new DownloadHistory(path.join(root, 'history.json'), root, () => 'Project');
    const input = {
      provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath: media,
      assetId: 'dQw4w9WgXcQ', title: 'Title', creator: 'Channel', profile: 'original', quality: 'best',
      mediaMode: 'video', selection: null,
      automation: {provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: []},
    };
    const record = history.add(input);
    assert.equal(record.available, true);
    assert.equal('filePath' in record, false);
    assert.equal(JSON.stringify(record).includes(media), false);
    assert.equal(history.reuse(record.id).record.project, 'Project');
    const protectedDelete = history.delete(record.id, [media]);
    assert.deepEqual(protectedDelete, {deleted: false, removed: true});
    assert.equal(existsSync(media), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('workspace only counts provider files and cleanup preserves protected media', () => {
  const root = tempRoot('clipdock-workspace-');
  const outside = tempRoot('clipdock-workspace-outside-');
  try {
    const youtube = path.join(root, 'youtube');
    mkdirSync(youtube);
    const keep = path.join(youtube, 'keep.mp4');
    const old = path.join(youtube, 'old.mp4');
    writeFileSync(keep, 'keep');
    writeFileSync(old, 'old-file');
    writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated');
    writeFileSync(path.join(outside, 'outside.mp4'), 'outside');
    symlinkSync(path.join(outside, 'outside.mp4'), path.join(youtube, 'link.mp4'));
    assert.deepEqual(inspectWorkspace(root, [keep]), {fileCount: 3, totalBytes: 21, cleanupFileCount: 2, cleanupBytes: 17});
    const result = cleanupWorkspace(root, [keep]);
    assert.deepEqual(result, {deletedFileCount: 2, deletedBytes: 17, fileCount: 1, totalBytes: 4});
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(path.join(root, 'unrelated.txt')), false);
    assert.equal(existsSync(path.join(youtube, 'link.mp4')), true);
    assert.equal(readFileSync(path.join(outside, 'outside.mp4'), 'utf8'), 'outside');
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  }
});

test('ffprobe parser makes container, codec, rate, duration, and rotation observable', () => {
  const probe = parseFfprobe(JSON.stringify({
    streams: [
      {codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001', duration: '12.5', tags: {rotate: '90'}},
      {codec_type: 'audio', codec_name: 'aac'},
    ],
    format: {format_name: 'mov,mp4', tags: {major_brand: 'isom'}, duration: '12.5'},
  }));
  assert.equal(probe.video.codec, 'h264');
  assert.equal(probe.video.width, 1920);
  assert.equal(probe.video.rotation, 90);
  assert.equal(probe.video.cfr, true);
  assert.equal(probe.container, 'mp4');
  assert.equal(probe.audio.codec, 'aac');
  assert.equal(probe.duration, 12.5);
  assert.throws(() => parseFfprobe(JSON.stringify({streams: [], format: {}})), /no video stream/);
});
