import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IPC_CHANNELS} from '../dist/shared.js';
import {mainFixture, deferred} from './helpers/files-main.mjs';

// Exercise registered handlers, including descriptor and transfer registrations.
// No source-shape assertions remain: a missing registration or sender gate fails here.
test('all 46 invoke channels reject foreign senders and frames before engine readiness or side effects', async t => {
  const discovery = deferred(), f = await mainFixture(t, {discovery: discovery.promise});
  const notifications = new Set(['resolveQuit', 'nativeDragStart', 'youtubeEvent', 'socialEvent', 'pinterestEvent', 'pexelsEvent', 'youtubePreviewState']);
  const expected = Object.entries(IPC_CHANNELS).filter(([key]) => !notifications.has(key)).map(([, channel]) => channel).sort();
  assert.equal(expected.length, 46);
  assert.equal(f.registrations.length, 46);
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
  assert.equal(f.registrations.length, 46);
  assert.throws(() => f.registerInvoke(IPC_CHANNELS.setAlwaysOnTop, () => 'overwritten'), {
    message: "Attempted to register a second handler for 'clipdock:set-always-on-top'",
  });
  assert.equal(f.registrations.length, 46);
  assert.equal(await f.invoke('setAlwaysOnTop', true), true);
});
