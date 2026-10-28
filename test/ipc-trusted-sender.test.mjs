import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IPC_CHANNELS} from '../dist/shared.js';
import {mainFixture, deferred} from './helpers/files-main.mjs';

// Exercise registered handlers, including descriptor and transfer registrations.
// No source-shape assertions remain: a missing registration or sender gate fails here.
test('all 58 invoke channels reject foreign senders and frames before engine readiness or side effects', async t => {
  const discovery = deferred(), f = await mainFixture(t, {discovery: discovery.promise});
  const notifications = new Set(['resolveQuit', 'nativeDragStart', 'youtubeEvent', 'socialEvent', 'pinterestEvent', 'pexelsEvent', 'pixabayEvent', 'youtubePreviewState', 'youtubeSearchPage']);
  const expected = Object.entries(IPC_CHANNELS).filter(([key]) => !notifications.has(key)).map(([, channel]) => channel).sort();
  assert.equal(expected.length, 58);
  assert.equal(f.registrations.length, 58);
  assert.deepEqual([...f.registrations].sort(), expected);
  assert.deepEqual([...f.handlers.keys()].sort(), expected);
  const foreignEvents = [
    {sender: {}, senderFrame: f.event.senderFrame},
    {sender: f.event.sender, senderFrame: {url: f.event.senderFrame.url}},
    {sender: f.event.sender, senderFrame: null},
  ];
  for (const channel of expected) for (const event of foreignEvents) {
    await assert.rejects(async () => f.invokeEvent(channel, event, 'untrusted'), {message: 'Invalid ClipDock sender.'}, channel);
  }
  const originalUrl = f.event.senderFrame.url;
  f.event.senderFrame.url = 'https://example.com/';
  for (const channel of expected) await assert.rejects(async () => f.invokeEvent(channel, f.event), {message: 'Invalid ClipDock sender.'}, channel);
  f.event.senderFrame.url = originalUrl;
  assert.equal(f.workers.length, 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.lifecycle.quitRequests, 0);
  discovery.resolve({ffmpegPath: null, ffprobePath: null, ytdlpPath: null, galleryDlPath: null, jsRuntime: null});
  assert.equal(await f.invoke('setAlwaysOnTop', true), true);
});


test('IPC fixture refuses duplicate registrations without replacing the registered handler', async t => {
  const f = await mainFixture(t);
  assert.equal(f.registrations.length, 58);
  assert.throws(() => f.registerInvoke(IPC_CHANNELS.setAlwaysOnTop, () => 'overwritten'), {
    message: "Attempted to register a second handler for 'clipdock:set-always-on-top'",
  });
  assert.equal(f.registrations.length, 58);
  assert.equal(await f.invoke('setAlwaysOnTop', true), true);
});

test('trusted YouTube search forwards only validated generations on the narrow page event channel', async t => {
  const f = await mainFixture(t);
  const worker = f.workers.find(worker => worker.initialRoot.endsWith('youtube-search'));
  const snapshot = {query: 'shots', page: 1, pageSize: 10, results: [], totalResults: null, pageCount: null, hasPrevious: false, hasNext: false};
  const final = {...snapshot, totalResults: 30, pageCount: 3, hasNext: true};
  let searches = 0; const cancels = [];
  worker.search = async (query, page, emit) => { searches++; assert.deepEqual([query, page], ['shots', 1]); emit(snapshot); return final; };
  worker.cancel = id => { cancels.push(id); return null; };
  assert.deepEqual(await f.invoke('searchYoutube', 'shots', 1, 7), final);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [{channel: 'clipdock:youtube-search-page', update: {generation: 7, page: snapshot}}]);
  for (const generation of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.invoke('searchYoutube', 'shots', 1, generation), {message: 'Invalid search request.'});
  }
  assert.equal(searches, 1);
  assert.equal(await f.invoke('cancelYoutubeSearch'), false);
  assert.deepEqual(cancels, ['youtube-search', 'youtube-search']);
});
