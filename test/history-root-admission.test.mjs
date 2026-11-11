import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DownloadHistory } from '../dist/history.js';
import { DownloadLedger } from '../dist/download-ledger.js';
import { ManagedRoot } from '../dist/managed-root.js';
import { claimDownloadFolder, defaultDownloadFolder } from '../dist/settings.js';
import { createHistoryPreparationHandlers } from '../dist/main-process.js';
import { historyInput } from './helpers/files-main.mjs';

function fixture(t, kind) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-admission-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const active = ManagedRoot.prepare(path.join(dir, 'active'));
  const fallback = defaultDownloadFolder(path.join(dir, 'Downloads'));
  const folder = kind === 'active' ? active.verify() : kind === 'default' ? fallback : path.join(dir, kind);
  fs.mkdirSync(folder, { recursive: true });
  if (kind === 'marked') claimDownloadFolder(ManagedRoot.capture(folder));
  const file = path.join(folder, 'victim.mp4'); fs.writeFileSync(file, 'victim');
  const store = path.join(dir, 'history.json');
  const writer = new DownloadHistory(store, active); t.after(() => writer.dispose());
  const original = path.join(active.verify(), 'original.mp4'); fs.writeFileSync(original, 'original');
  const record = writer.add({ ...historyInput(original), preparationFailed: { profile: 'fast' } });
  const raw = JSON.parse(fs.readFileSync(store, 'utf8'));
  Object.assign(raw.records[0], { trustedRoot: folder, filePath: file, fileName: 'victim.mp4' });
  fs.writeFileSync(store, JSON.stringify(raw));
  const before = fs.readFileSync(store, 'utf8');
  const history = new DownloadHistory(store, active, () => null, undefined, fallback);
  t.after(() => history.dispose());
  return { dir, active, folder, file, store, record, history, before, original, fallback };
}

for (const kind of ['active', 'default', 'marked', 'unmarked']) {
  test(`stored root admission: ${kind}`, t => {
    const f = fixture(t, kind);
    const trustedRoot = f.history.resolve(f.record.id)?.trustedRoot?.verify();
    assert.equal(fs.readFileSync(f.store, 'utf8'), f.before);
    const result = new DownloadLedger(f.history, () => false).deleteHistory(f.record.id);
    assert.equal(result.deleted, kind !== 'unmarked');
    assert.equal(fs.existsSync(f.file), kind === 'unmarked');
    assert.equal(trustedRoot, kind === 'unmarked' ? undefined : f.folder);
  });
}

test('forged unmarked root refuses retry before preparation and keeps the source', async t => {
  const f = fixture(t, 'unmarked'); let calls = 0;
  const handler = createHistoryPreparationHandlers({ history: f.history, prepareMedia: async () => { calls++; const filePath = path.join(f.folder, 'converted.mp4'); fs.writeFileSync(filePath, 'converted'); return { filePath, fileName: 'converted.mp4' }; }, cancelMediaPreparation: () => null, replaced() {} });
  await assert.rejects(handler.retryPreparation(f.record.id), /existing managed file/);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'victim');
  assert.equal(fs.readFileSync(f.store, 'utf8'), f.before);
});

test('unavailable roots stay external for the session and retain stored provenance across unrelated writes', t => {
  const f = fixture(t, 'marked');
  fs.renameSync(f.folder, `${f.folder}-offline`);
  const offline = new DownloadHistory(f.store, f.active); t.after(() => offline.dispose());
  assert.equal(offline.resolve(f.record.id), null);
  offline.add(historyInput(f.original));
  assert.equal(JSON.parse(fs.readFileSync(f.store, 'utf8')).records.find(r => r.id === f.record.id).trustedRoot, f.folder);
  fs.renameSync(`${f.folder}-offline`, f.folder);
  assert.equal(offline.resolve(f.record.id)?.trustedRoot, undefined);
  const online = new DownloadHistory(f.store, f.active); t.after(() => online.dispose());
  assert.equal(online.resolve(f.record.id)?.trustedRoot?.verify(), f.folder);
});
