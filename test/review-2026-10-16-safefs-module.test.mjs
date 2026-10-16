import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ManagedRoot} from '../dist/managed-root.js';
import {AnchoredDir, SafeFsError, appendOwned, captureFile, createDirectory, createPrivateDir, ensureDirectory, openExclusive, prepareDirectory, publishNoReplace, removeEmptyDir, removeOwned, removePrivateDir, verifyFile} from '../dist/safe-fs.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'safefs-module-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = ManagedRoot.capture(base), dir = AnchoredDir.capture(base, root);
  return {base, root, dir};
}
const code = wanted => error => error instanceof SafeFsError && error.code === wanted;
function write(dir, name, value = 'owned') {
  const opened = openExclusive(dir, name);
  try { fs.writeSync(opened.fd, value); } finally { fs.closeSync(opened.fd); }
  return opened.file;
}

test('anchored directory captures, verifies and restores every descendant identity', t => {
  const {base, root, dir} = fixture(t);
  const parent = createDirectory(dir, 'parent'), nested = createDirectory(parent, 'nested');
  assert.equal(nested.verify(), path.join(base, 'parent/nested'));
  const snapshot = structuredClone(nested.snapshot());
  assert.equal(typeof snapshot.directories[0].ino, 'bigint');
  assert.equal(AnchoredDir.restore(snapshot, ManagedRoot.restore(structuredClone(root.snapshot()))).verify(), nested.verify());
  fs.renameSync(parent.verify(), path.join(base, 'original')); fs.mkdirSync(path.join(base, 'parent')); fs.mkdirSync(path.join(base, 'parent/nested'));
  assert.throws(() => nested.verify(), code('replaced'));
  assert.throws(() => AnchoredDir.restore(snapshot, root), code('replaced'));
});

test('anchored directory rejects outside paths, malformed snapshots and unsafe child segments', t => {
  const {base, root, dir} = fixture(t);
  assert.throws(() => AnchoredDir.capture(path.dirname(base), root), code('outside'));
  for (const name of ['', '.', '..', '../file', 'a/b', 'a\0b', ...(process.platform === 'win32' ? ['a\\b', 'C:stream'] : [])]) assert.throws(() => dir.child(name), code('outside'));
  assert.equal(dir.child('clip.mp4'), path.join(base, 'clip.mp4'));
  if (process.platform !== 'win32') {
    for (const name of ['literal:colon', 'literal\\backslash']) assert.equal(fs.readFileSync(write(dir, name, 'literal filename').path, 'utf8'), 'literal filename');
  }
  assert.throws(() => AnchoredDir.restore({...dir.snapshot(), directories: []}, root), code('replaced'));
  fs.symlinkSync(base, path.join(base, 'link'));
  assert.throws(() => AnchoredDir.capture(path.join(base, 'link'), root), code('symlink'));
  const file = write(dir, 'file');
  assert.throws(() => AnchoredDir.capture(file.path, root), code('not-directory'));
});

test('anchored directory refuses a replaced managed root', t => {
  const {base, root, dir} = fixture(t);
  const folder = path.join(base, 'managed'); fs.mkdirSync(folder);
  const captured = ManagedRoot.capture(folder), nested = AnchoredDir.capture(folder, captured);
  fs.renameSync(folder, path.join(base, 'original')); fs.mkdirSync(folder);
  assert.throws(() => nested.verify(), code('root-changed'));
  assert.equal(dir.verify(), root.verify());
});

test('owned files require descendant regular files without symlink components', t => {
  const {base, dir} = fixture(t), child = createDirectory(dir, 'nested');
  const original = write(child, 'clip', 'literal media');
  const captured = captureFile(dir, original.path);
  assert.equal(verifyFile(captured), path.join(base, 'nested/clip'));
  assert.equal(fs.readFileSync(verifyFile(captured), 'utf8'), 'literal media');
  assert.throws(() => captureFile(dir, base), code('outside'));
  assert.throws(() => captureFile(dir, child.verify()), code('not-regular'));
  fs.symlinkSync(original.path, dir.child('link'));
  assert.throws(() => captureFile(dir, dir.child('link')), code('symlink'));
  fs.symlinkSync(child.verify(), dir.child('parent-link'));
  assert.throws(() => captureFile(dir, path.join(base, 'parent-link/clip')), code('symlink'));
});

