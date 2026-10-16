import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('Escape from an old native preview cannot close its replacement', async () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function registerYoutubePreviewHandlers()');
  const end = source.indexOf('\nasync function restorePexelsCredential', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), views = [], closed = [];
  const context = {
    youtubePreviewView: null, youtubePreviewBounds: null, youtubePreviewGeneration: 0,
    mainWindow: {getContentSize: () => [800, 600], contentView: {addChildView() {}}},
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    IPC_CHANNELS: {openYoutubePreview: 'open', closeYoutubePreview: 'close', setYoutubePreviewBounds: 'bounds'},
    requireClipdockSender() {}, youtubePreviewUrl: () => 'https://www.youtube.com/embed/test', normalizePreviewBounds: () => ({}),
    YOUTUBE_PREVIEW_REFERRER: 'https://www.youtube.com/', applyYoutubePreviewBounds() {},
    closeYoutubePreview(reason) {if (context.youtubePreviewView) closed.push({view: context.youtubePreviewView, reason}); context.youtubePreviewView = null;},
    WebContentsView: class {
      constructor() {
        this.events = {};
        this.webContents = {session: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}}, setWindowOpenHandler() {}, on: (name, fn) => {this.events[name] = fn;}, loadURL: async () => {}};
        views.push(this);
      }
      setBounds() {}
    },
  };
  runInNewContext(ts.transpile(source.slice(start, end)) + '\nregisterYoutubePreviewHandlers();', context);
  assert.equal(await handlers.get('open')({}, 'first', 0, {}), true);
  assert.equal(await handlers.get('open')({}, 'second', 0, {}), true);
  const event = () => ({preventDefault() {}}), input = {type: 'keyDown', key: 'Escape'};
  views[0].events['before-input-event'](event(), input);
  assert.equal(context.youtubePreviewView, views[1]);
  assert.equal(closed.length, 1);
  views[1].events['before-input-event'](event(), input);
  assert.equal(context.youtubePreviewView, null);
  assert.equal(closed.length, 2);
  assert.equal(closed[1].reason, 'escape');
});
