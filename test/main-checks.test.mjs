import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { IPC_CHANNELS } from '../scripts/lib/contracts.mjs';
import { mainFixture } from './helpers/files-main.mjs';

const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

test('pin IPC validates its boolean and returns the window state after applying it', async (t) => {
  const fixture = await mainFixture(t);
  const calls = []; let pinned = false;
  fixture.windows[0].setAlwaysOnTop = (value) => { calls.push(value); pinned = value; };
  fixture.windows[0].isAlwaysOnTop = () => pinned;
  await assert.rejects(fixture.invoke('setAlwaysOnTop', 'true'), /Invalid pin request/);
  assert.deepEqual(calls, []);
  assert.equal(await fixture.invoke('setAlwaysOnTop', true), true);
  assert.equal(await fixture.invoke('setAlwaysOnTop', false), false);
  assert.deepEqual(calls, [true, false]);
});

// Run the complete built entry point. Only native/Electron, engine discovery and
// credential persistence are substituted; session state uses the real client.
async function credentialMainFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-main-credential-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = 'test_key_12345678901234567890';
  const credentialFile = path.join(dir, 'saved-credential'); fs.writeFileSync(credentialFile, key);
  const handlers = new Map(), windows = [], calls = [];
  let failRemoval = true;
  class Credentials {
    async load() { return { key: fs.readFileSync(credentialFile, 'utf8'), message: 'Connected' }; }
    async clear() { calls.push('remove-saved'); if (failRemoval) throw new Error('fixture removal failure'); fs.unlinkSync(credentialFile); }
  }
  class Worker {
    setSessionDir() {} isActive() { return false; } dispose() {}
  }
  const electron = {
    app: { getPath: (name) => path.join(dir, name), whenReady: () => Promise.resolve(), on() {}, requestSingleInstanceLock: () => true },
    BrowserWindow: class {
      constructor() { this.webContents = { mainFrame: { url: pathToFileURL(path.join(dist, 'index.html')).href }, on() {}, setWindowOpenHandler() {} }; windows.push(this); }
      setMinimumSize() {} setMenuBarVisibility() {} on() {} loadFile() {}
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    nativeImage: { createFromDataURL: () => ({}) }, safeStorage: {},
  };
  const mocks = {
    electron,
    'node:os': { ...os, tmpdir: () => dir },
    './WorkflowIntegration.node': {},
    './ytdlp': { YtdlpWorker: Worker }, './gallerydl': { GalleryDlWorker: Worker },
    './media-prep': { createMediaPrep: () => new Worker() },
    './pexels-credential': { ...require(path.join(dist, 'pexels-credential.js')), MacKeychainPexelsCredentialStore: Credentials, PexelsCredentialStore: Credentials },
    './main-process': { ...require(path.join(dist, 'main-process.js')), discoverEnginePaths: async () => ({ ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null }) },
  };
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(dist, 'main.js'), 'utf8'), {
    module, exports: module.exports, require: (id) => mocks[id] ?? require(id.startsWith('.') ? path.resolve(dist, id) : id),
    __dirname: dist, __filename: path.join(dist, 'main.js'), process, URL, console, setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  return {
    calls, credentialFile, key,
    allowRemoval: () => { failRemoval = false; },
    invoke: (channel) => handlers.get(IPC_CHANNELS[channel])(event),
  };
}

test('Pexels disconnect preserves the connected session and saved credential when removal fails', async (t) => {
  const f = await credentialMainFixture(t);
  const connected = { connected: true, persisted: true, message: 'Connected' };
  assert.deepEqual(await f.invoke('pexelsKeyStatus'), connected);
  await assert.rejects(f.invoke('clearPexelsKey'), /^Error: Could not disconnect Pexels because the saved credential was not removed\.$/);
  assert.deepEqual(f.calls, ['remove-saved']);
  assert.deepEqual(await f.invoke('pexelsKeyStatus'), connected);
  assert.equal(fs.readFileSync(f.credentialFile, 'utf8'), f.key);
  f.allowRemoval();
  assert.deepEqual(await f.invoke('clearPexelsKey'), { connected: false, persisted: false, message: 'Disconnected.' });
  assert.deepEqual(f.calls, ['remove-saved', 'remove-saved']);
  assert.equal(fs.existsSync(f.credentialFile), false);
});
