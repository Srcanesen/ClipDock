import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {assertNoDuplicatePluginIds, findDuplicatePluginIds, reconcileDirectoryContents} from '../scripts/lib/install-files.mjs';

/** Run fn and return the thrown error; fail if nothing is thrown. */
function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
}

/** Helper to create fake fs that records operations and delegates to real fs unless overridden. */
function makeFakeFs({real, overrides = {}}) {
  return {
    lstatSync: overrides.lstatSync ?? real.lstatSync.bind(real),
    writeFileSync: overrides.writeFileSync ?? real.writeFileSync.bind(real),
    mkdirSync: overrides.mkdirSync ?? real.mkdirSync.bind(real),
    readdirSync: overrides.readdirSync ?? real.readdirSync.bind(real),
    rmSync: overrides.rmSync ?? real.rmSync.bind(real),
    cpSync: overrides.cpSync ?? real.cpSync.bind(real),
    renameSync: overrides.renameSync ?? real.renameSync.bind(real),
    existsSync: overrides.existsSync ?? real.existsSync.bind(real),
    readFileSync: overrides.readFileSync ?? real.readFileSync.bind(real),
  };
}

test('installer reconciles contents exactly with atomic same-parent staging and no residue', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-install-'));
  const source = path.join(root, 'dist');
  const destination = path.join(root, 'installed');
  mkdirSync(path.join(source, 'nested'), {recursive: true});
  mkdirSync(destination);
  writeFileSync(path.join(source, 'main.js'), 'current');
  writeFileSync(path.join(source, 'nested', 'asset.txt'), 'asset');
  writeFileSync(path.join(destination, 'stale.txt'), 'stale');

  try {
    reconcileDirectoryContents(source, destination);

    assert.deepEqual(readdirSync(destination).sort(), ['main.js', 'nested']);
    assert.equal(readFileSync(path.join(destination, 'main.js'), 'utf8'), 'current');
    assert.equal(readFileSync(path.join(destination, 'nested', 'asset.txt'), 'utf8'), 'asset');

    // No leftover staging/backup dirs in parent
    const parent = path.dirname(destination);
    const siblings = readdirSync(parent);
    assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false, 'no staging residue');
    assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false, 'no backup residue');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('stage-copy failure leaves original byte-for-byte and cleans staging', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-stage-copy-fail-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(source, {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new content');
  writeFileSync(path.join(dest, 'keep.txt'), 'original keep');
  const orig = readFileSync(path.join(dest, 'keep.txt'), 'utf8');

  const origError = Object.assign(new Error('ENOSPC no space'), {code: 'ENOSPC', errno: -28, syscall: 'copyfile', path: path.join(dest, 'new.js')});

  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      cpSync: (src, dst, opts) => {
        // Stage copy is cpSync(source, stageDir)
        if (src === source) throw origError;
        return fs.cpSync(src, dst, opts);
      },
    },
  });

  const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(error, origError, 'ENOSPC must propagate unchanged (same identity)');
  assert.equal(error.cause, undefined);

  // Original preserved byte-for-byte
  assert.equal(readFileSync(path.join(dest, 'keep.txt'), 'utf8'), orig);
  assert.equal(existsSync(path.join(dest, 'new.js')), false);
  // No leftover staging/backup
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);

  rmSync(root, {recursive: true, force: true});
});

test('destination-rename EBUSY leaves original byte-for-byte and no partial new install', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-rename-lock-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(path.join(source, 'nested'), {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new content');
  writeFileSync(path.join(source, 'nested', 'asset.txt'), 'asset');
  writeFileSync(path.join(dest, 'a.txt'), 'original a');
  writeFileSync(path.join(dest, 'b.txt'), 'original b');
  const origA = readFileSync(path.join(dest, 'a.txt'), 'utf8');
  const origB = readFileSync(path.join(dest, 'b.txt'), 'utf8');

  const locked = Object.assign(new Error('EBUSY resource busy'), {code: 'EBUSY', errno: -16, syscall: 'rename', path: dest});

  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      renameSync: (from, to) => {
        // Lock at destination -> backup rename
        if (from === dest) throw locked;
        return fs.renameSync(from, to);
      },
    },
  });

  const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(error.code, 'EBUSY');
  assert.equal(error.cause, locked);
  assert.match(error.message, /Quit DaVinci Resolve/);
  assert.match(error.message, /ClipDock/);
  // Original byte-for-byte
  assert.equal(readFileSync(path.join(dest, 'a.txt'), 'utf8'), origA);
  assert.equal(readFileSync(path.join(dest, 'b.txt'), 'utf8'), origB);
  assert.equal(existsSync(path.join(dest, 'new.js')), false);
  assert.equal(existsSync(path.join(dest, 'nested')), false);
  // No residue
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false, 'staging cleaned');
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false, 'no backup left');

  rmSync(root, {recursive: true, force: true});
});

