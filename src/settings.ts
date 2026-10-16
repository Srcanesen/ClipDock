// Main-process settings persistence. Electron-free so tests can exercise the
// store directly; main.ts supplies the real paths (app.getPath('userData')).
// The store is a small JSON file written atomically (temp file + rename) and
// every value is re-validated on load, so a corrupt or stale file falls back
// to the default Downloads/ClipDock folder instead of failing.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ManagedRoot } from './managed-root';
import { canonicalRoot } from './path-boundary';
import { randomUUID } from 'node:crypto';

/** Subfolder name under the OS Downloads folder used when no folder is chosen. */
export const DEFAULT_DOWNLOAD_FOLDER_NAME = 'ClipDock';
/** Identifies a custom directory whose contents ClipDock may manage. */
export const DOWNLOAD_FOLDER_MARKER = '.clipdock-owned';
const MARKER_CONTENT = 'ClipDock managed download folder\n';

export interface DownloadFolderValue {
  folder: string;
  /** True when the user explicitly chose this folder and it was persisted. */
  userSelected: boolean;
}

/** Default managed folder: <OS downloads>/ClipDock. */
export function defaultDownloadFolder(downloadsPath: string): string {
  return join(downloadsPath, DEFAULT_DOWNLOAD_FOLDER_NAME);
}

/** Accept only an absolute path to an existing directory. */
export function usableDownloadFolder(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  try {
    const st = lstatSync(value);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  return value;
}

/** True only for directories carrying ClipDock's regular-file ownership marker. */
export function ownedDownloadFolder(value: unknown): string | null {
  const folder = usableDownloadFolder(value);
  if (!folder) return null;
  try {
    const marker = join(folder, DOWNLOAD_FOLDER_MARKER);
    if (!lstatSync(marker).isFile() || readFileSync(marker, 'utf8') !== MARKER_CONTENT) return null;
    return folder;
  } catch {
    return null;
  }
}

/** Claim a custom directory, or reselect the implicitly managed default folder. */
export function claimDownloadFolder(root: ManagedRoot, defaultFolder?: string): void {
  const folder = root.verify();
  const isDefault = defaultFolder !== undefined && canonicalRoot(defaultFolder) === folder;
  const marker = join(folder, DOWNLOAD_FOLDER_MARKER);
  let createdMarker = false;
  try {
    if (!ownedDownloadFolder(root.verify())) {
      if (!isDefault && readdirSync(root.verify()).some((name) => !name.startsWith('.'))) throw new Error('The selected folder must be empty or already owned by ClipDock.');
      root.verify();
      writeFileSync(marker, MARKER_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      createdMarker = true;
      if (!isDefault && readdirSync(root.verify()).some((name) => name !== DOWNLOAD_FOLDER_MARKER && !name.startsWith('.'))) {
        throw new Error('The selected folder changed while ClipDock was preparing it.');
      }
    }
    const probe = join(root.verify(), `.clipdock-write-test-${randomUUID()}.tmp`);
    try { root.verify(); writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); }
    finally { root.verify(); rmSync(probe, { force: true }); }
  } catch (error) {
    if (createdMarker) { root.verify(); rmSync(marker, { force: true }); }
    throw error;
  }
}

/** Path ingress for settings callers; live folder changes use claimDownloadFolder. */
export function prepareCustomDownloadFolder(value: unknown): string {
  const folder = usableDownloadFolder(value);
  if (!folder) throw new Error('The selected download folder is not usable.');
  const root = ManagedRoot.capture(folder);
  claimDownloadFolder(root);
  root.verify();
  return folder;
}

/**
 * Load the persisted download folder. Custom values require the ownership
 * marker; unsafe, missing, or corrupt values fall back without being mutated.
 */
export function loadDownloadFolder(file: string, downloadsPath: string): DownloadFolderValue {
  const fallback = defaultDownloadFolder(downloadsPath);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { downloadFolder?: unknown };
    const folder = usableDownloadFolder(raw?.downloadFolder);
    if (folder && (resolve(folder) === resolve(fallback) || ownedDownloadFolder(folder))) {
      return { folder, userSelected: true };
    }
  } catch {
    /* missing or corrupt settings fall back to the default */
  }
  return { folder: fallback, userSelected: false };
}

/** Persist an owned folder atomically (temp file + rename). */
export function saveDownloadFolder(file: string, folder: ManagedRoot | string): void {
  if (typeof folder === 'string' && !ownedDownloadFolder(folder)) throw new Error('The selected download folder is not safely owned by ClipDock.');
  const root = typeof folder === 'string' ? ManagedRoot.capture(folder) : folder;
  root.verify();
  const safe = ownedDownloadFolder(typeof folder === 'string' ? folder : root.verify());
  if (!safe) throw new Error('The selected download folder is not safely owned by ClipDock.');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ downloadFolder: safe }, null, 2), { mode: 0o600 });
    root.verify();
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Validate every provider directory before changing any live worker root. */
export function prepareManagedDownloadFolder(folder: string): string {
  return ManagedRoot.prepare(folder).verify();
}
