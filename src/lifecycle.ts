// ClipDock — bridge/lifecycle seams. Pure Node module (no Electron imports): the
// Electron main module injects its native app/window seams, so both contracts
// here are exercised deterministically in plain Node without Electron or
// WorkflowIntegration.node; native cleanup remains owned by main's before-quit
// handler.
//
// Two contracts live here:
//   1. createTimeoutAwareLifecycle — the official bridge init sequence:
//      Initialize(pluginId) success must be followed by SetAPITimeout(10); a
//      false/throw from SetAPITimeout is a CONTROLLED VISIBLE FAILURE, never a
//      silent success. The wrapper resolves true only when both steps succeed.
//   2. createShutdownCoordinator — the SINGLE idempotent ResolveQuit contract:
//      the renderer notification precedes exactly one request to start the
//      normal Electron quit flow, no matter how many quit callbacks arrive.

// ---- Official SetAPITimeout init sequence ----

export interface TimeoutAwareLifecycle {
  Initialize(pluginId: string): Promise<boolean> | boolean;
  GetInfo(): unknown;
  GetResolve(): Promise<unknown> | unknown;
}

export interface ApiTimeoutNative {
  /** Official WorkflowIntegration.node API; seconds, returns success boolean. */
  SetAPITimeout(seconds: number): Promise<boolean> | boolean;
}

/**
 * Wrap the shared Initialize so the official SetAPITimeout(timeoutSeconds)
 * always runs right after the FIRST successful Initialize. Order is
 * deterministic: Initialize → SetAPITimeout → success. A failed timeout
 * (false or throw) rejects with a descriptive error so callers surface a
 * controlled error / visible degraded state instead of silent success; the
 * next Initialize pass retries the timeout (the bridge retries until Resolve
 * is ready anyway), so a transient failure can recover. Once the timeout is
 * applied it is never called again.
 */
export function createTimeoutAwareLifecycle(
  inner: TimeoutAwareLifecycle,
  native: ApiTimeoutNative,
  timeoutSeconds: number,
): TimeoutAwareLifecycle {
  let timeoutApplied = false;
  let initializing: Promise<boolean> | null = null;

  function initializeOnce(pluginId: string): Promise<boolean> {
    return Promise.resolve()
      .then(() => inner.Initialize(pluginId))
      .then(async (ok) => {
        if (ok !== true) return false; // Resolve not ready; retry on the next pass
        if (timeoutApplied) return true;
        let timeoutOk = false;
        try {
          timeoutOk = (await Promise.resolve(native.SetAPITimeout(timeoutSeconds))) === true;
        } catch (error) {
          throw new Error(
            `WorkflowIntegration initialized, but SetAPITimeout(${timeoutSeconds}) threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!timeoutOk) {
          throw new Error(`WorkflowIntegration initialized, but SetAPITimeout(${timeoutSeconds}) returned false.`);
        }
        timeoutApplied = true;
        return true;
      });
  }

  return {
    Initialize(pluginId: string): Promise<boolean> {
      if (timeoutApplied) return Promise.resolve(true);
      if (!initializing) {
        initializing = initializeOnce(pluginId).finally(() => { initializing = null; });
      }
      return initializing;
    },
    GetInfo: () => inner.GetInfo(),
    GetResolve: () => inner.GetResolve(),
  };
}

// ---- Single idempotent ResolveQuit contract ----

export type ShutdownReason = 'window-quit' | 'resolve-quit';

export interface ShutdownDependencies {
  /** Final renderer notification; called only for 'resolve-quit'. */
  notifyRenderer(reason: ShutdownReason): void;
  /** Start Electron's normal quit flow; called at most once. */
  requestQuit(): void;
}

export interface ShutdownCoordinator {
  /** Claim shutdown once; later calls (any reason) are no-ops. */
  beginShutdown(reason: ShutdownReason): void;
  readonly shuttingDown: boolean;
}

/**
 * ONE shared quit trigger for normal window quit and ResolveQuit.
 *
 * ResolveQuit is ordered synchronously: notify the renderer first, then
 * request Electron's normal app.quit flow. The before-quit handler owns service
 * disposal and native CleanUp, so those operations remain on Electron's
 * existing, best-effort lifecycle path. A window-quit claim only records that
 * quit is already underway and never requests another app.quit.
 */
export function createShutdownCoordinator(deps: ShutdownDependencies): ShutdownCoordinator {
  let started = false;

  return {
    get shuttingDown(): boolean { return started; },
    beginShutdown(reason: ShutdownReason): void {
      if (started) return;
      started = true;
      if (reason !== 'resolve-quit') return;

      try {
        deps.notifyRenderer(reason);
      } catch {
        /* the notification is best-effort; the normal quit flow still starts */
      }
      try {
        deps.requestQuit();
      } catch {
        /* a failed quit request cannot be retried by a later callback */
      }
    },
  };
}
