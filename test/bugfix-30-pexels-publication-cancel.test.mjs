import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from '../dist/safe-fs.js';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';

for (const boundary of ['final progress', 'publication']) {
  test(`accepted Pexels IPC cancellation at ${boundary} removes the unpublished download`, async t => {
    let renaming, release, cancellation, f;
    const reachedRename = new Promise(resolve => {renaming = resolve;});
    const publish = new Promise(resolve => {release = resolve;});
    if (boundary === 'publication') {
      const publishNoReplace = fs.publishNoReplace;
      t.mock.method(fs, 'publishNoReplace', (...args) => {const result = publishNoReplace(...args); renaming(); return result;});
    }
    f = await providerIpcFixture(t, 'pexels', {onEvent(channel, event) {
      if (boundary === 'final progress' && channel === 'clipdock:pexels-event' && event.percent === 100) cancellation = f.cancel('job');
    }});
    let pending;
    try {
      pending = f.start().then(() => 'completed', error => error.message);
      if (boundary === 'publication') {await reachedRename; cancellation = f.cancel('job'); release();}
      assert.equal(await pending, 'Download cancelled.');
      assert.equal(await cancellation, true, 'preload returns the same boolean as c3b9fe0');
      assert.deepEqual(f.events(), [
        {state: 'downloading', message: 'Downloading from Pexels…', percent: 0},
        {state: 'downloading', message: 'Downloading from Pexels…', percent: 99.9},
        {state: 'downloading', message: 'Downloading from Pexels…', percent: 100},
        {state: 'cancelled', message: 'Download cancelled.', percent: null},
      ]);
      assert.deepEqual(readdirSync(join(f.root, 'pexels')), []);
      assert.equal(await f.cancel('job'), false);
    } finally {release(); await f.stop(); await pending;}
  });
}
