import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { reconcileDirectoryContents, recoverInterruptedTransaction } from '../scripts/lib/install-files.mjs';

const helper = new URL('../scripts/lib/install-files.mjs', import.meta.url).href;
function fixture(t, installed = true) {
  fs.mkdirSync('output', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('output/testtool-gate-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'installed');
  const lock = path.join(root, '.__clipdock_lock_installed');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.js'), 'new artifact');
  if (installed) {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'main.js'), 'working original');
  }
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import {reconcileDirectoryContents, recoverInterruptedTransaction} from ${JSON.stringify(helper)};
    const source = ${JSON.stringify(source)}, destination = ${JSON.stringify(destination)}, lock = ${JSON.stringify(lock)};
    ${code}
  `], { encoding: 'utf8', timeout: 5000 });
  return { root, source, destination, lock, run };
}

const crashBeforeMkdir = `reconcileDirectoryContents(source, destination, {...fs,
  writeFileSync(file, data, options) {
    fs.writeFileSync(file, data, options);
    if (file === lock) process.exit(73);
  },
});`;
const crashAfterCleanup = `reconcileDirectoryContents(source, destination, {...fs,
  rmSync(file, options) {
    const work = JSON.parse(fs.readFileSync(lock, 'utf8')).workDir;
    fs.rmSync(file, options);
    if (file === work) process.exit(74);
  },
});`;

for (const installed of [true, false]) {
  for (const boundary of ['before mkdir', 'after cleanup']) {
    test(`dead journal with absent work directory recovers ${boundary} (installed=${installed})`, t => {
      const fx = fixture(t, installed);
      const child = fx.run(boundary === 'before mkdir' ? crashBeforeMkdir : crashAfterCleanup);
      assert.equal(child.status, boundary === 'before mkdir' ? 73 : 74, child.stderr);
      const journal = JSON.parse(fs.readFileSync(fx.lock, 'utf8'));
      assert.equal(fs.existsSync(journal.workDir), false);
      const expected = boundary === 'after cleanup' ? 'new artifact' : installed ? 'working original' : null;
      recoverInterruptedTransaction(fx.destination);
      recoverInterruptedTransaction(fx.destination);
      assert.equal(fs.existsSync(fx.destination), expected !== null);
      if (expected !== null) assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), expected);
      assert.deepEqual(fs.readdirSync(fx.root).sort(), expected === null ? ['source'] : ['installed', 'source']);
      reconcileDirectoryContents(fx.source, fx.destination);
      assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), 'new artifact');
      assert.deepEqual(fs.readdirSync(fx.root).sort(), ['installed', 'source']);
    });
  }
}

test('retry finishes a recovery interrupted after work directory removal', t => {
  const fx = fixture(t);
  const installer = fx.run(`reconcileDirectoryContents(source, destination, {...fs,
    renameSync(from, to) { fs.renameSync(from, to); if (from === destination) process.exit(75); },
  });`);
  assert.equal(installer.status, 75, installer.stderr);
  assert.equal(fs.existsSync(fx.destination), false);
  const recovery = fx.run(`recoverInterruptedTransaction(destination, {...fs,
    rmSync(file, options) {
      const work = JSON.parse(fs.readFileSync(lock, 'utf8')).workDir;
      fs.rmSync(file, options);
      if (file === work) process.exit(76);
    },
  });`);
  assert.equal(recovery.status, 76, recovery.stderr);
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(fx.lock, 'utf8')).workDir), false);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), 'working original');
  recoverInterruptedTransaction(fx.destination);
  recoverInterruptedTransaction(fx.destination);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['installed', 'source']);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), 'working original');
  reconcileDirectoryContents(fx.source, fx.destination);
  assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), 'new artifact');
});

for (const kind of ['symlink', 'dangling symlink', 'file']) {
  test(`missing-work recovery keeps refusing a ${kind} work root`, t => {
    const fx = fixture(t);
    const child = fx.run(crashBeforeMkdir);
    assert.equal(child.status, 73, child.stderr);
    const journal = fs.readFileSync(fx.lock, 'utf8');
    const work = JSON.parse(journal).workDir;
    const target = path.join(fx.root, 'target');
    if (kind === 'file') fs.writeFileSync(work, 'keep work file');
    else {
      if (kind === 'symlink') {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'keep.txt'), 'keep linked content');
      }
      fs.symlinkSync(target, work);
    }
    assert.throws(() => recoverInterruptedTransaction(fx.destination), /real directory/);
    assert.equal(fs.readFileSync(fx.lock, 'utf8'), journal);
    assert.equal(fs.readFileSync(path.join(fx.destination, 'main.js'), 'utf8'), 'working original');
    if (kind === 'file') assert.equal(fs.readFileSync(work, 'utf8'), 'keep work file');
    else assert.equal(fs.lstatSync(work).isSymbolicLink(), true);
    if (kind === 'symlink') assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep linked content');
  });
}
