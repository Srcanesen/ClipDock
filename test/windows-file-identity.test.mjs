import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tryAcquireFileLock } from '../dist/file-lock.js';
import { ManagedRoot } from '../dist/managed-root.js';
import { AnchoredDir, appendOwned, writeExclusive, writeOwned } from '../dist/safe-fs.js';

const windows = { skip: process.platform !== 'win32' };

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-volume-id-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { lstatSync, fstatSync } = fs;
  // Values measured on the same NTFS file with Resolve's bundled Node.
  const pathDevice = -572273382278554242n;
  let descriptorDevice = 249568638n;
  let birthOffset = 0n;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = lstatSync(file, options);
    if (stat) stat.dev = options?.bigint ? pathDevice : Number(pathDevice);
    return stat;
  });
  t.mock.method(fs, 'fstatSync', (fd, options) => {
    const stat = fstatSync(fd, options);
    stat.dev = options?.bigint ? descriptorDevice : Number(descriptorDevice);
    if (options?.bigint) stat.birthtimeNs += birthOffset;
    return stat;
  });
  return {
    root,
    changeDescriptorDevice: () => { descriptorDevice += 1n; },
    changeDescriptorBirth: () => { birthOffset += 1n; },
  };
}

test('the download folder admits owned writes when Windows reports two widths of the same volume ID', windows, t => {
  const { root, changeDescriptorBirth } = workspace(t);
  const managed = ManagedRoot.prepare(root);
  const youtube = managed.providerPath('youtube');
  assert.deepEqual(fs.readdirSync(youtube), []);
  const file = writeExclusive(AnchoredDir.capture(youtube, managed), 'clipdock.log', 'first\n');
  appendOwned(file, 'second\n', 64);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'first\nsecond\n');
  changeDescriptorBirth();
  assert.throws(() => writeOwned(file, 'foreign descriptor'), /File safety check failed: replaced/);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'first\nsecond\n');
});

test('a Windows descriptor from a different volume still fails the download folder probe', windows, t => {
  const { root, changeDescriptorDevice } = workspace(t);
  changeDescriptorDevice();
  assert.throws(() => ManagedRoot.prepare(root), /File safety check failed: replaced/);
});

test('workspace can restore a captured Windows identity with a signed volume ID', windows, t => {
  const { root } = workspace(t);
  const captured = ManagedRoot.capture(root);
  assert.equal(ManagedRoot.restore(JSON.parse(JSON.stringify(captured.snapshot()))).verify(), root);
});

test('a Windows history lock releases and can be acquired again despite the volume ID width mismatch', windows, t => {
  const { root } = workspace(t);
  const pathToLock = path.join(root, 'history.json.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = tryAcquireFileLock(pathToLock);
    assert.ok(lock);
    assert.equal(fs.existsSync(pathToLock), true);
    lock.release();
    assert.equal(fs.existsSync(pathToLock), false);
  }
});