test('stage-swap failure after backup move restores original byte-for-byte', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-swap-fail-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(source, {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new content');
  writeFileSync(path.join(dest, 'keep.txt'), 'original keep');
  const orig = readFileSync(path.join(dest, 'keep.txt'), 'utf8');

  const swapError = Object.assign(new Error('ENOSPC during swap'), {code: 'ENOSPC', errno: -28, syscall: 'rename', path: dest});

  let renameCalls = 0;
  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      renameSync: (from, to) => {
        renameCalls++;
        // First rename is dest -> backup (should succeed)
        // Second rename is stage -> dest (should fail)
        if (renameCalls === 2) throw swapError;
        return fs.renameSync(from, to);
      },
    },
  });

  const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(error, swapError, 'ENOSPC after backup move must propagate unchanged');
  // Original restored byte-for-byte
  assert.equal(readFileSync(path.join(dest, 'keep.txt'), 'utf8'), orig);
  assert.equal(existsSync(path.join(dest, 'new.js')), false);
  // No leftover
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false, 'backup cleaned after restore');

  rmSync(root, {recursive: true, force: true});
});

test('stage-swap EPERM after backup move restores original and is classified with quit guidance', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-swap-eperm-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(source, {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new content');
  writeFileSync(path.join(dest, 'keep.txt'), 'original keep');
  const orig = readFileSync(path.join(dest, 'keep.txt'), 'utf8');

  const eperm = Object.assign(new Error('EPERM operation not permitted'), {code: 'EPERM', errno: -1, syscall: 'rename', path: dest});

  let renameCalls = 0;
  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      renameSync: (from, to) => {
        renameCalls++;
        if (renameCalls === 2) throw eperm;
        return fs.renameSync(from, to);
      },
    },
  });

  const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(error.code, 'EPERM');
  assert.equal(error.cause, eperm);
  assert.match(error.message, /Quit DaVinci Resolve/);
  assert.equal(readFileSync(path.join(dest, 'keep.txt'), 'utf8'), orig);
  assert.equal(existsSync(path.join(dest, 'new.js')), false);
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);

  rmSync(root, {recursive: true, force: true});
});

test('unrelated filesystem errors propagate with original identity after safe rollback', () => {
  for (const code of ['ENOENT', 'ENOSPC']) {
    const root = mkdtempSync(path.join(tmpdir(), `clipdock-unrelated-${code}-`));
    const source = path.join(root, 'source');
    const dest = path.join(root, 'dest');
    mkdirSync(source, {recursive: true});
    mkdirSync(dest, {recursive: true});
    writeFileSync(path.join(source, 'new.js'), 'new');
    writeFileSync(path.join(dest, 'keep.txt'), 'keep');

    const original = Object.assign(new Error(`${code} during swap`), {code, errno: -2, syscall: 'rename', path: dest});
    let renameCalls = 0;
    const wrapper = makeFakeFs({
      real: fs,
      overrides: {
        renameSync: (from, to) => {
          renameCalls++;
          if (renameCalls === 2) throw original;
          return fs.renameSync(from, to);
        },
      },
    });

    const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
    assert.equal(error, original, `${code} must propagate unchanged after rollback`);
    assert.equal(error.cause, undefined);
    // Original still there
    assert.equal(readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'keep');
    const siblings = readdirSync(path.dirname(dest));
    assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);
    assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), false);

    rmSync(root, {recursive: true, force: true});
  }
});

