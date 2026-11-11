// ClipDock bridge-status provider. Owns the Resolve scripting calls through an
// INJECTED WorkflowIntegration module. The native module is never required here:
// main.ts requires ./WorkflowIntegration.node and passes it in, so this module
// can be exercised in plain Node with a fake adapter (test/status-provider-checks.test.mjs).
//
// This is the approved test seam: createStatusProvider(workflowIntegration, pluginId)
// returns { getStatus(): Promise<StatusSnapshot>, noteResolveQuit(): void }.

import { buildStatus } from './status';
import type { BridgeFacts, StatusSnapshot } from './status';

/** Minimal surface of the WorkflowIntegration.node module the provider needs. */
export interface WorkflowIntegration {
  Initialize(pluginId: string): Promise<boolean> | boolean;
  GetInfo(): unknown;
  GetResolve(): Promise<unknown> | unknown;
}

export interface StatusProvider {
  getStatus(): Promise<StatusSnapshot>;
  /** Mark that Resolve quit; subsequent status calls report the bridge as gone. */
  noteResolveQuit(): void;
}

interface ResolveLike {
  GetVersionString(): Promise<string>;
  GetProjectManager(): Promise<unknown>;
}

interface ProjectLike {
  GetName(): Promise<unknown>;
  GetCurrentTimeline(): Promise<unknown>;
}

interface TimelineLike {
  GetName(): Promise<unknown>;
}

/** Validate untyped native names inside the API error boundary, before status formatting. */
function bridgeName(value: unknown, field: 'project' | 'timeline'): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`Resolve returned an invalid ${field} name.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATUS_TIMEOUT_MS = 10_000;
const SHUTDOWN_MESSAGE = 'Resolve is shutting down; the bridge is no longer available.';

function unavailable(message: string): StatusSnapshot {
  return buildStatus({initialized: false, initError: null, resolveAvailable: false, resolveError: message,
    moduleVersion: null, resolveVersion: null, projectName: null, timelineName: null});
}

export function createStatusProvider(
  workflowIntegration: WorkflowIntegration,
  pluginId: string,
): StatusProvider {
  let initOk = false;
  let quitReceived = false;
  let statusInFlight: Promise<StatusSnapshot> | null = null;
  let finishCurrent: ((status: StatusSnapshot) => void) | null = null;

  /** GetInfo().version — display only, best-effort. */
  function moduleVersion(): string | null {
    try {
      const info: unknown = workflowIntegration.GetInfo();
      if (info && typeof info === 'object') {
        const version = (info as { version?: unknown }).version;
        if (typeof version === 'string') return version;
      }
    } catch {
      /* GetInfo is best-effort; null is rendered as "—" */
    }
    return null;
  }

  /** Collect raw bridge facts for the status snapshot (errors captured, never thrown). */
  async function getStatusFacts(signal: AbortSignal): Promise<BridgeFacts> {
    // Native promises cannot be cancelled. An expired traversal must neither
    // update initialization nor start more calls when its pending call returns.
    async function call<T>(operation: () => T | Promise<T>): Promise<T> {
      if (signal.aborted) throw signal.reason;
      const result = await operation();
      if (signal.aborted) throw signal.reason;
      return result;
    }
    const facts: BridgeFacts = {
      initialized: false,
      initError: null,
      resolveAvailable: false,
      resolveError: null,
      moduleVersion: null,
      resolveVersion: null,
      projectName: null,
      timelineName: null,
    };

    if (quitReceived) {
      facts.resolveError = SHUTDOWN_MESSAGE;
      return facts;
    }

    try {
      // Initialize once after success; retry later if Resolve was not ready yet.
      if (!initOk) initOk = (await call(() => workflowIntegration.Initialize(pluginId))) === true;
      if (!initOk) {
        facts.initError = 'WorkflowIntegration.Initialize failed. Is the plugin installed for Resolve Studio?';
        return facts;
      }
    } catch (error) {
      facts.initError = `WorkflowIntegration.Initialize failed: ${errorMessage(error)}`;
      return facts;
    }
    facts.initialized = true;
    facts.moduleVersion = moduleVersion();

    let resolve: unknown;
    try {
      resolve = await call(() => workflowIntegration.GetResolve());
    } catch (err) {
      facts.resolveError = `GetResolve threw: ${errorMessage(err)}`;
      return facts;
    }
    if (!resolve) {
      facts.resolveError = 'GetResolve returned no Resolve object.';
      return facts;
    }
    facts.resolveAvailable = true;

    try {
      const r = resolve as ResolveLike;
      try {
        facts.resolveVersion = await call(() => r.GetVersionString());
      } catch {
        /* optional display value */
      }

      const pm = await call(() => r.GetProjectManager());
      const project = pm
        ? await call(() => (pm as { GetCurrentProject(): Promise<unknown> }).GetCurrentProject())
        : null;
      if (project) {
        const p = project as ProjectLike;
        facts.projectName = bridgeName(await call(() => p.GetName()), 'project');
        const timeline = await call(() => p.GetCurrentTimeline());
        if (timeline) {
          facts.timelineName = bridgeName(await call(() => (timeline as TimelineLike).GetName()), 'timeline');
        }
      }
    } catch (err) {
      facts.resolveError = `Resolve API call failed: ${errorMessage(err)}`;
    }

    return facts;
  }

  function getStatus(): Promise<StatusSnapshot> {
    if (quitReceived) return Promise.resolve(unavailable(SHUTDOWN_MESSAGE));
    if (statusInFlight) return statusInFlight;
    const controller = new AbortController();
    let resolve!: (status: StatusSnapshot) => void;
    const pending = new Promise<StatusSnapshot>(done => { resolve = done; });
    statusInFlight = pending;
    const finish = (status: StatusSnapshot): void => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(timer);
      if (statusInFlight === pending) { statusInFlight = null; finishCurrent = null; }
      resolve(status);
    };
    const timer = setTimeout(() => finish(unavailable('Resolve status collection timed out. Click Refresh to retry.')), STATUS_TIMEOUT_MS);
    finishCurrent = finish;
    void getStatusFacts(controller.signal).then(facts => finish(buildStatus(facts)));
    return pending;
  }

  return {
    getStatus,
    noteResolveQuit: () => {
      quitReceived = true;
      finishCurrent?.(unavailable(SHUTDOWN_MESSAGE));
    },
  };
}
