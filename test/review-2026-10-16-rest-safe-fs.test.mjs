import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {cleanJobDirectory} from '../dist/provider-platform.js';
import {GalleryDlWorker} from '../dist/gallerydl.js';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {DownloadHistory} from '../dist/history.js';
import {ManagedRoot} from '../dist/managed-root.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rest-files-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const dir = path.join(base, 'managed'); fs.mkdirSync(dir);
  return {base, dir};
}

import {prepareDirectory, writeExclusive, writeOwned, captureEntry, removeEntry, replaceOwned} from '../dist/safe-fs.js';

test('owned writes truncate literal bytes and preserve a replaced inode', t => {
  const {dir} = fixture(t), anchor = prepareDirectory(dir), file = writeExclusive(anchor, 'clip', 'long original');
  writeOwned(file, 'short'); assert.equal(fs.readFileSync(file.path, 'utf8'), 'short');
  writeOwned(file, ''); assert.equal(fs.readFileSync(file.path, 'utf8'), '');
  fs.renameSync(file.path, `${file.path}.original`); fs.writeFileSync(file.path, 'replacement');
  assert.throws(() => writeOwned(file, 'unsafe'), /replaced/);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'replacement');
});

test('entry removal deletes the captured symlink and preserves its target and replacements', t => {
  const {base, dir} = fixture(t), anchor = prepareDirectory(dir), target = path.join(base, 'target'); fs.writeFileSync(target, 'precious');
  fs.symlinkSync(target, path.join(dir, 'link'));
  const entry = captureEntry(anchor, 'link'); removeEntry(entry);
  assert.equal(fs.existsSync(entry.identity.path), false); assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
  fs.symlinkSync(target, path.join(dir, 'link')); const replaced = captureEntry(anchor, 'link');
  fs.renameSync(path.join(dir, 'link'), path.join(dir, 'old-link')); fs.writeFileSync(path.join(dir, 'link'), 'replacement');
  assert.throws(() => removeEntry(replaced), /replaced/); assert.equal(fs.readFileSync(path.join(dir, 'link'), 'utf8'), 'replacement');
});

test('metadata replacement refuses a destination changed after capture', t => {
  const {dir} = fixture(t), anchor = prepareDirectory(dir), source = writeExclusive(anchor, 'temp', 'new metadata'), target = writeExclusive(anchor, 'store', 'old metadata');
  const lstat = fs.lstatSync; let visits = 0;
  t.mock.method(fs, 'lstatSync', (name, ...args) => {
    if (name === target.path && ++visits === 3) {fs.renameSync(target.path, `${target.path}.original`); fs.writeFileSync(target.path, 'replacement');}
    return lstat(name, ...args);
  });
  assert.throws(() => replaceOwned(source, anchor, 'store'), /replaced/);
  assert.equal(fs.readFileSync(target.path, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(source.path, 'utf8'), 'new metadata');
});