test('EBUSY/EPERM at staging or rename boundary is classified, others propagate', () => {
  const forLock = (code) => {
    const err = Object.assign(new Error(`${code} lock`), {code, syscall: 'rename', path: '/installed'});
    return err;
  };
  // Test EBUSY at stage copy
  {
    const err = forLock('EBUSY');
    const w = makeFakeFs({real: fs, overrides: {lstatSync: () => ({isDirectory: () => true, isSymbolicLink: () => false}), writeFileSync: () => {}, mkdirSync: () => {}, rmSync: () => {}, cpSync: () => { throw err; }}});
    const e = captureError(() => reconcileDirectoryContents('/src', '/dest', w));
    assert.equal(e.code, 'EBUSY');
    assert.equal(e.cause, err);
  }
  {
    const err = forLock('EPERM');
    const w = makeFakeFs({real: fs, overrides: {lstatSync: () => ({isDirectory: () => true, isSymbolicLink: () => false}), writeFileSync: () => {}, mkdirSync: () => {}, rmSync: () => {}, cpSync: () => { throw err; }}});
    const e = captureError(() => reconcileDirectoryContents('/src', '/dest', w));
    assert.equal(e.code, 'EPERM');
    assert.equal(e.cause, err);
  }
  // Unrelated at same boundary propagates
  {
    const err = Object.assign(new Error('ENOSPC'), {code: 'ENOSPC'});
    const w = makeFakeFs({real: fs, overrides: {lstatSync: () => ({isDirectory: () => true, isSymbolicLink: () => false}), writeFileSync: () => {}, mkdirSync: () => {}, rmSync: () => {}, cpSync: () => { throw err; }}});
    const e = captureError(() => reconcileDirectoryContents('/src', '/dest', w));
    assert.equal(e, err);
  }
});

test('no leftover staging/backup dirs after success or after handled failure', () => {
  // Success case already checked, now check handled failure leaves no duplicate topology
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-no-leftover-fail-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(source, {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new');
  writeFileSync(path.join(dest, 'old.txt'), 'old');

  const locked = Object.assign(new Error('EBUSY'), {code: 'EBUSY', syscall: 'rename', path: dest});
  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      renameSync: (from, to) => {
        if (from === dest) throw locked;
        return fs.renameSync(from, to);
      },
    },
  });

  const err = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(err.code, 'EBUSY');
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  const leftovers = siblings.filter((n) => n.includes('__clipdock_work_'));
  assert.deepEqual(leftovers, [], 'no work-dir residue after lock failure must not leave duplicate topology');

  // Also ensure original still intact
  assert.equal(readFileSync(path.join(dest, 'old.txt'), 'utf8'), 'old');

  rmSync(root, {recursive: true, force: true});
});

test('cleanup EBUSY after successful swap leaves exact new install and no immediate duplicate topology', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-cleanup-ebusy-'));
  const workflowRoot = path.join(root, 'Workflow Integration Plugins');
  mkdirSync(workflowRoot, {recursive: true});
  const source = path.join(root, 'source');
  const dest = path.join(workflowRoot, CANONICAL_ID);
  mkdirSync(source, {recursive: true});
  // source is the new plugin with canonical Id
  writeManifest(source, MANIFEST_CANONICAL);
  writeFileSync(path.join(source, 'main.js'), 'new content');
  writeFileSync(path.join(source, 'extra.txt'), 'extra');
  // dest is old plugin with same Id and stale file
  writeManifest(dest, MANIFEST_CANONICAL);
  writeFileSync(path.join(dest, 'old.txt'), 'old stale');
  writeFileSync(path.join(dest, 'manifest.xml'), MANIFEST_CANONICAL);

  const locked = Object.assign(new Error('EBUSY resource busy or locked'), {code: 'EBUSY', errno: -16, syscall: 'unlink', path: path.join(workflowRoot, '.__clipdock_work_backup')});
  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      rmSync: (target, opts) => {
        // Fail cleanup of nested backup after successful swap
        if (typeof target === 'string' && target.includes('backup')) throw locked;
        return fs.rmSync(target, opts);
      },
    },
  });

  const err = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  assert.equal(err.code, 'EBUSY');
  assert.equal(err.cause, locked);
  assert.match(err.message, /Quit DaVinci Resolve/);

  // New destination is exact: old stale removed, new files present, manifest preserved
  const destFiles = readdirSync(dest).sort();
  // inventory via readdir: should contain main.js, extra.txt, manifest.xml (and no old.txt)
  assert.ok(destFiles.includes('main.js'), 'new main.js must be present');
  assert.ok(destFiles.includes('extra.txt'), 'new extra.txt must be present');
  assert.ok(destFiles.includes('manifest.xml'), 'manifest must be present');
  assert.equal(existsSync(path.join(dest, 'old.txt')), false, 'stale file must be gone');
  assert.equal(readFileSync(path.join(dest, 'main.js'), 'utf8'), 'new content');
  assert.equal(readFileSync(path.join(dest, 'extra.txt'), 'utf8'), 'extra');
  // Ensure findDuplicate sees no immediate sibling conflict despite nested backup residue
  const conflicts = findDuplicatePluginIds(workflowRoot, CANONICAL_ID);
  assert.deepEqual(conflicts, [], 'nested backup must not appear as immediate duplicate Id');
  // Verify residue is nested inside work dir, not as immediate child with manifest
  const siblings = readdirSync(workflowRoot);
  const workDirName = siblings.find((n) => n.includes('__clipdock_work_'));
  assert.ok(workDirName, 'work dir residue must remain');
  assert.match(workDirName, /__clipdock_work_/, 'residue must be inside work dir');
  const nestedBackupManifest = path.join(workflowRoot, workDirName, 'backup', 'manifest.xml');
  assert.equal(existsSync(nestedBackupManifest), true, 'nested backup manifest must exist');
  assert.equal(readFileSync(nestedBackupManifest, 'utf8'), MANIFEST_CANONICAL, 'nested backup retains old manifest');
  // Ensure workDir itself does not look like a plugin root (no manifest at workDir/manifest.xml)
  assert.equal(existsSync(path.join(workflowRoot, workDirName, 'manifest.xml')), false, 'work dir must not be a plugin root');

  rmSync(root, {recursive: true, force: true});
});

