import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { recoverInterruptedTransaction, reconcileDirectoryContents } from '../scripts/lib/install-files.mjs';

const helper = new URL('../scripts/lib/install-files.mjs', import.meta.url).href;
const interruptRecovery = `recoverInterruptedTransaction(destination, {...fs, linkSync(from, to) { fs.linkSync(from, to); fs.rmSync(from); if (to.includes('.recovery')) process.exit(74); }});`;
function fixture(t) {
  fs.mkdirSync('output', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('output/testtool-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'installed');
  fs.mkdirSync(source); fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'new.js'), 'new');
  fs.writeFileSync(path.join(destination, 'old.js'), 'working original');
  const lock = path.join(root, '.__clipdock_lock_installed');
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; import {reconcileDirectoryContents, recoverInterruptedTransaction} from ${JSON.stringify(helper)}; const source=${JSON.stringify(source)}, destination=${JSON.stringify(destination)}; ${code}`], { encoding: 'utf8', timeout: process.platform === 'win32' ? 15000 : 5000 });
  const crashed = run(`reconcileDirectoryContents(source, destination, {...fs, renameSync(from, to) { fs.renameSync(from, to); if (from === destination) process.exit(73); }});`);
  assert.equal(crashed.status, 73, crashed.stderr);
  assert.equal(fs.existsSync(destination), false);
  return { root, source, destination, lock, run };
}

test('retry restores original after recovery itself is interrupted, and remains repeatable', t => {
  const fx = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const crashed = fx.run(interruptRecovery);
    assert.equal(crashed.status, 74, crashed.stderr);
    assert.equal(fs.existsSync(fx.destination), false);
  }
  recoverInterruptedTransaction(fx.destination);
  recoverInterruptedTransaction(fx.destination);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'old.js'), 'utf8'), 'working original');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['installed', 'source']);
  reconcileDirectoryContents(fx.source, fx.destination);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'new.js'), 'utf8'), 'new');
});

test('recovery refuses a live recovery owner and preserves the journal and backup', t => {
  const fx = fixture(t);
  const journal = fs.readFileSync(fx.lock, 'utf8');
  // Legacy locks also remain safe during an upgrade of the installer.
  fs.writeFileSync(`${fx.lock}.recovery`, String(process.pid));
  assert.throws(() => recoverInterruptedTransaction(fx.destination), { code: 'INSTALL_BUSY' });
  assert.equal(fs.readFileSync(fx.lock, 'utf8'), journal);
  assert.equal(fs.readFileSync(path.join(JSON.parse(journal).workDir, 'backup/old.js'), 'utf8'), 'working original');
});

test('a competing recovery cannot pass an active successor claim', t => {
  const fx = fixture(t);
  const crashed = fx.run(interruptRecovery);
  assert.equal(crashed.status, 74, crashed.stderr);
  let competed = false;
  recoverInterruptedTransaction(fx.destination, { ...fs, linkSync(from, to) {
    fs.linkSync(from, to);
    if (to.includes('.recovery')) {
      competed = true;
      assert.throws(() => recoverInterruptedTransaction(fx.destination), { code: 'INSTALL_BUSY' });
      assert.equal(fs.existsSync(fx.destination), false);
    }
  } });
  assert.equal(competed, true);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'old.js'), 'utf8'), 'working original');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['installed', 'source']);
});

test('Windows recovery reclaims the journal and recovery claim when their PIDs have been reused', { skip: process.platform !== 'win32' }, t => {
  const fx = fixture(t);
  const crashed = fx.run(interruptRecovery);
  assert.equal(crashed.status, 74, crashed.stderr);
  for (const file of [fx.lock, `${fx.lock}.recovery`]) {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...owner, pid: process.pid }));
  }
  const recovered = fx.run('recoverInterruptedTransaction(destination);');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'old.js'), 'utf8'), 'working original');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['installed', 'source']);
});
