// A subtitle card bound to its media (ownerPath) shares the media's history record:
// deleting it removes only the subtitle, never the media file, its card or its record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {ManagedRoot} from '../dist/managed-root.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {DownloadHistory} from '../dist/history.js';

const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const input = filePath => ({provider: 'youtube', source, filePath, assetId: null, title: 'Clip', creator: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: {provider: 'youtube', source, selection: null, chapters: []}});

test('deleting a bound subtitle card deletes only the subtitle', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-subtitle-card-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const history = new DownloadHistory(path.join(dir, 'history.json'), root), ledger = new DownloadLedger(history, () => false);
  const file = (name, text) => { const p = path.join(root.providerPath('youtube'), name); fs.writeFileSync(p, text); return p; };
  const media = file('clip.mp4', 'media'), subtitle = file('clip.en.srt', 'captions');
  const subtitleCard = ledger.registerSubtitle(subtitle, root);
  const record = ledger.record({...input(media), subtitle: {filePath: subtitle}}).record;
  const mediaCard = ledger.register({path: media, historyId: record.id}, root);
  assert.equal(ledger.deleteCard(subtitleCard).deleted, true);
  assert.deepEqual([fs.existsSync(media), fs.existsSync(subtitle), !!ledger.resolve(mediaCard), !!history.get(record.id)], [true, false, true, true]);
  assert.equal(ledger.deleteCard(mediaCard).deleted, true);
  assert.equal(fs.existsSync(media), false);
});