for (const replacement of ['file', 'parent', 'parent symlink']) {
  test(`owned removal preserves a replaced ${replacement}`, t => {
    const {base, dir} = fixture(t), nested = createDirectory(dir, 'nested'), file = write(nested, 'clip');
    if (replacement === 'file') {fs.renameSync(file.path, `${file.path}.original`); fs.writeFileSync(file.path, 'replacement');}
    else {
      fs.renameSync(nested.verify(), path.join(base, 'original'));
      const target = path.join(base, replacement === 'parent' ? 'nested' : 'outside'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'clip'), 'replacement');
      if (replacement === 'parent symlink') fs.symlinkSync(target, path.join(base, 'nested'));
    }
    assert.throws(() => verifyFile(file), code('replaced'));
    assert.equal(removeOwned(file), 'replaced');
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'replacement');
  });
}

test('owned removal distinguishes successful deletion and missing files', t => {
  const {dir} = fixture(t), file = write(dir, 'clip');
  assert.equal(removeOwned(file), 'removed');
  assert.equal(fs.existsSync(file.path), false);
  assert.equal(removeOwned(file), 'missing');
});

test('private directories are exclusive, private and cleaned only with matching identities', t => {
  const {base, dir} = fixture(t), first = createPrivateDir(dir, '.private-'), second = createPrivateDir(dir, '.private-');
  assert.notEqual(first.verify(), second.verify());
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.verify()).mode & 0o777, 0o700);
  write(first, 'partial'); const firstPath = first.verify(); removePrivateDir(first);
  assert.equal(fs.existsSync(firstPath), false);
  const secondPath = second.verify(); fs.renameSync(secondPath, path.join(base, 'moved')); fs.mkdirSync(secondPath); fs.writeFileSync(path.join(secondPath, 'user'), 'keep');
  removePrivateDir(second);
  assert.equal(fs.readFileSync(path.join(secondPath, 'user'), 'utf8'), 'keep');
  assert.equal(ensureDirectory(dir, 'existing').verify(), ensureDirectory(dir, 'existing').verify());
  const empty = createDirectory(dir, 'empty'), emptyPath = empty.verify(); removeEmptyDir(empty);
  assert.equal(fs.existsSync(emptyPath), false);
});

test('exclusive creation preserves existing regular files and dangling symlinks', t => {
  const {base, dir} = fixture(t), file = write(dir, 'clip', 'precious');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
  assert.throws(() => openExclusive(dir, 'clip'), code('exists'));
  const outside = path.join(base, 'absent'); fs.symlinkSync(outside, dir.child('dangling'));
  assert.throws(() => openExclusive(dir, 'dangling'), code('exists'));
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'precious');
});

for (const fallback of [null, 'EXDEV', 'EPERM', 'ENOTSUP']) {
  test(`publication copies literal bytes without replacement (${fallback ?? 'hard link'})`, t => {
    const {dir} = fixture(t), priv = createPrivateDir(dir, '.private-'), source = write(priv, 'source', 'literal publication');
    if (fallback) t.mock.method(fs, 'linkSync', () => {throw Object.assign(new Error('unsupported link'), {code: fallback});});
    const final = publishNoReplace(source, dir, 'final');
    assert.equal(fs.readFileSync(verifyFile(final), 'utf8'), 'literal publication');
    assert.equal(fs.existsSync(source.path), false);
    const next = write(priv, 'next', 'next publication');
    assert.throws(() => publishNoReplace(next, dir, 'final'), code('exists'));
    assert.equal(fs.readFileSync(next.path, 'utf8'), 'next publication');
    assert.equal(fs.readFileSync(final.path, 'utf8'), 'literal publication');
  });
}

