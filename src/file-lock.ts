import { closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { uptime } from 'node:os';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { matchesWindowsFileDescriptor } from './safe-fs';

const LOCK_STALE_MS = 60_000;

// Clock steps after boot shift this estimate; the margin keeps a current-boot owner live.
const BOOT_MARGIN_MS = 60_000;
// Allow small backward clock steps between process start and lock creation.
const PID_REUSE_MARGIN_MS = 5 * 60 * 1000;

type Snapshot = { dev: number | bigint; ino: number | bigint; mtimeMs: number; encoded: string; pid: number | null; createdAt: number | null };
export type FileLock = { release(): void };
/** Earliest possible start of the live process `pid`, epoch ms; undefined when it cannot be determined. */
export type ProcessStartProbe = (pid: number) => number | undefined;
export const probeProcessStart: ProcessStartProbe = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']};
    if (process.platform === 'win32') {
      const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`], options).trim();
      const startedAt = /^-?\d+$/.test(output) ? Number(output) : NaN;
      return Number.isFinite(startedAt) ? startedAt : undefined;
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
    const sampledFrom = Date.now();
    const output = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], options).trim();
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/.exec(output);
    if (!match) return undefined;
    const days = Number(match[1] ?? 0), hours = Number(match[2] ?? 0), minutes = Number(match[3]), seconds = Number(match[4]);
    if (minutes >= 60 || seconds >= 60 || (match[1] !== undefined && hours >= 24)) return undefined;
    const elapsedMs = ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
    return Number.isFinite(elapsedMs) ? sampledFrom - elapsedMs - 1000 : undefined;
  } catch { return undefined; }
};
function snapshot(file: string): Snapshot | null {
  try {
    const info = process.platform === 'win32' ? lstatSync(file, {bigint: true}) : lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe lock file.');
    const encoded = readFileSync(file, 'utf8');
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { value = null; }
    // Accept the old history PID-only format during upgrade.
    const pid = typeof value === 'number' ? value : (value as {pid?: unknown} | null)?.pid;
    const createdAt = (value as {createdAt?: unknown} | null)?.createdAt;
    return {dev: info.dev, ino: info.ino, mtimeMs: Number(info.mtimeMs), encoded, pid: Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : null, createdAt: Number.isFinite(createdAt) ? Number(createdAt) : null};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function recoverable(owner: Snapshot, processStartProbe: ProcessStartProbe): boolean {
  if (owner.pid === null) return Date.now() - owner.mtimeMs >= LOCK_STALE_MS;
  if (owner.pid === process.pid) return false;
  if (owner.createdAt !== null && owner.createdAt < Date.now() - uptime() * 1000 - BOOT_MARGIN_MS) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (owner.createdAt === null) return false;
  const startedAt = processStartProbe(owner.pid);
  return startedAt !== undefined && startedAt > owner.createdAt + PID_REUSE_MARGIN_MS;
}
function unlinkOwned(file: string, owner: Snapshot, recovering = false, processStartProbe: ProcessStartProbe = probeProcessStart): void {
  const current = snapshot(file);
  if (current?.dev === owner.dev && current.ino === owner.ino && current.encoded === owner.encoded && (!recovering || recoverable(current, processStartProbe))) unlinkSync(file);
}
function publish(file: string): FileLock | null {
  // Publish complete owner data atomically: a crash cannot leave an empty lock.
  const candidate = `${file}.${randomUUID()}.owner`;
  const fd = openSync(candidate, 'wx', 0o600);
  let linked = false;
  let owner!: Snapshot;
  try {
    const createdAt = Date.now();
    const encoded = JSON.stringify({pid: process.pid, token: randomUUID(), createdAt});
    writeFileSync(fd, encoded);
    const named = process.platform === 'win32' ? lstatSync(candidate, {bigint: true}) : null;
    if (named && !matchesWindowsFileDescriptor(named, fstatSync(fd, {bigint: true}))) throw new Error('Unsafe lock file.');
    const info = named ?? fstatSync(fd);
    owner = {dev: info.dev, ino: info.ino, mtimeMs: Number(info.mtimeMs), encoded, pid: process.pid, createdAt};
    try { linkSync(candidate, file); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally {
    try { closeSync(fd); } catch { /* Retain release authority if descriptor cleanup fails. */ }
    try { unlinkSync(candidate); } catch { /* Candidate litter must not strand the shared lock. */ }
  }
  if (!linked) return null;
  return {release: () => unlinkOwned(file, owner)};
}
/** Try to acquire, recovering dead owners or aged legacy locks without a valid owner. */
export function tryAcquireFileLock(file: string, recoveryDepth = 0, processStartProbe: ProcessStartProbe = probeProcessStart): FileLock | null {
  const acquired = publish(file);
  if (acquired) return acquired;
  const before = snapshot(file);
  if (!before || !recoverable(before, processStartProbe) || recoveryDepth >= 8) return null;
  // Serialize stale-owner recovery. Re-read INSIDE this guard: a contender may
  // have replaced the pathname while we waited. A crashed guard is recovered
  // by the same protocol at the next level; excessive crash chains fail closed.
  const recovery = tryAcquireFileLock(`${file}.recovery`, recoveryDepth + 1, processStartProbe);
  if (!recovery) return null;
  try {
    const current = snapshot(file);
    if (current && recoverable(current, processStartProbe)) unlinkOwned(file, current, true, processStartProbe);
    return publish(file);
  } finally { recovery.release(); }
}
