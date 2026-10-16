// Cooperative process locks. A live owner is never displaced, regardless of age.
import { closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const LOCK_STALE_MS = 60_000;

type Snapshot = { dev: number; ino: number; mtimeMs: number; encoded: string; pid: number | null };
export type FileLock = { release(): void };
function snapshot(file: string): Snapshot | null {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe lock file.');
    const encoded = readFileSync(file, 'utf8');
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { value = null; }
    // Accept the old history PID-only format during upgrade.
    const pid = typeof value === 'number' ? value : (value as {pid?: unknown} | null)?.pid;
    return {dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, encoded, pid: Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : null};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function recoverable(owner: Snapshot): boolean {
  // Previous versions created the lock before writing its owner. Preserve a
  // possible writer mid-write, but recover old empty/corrupt files after 60s.
  if (owner.pid === null) return Date.now() - owner.mtimeMs >= LOCK_STALE_MS;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function unlinkOwned(file: string, owner: Snapshot, recovering = false): void {
  const current = snapshot(file);
  if (current?.dev === owner.dev && current.ino === owner.ino && current.encoded === owner.encoded && (!recovering || recoverable(current))) unlinkSync(file);
}
function publish(file: string): FileLock | null {
  // Publish complete owner data atomically: a crash cannot leave an empty lock.
  const candidate = `${file}.${randomUUID()}.owner`;
  const fd = openSync(candidate, 'wx', 0o600);
  let linked = false;
  let owner!: Snapshot;
  try {
    const encoded = JSON.stringify({pid: process.pid, token: randomUUID(), createdAt: Date.now()});
    writeFileSync(fd, encoded);
    // Capture release authority before publication; no fallible pathname read
    // or candidate cleanup may strand a successfully linked live-owner lock.
    const info = fstatSync(fd);
    owner = {dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, encoded, pid: process.pid};
    try { linkSync(candidate, file); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally {
    try { closeSync(fd); } catch { /* Retain release authority if descriptor cleanup fails. */ }
    try { unlinkSync(candidate); } catch { /* Candidate litter must not strand the shared lock. */ }
  }
  if (!linked) return null;
  return {release: () => unlinkOwned(file, owner)};
}
/** Nonblocking acquisition. Recover dead PIDs or aged legacy locks without a valid owner. */
export function tryAcquireFileLock(file: string, recoveryDepth = 0): FileLock | null {
  const acquired = publish(file);
  if (acquired) return acquired;
  const before = snapshot(file);
  if (!before || !recoverable(before) || recoveryDepth >= 8) return null;
  // Serialize stale-owner recovery. Re-read INSIDE this guard: a contender may
  // have replaced the pathname while we waited. A crashed guard is recovered
  // by the same protocol at the next level; excessive crash chains fail closed.
  const recovery = tryAcquireFileLock(`${file}.recovery`, recoveryDepth + 1);
  if (!recovery) return null;
  try {
    const current = snapshot(file);
    if (current && recoverable(current)) unlinkOwned(file, current, true);
    return publish(file);
  } finally { recovery.release(); }
}
