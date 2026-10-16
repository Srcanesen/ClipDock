// Managed-root identity and path-safety boundaries.
// Canonical helpers: symlink rejection, realpath canonicalization, relative+isAbsolute containment.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** Canonical roots are accepted only when both the supplied and resolved directory are non-symlinks. */
export function canonicalRoot(root: unknown): string | null {
  try {
    if (typeof root !== 'string' || !isAbsolute(root)) return null;
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const resolved = realpathSync(root);
    const canonical = lstatSync(resolved);
    return canonical.isDirectory() && !canonical.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

/** Canonicalizes both via realpath/lstat; rejects symlink roots; strict inside ('' => false). */
export function contains(root: string, file: string): boolean {
  try {
    const canonical = canonicalRoot(root);
    if (!canonical) return false;
    if (typeof file !== 'string' || !isAbsolute(file)) return false;
    const resolved = realpathSync(file);
    const rel = relative(canonical, resolved);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** lstat symlink guard + statSync isFile + realpath (single stat on canonical, matching r2 fix). */
export function regularFile(p: string): string | null {
  try {
    const info = lstatSync(p);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const resolved = realpathSync(p);
    const st = statSync(resolved);
    return st.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Electron-free, fail-closed file-safety helper. Requires an absolute, existing
 * regular file, rejects symlinks via lstat, canonicalizes via realpath, and when
 * a trusted root is supplied enforces canonical containment and returns the validated canonical path.
 * File == root is considered contained (directory vs file never equal in practice,
 * but preserved for backwards compatibility).
 */
export function canonicalMediaPath(filePath: unknown, trustedRoot?: unknown, requireCanonicalRoot = false): string | null {
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    if (!isAbsolute(filePath)) return null;
    const canonicalFile = regularFile(filePath);
    if (!canonicalFile) return null;
    if (trustedRoot === undefined) return canonicalFile;
    if (typeof trustedRoot !== 'string' || trustedRoot.length === 0) return null;
    if (!isAbsolute(trustedRoot)) return null;
    const canonical = canonicalRoot(trustedRoot);
    if (!canonical || (requireCanonicalRoot && canonical !== trustedRoot)) return null;
    const rel = relative(canonical, canonicalFile);
    if (rel === '') return canonicalFile;
    if (isAbsolute(rel)) return null;
    if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}

export function isSafeMediaFile(filePath: unknown, trustedRoot?: unknown): boolean {
  return canonicalMediaPath(filePath, trustedRoot) !== null;
}
