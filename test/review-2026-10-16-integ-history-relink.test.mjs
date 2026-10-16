import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {historyInput} from './helpers/files-main.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-relink-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'managed'); fs.mkdirSync(root);
  const media = path.join(root, 'clip.mp4'), store = path.join(base, 'history.json');
  fs.writeFileSync(media, 'original media');
  return {base, root, media, store};
}

for (const state of ['missing-at-load', 'replaced-in-session']) {
  test(`explicit same-path relink refreshes only the selected media: ${state}`, t => {
    const {root, media, store} = fixture(t);
    let history = new DownloadHistory(store, root);
    const record = history.add(historyInput(media));
    fs.renameSync(media, `${media}.original`);
    if (state === 'missing-at-load') {
      history = new DownloadHistory(store, root);
      assert.equal(history.get(record.id).available, false);
    }
    fs.writeFileSync(media, 'explicitly selected media');
    assert.equal(history.relink(record.id, media).available, true);
    assert.deepEqual(history.delete(record.id, [], false, true), {deleted: true, removed: true});
    assert.equal(fs.existsSync(media), false);
    assert.equal(fs.readFileSync(`${media}.original`, 'utf8'), 'original media');
  });
}

test('transaction reloads and relinking another record never admit restored media', t => {
  const {root, media, store} = fixture(t), other = path.join(root, 'other.mp4');
  fs.writeFileSync(other, 'other media');
  const initial = new DownloadHistory(store, root);
  const a = initial.add(historyInput(media)), b = initial.add(historyInput(other));
  fs.renameSync(media, `${media}.original`); fs.renameSync(other, `${other}.original`);
  const history = new DownloadHistory(store, root);
  fs.writeFileSync(media, 'restored a'); fs.writeFileSync(other, 'restored b');
  assert.equal(history.reuse(b.id).record.available, true);
  assert.equal(history.relink(a.id, media).available, true);
  assert.deepEqual(history.delete(b.id, [], false, true), {deleted: false, removed: false, warning: 'Media changed or was replaced; preserved.'});
  assert.equal(fs.readFileSync(other, 'utf8'), 'restored b');
  assert.deepEqual(history.delete(a.id, [], false, true), {deleted: true, removed: true});
});

test('explicit media relink does not refresh a replaced subtitle companion', t => {
  const {root, media, store} = fixture(t), subtitle = path.join(root, 'clip.srt');
  fs.writeFileSync(subtitle, 'original subtitle');
  const initial = new DownloadHistory(store, root);
  const record = initial.add({...historyInput(media), subtitle: {filePath: subtitle}});
  fs.renameSync(media, `${media}.original`);
  const history = new DownloadHistory(store, root);
  fs.writeFileSync(media, 'restored media');
  fs.renameSync(subtitle, `${subtitle}.original`); fs.writeFileSync(subtitle, 'unrelated subtitle');
  assert.equal(history.relink(record.id, media).available, true);
  assert.deepEqual(history.delete(record.id, [], false, true), {deleted: true, removed: true, warning: 'Media deleted, but its subtitle could not be deleted.'});
  assert.equal(fs.readFileSync(subtitle, 'utf8'), 'unrelated subtitle');
});
