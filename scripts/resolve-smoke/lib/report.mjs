/**
 * Bounded JSON reporting for the ClipDock Resolve headless smoke harness.
 *
 * Every error is sanitized (whitespace collapsed, length-bounded) and the
 * report is a single bounded JSON object. Deterministic unit-test seam
 * (test/resolve-headless-result.test.mjs).
 */

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  ENVIRONMENT: 3,
  REFUSED: 4,
  PROBE_FAILED: 5,
  CLEANUP_FAILED: 6,
});

const CLEANUP_DONE = new Set(['graceful', 'terminated', 'killed']);

// Normal mode requires the read-only checks, not a quit-only success payload.
export function checksSucceeded(checks) {
  return checks !== null && typeof checks === 'object' && !Array.isArray(checks)
    && checks.projectManager === true && checks.projectList?.ready === true
    && checks.transferApi?.ok === true;
}

/** Collapses whitespace and bounds the length of an error message. */
export function sanitizeMessage(message, limit = 200) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : text.slice(0, limit);
}

/** Bounds error codes and messages so the report stays machine-safe. */
export function sanitizeError(error) {
  if (!error || typeof error !== 'object') {
    return { code: 'unknown', message: 'unknown error' };
  }
  return {
    code: String(error.code ?? 'unknown').slice(0, 60),
    message: sanitizeMessage(error.message),
  };
}

/**
 * Assembles the final machine-readable report. `ok` requires: no error, probe
 * checks present, cleanup completed (graceful/terminated/killed), and zero
 * Resolve/fuscript residue.
 */
export function buildReport({
  platform,
  elapsedMs,
  binary,
  scriptApi,
  python,
  resolveRunningBefore,
  fuscriptRunningBefore,
  resolvePids,
  fuscriptPids,
  phases,
  checks,
  residue,
  error,
  diagnostics,
}) {
  const errors = error ? [sanitizeError(error)] : [];
  const cleanupOk = phases?.cleanup ? CLEANUP_DONE.has(phases.cleanup.kind) : false;
  const residueOk = residue ? residue.resolve === 0 && residue.fuscript === 0 : false;
  const ok = errors.length === 0 && checksSucceeded(checks) && cleanupOk && residueOk;
  const report = {
    harness: 'clipdock-resolve-headless-smoke',
    ok,
    platform,
    elapsedMs,
    bundle: { binary, scriptApi, python },
    refusal: { resolveRunningBefore: resolveRunningBefore ?? null, fuscriptRunningBefore: fuscriptRunningBefore ?? null, resolvePids: resolvePids ?? null, fuscriptPids: fuscriptPids ?? null },
    phases: phases ?? null,
    checks,
    residue: residue ?? null,
  };
  if (errors.length > 0) {
    report.errors = errors;
  }
  if (diagnostics && Object.keys(diagnostics).length > 0) {
    report.diagnostics = diagnostics;
  }
  return report;
}

/**
 * Pure exit-code classification for run.mjs (deterministic seam). Every
 * non-null result carries a non-zero exit code, so the harness can never exit
 * 0 with a report whose ok is false. Precedence: async spawn failure ->
 * residue evidence failure -> probe failure -> cleanup incomplete -> Quit
 * skipped for unproven ownership.
 */
export function classifyExit({ probe, cleanup, residue, residueError, stderrTail }) {
  if (cleanup?.kind === 'error') {
    return {
      exitCode: EXIT.ENVIRONMENT,
      error: { code: 'launch-failed', message: sanitizeMessage(cleanup.error?.message ?? String(cleanup.error)) },
    };
  }
  if (residueError) {
    return { exitCode: EXIT.CLEANUP_FAILED, error: residueError, diagnostics: { childStderrTail: stderrTail ?? '' } };
  }
  if (!probe?.ok || !checksSucceeded(probe.checks)) {
    return {
      exitCode: EXIT.PROBE_FAILED,
      error: probe.error ?? { code: 'probe-failed', message: 'probe did not succeed' },
      diagnostics: { childStderrTail: stderrTail ?? '' },
    };
  }
  if (!CLEANUP_DONE.has(cleanup?.kind) || !residue || residue.resolve !== 0 || residue.fuscript !== 0) {
    return {
      exitCode: EXIT.CLEANUP_FAILED,
      error: {
        code: 'cleanup-incomplete',
        message: `cleanup ${cleanup?.kind}; residue resolve=${residue?.resolve} fuscript=${residue?.fuscript}`,
      },
      diagnostics: { childStderrTail: stderrTail ?? '' },
    };
  }
  if (probe.quitError) {
    return { exitCode: EXIT.PROBE_FAILED, error: probe.quitError, diagnostics: { childStderrTail: stderrTail ?? '' } };
  }
  return null;
}

export function renderReport(report, pretty = false) {
  return `${JSON.stringify(report, null, pretty ? 2 : 0)}\n`;
}
