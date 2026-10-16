import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { reconcileDirectoryContents } from '../scripts/lib/install-files.mjs';

const moduleUrl = pathToFileURL(path.resolve('scripts/lib/install-files.mjs')).href;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-txn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const dest = path.join(root, 'plugin');
  fs.mkdirSync(source); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(source, 'main.js'), 'NEW'); fs.writeFileSync(path.join(dest, 'main.js'), 'OLD');
  return { root, source, dest };
}
function worker(fx, body) {
  return `import fs from 'node:fs'; import { reconcileDirectoryContents } from ${JSON.stringify(moduleUrl)};
const source = ${JSON.stringify(fx.source)}; const dest = ${JSON.stringify(fx.dest)};
${body}`;
}
function run(fx, body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', worker(fx, body)], { encoding: 'utf8' });
}

test('a competing transaction is refused before it can report success (TLG-5)', async (t) => {
  const fx = fixture(t);
  const marker = path.join(fx.root, 'resume');
  const script = worker(fx, `reconcileDirectoryContents(source, dest, {...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    if (from === dest) { process.stdout.write('READY\\n'); while (!fs.existsSync(${JSON.stringify(marker)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  }});`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  const exit = new Promise((resolve, reject) => { child.once('exit', (code) => resolve(code)); child.once('error', reject); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transaction readiness timeout')), 5000);
    child.stdout.once('data', (data) => { clearTimeout(timer); assert.equal(data.toString(), 'READY\n'); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const competing = run(fx, 'reconcileDirectoryContents(source, dest);');
  assert.equal(competing.status, 1);
  assert.match(competing.stderr, /INSTALL_BUSY|transaction is active/);
  fs.writeFileSync(marker, 'resume');
  assert.equal(await exit, 0);
  assert.equal(fs.readFileSync(path.join(fx.dest, 'main.js'), 'utf8'), 'NEW');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['plugin', 'resume', 'source']);
});

for (const boundary of [0, 1, 2]) {
  test(`retry recovers process interruption at rename boundary ${boundary} (TLG-6)`, (t) => {
    const fx = fixture(t);
    const crashed = run(fx, `let count = 0; reconcileDirectoryContents(source, dest, {...fs,
      cpSync(from, to, options) { fs.cpSync(from, to, options); if (${boundary} === 0) process.exit(73); },
      renameSync(from, to) { fs.renameSync(from, to); if (++count === ${boundary}) process.exit(73); }
    });`);
    assert.equal(crashed.status, 73, crashed.stderr);
    // The retry first reconciles the old transaction. A failed new stage must
    // still leave a complete old or already committed plugin at the target.
    assert.throws(() => reconcileDirectoryContents(fx.source, fx.dest, {...fs, cpSync() { throw new Error('new stage failed'); }}), /new stage failed/);
    assert.equal(fs.readFileSync(path.join(fx.dest, 'main.js'), 'utf8'), boundary === 2 ? 'NEW' : 'OLD');
    reconcileDirectoryContents(fx.source, fx.dest);
    reconcileDirectoryContents(fx.source, fx.dest);
    assert.equal(fs.readFileSync(path.join(fx.dest, 'main.js'), 'utf8'), 'NEW');
    assert.deepEqual(fs.readdirSync(fx.root).sort(), ['plugin', 'source']);
  });
}

test('native copy/validation failure during staging keeps the old plugin (TLG-1)', (t) => {
  const fx = fixture(t);
  assert.throws(() => reconcileDirectoryContents(fx.source, fx.dest, undefined, (stage) => {
    fs.copyFileSync(path.join(fx.root, 'missing-native'), path.join(stage, 'WorkflowIntegration.node'));
  }), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(fx.dest, 'main.js'), 'utf8'), 'OLD');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['plugin', 'source']);
});

test('installer recovers the prior plugin even if new native input is unavailable (TLG-6)', async (t) => {
  const fx = fixture(t);
  const crashed = run(fx, `reconcileDirectoryContents(source, dest, {...fs, renameSync(from, to) { fs.renameSync(from, to); if (from === dest) process.exit(73); }});`);
  assert.equal(crashed.status, 73);
  assert.equal(fs.existsSync(fx.dest), false);
  const { recoverInterruptedTransaction } = await import('../scripts/lib/install-files.mjs');
  recoverInterruptedTransaction(fx.dest);
  assert.equal(fs.readFileSync(path.join(fx.dest, 'main.js'), 'utf8'), 'OLD');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['plugin', 'source']);
});
