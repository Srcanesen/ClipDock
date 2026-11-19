import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverGalleryDl, GalleryDlWorker } from '../dist/gallerydl.js';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-gallery-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Windows finds a pip --user gallery-dl launcher without PATH', { skip: process.platform !== 'win32' }, t => {
  const root = workspace(t);
  const scripts = path.join(root, 'Python', 'Python313', 'Scripts');
  mkdirSync(scripts, { recursive: true });
  const binary = path.join(scripts, 'gallery-dl.exe');
  writeFileSync(binary, '');
  const env = { APPDATA: root, PATH: '', ProgramFiles: root, CLIPDOCK_GALLERYDL_PATH: path.join(root, 'missing.exe') };
  assert.equal(discoverGalleryDl(env, 'win32', undefined, () => ({ code: 0, text: '1.32.20' })), binary);
});

test('Windows finds gallery-dl installed by Microsoft Store Python without PATH', { skip: process.platform !== 'win32' }, t => {
  const root = workspace(t);
  const scripts = path.join(root, 'Packages', 'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python313', 'Scripts');
  mkdirSync(scripts, { recursive: true });
  const binary = path.join(scripts, 'gallery-dl.exe');
  writeFileSync(binary, '');
  const env = { LOCALAPPDATA: root, PATH: '', ProgramFiles: root };
  assert.equal(discoverGalleryDl(env, 'win32', undefined, () => ({ code: 0, text: '1.32.20' })), binary);
});

test('Pinterest search returns the Windows install command when gallery-dl is missing', async t => {
  const worker = new GalleryDlWorker(null, () => assert.fail('Unexpected spawn'), { platform: 'win32', sessionDir: workspace(t) });
  await assert.rejects(worker.search('mountain landscape', 1), {
    message: 'gallery-dl 1.28.0 or newer was not found. Run py -3 -m pip install --user "gallery-dl>=1.28.0" or set CLIPDOCK_GALLERYDL_PATH to an absolute executable path.',
  });
});
