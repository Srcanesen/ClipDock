/**
 * Process primitives for the ClipDock Resolve headless smoke harness.
 *
 * Direct-binary spawn with -nogui (never `open -a`), bounded output capture,
 * bounded shutdown, and exact-name process accounting via pgrep or tasklist.
 * Tests use plain `node -e` / `sleep` children, never Resolve.
 */

import { spawn, spawnSync } from 'node:child_process';
import { sanitizeMessage } from './report.mjs';

/**
 * Ring buffer that keeps only the newest `limit` bytes of a stream so Resolve
 * stderr/stdout can never exhaust memory or the JSON report.
 */
export class BoundedBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (buf.length === 0) {
      return;
    }
    if (buf.length >= this.limit) {
      this.chunks = [buf.subarray(buf.length - this.limit)];
      this.size = this.limit;
      return;
    }
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (this.size - head.length >= this.limit) {
        this.size -= head.length;
        this.chunks.shift();
      } else {
        const drop = this.size - this.limit;
        this.chunks[0] = head.subarray(drop);
        this.size = this.limit;
      }
    }
  }

  toString() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Spawns the Resolve binary directly with -nogui. Never uses `open -a`. */
export function spawnResolve(binary, { env }) {
  const child = spawn(binary, ['-nogui'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.launch = new Promise((resolve) => {
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (error) => { child.launchError = error; resolve({ ok: false, error }); });
  });
  return child;
}

function sendSignal(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Process already gone; treat as delivered.
  }
}

export function killWindowsTree(child) {
  // Use only our live ChildProcess, never a PID found in a process listing.
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
}

/**
 * Resolves with {kind:'exited', exitCode, signal} when the child exits,
 * {kind:'timeout'} after `ms`, or {kind:'error', error} if the spawn failed
 * asynchronously (e.g. EACCES).
 */
export function waitForExit(child, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onExit = (code, signal) => finish({ kind: 'exited', exitCode: code, signal });
    const onError = (error) => finish({ kind: 'error', error });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), ms);
    if (child.launchError) {
      finish({ kind: 'error', error: child.launchError });
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ kind: 'exited', exitCode: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Bounded shutdown ladder: wait `graceMs` for the app to honor Quit(), then
 * SIGTERM and wait `termMs` on macOS, then force termination and wait
 * `killMs`. Windows force-terminates only the owned process tree.
 *
 * Resolves with {kind, ms, ...}: 'graceful' | 'terminated' | 'killed' when the
 * process exited, 'error' when the child never spawned, 'still-running' when
 * the process survived the whole ladder.
 */
export async function shutdown(child, { graceMs, termMs, killMs, waitFor = waitForExit, signal = sendSignal, platform = process.platform, killTree = killWindowsTree }) {
  const startedAt = Date.now();
  const first = await waitFor(child, graceMs);
  if (first.kind === 'exited') {
    return { kind: 'graceful', ms: Date.now() - startedAt, exitCode: first.exitCode, signal: first.signal };
  }
  if (first.kind === 'error') {
    return { kind: 'error', ms: Date.now() - startedAt, error: first.error };
  }
  if (platform === 'win32') {
    killTree(child);
  } else {
    signal(child, 'SIGTERM');
    const second = await waitFor(child, termMs);
    if (second.kind === 'exited') {
      return { kind: 'terminated', ms: Date.now() - startedAt, exitCode: second.exitCode, signal: second.signal };
    }
    if (second.kind === 'error') {
      return { kind: 'error', ms: Date.now() - startedAt, error: second.error };
    }
    signal(child, 'SIGKILL');
  }
  const third = await waitFor(child, killMs);
  if (third.kind === 'exited') {
    return { kind: 'killed', ms: Date.now() - startedAt, exitCode: third.exitCode, signal: third.signal };
  }
  return { kind: 'still-running', ms: Date.now() - startedAt };
}

export function parseTasklist(output, image) {
  const lines = output.trim().split(/\r?\n/).filter(line => line.trim() !== '');
  if (!lines.length) throw new Error('tasklist returned no process rows');
  const pids = [];
  for (const line of lines) {
    const row = /^"((?:[^"]|"")*)","(\d+)"(?:,"(?:[^"]|"")*"){3}$/.exec(line);
    if (!row) throw new Error('tasklist returned invalid process data');
    if (row[1].toLowerCase() !== image.toLowerCase()) continue;
    const pid = Number(row[2]);
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff || pids.includes(pid)) throw new Error('tasklist returned invalid process IDs');
    pids.push(pid);
  }
  return pids;
}

/**
 * Exact-name process accounting. Throws when enumeration fails so callers
 * can fail safe.
 */
export function collectProcesses(comm, platform = process.platform) {
  if (platform === 'win32') {
    const res = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (res.error) throw new Error(`tasklist failed: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`tasklist exited with status ${res.status}`);
    return parseTasklist(res.stdout, `${comm}.exe`);
  }
  let res;
  try {
    res = spawnSync('pgrep', ['-x', comm], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`pgrep failed: ${err.message}`);
  }
  if (res.error) {
    throw new Error(`pgrep failed: ${res.error.message}`);
  }
  if (res.status === 1) {
    return []; // pgrep exit 1 = no match
  }
  if (res.status !== 0) {
    throw new Error(`pgrep exited with status ${res.status}`);
  }
  const lines = res.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.some(pid => !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0)) {
    throw new Error('pgrep returned invalid process IDs');
  }
  return lines.map(Number);
}

export const collectResolveProcesses = () => collectProcesses('Resolve');

/**
 * Pre-flight refusal seam: refuses when Resolve or fuscript is already
 * active. The collector is injectable for deterministic tests.
 */
export function assertNoResolveRunning(collect = collectProcesses) {
  const pids = collect('Resolve');
  const fuscriptPids = collect('fuscript');
  return { ok: pids.length === 0 && fuscriptPids.length === 0, pids, fuscriptPids };
}

export function activeProcessMessage({pids, fuscriptPids = []}) {
  return `refusing to run: Resolve pids: ${pids.join(', ') || 'none'}; fuscript pids: ${fuscriptPids.join(', ') || 'none'}`;
}

/**
 * Residue evidence: live `Resolve` and `fuscript` process counts. When enumeration
 * fails the result is {ok:false, residue:{resolve:-1,fuscript:-1}, error}
 * so callers fail safe and can never treat unknown residue as success (the
 * harness must exit cleanup-failed, never 0). The collector is injectable for
 * deterministic tests (test/resolve-headless-process.test.mjs).
 */
export function collectResidue({ collect = collectProcesses } = {}) {
  try {
    return {
      ok: true,
      residue: { resolve: collect('Resolve').length, fuscript: collect('fuscript').length },
    };
  } catch (err) {
    return {
      ok: false,
      residue: { resolve: -1, fuscript: -1 },
      error: { code: 'residue-check-failed', message: sanitizeMessage(err?.message ?? String(err)) },
    };
  }
}
