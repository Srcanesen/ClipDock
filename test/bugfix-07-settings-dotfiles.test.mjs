import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { prepareCustomDownloadFolder, DOWNLOAD_FOLDER_MARKER } from '../dist/settings.js';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('prepareCustomDownloadFolder ignores dotfiles in emptiness checks', () => {
  const root = tempRoot('clipdock-settings-dot-');
  try {
    const chosen = path.join(root, 'chosen');
    mkdirSync(chosen);
    writeFileSync(path.join(chosen, '.DS_Store'), 'finder');
    writeFileSync(path.join(chosen, '.hidden'), 'x');
    // Should not throw despite dotfiles present; should claim folder
    const result = prepareCustomDownloadFolder(chosen);
    assert.equal(result, chosen);
    assert.ok(readdirSync(chosen).includes(DOWNLOAD_FOLDER_MARKER));
    assert.ok(readdirSync(chosen).includes('.DS_Store'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareCustomDownloadFolder still rejects real non-dot files', () => {
  const root = tempRoot('clipdock-settings-dot2-');
  try {
    const chosen = path.join(root, 'chosen');
    mkdirSync(chosen);
    writeFileSync(path.join(chosen, 'real.txt'), 'keep');
    writeFileSync(path.join(chosen, '.DS_Store'), 'dot');
    assert.throws(() => prepareCustomDownloadFolder(chosen), /empty or already owned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preparation observes additions made concurrently with marker creation', () => {
  const require = createRequire(import.meta.url);
  for (const addedName of ['.DS_Store', 'keep.mp4']) {
    const root = tempRoot('clipdock-settings-concurrent-');
    try {
      const module = { exports: {} };
      vm.runInNewContext(readFileSync('dist/settings.js', 'utf8'), {
        module, exports: module.exports,
        require: (id) => id === 'node:fs' ? {
          ...fs,
          writeFileSync(file, ...args) {
            const result = fs.writeFileSync(file, ...args);
            if (path.basename(file) === DOWNLOAD_FOLDER_MARKER) fs.writeFileSync(path.join(root, addedName), 'concurrent data');
            return result;
          },
        } : id.startsWith('.') ? require(path.resolve('dist', id)) : require(id),
      });
      if (addedName.startsWith('.')) {
        assert.equal(module.exports.prepareCustomDownloadFolder(root), root);
        assert.equal(fs.existsSync(path.join(root, DOWNLOAD_FOLDER_MARKER)), true);
      } else {
        assert.throws(() => module.exports.prepareCustomDownloadFolder(root), /changed while ClipDock/);
        assert.equal(fs.existsSync(path.join(root, DOWNLOAD_FOLDER_MARKER)), false);
      }
      assert.equal(fs.readFileSync(path.join(root, addedName), 'utf8'), 'concurrent data');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
