// ClipDock bridge-status provider. Owns the Resolve scripting calls through an
// INJECTED WorkflowIntegration module. The native module is never required here:
// main.ts requires ./WorkflowIntegration.node and passes it in, so this module
// can be exercised in plain Node with a fake adapter (scripts/verify-plugin.mjs).
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

export function createStatusProvider(
  workflowIntegration: WorkflowIntegration,
  pluginId: string,
): StatusProvider {
  let initOk = false;
  let quitReceived = false;
  let statusInFlight: Promise<StatusSnapshot> | null = null;

  /** Initialize once after success; retry later if Resolve was not ready yet. */
  async function ensureInitialized(): Promise<boolean> {
    if (initOk) return true;
    initOk = (await workflowIntegration.Initialize(pluginId)) === true;
    return initOk;
  }

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
  async function getStatusFacts(): Promise<BridgeFacts> {
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
      facts.resolveError = 'Resolve is shutting down; the bridge is no longer available.';
      return facts;
    }

    try {
      if (!(await ensureInitialized())) {
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
      resolve = await workflowIntegration.GetResolve();
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
        facts.resolveVersion = await r.GetVersionString();
      } catch {
        /* optional display value */
      }

      const pm = await r.GetProjectManager();
      const project = pm
        ? await (pm as { GetCurrentProject(): Promise<unknown> }).GetCurrentProject()
        : null;
      if (project) {
        const p = project as ProjectLike;
        facts.projectName = bridgeName(await p.GetName(), 'project');
        const timeline = await p.GetCurrentTimeline();
        if (timeline) {
          facts.timelineName = bridgeName(await (timeline as TimelineLike).GetName(), 'timeline');
        }
      }
    } catch (err) {
      facts.resolveError = `Resolve API call failed: ${errorMessage(err)}`;
    }

    return facts;
  }

  function getStatus(): Promise<StatusSnapshot> {
    if (!statusInFlight) {
      statusInFlight = getStatusFacts().then((facts) => {
        // A quit notification can arrive while a native call is still pending.
        if (quitReceived) {
          facts.resolveAvailable = false;
          facts.resolveError = 'Resolve is shutting down; the bridge is no longer available.';
          facts.initError = null;
          facts.projectName = null;
          facts.timelineName = null;
        }
        return buildStatus(facts);
      }).finally(() => { statusInFlight = null; });
    }
    return statusInFlight;
  }

  return {
    getStatus,
    noteResolveQuit: () => {
      quitReceived = true;
    },
  };
}
