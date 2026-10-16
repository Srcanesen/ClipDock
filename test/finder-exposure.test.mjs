import assert from 'node:assert/strict';
import { writeFileSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { SessionTransferCards } from '../dist/main-process.js';
import { download, mainFixture } from './helpers/files-main.mjs';

async function fixture(t, withSubtitle = false) {
  const paths = { registered: [], claimed: [], exposed: [] };
  class TrackedCards extends SessionTransferCards {
    registerDownloadedFile(file) { paths.registered.push(file); super.registerDownloadedFile(file); }
    takePristine(file) { paths.claimed.push(file); return super.takePristine(file); }
    noteExposed(file) { paths.exposed.push(file); super.noteExposed(file); }
  }
  const f = await mainFixture(t, { realTransfer: true, SessionTransferCards: TrackedCards });
  // Exercise an accepted noncanonical spelling at the real publication boundary.
  const worker = f.workers[0];
  const supplied = `${worker.root}/./clip één.mp4`;
  const subtitle = `${worker.root}/clip één.en.srt`;
  worker.download = async () => {
    writeFileSync(supplied, 'media');
    if (withSubtitle) writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nCaption\n');
    return { filePath: supplied, fileName: 'clip één.mp4', ...(withSubtitle ? { subtitlePath: subtitle, subtitleFileName: 'clip één.en.srt' } : {}) };
  };
  const calls = { lists: 0, paths: [], imports: [] };
  const item = file => ({ GetClipProperty: () => { calls.paths.push(file); return file; } });
  const clips = Array.from({ length: 200 }, (_, i) => item(`/old-${i}.mp4`));
  const folder = { GetClipList: () => { calls.lists++; return [...clips]; } };
  const pool = { GetCurrentFolder: () => folder };
  const project = { GetMediaPool: () => pool };
  f.controls.nativeResolve = {
    GetProjectManager: () => ({ GetCurrentProject: () => project }),
    GetMediaStorage: () => ({ AddItemListToMediaPool: ([file]) => {
      calls.imports.push(file);
      const clip = item(file); clips.push(clip); return [clip];
    } }),
  };
  const card = await download(f);
  assert.equal(typeof card.cardId, 'string');
  const record = f.controls.history.list()[0];
  const canonical = realpathSync(supplied);
  assert.notEqual(supplied, canonical);
  assert.equal(f.controls.history.resolve(record.id).path, canonical);
  return { f, paths, calls, card, record, canonical, subtitle, manualImport: (file = canonical) => clips.push(item(file)) };
}

test('provider registration, history resolution and transfer use the same canonical file path', async t => {
  const h = await fixture(t);
  assert.equal((await h.f.invoke('importToMediaPool', h.card.cardId, 'active')).kind, 'imported');
  assert.deepEqual(h.paths.registered, [h.canonical]);
  assert.deepEqual(h.paths.claimed, [h.canonical]);
  assert.deepEqual(h.calls.imports, [h.canonical]);
  assert.equal(h.calls.lists, 0, 'unexposed fresh card retains its scan shortcut');
  assert.deepEqual(h.calls.paths, []);
});

for (const exposure of ['historyReveal', 'openWorkspace', 'historyCopy']) {
  test(`${exposure} revokes freshness through the real IPC handler and scans before transfer`, async t => {
    const h = await fixture(t);
    assert.equal(await h.f.invoke(exposure, h.record.id), true);
    h.manualImport(); // The exposed path lets the user import the source into Resolve by hand.
    const result = await h.f.invoke('importToMediaPool', h.card.cardId, 'active');
    assert.equal(h.calls.lists, 1);
    assert.equal(result.kind, 'already-imported');
    assert.equal(h.calls.paths.length, 201);
    assert.equal(h.calls.paths.at(-1), h.canonical);
    assert.deepEqual(h.calls.imports, []);
    assert.deepEqual(h.paths.registered, [h.canonical]);
    assert.deepEqual(h.paths.claimed, [h.canonical]);
    if (exposure !== 'openWorkspace') assert.deepEqual(h.paths.exposed, [h.canonical]);
  });
}

test('historyRevealSubtitle marks the companion exposed and transfer reuses a manual import', async t => {
  const h = await fixture(t, true);
  assert.equal(typeof h.card.subtitle.cardId, 'string');
  assert.deepEqual(h.paths.registered, [h.canonical], 'subtitle cards never receive a pristine-file proof');
  assert.equal(await h.f.invoke('historyRevealSubtitle', h.record.id), true);
  assert.deepEqual(h.paths.exposed, [h.subtitle]);
  h.manualImport(h.subtitle);
  assert.equal((await h.f.invoke('importToMediaPool', h.card.subtitle.cardId, 'active')).kind, 'already-imported');
  assert.equal(h.calls.lists, 1);
  assert.equal(h.calls.paths.at(-1), h.subtitle);
  assert.deepEqual(h.calls.imports, []);
});
