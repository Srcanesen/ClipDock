// Electron-free owner of engine readiness, worker roles and managed operation lifetime.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { ManagedRoot, ManagedRootSelection } from './managed-root';
import { awaitEngineShutdown } from './provider-platform';
import { createPinterestMetadataSnapshotStore, createProviderDownloadHandlers, ManagedOperations, type ProviderDownloadDependencies, type ProviderDownloadHandlers, type discoverEnginePaths } from './main-process';
import type { YtdlpWorker } from './ytdlp';
import type { GalleryDlWorker } from './gallerydl';
import type { PexelsClient } from './pexels';
import type { createMediaPrep } from './media-prep';

type Engines = Awaited<ReturnType<typeof discoverEnginePaths>>;
type YoutubeWorker = Pick<YtdlpWorker, 'search' | 'metadata' | 'prefetchMetadata' | 'metadataSocial' | 'thumbnailSocial' | 'subtitles' | 'download' | 'downloadSocial' | 'cancel' | 'isActive' | 'dispose' | 'setSessionDir'>;
type PinterestWorker = Pick<GalleryDlWorker, 'search' | 'metadata' | 'download' | 'cancel' | 'isActive' | 'dispose' | 'setSessionDir'>;
type PexelsWorker = Pick<PexelsClient, 'search' | 'load' | 'download' | 'cancel' | 'isDownloading' | 'dispose' | 'setRoot' | 'abortApiRequests' | 'status' | 'validateKey' | 'setKey' | 'clearKey' | 'restoreKey' | 'restoreStatus'>;
type MediaPrep = ReturnType<typeof createMediaPrep>;
type ProviderName = 'youtube' | 'social' | 'pinterest' | 'pexels';
interface LifecycleWorker { isActive(): boolean; dispose(): void | Promise<void>; }
export interface EngineWorkerFactory {
  youtube(engines: Engines, sessionDir: string): YoutubeWorker;
  pinterest(engines: Engines, sessionDir: string): PinterestWorker;
  pexels(sessionDir: string): PexelsWorker;
  mediaPrep(engines: Engines): MediaPrep;
}
interface EngineHostDependencies {
  folder: string;
  runtimeRoot: string;
  workers: EngineWorkerFactory;
  completion: ProviderDownloadDependencies['completion'];
  registerSubtitle: ProviderDownloadDependencies['registerSubtitle'];
  emit(provider: ProviderName, event: unknown, update: unknown): void;
  restoreCredential(client: PexelsWorker): Promise<void>;
  disposeCredential?(): void | Promise<void>;
}
const shuttingDown = () => new Error('Download services are shutting down.');
const unavailableFolder = 'The download folder changed or became unavailable. Choose the download folder again to restore access.';
const folderFailure = (error: unknown) => `Choose a usable download folder. ${error instanceof Error ? error.message : 'Folder initialization failed.'}`;

