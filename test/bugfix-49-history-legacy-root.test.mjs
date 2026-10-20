import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DownloadHistory } from '../dist/history.js';
import { ManagedRoot } from '../dist/managed-root.js';

const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const automation = {provider: 'youtube', source, selection: null, chapters: []};
const input = filePath => ({provider: 'youtube', source, filePath, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation});
const stored = (id, filePath, managed) => ({id, provider: 'youtube', source, project: null, filePath, managed, fileName: path.basename(filePath), bytes: 3, assetId: null, title: id, creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation, createdAt: 1, lastUsedAt: 1, subtitlePath: null});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-legacy-root-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const a = path.join(dir, 'A'), b = path.join(dir, 'B');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const legacy = path.join(a, 'old.mp4'); fs.writeFileSync(legacy, 'old');
  const external = path.join(dir, 'external.mp4'); fs.writeFileSync(external, 'ext');
  const store = path.join(dir, 'history.json');
  // Store written before records carried trustedRoot.
  fs.writeFileSync(store, JSON.stringify({schemaVersion: 1, records: [stored('legacy', legacy, true), stored('external', external, false)]}));
  return {a, b, store};
}

test('a legacy managed record stays bound to the folder it was first loaded under after a folder change', t => {
  const {a, b, store} = fixture(t);
  let current = ManagedRoot.capture(a);
  const history = new DownloadHistory(store, () => current);
  assert.equal(history.get('legacy').available, true);
  current = ManagedRoot.capture(b);
  const newFile = path.join(b, 'new.mp4'); fs.writeFileSync(newFile, 'new');
  history.add(input(newFile));
  assert.equal(history.get('legacy').available, true);
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).records.find(r => r.id === 'legacy').trustedRoot, a);
  current = ManagedRoot.capture(a);
  assert.equal(new DownloadHistory(store, () => current).get('legacy').available, true);
});

test('a legacy managed record loaded while the folder is unavailable is not persisted without provenance', t => {
  const {a, store} = fixture(t);
  let current = null;
  const history = new DownloadHistory(store, () => current);
  assert.equal(history.get('legacy').available, false);
  assert.deepEqual(history.delete('external', []), {deleted: false, removed: true});
  assert.equal('trustedRoot' in JSON.parse(fs.readFileSync(store, 'utf8')).records.find(r => r.id === 'legacy'), false);
  current = ManagedRoot.capture(a);
  assert.equal(new DownloadHistory(store, () => current).get('legacy').available, true);
});
