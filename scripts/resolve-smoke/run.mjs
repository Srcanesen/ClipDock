#!/usr/bin/env node
/**
 * ClipDock Resolve headless smoke harness (read-only, opt-in).
 *
 * Orchestrates: pre-flight refusal when Resolve or fuscript is active ->
 * direct bundle-binary spawn with -nogui (never `open -a`) under the official
 * scripting env -> bounded probe (scriptapp + ProjectManager readiness,
 * read-only checks, Quit request) -> bounded graceful/SIGTERM/SIGKILL
 * cleanup -> residue check -> one bounded machine-readable JSON report.
 *
 * Never creates, saves, closes, renames, or deletes projects, timelines, bins,
 * or clips. Stdlib only. See scripts/resolve-smoke/README.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, USAGE, parseArgs } from './lib/args.mjs';
import { resolveBinary, scriptEnv, scriptLibForBinary, validatePaths } from './lib/locate.mjs';
import { BoundedBuffer, activeProcessMessage, assertNoResolveRunning, collectResidue, shutdown, spawnResolve } from './lib/spawn.mjs';
import { checkPython, runProbe } from './lib/probe.mjs';
import { EXIT, buildReport, classifyExit, renderReport, sanitizeMessage } from './lib/report.mjs';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESOLVE_CHILD_STDOUT_LIMIT = 64 * 1024;
const RESOLVE_CHILD_STDERR_LIMIT = 16 * 1024;
const QUIT_ONLY_FALLBACK_MS = 10000;
const RESIDUE_SETTLE_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);

  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`clipdock-resolve-headless-smoke: ${err.message}\n\n${USAGE}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }
    throw err;
  }
  if (cfg.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const base = {
    platform: process.platform,
    binary: null,
    scriptApi: null,
    python: cfg.python,
    resolveRunningBefore: null,
    phases: null,
    checks: null,
    residue: null,
  };
  const finish = (exitCode, error = null, diagnostics = null) => {
    process.stdout.write(renderReport(buildReport({ ...base, elapsedMs: Date.now() - startedAt, error, diagnostics }), cfg.pretty));
    process.exitCode = exitCode;
  };

  // First supported environment: macOS + Resolve Studio 21. Fail clearly elsewhere.
  if (process.platform !== 'darwin') {
    return finish(EXIT.ENVIRONMENT, {
      code: 'unsupported-platform',
      message: `harness supports macOS only, found ${process.platform}`,
    });
  }

  // Official layout + official scripting env paths.
  const binary = resolveBinary(cfg.bundle);
  base.binary = binary;
  const scriptApi = cfg.scriptApi;
  const scriptLib = scriptLibForBinary(binary);
  const paths = validatePaths({ binary, scriptApi, scriptLib });
  if (!paths.ok) {
    return finish(EXIT.ENVIRONMENT, paths.error);
  }
  base.scriptApi = scriptApi;

  const pythonCheck = checkPython(cfg.python);
  if (!pythonCheck.ok) {
    return finish(EXIT.ENVIRONMENT, pythonCheck.error);
  }

  // Refuse to run when Resolve or fuscript is already active.
  let pre;
  try {
    pre = assertNoResolveRunning();
  } catch (err) {
    return finish(EXIT.ENVIRONMENT, { code: 'preflight-failed', message: sanitizeMessage(err?.message ?? String(err)) });
  }
  base.resolveRunningBefore = pre.pids.length;
  base.fuscriptRunningBefore = pre.fuscriptPids.length;
  base.resolvePids = pre.pids;
  base.fuscriptPids = pre.fuscriptPids;
  if (!pre.ok) {
    return finish(EXIT.REFUSED, {
      code: 'resolve-already-running',
      message: activeProcessMessage(pre),
    });
  }

  const env = scriptEnv(binary, scriptApi, process.env);
  const probeScript = cfg.probe ?? path.join(HARNESS_DIR, 'probe.py');

  // Direct bundle-binary spawn with -nogui; never `open -a`.
  let child;
  try {
    child = spawnResolve(binary, { env });
  } catch (err) {
    return finish(EXIT.ENVIRONMENT, { code: 'launch-failed', message: sanitizeMessage(err?.message ?? String(err)) });
  }
  const launch = await child.launch;
  if (!launch.ok) return finish(EXIT.ENVIRONMENT, { code: 'launch-failed', message: sanitizeMessage(launch.error.message) });
  const childOut = new BoundedBuffer(RESOLVE_CHILD_STDOUT_LIMIT);
  const childErr = new BoundedBuffer(RESOLVE_CHILD_STDERR_LIMIT);
  child.stdout.on('data', (chunk) => childOut.push(chunk));
  child.stderr.on('data', (chunk) => childErr.push(chunk));

  // Close the preflight/connect Quit TOCTOU: the probe may call Resolve.Quit
  // only when `pgrep -x Resolve` is exactly this child pid. Pass the pid
  // through env; probe.py verifies ownership before both normal and quit-only
  // Quit and skips Quit with a sanitized ownership error otherwise. Parent
  // cleanup below signals only this own child.
  if (child.pid !== undefined) {
    env.RESOLVE_SMOKE_CHILD_PID = String(child.pid);
  }

  const phases = {
    spawn: { ms: Date.now() - startedAt },
    connect: { ms: null },
    probe: { ms: null },
    cleanup: { kind: null, ms: null, exitCode: null, signal: null },
  };
  base.phases = phases;

  // Bounded probe: scriptapp + ProjectManager readiness, read-only checks, Quit.
  let probe;
  try {
    probe = await runProbe({ python: cfg.python, probeScript, env, timeoutMs: cfg.timeoutMs, mode: 'probe' });
  } catch (err) {
    probe = { ok: false, error: { code: 'probe-runner-failed', message: sanitizeMessage(err?.message ?? String(err)) } };
  }
  phases.probe = {
    ok: probe.ok,
    exitCode: probe.exitCode ?? null,
    ms: probe.ms ?? null,
    quitError: probe.quitError ?? null,
  };
  phases.connect.ms = probe.readiness && Number.isFinite(probe.readiness.pollMs) ? probe.readiness.pollMs : null;

  // Best-effort Quit request when the main probe never reached the app (and
  // did not already report an unproven-ownership skip: the fallback would make
  // the same ownership decision).
  if (!probe.ok && probe.quitRequested !== true && probe.quitError == null) {
    try {
      await runProbe({ python: cfg.python, probeScript, env, timeoutMs: Math.min(QUIT_ONLY_FALLBACK_MS, cfg.timeoutMs), mode: 'quit-only' });
    } catch {
      // Bounded shutdown below still applies.
    }
  }

  // Bounded shutdown: Quit() grace -> SIGTERM -> SIGKILL.
  const cleanup = await shutdown(child, {
    graceMs: cfg.quitGraceMs,
    termMs: cfg.termWaitMs,
    killMs: cfg.killWaitMs,
  });
  phases.cleanup = {
    kind: cleanup.kind,
    ms: cleanup.ms,
    exitCode: cleanup.exitCode ?? null,
    signal: cleanup.signal ?? null,
  };

  // Residue evidence: no Resolve and no fuscript process may remain. pgrep
  // failure is fail-safe: unknown residue exits cleanup-failed, never 0.
  await sleep(RESIDUE_SETTLE_MS);
  const residueResult = collectResidue();
  base.residue = residueResult.residue;

  if (probe.ok) {
    base.checks = probe.checks;
  }

  const failure = classifyExit({
    probe,
    cleanup,
    residue: residueResult.residue,
    residueError: residueResult.ok ? null : residueResult.error,
    stderrTail: childErr.toString().slice(-1500),
  });
  if (failure) {
    return finish(failure.exitCode, failure.error, failure.diagnostics ?? null);
  }

  finish(EXIT.OK);
}

main().catch((err) => {
  process.stderr.write(`clipdock-resolve-headless-smoke: unexpected failure: ${sanitizeMessage(err?.message ?? String(err))}\n`);
  process.exitCode = 1;
});
