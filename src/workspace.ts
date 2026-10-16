// Managed download workspace. Renderer receives only aggregate counts, never paths.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { AnchoredDir, captureFile, removeEmptyDir, removeOwned, verifyFile, type OwnedFile } from './safe-fs';
import { ManagedRoot, type RootIdentity } from './managed-root';

export type WorkspaceSummary = { fileCount: number; totalBytes: number; cleanupFileCount: number; cleanupBytes: number };
export type WorkspaceCleanupResult = { deletedFileCount: number; deletedBytes: number; fileCount: number; totalBytes: number };

type File = { path: string; bytes: number; owned: OwnedFile };
type WorkspaceFileClass = 'media' | 'companion' | 'transient' | 'diagnostic';
const PROVIDER_DIRECTORIES = ['youtube', 'social', 'pexels', 'pinterest'] as const;
// Subtitles are user content but are classified separately from media so counts
// stay truthful; transient partial/temp files and the diagnostic log are never
// presented as stored media. Anything else keeps the historical default (counted).
const COMPANION_EXTENSIONS = new Set(['.srt']);
const TRANSIENT_EXTENSIONS = new Set(['.part', '.tmp', '.temp', '.ytdl']);
const DIAGNOSTIC_NAMES = new Set(['clipdock.log']);

function classifyFile(name: string): WorkspaceFileClass {
  const ext = extname(name).toLowerCase();
  if (DIAGNOSTIC_NAMES.has(name)) return 'diagnostic';
  if (TRANSIENT_EXTENSIONS.has(ext)) return 'transient';
  if (COMPANION_EXTENSIONS.has(ext)) return 'companion';
  return 'media';
}

// String input is an ingress adapter for older callers; workers always receive identity snapshots.
const legacyRoots = new Map<string, ManagedRoot>();
function captured(root: ManagedRoot | string): ManagedRoot {
  if (typeof root !== 'string') return root;
  let value = legacyRoots.get(root);
  if (!value) { value = ManagedRoot.capture(root); legacyRoots.set(root, value); }
  value.verify();
  return value;
}
function files(root: ManagedRoot): File[] {
  const anchor = AnchoredDir.capture(root.verify(), root), found: File[] = [];
  const visit = (dir: AnchoredDir, top = false): void => {
    for (const name of readdirSync(dir.verify())) {
      if (top && name.startsWith('.')) continue;
      try {
        const candidate = dir.child(name), info = lstatSync(candidate);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (!top || PROVIDER_DIRECTORIES.includes(name as typeof PROVIDER_DIRECTORIES[number])) visit(AnchoredDir.capture(candidate, root));
        } else if (info.isFile()) {
          const owned = captureFile(dir, candidate);
          found.push({path: owned.path, bytes: Number(lstatSync(verifyFile(owned), {bigint: true}).size), owned});
        }
      } catch { /* vanished or changed descendant */ }
    }
  };
  visit(anchor, true); root.verify(); return found;
}
const fileIdentity = (file: OwnedFile): string => `${file.identity.dev}:${file.identity.ino}`;
function protectedFiles(root: ManagedRoot, paths: Iterable<string>): Set<string> {
  const safe = new Set<string>(), anchor = AnchoredDir.capture(root.verify(), root);
  for (const candidate of paths) {
    try { safe.add(fileIdentity(captureFile(anchor, realpathSync(candidate)))); } catch { /* stale card */ }
  }
  return safe;
}
function pruneEmptyDirectories(root: ManagedRoot): void {
  const anchor = AnchoredDir.capture(root.verify(), root);
  const visit = (directory: AnchoredDir): void => {
    for (const name of readdirSync(directory.verify())) {
      try {
        const candidate = directory.child(name), info = lstatSync(candidate);
        if (info.isDirectory() && !info.isSymbolicLink()) visit(AnchoredDir.capture(candidate, root));
      } catch { /* vanished or changed descendant */ }
    }
    try { if (readdirSync(directory.verify()).length === 0) removeEmptyDir(directory); } catch { /* changed or no longer empty */ }
  };
  for (const name of PROVIDER_DIRECTORIES) {
    try { visit(AnchoredDir.capture(anchor.child(name), root)); } catch { /* missing or changed provider */ }
  }
  root.verify();
}

export function inspectWorkspace(inputRoot: ManagedRoot | string, protectedPaths: Iterable<string>): WorkspaceSummary {
  const root = captured(inputRoot);
  const all = files(root);
  const protectedSet = protectedFiles(root, protectedPaths);
  // User-facing counts: media + companions only. Transient partial/temp files
  // and the diagnostic log are never presented as stored media.
  const content = all.filter((file) => {
    const cls = classifyFile(basename(file.path));
    return cls !== 'transient' && cls !== 'diagnostic';
  });
  // Cleanup accounting: every unprotected file cleanup will actually delete,
  // including stale transient/diagnostic files (safe once idle).
  const cleanup = all.filter((file) => !protectedSet.has(fileIdentity(file.owned)));
  return {
    fileCount: content.length,
    totalBytes: content.reduce((sum, file) => sum + file.bytes, 0),
    cleanupFileCount: cleanup.length,
    cleanupBytes: cleanup.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function cleanupWorkspace(inputRoot: ManagedRoot | string, protectedPaths: Iterable<string>): WorkspaceCleanupResult {
  const root = captured(inputRoot);
  root.verify();
  const protectedSet = protectedFiles(root, protectedPaths);
  let deletedFileCount = 0;
  let deletedBytes = 0;
  for (const file of files(root)) {
    if (protectedSet.has(fileIdentity(file.owned))) continue;
    try {
      if (removeOwned(file.owned) !== 'removed') continue;
      deletedFileCount += 1;
      deletedBytes += file.bytes;
    } catch { /* vanished or changed file */ }
  }
  pruneEmptyDirectories(root);
  const remaining = inspectWorkspace(root, protectedPaths);
  return { deletedFileCount, deletedBytes, fileCount: remaining.fileCount, totalBytes: remaining.totalBytes };
}

// Keep filesystem traversal off Electron's event loop. Equal status requests share one inventory.
const pendingInspections = new Map<string, Promise<WorkspaceSummary>>();
function workspaceWorker<T>(root: RootIdentity, protectedPaths: string[], cleanup: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { clipdockWorkspace: true, root, protectedPaths, cleanup } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Workspace scan exited with code ${code}.`)); });
  });
}
export function inspectWorkspaceAsync(inputRoot: ManagedRoot | string, protectedPaths: Iterable<string>): Promise<WorkspaceSummary> {
  const root = captured(inputRoot).snapshot();
  const paths = [...protectedPaths].sort();
  const key = JSON.stringify([root, paths]);
  const pending = pendingInspections.get(key);
  if (pending) return pending;
  const result = workspaceWorker<WorkspaceSummary>(root, paths, false).finally(() => pendingInspections.delete(key));
  pendingInspections.set(key, result);
  return result;
}
export function cleanupWorkspaceAsync(inputRoot: ManagedRoot | string, protectedPaths: Iterable<string>): Promise<WorkspaceCleanupResult> {
  return workspaceWorker(captured(inputRoot).snapshot(), [...protectedPaths], true);
}
if (!isMainThread && workerData?.clipdockWorkspace) {
  const { root, protectedPaths, cleanup } = workerData;
  parentPort!.postMessage(cleanup ? cleanupWorkspace(ManagedRoot.restore(root), protectedPaths) : inspectWorkspace(ManagedRoot.restore(root), protectedPaths));
}
