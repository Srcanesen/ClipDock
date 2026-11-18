import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCAL_SCRIPT_SERVER = '127.0.0.1:1144';
const POLL_MS = 250;

export function hasWindowsScriptingConnection(listing, pid) {
  return listing.split(/\r?\n/).some(row => {
    const columns = row.trim().split(/\s+/);
    const [protocol, local, remote] = columns;
    return protocol === 'TCP' && local?.startsWith('127.0.0.1:') &&
      remote === LOCAL_SCRIPT_SERVER && columns.at(-1) === String(pid);
  });
}

function connectionEstablished(pid, timeout) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout });
  if (result.error || result.status !== 0) {
    throw new Error(`Windows scripting connection check failed: ${result.error?.message ?? `netstat exit ${result.status}`}`);
  }
  return hasWindowsScriptingConnection(result.stdout, pid);
}

export async function waitForWindowsScriptingServer(child, timeoutMs, { connected = connectionEstablished } = {}) {
  const deadline = Date.now() + timeoutMs;
  let remaining = timeoutMs;
  while (remaining > 0) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Resolve exited before connecting to its Windows scripting server');
    // An early external scriptapp client can interfere with Resolve's own fuscript handshake.
    if (connected(child.pid, Math.min(remaining, 3000))) return Math.max(1, deadline - Date.now());
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    remaining = deadline - Date.now();
  }
  throw new Error(`Resolve did not connect to its Windows scripting server within ${timeoutMs} ms`);
}
