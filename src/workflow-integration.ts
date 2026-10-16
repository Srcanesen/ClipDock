// Shares one WorkflowIntegration initialization across status and transfer flows.
// The native module stays owned by main.ts and is injected here, so this lifecycle
// can be tested in plain Node without Resolve.

export interface WorkflowIntegrationLifecycle {
  Initialize(pluginId: string): Promise<boolean> | boolean;
  GetInfo(): unknown;
  GetResolve(): Promise<unknown> | unknown;
}

export function createSharedWorkflowIntegration(
  native: WorkflowIntegrationLifecycle,
): WorkflowIntegrationLifecycle {
  let initialized = false;
  let initializing: Promise<boolean> | null = null;

  return {
    Initialize(pluginId: string): Promise<boolean> {
      if (initialized) return Promise.resolve(true);
      if (!initializing) {
        initializing = Promise.resolve(native.Initialize(pluginId)).then(
          (ok) => {
            initialized = ok === true;
            if (!initialized) initializing = null;
            return initialized;
          },
          (error) => {
            initializing = null;
            throw error;
          },
        );
      }
      return initializing;
    },
    GetInfo: () => native.GetInfo(),
    GetResolve: () => native.GetResolve(),
  };
}
