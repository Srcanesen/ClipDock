import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 1000;

export function hasWindowsScriptingConnection(listing, pid) {
  return listing.split(/\r?\n/).some(row => row.trim() === String(pid));
}

function connectionEstablished(pid, timeout) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error('Invalid Resolve process ID');
  // The cmdlet reports an empty result as ObjectNotFound on Windows PowerShell.
  const command = [
    `Get-NetTCPConnection -OwningProcess ${pid} -RemoteAddress 127.0.0.1 -RemotePort 1144 -State Established -ErrorAction SilentlyContinue -ErrorVariable queryErrors | Select-Object -First 1 -ExpandProperty OwningProcess`,
    "if ($queryErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }) { exit 1 }",
    'exit 0',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout });
  if (result.error || result.status !== 0) {
    throw new Error(`Windows scripting connection check failed: ${result.error?.message ?? `PowerShell exit ${result.status}`}`);
  }
  return hasWindowsScriptingConnection(result.stdout, pid);
}

export async function waitForWindowsScriptingServer(child, timeoutMs, { connected = connectionEstablished } = {}) {
  const deadline = Date.now() + timeoutMs;
  let remaining = timeoutMs;
  while (remaining > 0) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Resolve exited before connecting to its Windows scripting server');
    const nextPoll = Math.min(Date.now() + POLL_MS, deadline);
    // An early external scriptapp client can interfere with Resolve's own fuscript handshake.
    if (connected(child.pid, Math.min(remaining, 3000))) return Math.max(1, deadline - Date.now());
    await sleep(Math.max(0, nextPoll - Date.now()));
    remaining = deadline - Date.now();
  }
  throw new Error(`Resolve did not connect to its Windows scripting server within ${timeoutMs} ms`);
}