// --- Topology guard (same-plugin-ID scan) ---
const CANONICAL_ID = 'com.clipdock.app';
const MANIFEST_CANONICAL = `<?xml version="1.0"?><BlackmagicDesign><Plugin><Id>${CANONICAL_ID}</Id></Plugin></BlackmagicDesign>`;
const MANIFEST_OTHER = `<?xml version="1.0"?><BlackmagicDesign><Plugin><Id>com.other.plugin</Id></Plugin></BlackmagicDesign>`;
const MANIFEST_MALFORMED = `<BlackmagicDesign><Plugin><Name>NoId</Name></Plugin></BlackmagicDesign>`;

function writeManifest(dir, xml) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'manifest.xml'), xml);
}

test('topology guard: single canonical passes with no duplicate', () => {
  const workflowRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-topo-single-'));
  try {
    writeManifest(path.join(workflowRoot, CANONICAL_ID), MANIFEST_CANONICAL);
    assert.deepEqual(findDuplicatePluginIds(workflowRoot, CANONICAL_ID), []);
    assert.doesNotThrow(() => assertNoDuplicatePluginIds(workflowRoot, CANONICAL_ID));
  } finally {
    rmSync(workflowRoot, {recursive: true, force: true});
  }
});

test('topology guard: same-ID backup sibling fails with canonical/conflict and move guidance', () => {
  const workflowRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-topo-dup-'));
  try {
    writeManifest(path.join(workflowRoot, CANONICAL_ID), MANIFEST_CANONICAL);
    const backupName = `${CANONICAL_ID}.backup-20260811T095749Z`;
    writeManifest(path.join(workflowRoot, backupName), MANIFEST_CANONICAL);
    const conflicts = findDuplicatePluginIds(workflowRoot, CANONICAL_ID);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0], path.join(workflowRoot, backupName));
    const error = captureError(() => assertNoDuplicatePluginIds(workflowRoot, CANONICAL_ID));
    assert.equal(error.code, 'DUPLICATE_PLUGIN_ID');
    assert.equal(error.canonical, path.join(workflowRoot, CANONICAL_ID));
    assert.deepEqual(error.conflicts, conflicts);
    assert.match(error.message, /Duplicate plugin ID/);
    assert.match(error.message, new RegExp(CANONICAL_ID));
    assert.match(error.message, new RegExp(backupName));
    assert.match(error.message, /Move backup/);
    assert.match(error.message, /No files were moved/);
    // Guard is non-mutating: both dirs still exist
    assert.equal(existsSyncWorkaround(path.join(workflowRoot, backupName, 'manifest.xml')), true);
  } finally {
    rmSync(workflowRoot, {recursive: true, force: true});
  }
});

function existsSyncWorkaround(p) {
  try { readFileSync(p); return true; } catch { return false; }
}

test('topology guard: different-ID sibling passes', () => {
  const workflowRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-topo-diff-'));
  try {
    writeManifest(path.join(workflowRoot, CANONICAL_ID), MANIFEST_CANONICAL);
    writeManifest(path.join(workflowRoot, 'com.other.plugin'), MANIFEST_OTHER);
    // sibling with different Id plus one with canonical-like name but different Id must not be flagged
    writeManifest(path.join(workflowRoot, `${CANONICAL_ID}.other`), MANIFEST_OTHER);
    assert.deepEqual(findDuplicatePluginIds(workflowRoot, CANONICAL_ID), []);
    assert.doesNotThrow(() => assertNoDuplicatePluginIds(workflowRoot, CANONICAL_ID));
  } finally {
    rmSync(workflowRoot, {recursive: true, force: true});
  }
});

