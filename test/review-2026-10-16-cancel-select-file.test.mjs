import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {mainFixture, deferred} from './helpers/files-main.mjs';
import {tick} from './helpers/provider-ipc.mjs';
import * as workspace from '../dist/workspace.js';

test('selectFile rejects during cleanup before opening a dialog or publishing a card', async t => {
  const entered = deferred(), release = deferred();
  const f = await mainFixture(t, {modules: {'./workspace': {...workspace,
    async cleanupWorkspaceAsync(root, protectedPaths) {
      entered.resolve(); await release.promise;
      return workspace.cleanupWorkspaceAsync(root, protectedPaths);
    },
  }}});
  const file = path.join(f.root, 'youtube', 'old.mp4'); fs.writeFileSync(file, 'media');
  let dialogs = 0;
  f.controls.dialog = async () => { dialogs++; return {canceled: false, filePaths: [file]}; };
  const cleanup = f.invoke('cleanupWorkspace'); await entered.promise;
  try {
    await assert.rejects(f.invoke('selectFile'), {message: 'Wait for the download folder operation to finish.'});
    assert.equal(dialogs, 0);
  } finally { release.resolve(); await cleanup; f.quit(); await tick(); }
});

test('selectFile holds cleanup exclusion from dialog admission through card publication', async t => {
  const f = await mainFixture(t), entered = deferred(), release = deferred();
  const file = path.join(f.root, 'youtube', 'selected.mp4'); fs.writeFileSync(file, 'media');
  f.controls.dialog = async () => { entered.resolve(); return release.promise; };
  const selection = f.invoke('selectFile'); await entered.promise;
  try {
    await assert.rejects(f.invoke('cleanupWorkspace'), {message: 'Wait for active downloads or media preparation to finish.'});
  } finally { release.resolve({canceled: false, filePaths: [file]}); }
  const card = await selection;
  assert.equal(card.canceled, false);
  const cleaned = await f.invoke('cleanupWorkspace');
  assert.equal(cleaned.deletedFileCount, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'media');
  assert.equal((await f.invoke('importToMediaPool', card.cardId, 'active')).kind, 'imported');
  f.quit(); await tick();
});

test('selectFile rejects while a folder-change dialog is pending', async t => {
  const f = await mainFixture(t), entered = deferred(), release = deferred();
  let dialogs = 0;
  f.controls.dialog = async () => {
    dialogs++;
    if (dialogs > 1) return {canceled: true, filePaths: []};
    entered.resolve(); return release.promise;
  };
  const folderChange = f.invoke('chooseDownloadFolder'); await entered.promise;
  try {
    await assert.rejects(f.invoke('selectFile'), {message: 'Wait for the download folder operation to finish.'});
    assert.equal(dialogs, 1);
  } finally {
    release.resolve({canceled: true, filePaths: []}); await folderChange;
    f.quit(); await tick();
  }
});