export function createEngineHost(deps: EngineHostDependencies) {
  const roots = new ManagedRootSelection();
  const operationRoot = new AsyncLocalStorage<ManagedRoot>();
  const operations = new ManagedOperations();
  const handoffs = new Set<Promise<unknown>>();
  const credentials = new Set<Promise<unknown>>();
  const lifecycle: LifecycleWorker[] = [];
  let displayedFallback = deps.folder;
  let folderError: string | undefined;
  let startupError: Error | undefined;
  let disposed = false;
  let started = false;
  let shutdown: Promise<void> | undefined;
  let downloads: ProviderDownloadHandlers | undefined;
  let engines: Engines;
  let workers: ReturnType<typeof createWorkers>;
  let credentialRestore = Promise.resolve();
  let restoringCredential = false;
  let credentialShutdown: Promise<void> | undefined;
  let finish!: () => void;
  const initialized = new Promise<void>(resolve => { finish = resolve; });
  try { roots.change(ManagedRoot.prepare(deps.folder), []); }
  catch (error) { folderError = folderFailure(error); }

  function assertActive(): void { if (disposed) throw shuttingDown(); }
  async function ready(): Promise<Engines> {
    await initialized;
    if (startupError) throw startupError;
    assertActive();
    return engines;
  }
  function activeRoot(): ManagedRoot {
    try {
      const root = roots.current();
      if (folderError === unavailableFolder) folderError = undefined;
      return root;
    } catch {
      folderError ??= unavailableFolder;
      throw new Error(folderError);
    }
  }
  function applyFolder(root: ManagedRoot, persist?: (root: ManagedRoot) => void): void {
    assertActive();
    roots.change(root, [
      next => workers.youtube.setSessionDir(next.providerPath('youtube')),
      next => workers.social.setSessionDir(next.providerPath('social')),
      next => workers.pinterest.setSessionDir(next.providerPath('pinterest')),
      next => workers.pexels.setRoot(next.providerPath('pexels')),
    ], persist);
    folderError = undefined;
    displayedFallback = root.verify();
  }
  function createWorkers(engines: Engines) {
    // Each role admits one job at a time. Metadata/search cannot share download workers.
    const yt = (role: string) => { const worker = deps.workers.youtube(engines, path.join(deps.runtimeRoot, role)); lifecycle.push(worker); return worker; };
    const pin = (role: string) => { const worker = deps.workers.pinterest(engines, path.join(deps.runtimeRoot, role)); lifecycle.push(worker); return worker; };
    const roles = {
      youtube: yt('youtube'), social: yt('social'), pinterest: pin('pinterest'),
      pinterestMetadata: pin('pinterest-metadata'), pinterestSearch: pin('pinterest-search'),
      youtubeSearch: yt('youtube-search'), youtubeMetadata: yt('youtube-metadata'),
      socialMetadata: yt('social-metadata'), youtubeSubtitles: yt('youtube-subtitles'),
    };
    const mediaPrep = deps.workers.mediaPrep(engines);
    lifecycle.push(mediaPrep);
    const pexels = deps.workers.pexels(path.join(deps.runtimeRoot, 'pexels'));
    lifecycle.splice(lifecycle.length - 1, 0, {isActive: () => pexels.isDownloading(), dispose: () => {
      pexels.abortApiRequests?.();
      return restoringCredential || credentials.size ? drainCredentials().then(() => pexels.dispose()) : pexels.dispose();
    }});
    return {...roles, mediaPrep, pexels};
  }
  async function start(discovered: Promise<Engines>): Promise<void> {
    if (started || disposed) return;
    started = true;
    try {
      engines = await discovered;
      if (disposed) return;
      workers = createWorkers(engines);
      try { applyFolder(activeRoot()); } catch (error) { folderError = folderFailure(error); }
      downloads = createProviderDownloadHandlers({
        completion: deps.completion, registerSubtitle: deps.registerSubtitle,
        ffprobeAvailable: !!engines.ffprobePath, cancelMediaPreparation: jobId => workers.mediaPrep.cancel(jobId),
        youtube: {worker: workers.youtube, emit: (event, update) => deps.emit('youtube', event, update)},
        social: {worker: workers.social, emit: (event, update) => deps.emit('social', event, update)},
        pinterest: {worker: workers.pinterest, snapshots, emit: (event, update) => deps.emit('pinterest', event, update)},
        pexels: {worker: workers.pexels, emit: (event, update) => deps.emit('pexels', event, update)},
      });
      restoringCredential = true;
      credentialRestore = deps.restoreCredential(workers.pexels).catch(() => { /* Status remains disconnected. */ }).finally(() => { restoringCredential = false; });
    } catch (error) {
      startupError = new Error(`Download services could not start: ${error instanceof Error ? error.message : 'Initialization failed.'}`);
    } finally { finish(); }
  }
  function drainCredentials(): Promise<void> {
    return credentialShutdown ??= (async () => {
      await deps.disposeCredential?.();
      await credentialRestore;
      await Promise.allSettled([...credentials]);
    })();
  }
  function credential<T>(operation: (client: PexelsWorker) => T | Promise<T>): Promise<T> {
    const pending = run(async () => {
      await credentialRestore;
      assertActive();
      return operation(workers.pexels);
    });
    credentials.add(pending);
    void pending.finally(() => credentials.delete(pending)).catch(() => {});
    return pending;
  }
  async function run<T>(operation: () => T | Promise<T>, readiness: 'engines' | 'immediate' = 'engines'): Promise<T> {
    if (readiness === 'engines') await ready();
    assertActive();
    return operation();
  }
  const isBusy = () => operations.isBusy() || lifecycle.some(worker => worker.isActive());
  async function changeFolder(
    select: () => Promise<string | null>,
    prepare: (folder: string) => ManagedRoot,
    persist?: (root: ManagedRoot) => void,
  ): Promise<string | null> {
    if (isBusy()) throw new Error('Wait for active downloads or media preparation to finish.');
    return operations.changeFolder(async () => {
      await initialized;
      assertActive();
      if (startupError) throw startupError;
      const selected = await select();
      if (selected === null) return null;
      if (lifecycle.some(worker => worker.isActive())) throw new Error('Wait for active downloads or media preparation to finish.');
      try {
        const root = prepare(selected);
        const folder = root.verify();
        applyFolder(root, persist);
        return folder;
      } catch (error) {
        throw new Error(`Could not change the download folder: ${error instanceof Error ? error.message : 'preparation failed'}`);
      }
    });
  }
  const snapshots = createPinterestMetadataSnapshotStore();
  // Cancels address the shared job owner, preserving cross-provider cancellation by id.
  const cancel = (jobId: unknown): boolean => typeof jobId === 'string' && (downloads?.cancel(jobId) ?? false);
  function download<N extends ProviderName>(name: N) {
    return (...args: Parameters<ProviderDownloadHandlers[N]>) => operations.run(async () => {
      await ready();
      const root = activeRoot();
      if (folderError) throw new Error(folderError);
      // The four handlers differ only in arity; all accept untrusted IPC values.
      const handler: (event: unknown, ...args: unknown[]) => ReturnType<ProviderDownloadHandlers[ProviderName]> = downloads![name];
      return operationRoot.run(root, () => handler(args[0], ...args.slice(1)));
    });
  }
  const providers = {
    youtube: {
      search: (query: unknown, page: unknown) => run(() => workers.youtubeSearch.search(query, page)),
      load: (url: unknown) => run(() => workers.youtubeMetadata.metadata(url)),
      prefetch: (url: unknown) => run(() => workers.youtubeMetadata.prefetchMetadata(url)),
      subtitles: (url: unknown, language: unknown) => run(() => workers.youtubeSubtitles.subtitles(url, language)),
      download: download('youtube'), cancel,
    },
    social: {
      load: (url: unknown) => run(() => workers.socialMetadata.metadataSocial(url)),
      thumbnail: (url: unknown) => run(() => workers.socialMetadata.thumbnailSocial(url)),
      download: download('social'), cancel,
    },
    pinterest: {
      search: (query: unknown, page: unknown) => run(() => workers.pinterestSearch.search(query, page)),
      load: (url: unknown) => run(async () => { const metadata = await workers.pinterestMetadata.metadata(url); snapshots.remember(metadata); return metadata; }),
      download: download('pinterest'), cancel,
    },
    pexels: {
      search: (kind: unknown, query: unknown, page: unknown) => run(() => workers.pexels.search(kind, query, page)),
      load: (kind: unknown, id: unknown) => run(() => workers.pexels.load(kind, id)),
      abortRequests: () => run(() => workers.pexels.abortApiRequests()),
      download: download('pexels'), cancel,
    },
  };
  return {
    start, ready, run, activeRoot, changeFolder,
    provider: <N extends ProviderName>(name: N) => providers[name],
    error: () => folderError ?? startupError?.message,
    displayedFolder: () => { try { return activeRoot().verify(); } catch { return displayedFallback; } },
    isBusy,
    mediaInUse: () => handoffs.size > 0 || Boolean(workers?.mediaPrep.isActive()),
    operationRoot: () => operationRoot.getStore() ?? activeRoot(),
    prepareMedia: (...args: Parameters<MediaPrep['prepare']>) => workers.mediaPrep.prepare(...args),
    withFolderChange: <T>(operation: () => Promise<T>) => operations.changeFolder(operation),
    operation: <T>(operation: () => Promise<T>) => operations.run(operation),
    credential,
    async handoff<T>(operation: () => T | Promise<T>): Promise<T> {
      assertActive();
      // Register before entering native code, which can itself trigger ResolveQuit.
      const pending = operations.run(() => Promise.resolve().then(operation));
      handoffs.add(pending);
      try { return await pending; } finally { handoffs.delete(pending); }
    },
    dispose(): Promise<void> {
      if (shutdown) return shutdown;
      disposed = true;
      if (!started) finish();
      shutdown = awaitEngineShutdown([...lifecycle,
        {dispose: drainCredentials},
        {dispose: async () => { if (!started) return; await initialized; await downloads?.shutdown(); }},
        {dispose: async () => { await Promise.allSettled([...handoffs]); }},
      ], 8000);
      return shutdown;
    },
  };
}
