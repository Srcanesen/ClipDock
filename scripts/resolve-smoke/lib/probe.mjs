/**
 * Probe orchestration for the ClipDock Resolve headless smoke harness.
 *
 * Runs probe.py under the official scripting environment, captures bounded
 * output, and parses the single marked JSON line the probe emits. Deterministic
 * unit-test seam (test/resolve-headless-result.test.mjs): tests feed fake
 * probe scripts and injected waitFor fns, never a real Resolve.
 */

import { spawn, spawnSync } from 'node:child_process';
import { checksSucceeded, sanitizeMessage } from './report.mjs';
import { BoundedBuffer, waitForExit } from './spawn.mjs';

export const PROBE_OUTPUT_LIMIT = 64 * 1024;
export const PROBE_STDERR_LIMIT = 4096;
/** Extra node-side margin beyond the probe's own internal deadline. */
export const PROBE_WAIT_MARGIN_MS = 3000;
/** Marker prefix for the single JSON line probe.py emits. */
export const PROBE_MARKER = 'CLIPDOCK_SMOKE_JSON:';

/**
 * Parses the marked JSON line from the probe's stdout. Never trusts more than
 * the final line, so a chatty fusionscript bootstrap cannot corrupt results.
 */
export function parseProbeOutput(text) {
  const input = String(text ?? '');
  const idx = input.lastIndexOf(PROBE_MARKER);
  if (idx === -1) {
    return { ok: false, error: { code: 'probe-output-missing', message: 'probe produced no CLIPDOCK_SMOKE_JSON line' } };
  }
  const line = input.slice(idx + PROBE_MARKER.length).split('\n')[0].trim();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: 'probe-output-invalid', message: 'probe JSON payload could not be parsed' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { code: 'probe-output-invalid', message: 'probe JSON payload is not an object' } };
  }
  return {
    ok: parsed.ok === true,
    checks: parsed.checks ?? null,
    readiness: parsed.readiness ?? null,
    quitRequested: parsed.quitRequested === true,
    quitError: parsed.quitError ?? null,
    error: parsed.error ?? null,
  };
}

function runPythonVersion(python) {
  try {
    const res = spawnSync(python, ['--version'], { encoding: 'utf8' });
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    return { ok: res.status === 0 && text.length > 0, version: text };
  } catch {
    return { ok: false, version: '' };
  }
}

/**
 * Official scripting prerequisite: Python >= 3.6 64-bit (Resolve Scripting
 * README "Prerequisites"). `run` is injectable for deterministic tests.
 */
export function checkPython(python, { run = runPythonVersion } = {}) {
  const res = run(python);
  if (!res.ok) {
    return { ok: false, error: { code: 'python-not-found', message: `python executable not runnable: ${python} (use --python to override)` } };
  }
  const m = /Python\s+(\d+)\.(\d+)/.exec(res.version);
  if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 6)) {
    return { ok: false, error: { code: 'python-too-old', message: `Python >= 3.6 required, got "${res.version || 'unknown'}"` } };
  }
  return { ok: true, version: res.version };
}

/**
 * Runs probe.py with the official scripting env and a bounded deadline.
 * mode 'probe' performs the read-only checks; mode 'quit-only' only connects
 * and requests Quit (best-effort fallback after a failed probe).
 */
export async function runProbe({ python, probeScript, env, timeoutMs, mode = 'probe', waitFor = waitForExit }) {
  const child = spawn(
    python,
    [probeScript],
    {
      env: {
        ...env,
        RESOLVE_SMOKE_DEADLINE_MS: String(Math.max(1, Math.floor(timeoutMs))),
        RESOLVE_SMOKE_QUIT_ONLY: mode === 'quit-only' ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = new BoundedBuffer(PROBE_OUTPUT_LIMIT);
  const stderr = new BoundedBuffer(PROBE_STDERR_LIMIT);
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const startedAt = Date.now();
  const waited = await waitFor(child, timeoutMs + PROBE_WAIT_MARGIN_MS);
  const ms = Date.now() - startedAt;
  const output = stdout.toString();
  if (waited.kind !== 'exited') {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    if (waited.kind === 'error') {
      return {
        ok: false,
        exitCode: null,
        ms,
        output,
        stderr: stderr.toString(),
        quitRequested: false,
        quitError: null,
        error: { code: 'probe-spawn-failed', message: sanitizeMessage(waited.error?.message ?? String(waited.error)) },
      };
    }
    return {
      ok: false,
      exitCode: null,
      ms,
      output,
      stderr: stderr.toString(),
      quitRequested: false,
      quitError: null,
      error: { code: 'probe-timeout', message: `probe did not finish within ${timeoutMs} ms` },
    };
  }
  const parsed = parseProbeOutput(output);
  return {
    ok: waited.exitCode === 0 && parsed.ok && (mode === 'quit-only' || checksSucceeded(parsed.checks)),
    exitCode: waited.exitCode,
    ms,
    output,
    stderr: stderr.toString(),
    checks: parsed.checks,
    readiness: parsed.readiness,
    quitRequested: parsed.quitRequested,
    quitError: parsed.quitError,
    error: parsed.error,
  };
}
