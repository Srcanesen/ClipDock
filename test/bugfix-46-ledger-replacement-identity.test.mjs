import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRoot } from '../dist/managed-root.js';
import { DownloadHistory } from '../dist/history.js';
import { DownloadLedger } from '../dist/download-ledger.js';

const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const input = filePath => ({ provider: 'youtube', source, filePath, title: 'Clip', creator: null, assetId: null, profile: 'original', quality: 'best', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source, selection: null, chapters: [] } });

function fixture(t, scenario, registerMedia = true) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'ledger-replacement-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = ManagedRoot.prepare(path.join(base, 'managed'));
  const store = path.join(base, 'history.json');
  const history = new DownloadHistory(store, root), ledger = new DownloadLedger(history, () => false);
  const media = path.join(root.providerPath('youtube'), 'first.mp4'), subtitle = path.join(root.providerPath('youtube'), 'first.srt');
  fs.writeFileSync(media, 'original media'); fs.writeFileSync(subtitle, 'original subtitle');
  const subtitleCard = ledger.registerSubtitle(subtitle, root);
  if (scenario === 'failed history write') fs.writeFileSync(`${store}.lock`, JSON.stringify({ pid: process.pid, token: 'other-panel' }));
  const recorded = ledger.record({ ...input(media), subtitle: { filePath: subtitle } });
  if (scenario === 'failed history write') {
    assert.equal(recorded.record, null);
    assert.equal(recorded.warning, 'Download history could not be updated.');
    fs.unlinkSync(`${store}.lock`);
  } else assert.ok(recorded.record);
  const card = registerMedia ? ledger.register({ path: media, historyId: recorded.record?.id }, root) : null;
  if (scenario === 'evicted record') {
    const other = path.join(root.providerPath('youtube'), 'other.mp4'); fs.writeFileSync(other, 'another download');
    for (let n = 0; n < 200; n++) history.add(input(other));
    assert.equal(history.list().length, 200);
    assert.equal(history.get(recorded.record.id), null);
  }
  return { ledger, media, subtitle, card, subtitleCard };
}

for (const scenario of ['evicted record', 'failed history write']) {
  for (const target of ['media', 'subtitle card', 'subtitle companion']) {
    test(`${scenario}: queue deletion preserves a replacement ${target}`, t => {
      const { ledger, media, subtitle, card, subtitleCard } = fixture(t, scenario, target !== 'subtitle card');
      const victim = target === 'media' ? media : subtitle;
      fs.renameSync(victim, `${victim}.original`); fs.writeFileSync(victim, 'USER REPLACEMENT');
      const result = ledger.deleteCard(target === 'subtitle card' ? subtitleCard : card);
      assert.equal(fs.existsSync(victim), true, 'replacement must survive queue deletion');
      assert.equal(fs.readFileSync(victim, 'utf8'), 'USER REPLACEMENT');
      assert.equal(fs.readFileSync(`${victim}.original`, 'utf8'), target === 'media' ? 'original media' : 'original subtitle');
      if (target === 'subtitle companion') {
        // As with recorded deletion, deleted describes the unchanged media.
        assert.equal(result.deleted, true);
        assert.equal(fs.existsSync(media), false);
        assert.match(result.message, /subtitle.*could not be deleted/i);
      } else {
        assert.equal(result.deleted, false);
        assert.match(result.message, /changed or was replaced; preserved/i);
        assert.ok(ledger.resolve(target === 'subtitle card' ? subtitleCard : card), 'preserved card remains in the queue');
      }
    });
  }

  test(`${scenario}: unchanged media and subtitle companion are deleted`, t => {
    const { ledger, media, subtitle, card } = fixture(t, scenario);
    assert.deepEqual(ledger.deleteCard(card), { deleted: true, message: 'File deleted.' });
    assert.equal(fs.existsSync(media), false);
    assert.equal(fs.existsSync(subtitle), false);
    assert.equal(ledger.resolve(card), null);
  });

  test(`${scenario}: unchanged subtitle card is deleted`, t => {
    const { ledger, media, subtitle, subtitleCard } = fixture(t, scenario, false);
    assert.deepEqual(ledger.deleteCard(subtitleCard), { deleted: true, message: 'File deleted.' });
    assert.equal(fs.existsSync(subtitle), false);
    assert.equal(fs.readFileSync(media, 'utf8'), 'original media');
  });
}
