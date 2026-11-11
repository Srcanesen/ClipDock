import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyDockIcon } from '../dist/main-process.js';
import * as mainProcess from '../dist/main-process.js';
import { mainFixture } from './helpers/files-main.mjs';

test('Dock icon passes the exact path to setIcon', () => {
  const calls = [];
  const iconPath = '/Library/Application Support/ClipDock/icons/dock-icon.png';
  applyDockIcon({ setIcon: (image) => calls.push(image) }, iconPath);
  assert.deepEqual(calls, [iconPath]);
});

test('Dock icon is a no-op without app.dock on Windows and Linux', () => {
  assert.doesNotThrow(() => {
    assert.equal(applyDockIcon(undefined, '/unused/icons/dock-icon.png'), undefined);
  });
});

test('built Dock icon is a 1024 by 1024 PNG', () => {
  const png = readFileSync(new URL('../dist/icons/dock-icon.png', import.meta.url));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(8), 13);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
});

test('main resolves the Dock icon next to a relocated installed entry point before startup', async (t) => {
  const installed = path.join('/tmp', 'ClipDock installed location');
  const calls = [];
  const source = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');
  const fixture = await mainFixture(t, {
    mainSource: `__dirname = ${JSON.stringify(installed)};\n${source}`,
    mainProcess: {
      ...mainProcess,
      applyDockIcon: (dock, iconPath) => { calls.push(['icon', dock, iconPath]); applyDockIcon(dock, iconPath); },
      runStartupSequence: (sequence) => { calls.push(['startup']); mainProcess.runStartupSequence(sequence); },
    },
  });
  assert.deepEqual(calls, [['icon', undefined, path.join(installed, 'icons', 'dock-icon.png')], ['startup']]);
  assert.equal(fixture.windows.length, 1);
});

test('a second instance exits before applying the Dock icon', async (t) => {
  const calls = [];
  const fixture = await mainFixture(t, {
    lock: false,
    mainProcess: { ...mainProcess, applyDockIcon: (...args) => calls.push(args) },
  });
  assert.deepEqual(calls, []);
  assert.equal(fixture.lifecycle.completedQuits, 1);
  assert.equal(fixture.windows.length, 0);
});
