// Volumes without hard links (exFAT reports ENOTSUP or EPERM from link) must publish in
// constant filesystem checks, never replace a target, and stay inside the managed root.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ManagedRoot} from '../dist/managed-root.js';
import {AnchoredDir, SafeFsError, createDirectory, createPrivateDir, openExclusive, publishNoReplace, verifyFile} from '../dist/safe-fs.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'safefs-nolink-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = ManagedRoot.capture(base);
  return {base, dir: AnchoredDir.capture(base, root)};
}
const code = wanted => error => error instanceof SafeFsError && error.code === wanted;
function write(dir, name, value) {
  const opened = openExclusive(dir, name);
  try { fs.writeSync(opened.fd, value); } finally { fs.closeSync(opened.fd); }
  return opened.file;
}
const noLinks = (t, errno) => t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('link unsupported'), {code: errno}); });
/** Publish while counting lstat calls, the unit of every path verification. */
function publishCounted(t, source, dir, name) {
  const lstat = t.mock.method(fs, 'lstatSync');
  try { return [publishNoReplace(source, dir, name), lstat.mock.callCount()]; } finally { lstat.mock.restore(); }
}
const large = Buffer.alloc(8 * 1024 * 1024, 'clipdock media ');

for (const errno of ['ENOTSUP', 'EPERM']) {
  test(`publication without hard links moves the source in constant checks (${errno})`, t => {
    const {dir} = fixture(t), priv = createPrivateDir(dir, '.private-'), source = write(priv, 'source', large);
    const ino = fs.statSync(source.path).ino;
    noLinks(t, errno);
    const [final, checks] = publishCounted(t, source, dir, 'final.mp4');
    assert.equal(final.path, dir.child('final.mp4'));
    assert.ok(fs.readFileSync(verifyFile(final)).equals(large));
    assert.equal(fs.statSync(final.path).ino, ino);
    assert.deepEqual(fs.readdirSync(priv.verify()), []);
    assert.ok(checks <= 256, `lstat calls: ${checks}`);
  });
}

test('cross-volume publication copies literal bytes with checks independent of size', t => {
  const {dir} = fixture(t), priv = createPrivateDir(dir, '.private-');
  const small = write(priv, 'small', 'literal publication'), big = write(priv, 'big', large);
  noLinks(t, 'EXDEV');
  const [first, smallChecks] = publishCounted(t, small, dir, 'small.mp4');
  const [second, bigChecks] = publishCounted(t, big, dir, 'big.mp4');
  assert.equal(fs.readFileSync(verifyFile(first), 'utf8'), 'literal publication');
  assert.ok(fs.readFileSync(verifyFile(second)).equals(large));
  assert.deepEqual(fs.readdirSync(priv.verify()), []);
  assert.equal(bigChecks, smallChecks);
  assert.ok(bigChecks <= 256, `lstat calls: ${bigChecks}`);
});

test('publication without hard links never replaces an existing, symlinked or outside target', t => {
  const {base, dir} = fixture(t), priv = createPrivateDir(dir, '.private-'), source = write(priv, 'source', 'literal source');
  noLinks(t, 'ENOTSUP');
  write(dir, 'existing.mp4', 'precious');
  assert.throws(() => publishNoReplace(source, dir, 'existing.mp4'), code('exists'));
  assert.equal(fs.readFileSync(dir.child('existing.mp4'), 'utf8'), 'precious');
  const outside = path.join(base, 'outside.mp4'); fs.symlinkSync(outside, dir.child('link.mp4'));
  assert.throws(() => publishNoReplace(source, dir, 'link.mp4'), code('exists'));
  assert.equal(fs.existsSync(outside), false);
  assert.throws(() => publishNoReplace(source, dir, '../escape.mp4'), code('outside'));
  assert.equal(fs.existsSync(path.join(path.dirname(base), 'escape.mp4')), false);
  const dest = createDirectory(dir, 'dest'), elsewhere = path.join(base, 'elsewhere');
  fs.renameSync(dest.verify(), path.join(base, 'moved')); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(base, 'dest'));
  assert.throws(() => publishNoReplace(source, dest, 'final.mp4'), code('symlink'));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'literal source');
});

test('a reserved name taken over before the move keeps both the new file and the source', t => {
  const {dir} = fixture(t), priv = createPrivateDir(dir, '.private-'), source = write(priv, 'source', 'literal source');
  const target = dir.child('final.mp4'), close = fs.closeSync;
  noLinks(t, 'ENOTSUP');
  let armed = true;
  t.mock.method(fs, 'closeSync', function (fd) {
    if (armed) { armed = false; fs.unlinkSync(target); fs.writeFileSync(target, 'precious'); }
    return close.call(this, fd);
  });
  assert.throws(() => publishNoReplace(source, dir, 'final.mp4'), code('replaced'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'literal source');
});
