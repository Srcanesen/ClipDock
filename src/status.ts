// Pure bridge-status shape logic for the ClipDock panel.
// This module has NO electron or native-module imports on purpose: it can be
// unit-checked in plain Node (scripts/verify-plugin.mjs) without Resolve running.

export type BridgePhase = 'bridge-error' | 'no-project' | 'no-timeline' | 'ready';

export interface BridgeFacts {
  /** WorkflowIntegration.Initialize(pluginId) returned true. */
  initialized: boolean;
  initError: string | null;
  /** GetResolve() returned a Resolve object. */
  resolveAvailable: boolean;
  resolveError: string | null;
  /** WorkflowIntegration.GetInfo().version (display only). */
  moduleVersion: string | null;
  /** resolve.GetVersionString() (display only). */
  resolveVersion: string | null;
  /** GetCurrentProject().GetName() (trimmed). */
  projectName: string | null;
  /** GetCurrentTimeline().GetName() (trimmed). */
  timelineName: string | null;
}

export interface StatusSnapshot {
  phase: BridgePhase;
  bridge: { connected: boolean; moduleVersion: string | null; resolveVersion: string | null; error: string | null };
  project: { name: string | null; loaded: boolean };
  timeline: { name: string | null; loaded: boolean };
  message: string;
  refreshHint: string | null;
}

/** Treat null / empty / whitespace-only names as "not present". */
function cleanName(name: string | null): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildStatus(f: BridgeFacts): StatusSnapshot {
  const connected = f.initialized && f.resolveAvailable && !f.initError && !f.resolveError;
  const projectName = cleanName(f.projectName);
  const timelineName = cleanName(f.timelineName);
  const bridgeError = f.initError ?? f.resolveError;

  let phase: BridgePhase;
  let message: string;
  let refreshHint: string | null;

  if (!connected) {
    phase = 'bridge-error';
    message = bridgeError ?? 'The Resolve JavaScript bridge could not be reached.';
    refreshHint = 'Click Refresh to re-initialize the bridge.';
  } else if (!projectName) {
    phase = 'no-project';
    message = 'DaVinci Resolve is connected, but no project is currently open.';
    refreshHint = 'Open a project in Resolve, then click Refresh.';
  } else if (!timelineName) {
    phase = 'no-timeline';
    message = `Project "${projectName}" is open, but it has no active timeline.`;
    refreshHint = 'Open or create a timeline in Resolve, then click Refresh.';
  } else {
    phase = 'ready';
    message = `Connected to project "${projectName}" — timeline "${timelineName}".`;
    refreshHint = null;
  }

  return {
    phase,
    bridge: {
      connected,
      moduleVersion: f.moduleVersion,
      resolveVersion: f.resolveVersion,
      error: bridgeError,
    },
    project: { name: projectName, loaded: projectName != null },
    timeline: { name: timelineName, loaded: timelineName != null },
    message,
    refreshHint,
  };
}