test('publication refuses dangling destination symlinks and changed sources', t => {
  const {base, dir} = fixture(t), priv = createPrivateDir(dir, '.private-'), source = write(priv, 'source');
  const outside = path.join(base, 'outside'); fs.symlinkSync(outside, dir.child('final'));
  assert.throws(() => publishNoReplace(source, dir, 'final'), code('exists'));
  assert.equal(fs.existsSync(outside), false);
  fs.renameSync(source.path, `${source.path}.original`); fs.writeFileSync(source.path, 'replacement');
  assert.throws(() => publishNoReplace(source, dir, 'other'), code('replaced'));
  assert.equal(fs.existsSync(dir.child('other')), false);
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'replacement');
});

test('diagnostic append and rotation use the owned descriptor and preserve replacements', t => {
  const {dir} = fixture(t), file = write(dir, 'clipdock.log', '0123456789');
  appendOwned(file, 'ABC', 8); assert.equal(fs.readFileSync(file.path, 'utf8'), '56789ABC');
  fs.renameSync(file.path, `${file.path}.original`); fs.writeFileSync(file.path, 'precious');
  assert.throws(() => appendOwned(file, 'bad', 8), code('replaced'));
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'precious');
});

test('directory mutations and cleanup refuse a replaced ancestor chain', t => {
  const {base, dir} = fixture(t), parent = createDirectory(dir, 'parent'), nested = createPrivateDir(parent, 'private-');
  const name = path.basename(nested.verify());
  fs.renameSync(parent.verify(), path.join(base, 'moved'));
  fs.mkdirSync(path.join(base, 'parent')); fs.mkdirSync(path.join(base, 'parent', name));
  fs.writeFileSync(path.join(base, 'parent', name, 'user'), 'precious');
  assert.throws(() => openExclusive(nested, 'new'), code('replaced'));
  assert.throws(() => createPrivateDir(nested, 'new-'), code('replaced'));
  assert.throws(() => ensureDirectory(nested, 'new'), code('replaced'));
  removePrivateDir(nested);
  assert.deepEqual(fs.readdirSync(path.join(base, 'parent', name)), ['user']);
  assert.equal(fs.readFileSync(path.join(base, 'parent', name, 'user'), 'utf8'), 'precious');
});

test('publication checks the destination identity and cleans its link if the source changes', t => {
  const {dir} = fixture(t), destination = createDirectory(dir, 'destination'), source = write(dir, 'source');
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (...args) => {
    link(...args); fs.renameSync(source.path, `${source.path}.original`); fs.writeFileSync(source.path, 'replacement');
  });
  assert.throws(() => publishNoReplace(source, destination, 'final'), code('replaced'));
  assert.deepEqual(fs.readdirSync(destination.verify()), []);
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'replacement');
});

test('captured identities retain file IDs above JavaScript integer precision', t => {
  const {base} = fixture(t), lstat = fs.lstatSync;
  const first = 9007199254740992n, second = first + 1n;
  let ino = first;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const info = lstat(file, options);
    if (file === base && options?.bigint) Object.defineProperty(info, 'ino', {value: ino});
    return info;
  });
  const root = ManagedRoot.capture(base), dir = AnchoredDir.capture(base, root);
  assert.equal(dir.snapshot().directories[0].ino, first);
  assert.equal(ManagedRoot.restore(JSON.parse(JSON.stringify(root.snapshot()))).verify(), base);
  ino = second;
  assert.throws(() => dir.verify(), code('root-changed'));
});


test('directory admission creates missing components once and rejects an existing symlink', t => {
  const {base} = fixture(t), target = path.join(base, 'new/nested');
  const dir = prepareDirectory(target);
  assert.equal(dir.verify(), target);
  assert.equal(prepareDirectory(target).verify(), target);
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  fs.symlinkSync(target, path.join(base, 'link'));
  assert.throws(() => prepareDirectory(path.join(base, 'link')), /safety check/);
  assert.equal(prepareDirectory(path.join(base, 'link', 'child')).verify(), path.join(target, 'child'));
});
