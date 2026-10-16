// Focused unit tests for the main-process download folder store (src/settings.ts).
// Run after `npm run build`; tests import the compiled artifact.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {
  DEFAULT_DOWNLOAD_FOLDER_NAME,
  DOWNLOAD_FOLDER_MARKER,
  defaultDownloadFolder,
  loadDownloadFolder,
  ownedDownloadFolder,
  prepareCustomDownloadFolder,
  saveDownloadFolder,
  usableDownloadFolder,
} from '../dist/settings.js';

const withTemp = async (run) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'clipdock-settings-test-'));
  try { await run(dir); } finally { await rm(dir, {recursive: true, force: true}); }
};

test('settings: default folder is <downloads>/ClipDock', () => {
  assert.equal(DEFAULT_DOWNLOAD_FOLDER_NAME, 'ClipDock');
  assert.equal(defaultDownloadFolder('/Users/x/Downloads'), path.join('/Users/x/Downloads', 'ClipDock'));
});

test('settings: usableDownloadFolder requires an absolute existing directory', () => withTemp(async (dir) => {
  assert.equal(usableDownloadFolder(dir), dir);
  assert.equal(usableDownloadFolder(path.join(dir, 'missing')), null);
  assert.equal(usableDownloadFolder('relative/path'), null);
  assert.equal(usableDownloadFolder(42), null);
  const file = path.join(dir, 'file.txt');
  await writeFile(file, 'x');
  assert.equal(usableDownloadFolder(file), null);
}));

test('settings: an empty writable custom folder is claimed with the ownership marker', () => withTemp(async (dir) => {
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  assert.equal(prepareCustomDownloadFolder(chosen), chosen);
  assert.equal(ownedDownloadFolder(chosen), chosen);
  assert.deepEqual(await readdir(chosen), [DOWNLOAD_FOLDER_MARKER]);
  assert.match(await readFile(path.join(chosen, DOWNLOAD_FOLDER_MARKER), 'utf8'), /ClipDock managed/);
  // An already-owned folder may contain downloads and remains writable/prepared.
  await writeFile(path.join(chosen, 'existing.mp4'), 'media');
  assert.equal(prepareCustomDownloadFolder(chosen), chosen);
}));

test('settings: a non-empty unowned folder is rejected without mutation', () => withTemp(async (dir) => {
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  await writeFile(path.join(chosen, 'keep.txt'), 'keep');
  assert.throws(() => prepareCustomDownloadFolder(chosen), /empty or already owned/);
  assert.deepEqual(await readdir(chosen), ['keep.txt']);
  assert.equal(await readFile(path.join(chosen, 'keep.txt'), 'utf8'), 'keep');
}));

test('settings: unsafe persisted custom folders fall back without mutation', () => withTemp(async (dir) => {
  const userData = path.join(dir, 'userData');
  const store = path.join(userData, 'clipdock-settings.json');
  const downloads = path.join(dir, 'Downloads');
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  await writeFile(path.join(chosen, 'unrelated.txt'), 'keep');
  await mkdir(userData, {recursive: true});
  await writeFile(store, JSON.stringify({downloadFolder: chosen}));
  assert.deepEqual(loadDownloadFolder(store, downloads), {
    folder: path.join(downloads, 'ClipDock'), userSelected: false,
  });
  assert.deepEqual(await readdir(chosen), ['unrelated.txt']);
}));

test('settings: missing/corrupt/invalid stores fall back; owned values round-trip', () => withTemp(async (dir) => {
  const store = path.join(dir, 'userData', 'clipdock-settings.json');
  const downloads = path.join(dir, 'Downloads');
  const fallback = {folder: path.join(downloads, 'ClipDock'), userSelected: false};
  assert.deepEqual(loadDownloadFolder(store, downloads), fallback);
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  prepareCustomDownloadFolder(chosen);
  saveDownloadFolder(store, chosen);
  assert.deepEqual(loadDownloadFolder(store, downloads), {folder: chosen, userSelected: true});
  await writeFile(store, 'not json{');
  assert.deepEqual(loadDownloadFolder(store, downloads), fallback);
  await writeFile(store, JSON.stringify({downloadFolder: 'relative'}));
  assert.deepEqual(loadDownloadFolder(store, downloads), fallback);
  assert.throws(() => saveDownloadFolder(store, path.join(dir, 'nope')), /safely owned/);
}));

test('settings: save is atomic and leaves no temp debris', () => withTemp(async (dir) => {
  const store = path.join(dir, 'userData', 'clipdock-settings.json');
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  prepareCustomDownloadFolder(chosen);
  saveDownloadFolder(store, chosen);
  assert.deepEqual(await readdir(path.dirname(store)), ['clipdock-settings.json']);
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')), {downloadFolder: chosen});
}));

test('settings: failed atomic rename cleans its temporary file', () => withTemp(async (dir) => {
  const parent = path.join(dir, 'userData');
  const store = path.join(parent, 'clipdock-settings.json');
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  prepareCustomDownloadFolder(chosen);
  await mkdir(store, {recursive: true}); // rename(file, existing directory) must fail.
  assert.throws(() => saveDownloadFolder(store, chosen));
  assert.deepEqual(await readdir(parent), ['clipdock-settings.json']);
}));

test('settings: parent directories are created on save', () => withTemp(async (dir) => {
  const store = path.join(dir, 'deep', 'nested', 'userData', 'clipdock-settings.json');
  const chosen = await mkdtemp(path.join(dir, 'chosen-'));
  prepareCustomDownloadFolder(chosen);
  saveDownloadFolder(store, chosen);
  assert.equal((await readdir(path.dirname(store))).includes('clipdock-settings.json'), true);
}));
