import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, statSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const realFs = {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, statSync, lstatSync};

const ABSENT_PATH_CODES = new Set(['ENOENT', 'ENOTDIR']);

function isAbsentPathError(error) {
  return ABSENT_PATH_CODES.has(error?.code);
}

export function findDuplicatePluginIds(destRoot, canonicalId, fs = realFs) {
  let entries;
  try {
    entries = fs.readdirSync(destRoot, {withFileTypes: true});
  } catch (error) {
    if (isAbsentPathError(error)) return [];
    throw error;
  }
  const escaped = canonicalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idPattern = new RegExp(`<Id>\\s*${escaped}\\s*</Id>`);
  const conflicts = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!name || name === canonicalId) continue;
    const isDir = typeof entry === 'string'
      ? true
      : (typeof entry.isDirectory === 'function' ? entry.isDirectory() : Boolean(entry.isDirectory));
    if (!isDir) continue;
    const manifestPath = path.join(destRoot, name, 'manifest.xml');
    let xml;
    try {
      xml = fs.readFileSync(manifestPath, 'utf8');
    } catch (error) {
      if (isAbsentPathError(error)) continue;
      throw error;
    }
    if (typeof xml !== 'string') continue;
    if (idPattern.test(xml)) conflicts.push(path.join(destRoot, name));
  }
  return conflicts;
}

export function assertNoDuplicatePluginIds(destRoot, canonicalId, fs = realFs) {
  const conflicts = findDuplicatePluginIds(destRoot, canonicalId, fs);
  if (conflicts.length === 0) return;
  const canonicalPath = path.join(destRoot, canonicalId);
  const lines = [
    `Duplicate plugin ID "${canonicalId}" found in Workflow Integration root "${destRoot}".`,
    `Canonical: ${canonicalPath}`,
    `Conflicting sibling(s):`,
    ...conflicts.map((c) => `  - ${c}`),
    `Resolve scans every immediate child of the Workflow Integration Plugins directory, so any sibling with the same <Id> causes ambiguous/false-green installs.`,
    `Move backup(s) out of the Workflow Integration Plugins directory (e.g., to ~/Documents/ClipDock-backups or /tmp) — Resolve does not scan there. No files were moved or deleted.`,
  ];
  const error = new Error(lines.join('\n'));
  error.code = 'DUPLICATE_PLUGIN_ID';
  error.canonical = canonicalPath;
  error.conflicts = conflicts;
  throw error;
}

// Files locked at the rename boundary surface as EBUSY or EPERM: DaVinci
// Resolve keeps the installed plugin open while running, and a ClipDock panel
// can leave its Electron process behind (dock/tray/background). Both mean the
// user must quit the applications before the installer can replace the files.
const IN_USE_CODES = new Set(['EBUSY', 'EPERM']);

function lockedFileError(destination, cause) {
  const lockedPath = cause.path ?? destination;
  const error = new Error(
    `Cannot replace the installed plugin in ${destination}: ${cause.code} while ` +
      `updating ${lockedPath}. The files are locked by a running application. ` +
      'Quit DaVinci Resolve completely and quit any remaining ClipDock process ' +
      '(the Electron app may still be running in the dock, tray, or background), ' +
      'then run the installer again.',
    {cause},
  );
  // Preserve the original fs error identity fields for callers/tests.
  error.code = cause.code;
  if (cause.errno !== undefined) error.errno = cause.errno;
  if (cause.syscall !== undefined) error.syscall = cause.syscall;
  if (cause.path !== undefined) error.path = cause.path;
  return error;
}

function restoreRecoveryError(destination, backupDir, restoreError, originalError) {
  const isLock = Boolean(restoreError?.code && IN_USE_CODES.has(restoreError.code));
  const detail = `Failed to restore original plugin to ${destination} after swap failure. ` +
    `Your original files are preserved in backup ${backupDir}. ` +
    `Restore failed with ${restoreError.code ?? 'error'}: ${restoreError.message}. ` +
    `Original swap error: ${originalError.code ?? 'unknown'} ${originalError.message}. ` +
    `Manual recovery: move ${backupDir} back to ${destination} once the lock is cleared.`;
  let error;
  if (isLock) {
    error = lockedFileError(destination, restoreError);
    error.message = `${detail} ${error.message}`;
  } else {
    error = new Error(detail, {cause: restoreError});
    error.code = restoreError.code;
    if (restoreError.errno !== undefined) error.errno = restoreError.errno;
    if (restoreError.syscall !== undefined) error.syscall = restoreError.syscall;
    error.path = restoreError.path ?? backupDir;
  }
  error.backupPath = backupDir;
  error.backupDir = backupDir;
  error.destination = destination;
  error.restoreError = restoreError;
  error.originalError = originalError;
  if (!error.cause) error.cause = restoreError;
  return error;
}