test('topology guard: malformed / missing manifest is safely ignored', () => {
  const workflowRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-topo-malformed-'));
  try {
    writeManifest(path.join(workflowRoot, CANONICAL_ID), MANIFEST_CANONICAL);
    // sibling dir without manifest.xml at all
    mkdirSync(path.join(workflowRoot, `${CANONICAL_ID}.backup-empty`), {recursive: true});
    // sibling with manifest but no <Id>
    writeManifest(path.join(workflowRoot, `${CANONICAL_ID}.backup-malformed`), MANIFEST_MALFORMED);
    // sibling that is a file, not a directory
    writeFileSync(path.join(workflowRoot, `${CANONICAL_ID}.backup-file`), 'not a dir');
    assert.deepEqual(findDuplicatePluginIds(workflowRoot, CANONICAL_ID), []);
    assert.doesNotThrow(() => assertNoDuplicatePluginIds(workflowRoot, CANONICAL_ID));
  } finally {
    rmSync(workflowRoot, {recursive: true, force: true});
  }
});

test('topology guard: missing workflow root (ENOENT) does not throw', () => {
  const missing = path.join(tmpdir(), `clipdock-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const missingError = Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
  const fsFake = {
    readdirSync() { throw missingError; },
    existsSync() { return true; },
    readFileSync() { return MANIFEST_CANONICAL; },
  };
  assert.deepEqual(findDuplicatePluginIds(missing, CANONICAL_ID, fsFake), []);
  assert.doesNotThrow(() => assertNoDuplicatePluginIds(missing, CANONICAL_ID, fsFake));
  const notDirectoryFs = {readdirSync() { throw Object.assign(new Error('ENOTDIR'), {code: 'ENOTDIR'}); }};
  assert.deepEqual(findDuplicatePluginIds(missing, CANONICAL_ID, notDirectoryFs), []);
});

test('topology guard: root readdir permission errors propagate', () => {
  const original = Object.assign(new Error('root denied'), {code: 'EACCES'});
  const fsFake = {readdirSync() { throw original; }};
  assert.equal(captureError(() => findDuplicatePluginIds('/workflow', CANONICAL_ID, fsFake)), original);
  assert.equal(captureError(() => assertNoDuplicatePluginIds('/workflow', CANONICAL_ID, fsFake)), original);
});

test('topology guard: sibling manifest permission errors propagate', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const original = Object.assign(new Error(`${code} reading manifest`), {code});
    const fsFake = {
      readdirSync() { return [{name: `${CANONICAL_ID}.backup`, isDirectory: () => true}]; },
      existsSync() { return true; },
      readFileSync() { throw original; },
    };
    assert.equal(captureError(() => findDuplicatePluginIds('/workflow', CANONICAL_ID, fsFake)), original, `${code} must propagate unchanged`);
    assert.equal(captureError(() => assertNoDuplicatePluginIds('/workflow', CANONICAL_ID, fsFake)), original, `${code} must propagate unchanged`);
  }
});

test('topology guard: canonical folder itself is never counted as conflict', () => {
  const workflowRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-topo-canonical-only-'));
  try {
    writeManifest(path.join(workflowRoot, CANONICAL_ID), MANIFEST_CANONICAL);
    // Only canonical exists, no siblings — must be zero conflicts even though canonical manifest matches
    const conflicts = findDuplicatePluginIds(workflowRoot, CANONICAL_ID);
    assert.equal(conflicts.length, 0);
  } finally {
    rmSync(workflowRoot, {recursive: true, force: true});
  }
});

test('stage-swap failure plus restore failure preserves recoverable backup and surfaces recovery error', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-restore-fail-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(source, {recursive: true});
  mkdirSync(dest, {recursive: true});
  writeFileSync(path.join(source, 'new.js'), 'new content');
  writeFileSync(path.join(dest, 'keep.txt'), 'original keep');
  const orig = readFileSync(path.join(dest, 'keep.txt'), 'utf8');

  const swapError = Object.assign(new Error('ENOSPC during swap'), {code: 'ENOSPC', errno: -28, syscall: 'rename', path: dest});
  const restoreError = Object.assign(new Error('EACCES restore blocked'), {code: 'EACCES', errno: -13, syscall: 'rename', path: dest});

  let renameCalls = 0;
  const rmTargets = [];
  const wrapper = makeFakeFs({
    real: fs,
    overrides: {
      renameSync: (from, to) => {
        renameCalls++;
        if (renameCalls === 2) throw swapError;
        if (renameCalls === 3) throw restoreError;
        return fs.renameSync(from, to);
      },
      rmSync: (target, opts) => {
        rmTargets.push(String(target));
        return fs.rmSync(target, opts);
      },
    },
  });

  const error = captureError(() => reconcileDirectoryContents(source, dest, wrapper));
  // Must not hide restore failure behind original swap error
  assert.notEqual(error, swapError, 'restore failure must not surface original swap error');
  assert.equal(error.cause, restoreError, 'cause must be restore error');
  assert.equal(error.restoreError, restoreError);
  assert.equal(error.originalError, swapError);
  // Must identify recovery/backup and carry backup path
  assert.match(error.message, /backup/i, 'error must mention backup');
  assert.match(error.message, /recover/i, 'error must mention recovery');
  const backupPath = error.backupPath ?? error.backupDir;
  assert.ok(backupPath && backupPath.includes('__clipdock_work_'), 'error must carry backup path inside work dir');
  assert.ok(backupPath.includes('backup'), 'backup path must point to backup');
  assert.ok(error.message.includes(backupPath), 'message must contain backup path');
  // Original bytes must remain under workDir/backup, not deleted by cleanup
  const parent = path.dirname(dest);
  const siblings = readdirSync(parent);
  const workDirName = siblings.find((n) => n.includes('__clipdock_work_'));
  assert.ok(workDirName, 'work dir must remain after restore failure');
  const preserved = path.join(parent, workDirName, 'backup', 'keep.txt');
  assert.equal(existsSync(preserved), true, 'backup must be preserved');
  assert.equal(readFileSync(preserved, 'utf8'), orig, 'backup bytes must be intact');
  // Cleanup must not have deleted workDir/backup
  const deletedWorkDir = rmTargets.some((t) => t === path.join(parent, workDirName));
  const deletedBackup = rmTargets.some((t) => t.includes(path.join(workDirName, 'backup')) && !t.includes('stage'));
  // The only allowed rm is stage; workDir/backup must not be removed
  assert.equal(deletedWorkDir, false, 'workDir must not be deleted on restore failure');
  // Verify no sibling residue check would be false-green
  assert.equal(siblings.some((n) => n.includes('__clipdock_work_')), true, 'work dir residue must be detectable');

  // Also verify lock-guided restore failure carries quit guidance
  {
    const root2 = mkdtempSync(path.join(tmpdir(), 'clipdock-restore-lock-'));
    const src2 = path.join(root2, 'source');
    const dst2 = path.join(root2, 'dest');
    mkdirSync(src2, {recursive: true});
    mkdirSync(dst2, {recursive: true});
    writeFileSync(path.join(src2, 'new.js'), 'new');
    writeFileSync(path.join(dst2, 'keep.txt'), 'keep');
    let c2 = 0;
    const ebusyRestore = Object.assign(new Error('EBUSY restore'), {code: 'EBUSY', errno: -16, syscall: 'rename', path: dst2});
    const swap2 = Object.assign(new Error('swap fail'), {code: 'ENOSPC', syscall: 'rename', path: dst2});
    const w2 = makeFakeFs({
      real: fs,
      overrides: {
        renameSync: (from, to) => {
          c2++;
          if (c2 === 2) throw swap2;
          if (c2 === 3) throw ebusyRestore;
          return fs.renameSync(from, to);
        },
      },
    });
    const e2 = captureError(() => reconcileDirectoryContents(src2, dst2, w2));
    assert.match(e2.message, /backup/i);
    assert.match(e2.message, /Quit DaVinci Resolve/);
    assert.equal(e2.cause, ebusyRestore);
    assert.ok(e2.backupPath.includes('__clipdock_work_'));
    const sib2 = readdirSync(path.dirname(dst2));
    const wd2 = sib2.find((n) => n.includes('__clipdock_work_'));
    assert.ok(wd2);
    assert.equal(existsSync(path.join(path.dirname(dst2), wd2, 'backup', 'keep.txt')), true);
    rmSync(root2, {recursive: true, force: true});
  }

  rmSync(root, {recursive: true, force: true});
});
