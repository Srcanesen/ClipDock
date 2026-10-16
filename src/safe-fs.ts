// Path strings are never mutation authority: capture identities, then verify immediately
// before each syscall. Node has no openat/unlinkat; the residual microsecond window
// between the final verification and the syscall cannot be closed here and is accepted.
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ManagedRoot } from './managed-root';

type Code = 'root-changed' | 'outside' | 'symlink' | 'replaced' | 'exists' | 'not-regular' | 'not-directory';
export class SafeFsError extends Error {
  constructor(readonly code: Code) { super(`File safety check failed: ${code}.`); this.name = 'SafeFsError'; }
}
type Identity = Readonly<{path: string; dev: bigint; ino: bigint}>;
export type DirectorySnapshot = Readonly<{path: string; directories: ReadonlyArray<Identity>}>;
const same = (a: {dev: bigint; ino: bigint}, b: {dev: bigint; ino: bigint}) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
function inside(dir: string, path: string, equal = false): boolean {
  const rel = relative(dir, path);
  return isAbsolute(path) && (equal && rel === '' || rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function segment(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('\0') || basename(name) !== name || (sep === '\\' && name.includes(':'))) throw new SafeFsError('outside');
}
function directory(path: string): Identity {
  const info = lstatSync(path, {bigint: true});
  if (info.isSymbolicLink()) throw new SafeFsError('symlink');
  if (!info.isDirectory()) throw new SafeFsError('not-directory');
  return Object.freeze({path, dev: info.dev, ino: info.ino});
}
function verifyChain(chain: ReadonlyArray<Identity>): void {
  // Check parents before children so no lstat traverses an unverified ancestor.
  for (const entry of chain) {
    try { if (!same(directory(entry.path), entry)) throw new SafeFsError('replaced'); }
    catch (error) { if (missing(error)) throw new SafeFsError('replaced'); throw error; }
  }
}

export class AnchoredDir {
  private constructor(readonly root: ManagedRoot, private readonly value: DirectorySnapshot) { Object.freeze(this); }
  static capture(path: string, root: ManagedRoot): AnchoredDir {
    let base: string;
    try { base = root.verify(); } catch { throw new SafeFsError('root-changed'); }
    if (!inside(base, path, true) || resolve(path) !== path) throw new SafeFsError('outside');
    const chain: Identity[] = [];
    for (const name of relative(base, path).split(sep).filter(Boolean)) {
      const next = join(chain.at(-1)?.path ?? base, name);
      chain.push(directory(next));
    }
    // Capture the root too when the anchor equals it; ManagedRoot owns its ancestry.
    if (!chain.length) chain.push(directory(base));
    const result = new AnchoredDir(root, Object.freeze({path, directories: Object.freeze(chain)}));
    result.verify(); return result;
  }
  static restore(snapshot: DirectorySnapshot, root: ManagedRoot): AnchoredDir {
    let base: string;
    try { base = root.verify(); } catch { throw new SafeFsError('root-changed'); }
    if (!snapshot || !inside(base, snapshot.path, true) || resolve(snapshot.path) !== snapshot.path || !Array.isArray(snapshot.directories)) throw new SafeFsError('outside');
    const expected = relative(base, snapshot.path).split(sep).filter(Boolean);
    const paths = expected.length ? expected.map((_, i) => join(base, ...expected.slice(0, i + 1))) : [base];
    if (paths.length !== snapshot.directories.length || snapshot.directories.some((entry, i) => entry.path !== paths[i] || typeof entry.dev !== 'bigint' || typeof entry.ino !== 'bigint')) throw new SafeFsError('replaced');
    const result = new AnchoredDir(root, Object.freeze({path: snapshot.path, directories: Object.freeze(snapshot.directories.map(entry => Object.freeze({...entry})))}));
    result.verify(); return result;
  }
  verify(): string {
    try { this.root.verify(); } catch { throw new SafeFsError('root-changed'); }
    verifyChain(this.value.directories); return this.value.path;
  }
  snapshot(): DirectorySnapshot { this.verify(); return this.value; }
  child(name: string): string { segment(name); return join(this.verify(), name); }
}

export type OwnedFile = Readonly<{dir: AnchoredDir; path: string; chain: ReadonlyArray<Identity>; identity: Identity}>;
export function captureFile(dir: AnchoredDir, path: string): OwnedFile {
  const base = dir.verify();
  if (!inside(base, path) || resolve(path) !== path) throw new SafeFsError('outside');
  const parent = AnchoredDir.capture(dirname(path), dir.root);
  parent.verify();
  const info = lstatSync(path, {bigint: true});
  if (info.isSymbolicLink()) throw new SafeFsError('symlink');
  if (!info.isFile()) throw new SafeFsError('not-regular');
  const file = Object.freeze({dir, path, chain: parent.snapshot().directories, identity: Object.freeze({path, dev: info.dev, ino: info.ino})});
  verifyFile(file); return file;
}
export function verifyFile(file: OwnedFile): string {
  // Once admitted, any changed component has the same public meaning: replaced.
  try {
    file.dir.verify(); verifyChain(file.chain);
    const info = lstatSync(file.path, {bigint: true});
    if (!info.isFile() || info.isSymbolicLink() || !same(info, file.identity)) throw new SafeFsError('replaced');
    return file.path;
  } catch (error) { if (error instanceof SafeFsError || missing(error)) throw new SafeFsError('replaced'); throw error; }
}
export function removeOwned(file: OwnedFile): 'removed' | 'missing' | 'replaced' {
  try {
    file.dir.verify(); verifyChain(file.chain);
    try { lstatSync(file.path, {bigint: true}); } catch (error) { if (missing(error)) return 'missing'; throw error; }
    verifyFile(file); unlinkSync(file.path); return 'removed';
  } catch (error) { if (error instanceof SafeFsError) return 'replaced'; if (missing(error)) return 'missing'; throw error; }
}
/** Bootstrap at explicit path admission only. Each missing component is created
 * through a captured existing ancestor; never use this to refresh an old anchor. */
export function prepareDirectory(path: string): AnchoredDir {
  if (!isAbsolute(path)) throw new SafeFsError('outside');
  const names: string[] = [];
  let current = resolve(path);
  for (;;) {
    try { lstatSync(current, {bigint: true}); break; }
    catch (error) {
      if (!missing(error) || dirname(current) === current) throw error;
      names.unshift(basename(current));
      current = dirname(current);
    }
  }
  // An existing selected directory must itself be a non-symlink. Ancestor aliases
  // (for example macOS /var) are canonicalized once at this ingress boundary.
  const root = ManagedRoot.capture(names.length ? realpathSync(current) : current);
  let dir = AnchoredDir.capture(root.verify(), root);
  for (const name of names) dir = ensureDirectory(dir, name);
  return dir;
}
/** Create a named directory only through a verified parent; existing entries must be real directories. */
export function ensureDirectory(dir: AnchoredDir, name: string): AnchoredDir {
  const path = dir.child(name);
  try { dir.verify(); mkdirSync(path, {mode: 0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return AnchoredDir.capture(path, dir.root);
}
/** Exclusive named creation is used by providers whose subprocess argv already owns the name. */
export function createDirectory(dir: AnchoredDir, name: string): AnchoredDir {
  const path = dir.child(name); dir.verify(); mkdirSync(path, {mode: 0o700}); return AnchoredDir.capture(path, dir.root);
}
export function createPrivateDir(dir: AnchoredDir, prefix: string): AnchoredDir {
  segment(prefix);
  const path = mkdtempSync(dir.child(prefix));
  return AnchoredDir.capture(path, dir.root);
}
export function removePrivateDir(priv: AnchoredDir): void {
  try { const path = priv.verify(); rmSync(path, {recursive: true, force: true}); }
  catch (error) { if (error instanceof SafeFsError || missing(error)) return; throw error; }
}
export function removeEmptyDir(dir: AnchoredDir): void { const path = dir.verify(); rmdirSync(path); }
export function openExclusive(dir: AnchoredDir, name: string, mode = 0o600): {fd: number; file: OwnedFile} {
  const path = dir.child(name);
  let fd: number;
  try { dir.verify(); fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeFsError('exists'); throw error; }
  try {
    const file = captureFile(dir, path);
    if (!same(fstatSync(fd, {bigint: true}), file.identity)) throw new SafeFsError('replaced');
    return {fd, file};
  } catch (error) { closeSync(fd); throw error; }
}
export function publishNoReplace(src: OwnedFile, dest: AnchoredDir, name: string): OwnedFile {
  const target = dest.child(name);
  verifyFile(src); dest.verify();
  let published: OwnedFile;
  try {
    linkSync(src.path, target);
    // Do not adopt a replacement that appeared between link and capture.
    published = captureFile(dest, target);
    if (!same(published.identity, src.identity)) throw new SafeFsError('replaced');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new SafeFsError('exists');
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '')) throw error;
    const opened = openExclusive(dest, name);
    published = opened.file;
    let input: number | undefined;
    try {
      verifyFile(src);
      input = openSync(src.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!same(fstatSync(input, {bigint: true}), src.identity)) throw new SafeFsError('replaced');
      const buffer = Buffer.alloc(64 * 1024);
      for (let count; (count = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
        verifyFile(src); verifyFile(published);
        for (let offset = 0; offset < count;) {
          verifyFile(src); verifyFile(published);
          offset += writeSync(opened.fd, buffer, offset, count - offset);
        }
      }
      verifyFile(src); verifyFile(published); fsyncSync(opened.fd);
    } catch (failure) { removeOwned(published); throw failure; }
    finally { if (input !== undefined) closeSync(input); closeSync(opened.fd); }
  }
  try {
    verifyFile(src); verifyFile(published);
    if (removeOwned(src) !== 'removed') throw new SafeFsError('replaced');
    return published;
  } catch (error) { removeOwned(published); throw error; }
}
/** Diagnostics can update only their captured regular file, through its verified descriptor. */
export function appendOwned(file: OwnedFile, line: string, limit: number): void {
  verifyFile(file);
  const fd = openSync(file.path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd, {bigint: true});
    if (!info.isFile() || !same(info, file.identity)) throw new SafeFsError('replaced');
    verifyFile(file);
    const next = Buffer.from(line), size = Number(info.size);
    const kept = Math.min(size, Math.max(0, limit - next.length));
    const tail = Buffer.alloc(kept); let offset = 0;
    while (offset < kept) { const count = readSync(fd, tail, offset, kept - offset, size - kept + offset); if (!count) break; offset += count; }
    const content = Buffer.concat([tail.subarray(0, offset), next]).subarray(-limit);
    verifyFile(file);
    for (let written = 0; written < content.length;) {
      verifyFile(file); written += writeSync(fd, content, written, content.length - written, written);
    }
    verifyFile(file); ftruncateSync(fd, content.length);
  } finally { closeSync(fd); }
}

/** Write only to the admitted inode, never truncate a pathname before checking it. */
export function writeOwned(file: OwnedFile, content: string): void {
  verifyFile(file);
  const fd = openSync(file.path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    if (!same(fstatSync(fd, {bigint: true}), file.identity)) throw new SafeFsError('replaced');
    const bytes = Buffer.from(content);
    for (let offset = 0; offset < bytes.length;) {
      verifyFile(file); offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    verifyFile(file); ftruncateSync(fd, bytes.length);
  } finally { closeSync(fd); }
}
export function writeExclusive(dir: AnchoredDir, name: string, content: string): OwnedFile {
  const opened = openExclusive(dir, name);
  try { writeOwned(opened.file, content); return opened.file; }
  finally { closeSync(opened.fd); }
}
/** Inventory a direct entry, including symlinks, without following it. */
export type OwnedEntry = Readonly<{dir: AnchoredDir; identity: Identity}>;
export function captureEntry(dir: AnchoredDir, name: string): OwnedEntry {
  const path = dir.child(name), info = lstatSync(path, {bigint: true});
  if (!info.isFile() && !info.isSymbolicLink()) throw new SafeFsError('not-regular');
  const entry = Object.freeze({dir, identity: Object.freeze({path, dev: info.dev, ino: info.ino})});
  verifyEntry(entry); return entry;
}
function verifyEntry(entry: OwnedEntry): void {
  entry.dir.verify();
  try { if (!same(lstatSync(entry.identity.path, {bigint: true}), entry.identity)) throw new SafeFsError('replaced'); }
  catch (error) { if (missing(error)) throw new SafeFsError('replaced'); throw error; }
}
export function removeEntry(entry: OwnedEntry): void { verifyEntry(entry); unlinkSync(entry.identity.path); }

/** Atomic metadata replacement: source and any existing destination are captured. */
export function replaceOwned(source: OwnedFile, dest: AnchoredDir, name: string): void {
  const target = dest.child(name);
  let previous: OwnedFile | null = null;
  try { previous = captureFile(dest, target); } catch (error) { if (!missing(error)) throw error; }
  verifyFile(source); dest.verify();
  if (previous) verifyFile(previous);
  else {
    try { lstatSync(target); throw new SafeFsError('exists'); }
    catch (error) { if (!missing(error)) throw error; }
  }
  renameSync(source.path, target);
}