// One canonical target needs one owner. The exclusive journal also records enough
// immutable state to recover if the owner dies between the two directory renames.
function acquireTransaction(destination, fs) {
  const parent = path.dirname(destination);
  const lock = path.join(parent, `.__clipdock_lock_${path.basename(destination)}`);
  const recovery = `${lock}.recovery`;
  const write = fs.writeFileSync ?? writeFileSync;
  const owner = { pid: process.pid, destination: path.resolve(destination), workDir: path.join(parent, `.__clipdock_work_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`) };
  const busy = () => Object.assign(new Error(`Installation transaction is active or needs recovery: ${lock}`), {code: 'INSTALL_BUSY'});
  const recover = () => {
    // Never unlink a dead owner's shared lock to claim it: two retries could
    // otherwise unlink each other's replacement. Dead claims instead lead to
    // one immutable successor path, on which exclusive creation elects a winner.
    const claims = [];
    const recoveryOwner = {pid: process.pid, token: randomUUID()};
    let claim = recovery;
    for (;;) {
      try { write(claim, JSON.stringify(recoveryOwner), {flag: 'wx'}); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let previous;
      try { previous = JSON.parse(fs.readFileSync(claim, 'utf8')); } catch { throw busy(); }
      // The old installer recorded just a PID. Retain its live-owner refusal.
      if (Number.isInteger(previous)) previous = {pid: previous, token: `legacy-${previous}`};
      if (!Number.isInteger(previous?.pid) || previous.pid <= 0 || !/^(?:[a-f0-9-]{36}|legacy-\d+)$/.test(previous.token)) throw busy();
      try { process.kill(previous.pid, 0); throw busy(); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      claims.push(claim);
      claim = `${recovery}.${previous.token}`;
      if (claims.includes(claim)) throw busy();
    }
    let recovered = false;
    try {
      let prior;
      try { prior = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw busy(); }
      if (typeof prior.workDir !== 'string' || !Number.isInteger(prior.pid) || prior.pid <= 0 || prior.destination !== path.resolve(destination) || path.dirname(prior.workDir) !== parent || !path.basename(prior.workDir).startsWith('.__clipdock_work_')) throw busy();
      try { process.kill(prior.pid, 0); throw busy(); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const backup = path.join(prior.workDir, 'backup');
      const stage = path.join(prior.workDir, 'stage');
      // The journal precedes mkdir and outlives work-directory cleanup. If
      // work is absent, no stage/backup remains: preserve the destination and
      // finish journal cleanup. Existing work roots must still be real dirs.
      assertDirectoryRoot(prior.workDir, fs, true);
      assertDirectoryRoot(destination, fs, true);
      if (fs.existsSync(backup)) {
        assertDirectoryRoot(backup, fs);
        if (!fs.existsSync(destination)) fs.renameSync(backup, destination);
        else {
          const receipt = JSON.parse(fs.readFileSync(path.join(prior.workDir, 'receipt.json'), 'utf8'));
          const installed = (fs.statSync ?? statSync)(destination);
          if (fs.existsSync(stage) || installed.dev !== receipt.dev || installed.ino !== receipt.ino) throw new Error(`Ambiguous interrupted install; original preserved at ${backup}. Recover it before retrying.`);
        }
      }
      fs.rmSync(prior.workDir, {recursive: true, force: true});
      fs.rmSync(lock);
      recovered = true;
    } finally {
      // Ancestors remain immutable until the journal has been recovered. A
      // failed retry releases only its own tail; an interrupted one is reclaimable.
      if (recovered) for (const stale of claims) fs.rmSync(stale, {force: true});
      fs.rmSync(claim, {force: true});
    }
  };
  try { write(lock, JSON.stringify(owner), {flag: 'wx'}); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    recover();
    try { write(lock, JSON.stringify(owner), {flag: 'wx'}); } catch (next) { if (next.code === 'EEXIST') throw busy(); throw next; }
  }
  return {workDir: owner.workDir, release() {
    let current;
    try { current = fs.readFileSync(lock, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (current !== JSON.stringify(owner)) throw busy();
    fs.rmSync(lock, {force: true});
  }};
}

// Restore an interrupted upgrade even when the next installer invocation has
// missing build/native inputs. Dry-run callers must omit this mutation.
export function recoverInterruptedTransaction(destination, fs = realFs) {
  destination = path.resolve(destination);
  const lock = path.join(path.dirname(destination), `.__clipdock_lock_${path.basename(destination)}`);
  if (!fs.existsSync(lock)) return;
  const transaction = acquireTransaction(destination, fs);
  transaction.release();
}

function assertDirectoryRoot(directory, fs, optional = false) {
  let info;
  try { info = (fs.lstatSync ?? lstatSync)(directory); } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a real directory, not a symbolic link or file: ${directory}`);
}

function canonicalPath(file, fs) {
  try { return (fs.realpathSync ?? realpathSync)(file); } catch (error) {
    const parent = path.dirname(file);
    if (!isAbsentPathError(error) || parent === file) throw error;
    return path.join(canonicalPath(parent, fs), path.basename(file));
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Reconcile the destination exactly with the source using an atomic
// same-parent work-directory swap. The fs parameter is an injectable seam for
// deterministic tests; callers omit it to use node:fs. All mutations and
// observations go through the injected seam. A single same-volume work dir
// under the destination parent holds stage/ and backup/ so a backup-cleanup
// failure cannot leave an immediate sibling with the same plugin <Id>.
export function reconcileDirectoryContents(source, destination, fs = realFs, prepareStage = () => {}) {
  destination = path.resolve(destination);
  assertDirectoryRoot(source, fs);
  assertDirectoryRoot(destination, fs, true);
  const sourcePath = canonicalPath(path.resolve(source), fs);
  const destinationPath = canonicalPath(destination, fs);
  if (containsPath(sourcePath, destinationPath) || containsPath(destinationPath, sourcePath)) {
    throw new Error('Source and destination directories must not overlap');
  }
  const parent = path.dirname(destination);
  // Ensure parent exists so work dir and renames stay same-volume.
  fs.mkdirSync(parent, {recursive: true});

  const transaction = acquireTransaction(destination, fs);
  const workDir = transaction.workDir;
  try {
    const stageDir = path.join(workDir, 'stage');
    const backupDir = path.join(workDir, 'backup');

    // Ensure work dir exists.
    fs.mkdirSync(workDir, {recursive: true});

    // 1. Copy source to work/stage before touching destination.
    try {
      fs.cpSync(source, stageDir, {recursive: true});
      assertDirectoryRoot(stageDir, fs);
      prepareStage(stageDir);
      assertDirectoryRoot(stageDir, fs);
      const staged = (fs.statSync ?? statSync)(stageDir);
      (fs.writeFileSync ?? writeFileSync)(path.join(workDir, 'receipt.json'), JSON.stringify({dev: staged.dev, ino: staged.ino}), {flag: 'wx'});
    } catch (error) {
      try { fs.rmSync(workDir, {recursive: true, force: true}); } catch {}
      if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
      throw error;
    }

    // 2. Check if destination exists (via injected seam).
    let destinationExists = false;
    try {
      destinationExists = fs.existsSync(destination);
    } catch (error) {
      try { fs.rmSync(workDir, {recursive: true, force: true}); } catch {}
      if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
      throw error;
    }

    let hasBackup = false;
    if (destinationExists) {
      // Atomically rename existing destination into work/backup.
      try {
        fs.renameSync(destination, backupDir);
        hasBackup = true;
      } catch (error) {
        // A lock before swap must leave original byte-for-byte and no partial new install.
        try { fs.rmSync(workDir, {recursive: true, force: true}); } catch {}
        if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
        throw error;
      }
    }

    // 3. Rename work/stage into destination.
    try {
      fs.renameSync(stageDir, destination);
    } catch (error) {
      // On swap failure, restore original.
      if (hasBackup) {
        try {
          if (fs.existsSync(destination)) throw new Error('Destination no longer belongs to this transaction; backup preserved');
          fs.renameSync(backupDir, destination);
          hasBackup = false;
        } catch (restoreError) {
          // Preserve recoverable backup; never delete workDir/backup.
          // Keep stage and its receipt, so recovery cannot mistake an unrelated
          // destination for the installation this transaction promoted.
          throw restoreRecoveryError(destination, backupDir, restoreError, error);
        }
      }
      try { fs.rmSync(workDir, {recursive: true, force: true}); } catch {}
      if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
      throw error;
    }

    // 4. Clean backup on success. Cleanup failure must not be reported as success
    // and must not leave an immediate sibling with the same plugin Id.
    if (hasBackup) {
      try {
        fs.rmSync(backupDir, {recursive: true, force: true});
        fs.rmSync(workDir, {recursive: true, force: true});
      } catch (error) {
        if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
        throw error;
      }
    } else {
      try {
        fs.rmSync(workDir, {recursive: true, force: true});
      } catch (error) {
        if (error?.code && IN_USE_CODES.has(error.code)) throw lockedFileError(destination, error);
        throw error;
      }
    }
  } finally { if (!fs.existsSync(workDir)) transaction.release(); }
}
