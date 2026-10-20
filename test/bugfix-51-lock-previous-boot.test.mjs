// A lock written before the current boot cannot have a live owner, even when the OS has
// since given its PID to an unrelated process; liveness must not rest on kill(pid, 0) alone.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {tryAcquireFileLock} from '../dist/file-lock.js';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-boot-lock-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  // Stand-in for the crashed owner's reused PID: a live process that never touched the lock.
  const unrelated = spawn('/bin/sleep', ['30'], {stdio: 'ignore'});
  t.after(() => unrelated.kill('SIGKILL'));
  return {lock: path.join(dir, 'history.json.lock'), pid: unrelated.pid};
}

test('a lock from before this boot is recovered although its PID is alive again', t => {
  const {lock, pid} = fixture(t);
  const bootedAt = Date.now() - os.uptime() * 1000;
  fs.writeFileSync(lock, JSON.stringify({pid, token: 'crashed-writer', createdAt: bootedAt - 3_600_000}));
  const acquired = tryAcquireFileLock(lock);
  assert.ok(acquired, 'previous-boot lock must be recoverable');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  acquired.release();
});

test('a lock from this boot whose PID is alive stays owned', t => {
  const {lock, pid} = fixture(t);
  const owner = JSON.stringify({pid, token: 'live-owner', createdAt: Date.now()});
  fs.writeFileSync(lock, owner);
  assert.equal(tryAcquireFileLock(lock), null);
  assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});
