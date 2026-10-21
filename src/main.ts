// ClipDock — DaVinci Resolve Studio Workflow Integration plugin.
// Electron main process. This is the ONLY process that touches the
// WorkflowIntegration.node native module and Resolve's JavaScript scripting API.
// The renderer communicates exclusively through the narrow IPC surface exposed
// by preload.ts (contextBridge + ipcMain.handle / ipcMain.on / ipcRenderer.invoke/send).
//
// Structure and naming follow Blackmagic's official SamplePlugin
// (sandboxed + contextIsolation model, recommended for plugin writers).

import { createEngineHost } from './engine-host';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell, WebContentsView } from 'electron';
import type { IpcMainInvokeEvent, WebFrameMain } from 'electron';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { ManagedRoot } from './managed-root';
import { DownloadLedger, type Card } from './download-ledger';
import { canonicalMediaPath } from './path-boundary';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WorkflowIntegration = require('./WorkflowIntegration.node');

import { IPC_CHANNELS, PLUGIN_ID } from './shared';
import { isSafeMediaFile as isSafeMediaFileHelper, normalizePreviewBounds, registerMainTransferInvokeHandlers, SessionTransferCards, resolveMainProcessCard, createSensitiveIpcHandler as sensitiveHandler, discoverEnginePaths, runStartupSequence, youtubePreviewUrl, YOUTUBE_PREVIEW_REFERRER, type ArtifactCompletionDependencies, type MainIpcRegistrar, type PreviewBounds } from './main-process';
import { createStatusProvider } from './status-provider';
import { createTransfer, type TimelineAutomation } from './transfer';
import { createSharedWorkflowIntegration } from './workflow-integration';
import { createShutdownCoordinator, createTimeoutAwareLifecycle } from './lifecycle';
import { YtdlpWorker } from './ytdlp';
import { GalleryDlWorker } from './gallerydl';
import { createMediaPrep } from './media-prep';
import { PexelsClient, safePexelsExternal } from './pexels';
import { PixabayClient, safePixabayExternal } from './pixabay';
import type { StockClient } from './stock';
import { MacKeychainPexelsCredentialStore, PexelsCredentialStore, PEXELS_CREDENTIAL, PIXABAY_CREDENTIAL, type CredentialSource, type PexelsCredentialPersistence } from './pexels-credential';
import { cleanupWorkspaceAsync, inspectWorkspaceAsync } from './workspace';
import { DownloadHistory, safeHistorySource } from './history';
import { MEDIA_EXTENSIONS } from './media-extensions';
import { loadDownloadFolder, claimDownloadFolder, saveDownloadFolder, defaultDownloadFolder } from './settings';

// Must match the <Id> element in manifest.xml (Resolve requirement).
// PLUGIN_ID is canonical in scripts/lib/contracts.mjs via src/shared.ts
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_MAX_START_SECONDS = 604800;

const RELINK_EXTENSIONS = [...MEDIA_EXTENSIONS].map(extension => extension.slice(1));

let mainWindow: BrowserWindow | null = null;
let youtubePreviewView: WebContentsView | null = null;
let youtubePreviewBounds: PreviewBounds | null = null;
let youtubePreviewGeneration = 0;

function exactClipdockDocumentUrl(value: string): boolean {
  try {
    const expected = new URL(pathToFileURL(path.join(__dirname, 'index.html')).href);
    const actual = new URL(value);
    return actual.href === expected.href;
  } catch {
    return false;
  }
}

function isValidatedClipdockFrame(frame: WebFrameMain | null | undefined): boolean {
  try {
    return !!mainWindow
      && !!frame
      && frame === mainWindow.webContents.mainFrame
      && exactClipdockDocumentUrl(frame.url);
  } catch {
    return false;
  }
}

function requireClipdockSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || !isValidatedClipdockFrame(event.senderFrame)) {
    throw new Error('Invalid ClipDock sender.');
  }
}

/** Trusted-sender check shaped for the Electron-free handler seams (see main-process.ts). */
const requireTrustedSender = (event: unknown): void => requireClipdockSender(event as IpcMainInvokeEvent);

// Bridge-status provider. main.ts is the ONLY owner of WorkflowIntegration.node:
// it requires the native module here and injects it (never required elsewhere),
// which is what lets the automated check feed a fake adapter instead. The shared
// Initialize is wrapped with the official SetAPITimeout(10) step: it runs right
// after the first successful Initialize, and a false/throw is a controlled
// visible failure (the bridge never reports silent success without the timeout).
const sharedWorkflowIntegration = createSharedWorkflowIntegration(WorkflowIntegration);
const workflowIntegration = createTimeoutAwareLifecycle(sharedWorkflowIntegration, WorkflowIntegration, 10);
const statusProvider = createStatusProvider(workflowIntegration, PLUGIN_ID);
const sessionTransferCards = new SessionTransferCards();
const transferBoundary = new AsyncLocalStorage<{ trustedRoot?: ManagedRoot }>();
const transfer = createTransfer(workflowIntegration, PLUGIN_ID, {
  validatePath: (filePath) => {
    const root = transferBoundary.getStore()?.trustedRoot;
    return root ? root.resolve(filePath) : canonicalMediaPath(filePath);
  },
  takePristine: (filePath) => sessionTransferCards.takePristine(filePath),
});

// The managed download folder is user-settable and persisted under app userData.
// It is loaded before the root-bound services below so every worker starts on
// the selected folder; changing it later re-points those services (see
// engineHost.changeFolder) without moving or deleting any existing files.
const settingsFile = path.join(app.getPath('userData'), 'clipdock-settings.json');
const folderPreference = loadDownloadFolder(settingsFile, app.getPath('downloads'));
let userSelectedFolder = folderPreference.userSelected;
// Runtime roots are private to this process; stale shared temp directories cannot break startup.
const runtimeRoot = path.join(tmpdir(), `clipdock-runtime-${randomUUID()}`);
const activeRoot = () => engineHost.activeRoot();
const displayedFolder = () => engineHost.displayedFolder();

function createSensitiveIpcHandler(requireSender: (event: unknown) => void, operation: (event: unknown, ...args: unknown[]) => unknown, readiness: 'engines' | 'immediate' = 'engines') {
  return sensitiveHandler(requireSender, (event, ...args) => engineHost.run(() => operation(event, ...args), readiness));
}

type StockProvider = 'pexels' | 'pixabay';
const credentialStore = (source: CredentialSource, file: string): PexelsCredentialPersistence => process.platform === 'darwin'
  ? new MacKeychainPexelsCredentialStore(undefined, undefined, source)
  : new PexelsCredentialStore(path.join(app.getPath('userData'), file), safeStorage);
const stockCredentials: Record<StockProvider, PexelsCredentialPersistence> = {
  pexels: credentialStore(PEXELS_CREDENTIAL, 'pexels-credential.json'),
  pixabay: credentialStore(PIXABAY_CREDENTIAL, 'pixabay-credential.json'),
};
let currentProjectName: string | null = null;
let currentProjectReadAt: number | null = null;
const busy = () => engineHost.isBusy();
/** Deleting one file waits only for work that reads existing media (Resolve handoffs, media preparation); downloads and searches write elsewhere. */
const mediaInUse = () => engineHost.mediaInUse();
async function refreshHistoryProject(): Promise<void> {
  if (currentProjectReadAt !== null && Date.now() - currentProjectReadAt < 6_000) return;
  try { currentProjectName = (await statusProvider.getStatus()).project.name; currentProjectReadAt = Date.now(); }
  catch { currentProjectName = null; currentProjectReadAt = null; }
}

// One shared completion-service dependency bundle: the card registry, history
// store, project refresh, file validation, and media-prep runner are common to
// every provider; only the provider event channel differs per handler.
const completionDeps: Omit<ArtifactCompletionDependencies, 'emitCompleted'> = {
  // Provider artifacts must remain under the root their active job used.
  isSafeMediaFile: (filePath) => engineHost.operationRoot().resolve(filePath) !== null,
  refreshHistoryProject,
  recordHistory: (input) => ledger.record(input),
  registerCard: (input) => {
    const root = engineHost.operationRoot();
    const filePath = root.resolve(input.path);
    if (!filePath) throw new Error('Could not safely register managed download.');
    // History canonicalizes this same artifact; cards and exposure keys must agree.
    const cardId = ledger.register({ ...input, path: filePath }, root);
    sessionTransferCards.registerDownloadedFile(filePath);
    return cardId;
  },
  prepareMedia: (request) => engineHost.prepareMedia(request),
};

function sendProviderEvent(event: unknown, channel: string, update: unknown): void {
  try {
    const sender = (event as {sender: {isDestroyed?(): boolean; send(channel: string, ...args: unknown[]): void}}).sender;
    if (sender.isDestroyed?.()) return;
    sender.send(channel, update);
  } catch {
    /* A stale or crashed renderer no longer receives provider progress. */
  }
}

const engineHost = createEngineHost({
  folder: folderPreference.folder, runtimeRoot, completion: completionDeps,
  workers: {
    youtube: (engines, sessionDir) => new YtdlpWorker(engines.ytdlpPath, undefined, undefined, { ...engines, sessionDir }),
    pinterest: (engines, sessionDir) => new GalleryDlWorker(engines.galleryDlPath, undefined, { ffmpegPath: engines.ffmpegPath, sessionDir }),
    pexels: sessionDir => new PexelsClient(sessionDir),
    pixabay: sessionDir => new PixabayClient(sessionDir),
    mediaPrep: engines => createMediaPrep(engines),
  },
  registerSubtitle: (filePath, fileName) => ({cardId: ledger.registerSubtitle(filePath, engineHost.operationRoot()), fileName}),
  emit: (provider, event, update) => ({
    youtube: () => sendProviderEvent(event, IPC_CHANNELS.youtubeEvent, update),
    social: () => sendProviderEvent(event, IPC_CHANNELS.socialEvent, update),
    pinterest: () => sendProviderEvent(event, IPC_CHANNELS.pinterestEvent, update),
    pexels: () => sendProviderEvent(event, IPC_CHANNELS.pexelsEvent, update),
    pixabay: () => sendProviderEvent(event, IPC_CHANNELS.pixabayEvent, update),
  })[provider](),
  restoreCredential: restoreStockCredential,
  disposeCredential: async () => { await Promise.all([stockCredentials.pexels.dispose?.(), stockCredentials.pixabay.dispose?.()]); },
});

// History can consult the root while loading legacy records; capture it first.
const history = new DownloadHistory(path.join(app.getPath('userData'), 'download-history.json'), activeRoot, () => currentProjectName);
const ledger = new DownloadLedger(history, mediaInUse);

// OS drag icon. macOS startDrag REQUIRES a non-empty icon; a 32x32 PNG data URL
// is a valid NativeImage (no asset file needed). Keep it accent-colored for visibility.
const DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQUlEQVR4nO3XMREAIAwEwSiJHAoU4QKZyAAXJMUW1/9s95Fj3cqizYC5z9cMIECAAAECBAgQIECAAIF+All9Tqt6JXwm1z9u/FUAAAAASUVORK5CYII=',
);

/** Re-validate the card path on EVERY operation: delegates to the Electron-free helper. */
function isSafeMediaFile(p: unknown, trustedRoot?: unknown): boolean {
  return isSafeMediaFileHelper(p, trustedRoot);
}

/** Card lookup always crosses the ownership ledger. */
function resolveCard(cardId: unknown): Card | null { return resolveMainProcessCard(ledger, cardId); }

const invalidTargetBin = (targetBin: unknown): boolean => targetBin !== 'active' && targetBin !== 'clipdock';
const invalidTimelinePlacement = (placement: unknown): boolean => placement !== 'end' && placement !== 'playhead';

function registerTransferEventHandlers(): void {
  // OS file dialog — selection happens ONLY in main; the renderer receives a cardId.
  ipcMain.handle(IPC_CHANNELS.selectFile, createSensitiveIpcHandler(requireTrustedSender, () => engineHost.operation(async () => {
    const options = {
      title: 'Choose a local video',
      filters: [{ name: 'Video files', extensions: ['mp4', 'mov', 'mkv'] }],
      properties: ['openFile'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { canceled: true } as const;
    const filePath = result.filePaths[0];
    if (!isSafeMediaFile(filePath)) return { canceled: true } as const;
    const id = ledger.registerExternal(filePath);
    return { canceled: false, cardId: id, fileName: path.basename(filePath) } as const;
  })));

  const transferHandlers = registerMainTransferInvokeHandlers(
    ipcMain as unknown as MainIpcRegistrar,
    { importToMediaPool: IPC_CHANNELS.importToMediaPool, addToTimeline: IPC_CHANNELS.addToTimeline },
    {
      requireSender: (event) => requireClipdockSender(event as IpcMainInvokeEvent),
      resolveCard,
      noteNativeDrag: (filePath) => sessionTransferCards.noteExposed(filePath),
      transfer,
      runTransfer: async (card, operation) => {
        return engineHost.handoff(() => transferBoundary.run(card, operation));
      },
      invalidTargetBin,
      invalidTimelinePlacement,
    },
  );

  // Fire-and-forget native drag: SYNCHRONOUS handler, no await. The renderer sends
  // opaque cardId(s) on `dragstart`; main resolves every one and starts the OS file
  // drag so the user can drop the real file(s) onto the Resolve Media Pool or timeline.
  ipcMain.on(IPC_CHANNELS.nativeDragStart, (event, cardIds: unknown) => {
    transferHandlers.nativeDragStart(event, cardIds, (filePath) => {
      if (Array.isArray(filePath)) event.sender.startDrag({ files: filePath, icon: DRAG_ICON });
      else event.sender.startDrag({ file: filePath, icon: DRAG_ICON });
    });
  });
}

/** Descriptor facts belong to Electron; worker roles and admission belong to the host. */
function registerProviderHandlers(): void {
  const youtube = engineHost.provider('youtube'), social = engineHost.provider('social');
  const pinterest = engineHost.provider('pinterest'), pexels = engineHost.provider('pexels'), pixabay = engineHost.provider('pixabay');
  const providers = [
    {cancel: IPC_CHANNELS.cancelYoutube, host: youtube, routes: [
      [IPC_CHANNELS.searchYoutube, (_event: unknown, query: unknown, page: unknown) => youtube.search(query, page)],
      [IPC_CHANNELS.prefetchYoutube, (_event: unknown, url: unknown) => youtube.prefetch(url)],
      [IPC_CHANNELS.loadYoutube, (_event: unknown, url: unknown) => youtube.load(url)],
      [IPC_CHANNELS.downloadYoutube, youtube.download],
      [IPC_CHANNELS.searchSubtitles, (_event: unknown, url: unknown, language: unknown) => youtube.subtitles(url, language)],
    ]},
    {cancel: IPC_CHANNELS.cancelSocial, host: social, routes: [
      [IPC_CHANNELS.loadSocialThumbnail, (_event: unknown, url: unknown) => social.thumbnail(url)],
      [IPC_CHANNELS.loadSocial, (_event: unknown, url: unknown) => social.load(url)],
      [IPC_CHANNELS.downloadSocial, social.download],
    ]},
    {cancel: IPC_CHANNELS.cancelPinterest, host: pinterest, routes: [
      [IPC_CHANNELS.searchPinterest, (_event: unknown, query: unknown, page: unknown) => pinterest.search(query, page)],
      [IPC_CHANNELS.loadPinterest, (_event: unknown, url: unknown) => pinterest.load(url)],
      [IPC_CHANNELS.downloadPinterest, pinterest.download],
    ]},
    {cancel: IPC_CHANNELS.cancelPexels, host: pexels, routes: [
      [IPC_CHANNELS.searchPexels, (_event: unknown, kind: unknown, query: unknown, page: unknown) => pexels.search(kind, query, page)],
      [IPC_CHANNELS.loadPexels, (_event: unknown, kind: unknown, id: unknown) => pexels.load(kind, id)],
      [IPC_CHANNELS.downloadPexels, pexels.download],
      [IPC_CHANNELS.cancelPexelsRequests, () => pexels.abortRequests()],
    ]},
    {cancel: IPC_CHANNELS.cancelPixabay, host: pixabay, routes: [
      [IPC_CHANNELS.searchPixabay, (_event: unknown, kind: unknown, query: unknown, page: unknown) => pixabay.search(kind, query, page)],
      [IPC_CHANNELS.loadPixabay, (_event: unknown, kind: unknown, id: unknown) => pixabay.load(kind, id)],
      [IPC_CHANNELS.downloadPixabay, pixabay.download],
      [IPC_CHANNELS.cancelPixabayRequests, () => pixabay.abortRequests()],
    ]},
  ] satisfies Array<{cancel: string; host: {cancel(jobId: unknown): boolean}; routes: Array<[string, (event: unknown, ...args: unknown[]) => unknown]>}>;
  for (const provider of providers) {
    for (const [channel, handler] of provider.routes) ipcMain.handle(channel, createSensitiveIpcHandler(requireTrustedSender, handler));
    ipcMain.handle(provider.cancel, createSensitiveIpcHandler(requireTrustedSender, (_event, jobId) => provider.host.cancel(jobId)));
  }
}

function canonicalYoutubeWatchUrl(videoId: unknown, startSeconds: unknown): string | null {
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID.test(videoId)) return null;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  if (startSeconds === undefined) return url;
  if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > YOUTUBE_MAX_START_SECONDS) return url;
  const seconds = Math.floor(startSeconds);
  return seconds > 0 ? `${url}&t=${seconds}s` : url;
}

function registerExternalOpenHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.openYoutubeExternal, async (event, videoId: unknown, startSeconds: unknown) => {
    requireClipdockSender(event);
    const url = canonicalYoutubeWatchUrl(videoId, startSeconds);
    if (!url) return false;
    try { await shell.openExternal(url); return true; } catch { return false; }
  });
}

function sendYoutubePreviewState(state: 'closed' | 'failed', reason: 'closed' | 'escape' | 'load' | 'crash'): void {
  try {
    if (mainWindow && isValidatedClipdockFrame(mainWindow.webContents.mainFrame)) mainWindow.webContents.send(IPC_CHANNELS.youtubePreviewState, { state, reason });
  } catch { /* A stale renderer never receives player state. */ }
}

function closeYoutubePreview(reason: 'closed' | 'escape' | 'load' | 'crash' = 'closed', notify = true): boolean {
  const view = youtubePreviewView;
  if (!view) return false;
  youtubePreviewView = null;
  youtubePreviewBounds = null;
  youtubePreviewGeneration += 1;
  try { mainWindow?.contentView.removeChildView(view); } catch { /* already detached */ }
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already destroyed */ }
  if (notify) sendYoutubePreviewState(reason === 'load' || reason === 'crash' ? 'failed' : 'closed', reason);
  return true;
}

function applyYoutubePreviewBounds(bounds: unknown): boolean {
  if (!mainWindow || !youtubePreviewView) return false;
  const [width, height] = mainWindow.getContentSize();
  const normalized = normalizePreviewBounds(bounds, { width, height });
  if (!normalized) { closeYoutubePreview(); return false; }
  youtubePreviewBounds = bounds as PreviewBounds;
  youtubePreviewView.setBounds(normalized);
  return true;
}

function registerYoutubePreviewHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.openYoutubePreview, async (event, videoId: unknown, startSeconds: unknown, bounds: unknown) => {
    requireClipdockSender(event);
    const url = youtubePreviewUrl(videoId, startSeconds);
    if (!url || !mainWindow) return false;
    const [width, height] = mainWindow.getContentSize();
    const normalized = normalizePreviewBounds(bounds, { width, height });
    if (!normalized) return false;
    closeYoutubePreview('closed', false);
    const generation = ++youtubePreviewGeneration;
    const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'clipdock-youtube-preview' } });
    youtubePreviewView = view;
    youtubePreviewBounds = bounds as PreviewBounds;
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault());
    view.webContents.on('will-redirect', (navigationEvent) => navigationEvent.preventDefault());
    view.webContents.on('before-input-event', (inputEvent, input) => {
      if (youtubePreviewView === view && input?.type === 'keyDown' && input.key === 'Escape') { inputEvent.preventDefault(); closeYoutubePreview('escape'); }
    });
    view.webContents.on('did-fail-load', (_loadEvent, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (isMainFrame !== false && errorCode !== -3 && youtubePreviewView === view) closeYoutubePreview('load');
    });
    view.webContents.on('render-process-gone', () => { if (youtubePreviewView === view) closeYoutubePreview('crash'); });
    mainWindow.contentView.addChildView(view);
    view.setBounds(normalized);
    try {
      await view.webContents.loadURL(url, { httpReferrer: YOUTUBE_PREVIEW_REFERRER });
      return generation === youtubePreviewGeneration && youtubePreviewView === view;
    } catch {
      if (youtubePreviewView === view) closeYoutubePreview('load');
      return false;
    }
  });
  ipcMain.handle(IPC_CHANNELS.closeYoutubePreview, async (event) => { requireClipdockSender(event); return closeYoutubePreview(); });
  ipcMain.handle(IPC_CHANNELS.setYoutubePreviewBounds, async (event, bounds: unknown) => { requireClipdockSender(event); return applyYoutubePreviewBounds(bounds); });
}

async function restoreStockCredential(provider: StockProvider, client: Pick<StockClient, 'restoreStatus' | 'restoreKey'>): Promise<void> {
  const credentials = stockCredentials[provider];
  const restored = await credentials.load();
  if (!restored.key) { client.restoreStatus(restored.message); return; }
  if (client.restoreKey(restored.key, true, restored.message)) return;
  try {
    await credentials.clear();
    client.restoreStatus('Disconnected. Saved credential was invalid and removed.');
  } catch {
    client.restoreStatus('Disconnected. Saved credential was invalid but could not be removed.');
  }
}

/** Each stock provider has its own key, Keychain item and IPC channels; the flows are identical. */
function stockHandlers(provider: StockProvider, label: string, safeExternal: (url: unknown) => string | null) {
  const credentials = stockCredentials[provider];
  return {
    status: createSensitiveIpcHandler(requireTrustedSender, () => engineHost.credential(provider, client => client.status())),
    set: createSensitiveIpcHandler(requireTrustedSender, (_event, key: unknown) => engineHost.credential(provider, async client => {
      const validated = await client.validateKey(key);
      const previous = client.status();
      const persisted = await credentials.save(validated).catch(() => false);
      if (!persisted && previous.connected && previous.persisted) throw new Error(`Could not save the new ${label} credential securely. Your existing connection was kept.`);
      return client.setKey(validated, persisted);
    })),
    clear: createSensitiveIpcHandler(requireTrustedSender, () => engineHost.credential(provider, async client => {
      try { await credentials.clear(); }
      catch { throw new Error(`Could not disconnect ${label} because the saved credential was not removed.`); }
      client.clearKey();
      return client.status();
    })),
    open: createSensitiveIpcHandler(requireTrustedSender, async (_event, url: unknown) => { const safe = safeExternal(url); if (!safe) return false; try { await shell.openExternal(safe); return true; } catch { return false; } }),
  };
}

function registerStockHandlers(): void {
  const pexels = stockHandlers('pexels', 'Pexels', safePexelsExternal), pixabay = stockHandlers('pixabay', 'Pixabay', safePixabayExternal);
  ipcMain.handle(IPC_CHANNELS.pexelsKeyStatus, pexels.status);
  ipcMain.handle(IPC_CHANNELS.setPexelsKey, pexels.set);
  ipcMain.handle(IPC_CHANNELS.clearPexelsKey, pexels.clear);
  ipcMain.handle(IPC_CHANNELS.openPexelsExternal, pexels.open);
  ipcMain.handle(IPC_CHANNELS.pixabayKeyStatus, pixabay.status);
  ipcMain.handle(IPC_CHANNELS.setPixabayKey, pixabay.set);
  ipcMain.handle(IPC_CHANNELS.clearPixabayKey, pixabay.clear);
  ipcMain.handle(IPC_CHANNELS.openPixabayExternal, pixabay.open);
}

function registerWorkspaceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.workspaceStatus, createSensitiveIpcHandler(requireTrustedSender, async () => inspectWorkspaceAsync(activeRoot(), ledger.protectedPaths()), 'immediate'));
  ipcMain.handle(IPC_CHANNELS.openWorkspace, createSensitiveIpcHandler(requireTrustedSender, async () => { sessionTransferCards.noteAllExposed(); return (await shell.openPath(activeRoot().verify())) === ''; }));
  ipcMain.handle(IPC_CHANNELS.cleanupWorkspace, createSensitiveIpcHandler(requireTrustedSender, async () => {
    if (busy()) throw new Error('Wait for active downloads or media preparation to finish.');
    return engineHost.withFolderChange(() => cleanupWorkspaceAsync(activeRoot(), ledger.protectedPaths()));
  }));
}

function registerHistoryHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.historyList, createSensitiveIpcHandler(requireTrustedSender, async () => {
    return ledger.listHistory();
  }, 'immediate'));
  ipcMain.handle(IPC_CHANNELS.queueDelete, createSensitiveIpcHandler(requireTrustedSender, async (_event, cardId: unknown) => ledger.deleteCard(cardId)));
  ipcMain.handle(IPC_CHANNELS.historyReuse, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => engineHost.operation(async () => { await refreshHistoryProject(); return ledger.reuseHistory(id); })));
  ipcMain.handle(IPC_CHANNELS.historyReveal, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => { const hit = history.resolve(id); if (!hit) return false; sessionTransferCards.noteExposed(hit.path); shell.showItemInFolder(hit.path); return true; }));
  // Subtitle companions resolve only in main; the renderer gets a boolean, never a path.
  ipcMain.handle(IPC_CHANNELS.historyRevealSubtitle, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => { const hit = history.resolveSubtitle(id); if (!hit) return false; sessionTransferCards.noteExposed(hit.path); shell.showItemInFolder(hit.path); return true; }));
  ipcMain.handle(IPC_CHANNELS.historySource, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => { const record = history.get(id); if (!record) return false; const source = safeHistorySource(record.provider, record.source); if (!source) return false; try { await shell.openExternal(source); return true; } catch { return false; } }));
  ipcMain.handle(IPC_CHANNELS.historyCopy, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => { const hit = history.resolve(id); if (!hit) return false; sessionTransferCards.noteExposed(hit.path); clipboard.writeText(hit.path); return true; }));
  ipcMain.handle(IPC_CHANNELS.historyRelink, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => { if (typeof id !== 'string') return null; const result = mainWindow ? await dialog.showOpenDialog(mainWindow, { filters: [{ name: 'Supported media', extensions: RELINK_EXTENSIONS }], properties: ['openFile'] }) : await dialog.showOpenDialog({ filters: [{ name: 'Supported media', extensions: RELINK_EXTENSIONS }], properties: ['openFile'] }); return result.canceled || !result.filePaths[0] ? null : history.relink(id, result.filePaths[0]); }));
  ipcMain.handle(IPC_CHANNELS.historyDelete, createSensitiveIpcHandler(requireTrustedSender, async (_event, id: unknown) => {
    return ledger.deleteHistory(id);
  }));
}

function registerFolderHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.downloadFolderStatus, async (event: IpcMainInvokeEvent) => {
    requireClipdockSender(event);
    return { folder: displayedFolder(), userSelected: userSelectedFolder, error: engineHost.error() };
  });
  ipcMain.handle(IPC_CHANNELS.chooseDownloadFolder, async (event: IpcMainInvokeEvent) => {
    requireClipdockSender(event);
    const folder = await engineHost.changeFolder(async () => {
      const options = {
        title: 'Choose ClipDock download folder',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    }, candidate => ManagedRoot.prepare(candidate, next => claimDownloadFolder(next, defaultDownloadFolder(app.getPath('downloads')))),
    next => saveDownloadFolder(settingsFile, next));
    if (folder === null) return { folder: displayedFolder(), userSelected: userSelectedFolder, error: engineHost.error() };
    userSelectedFolder = true;
    return { folder, userSelected: true };
  });
}

function registerResolveEventHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getStatus, createSensitiveIpcHandler(requireTrustedSender, async () => { const status = await statusProvider.getStatus(); currentProjectName = status.project.name; currentProjectReadAt = Date.now(); return status; }, 'immediate'));
}

function registerWindowHandlers(): void {
  // Session-only window-above-others control: main owns the native call and never
  // persists the state, so closing the window resets it naturally.
  ipcMain.handle(IPC_CHANNELS.setAlwaysOnTop, createSensitiveIpcHandler(requireTrustedSender, async (_event, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin request.');
    if (!mainWindow) throw new Error('No ClipDock window.');
    mainWindow.setAlwaysOnTop(pinned);
    return mainWindow.isAlwaysOnTop();
  }, 'immediate'));
}

// The SINGLE quit trigger shared by normal window quit and ResolveQuit.
// ResolveQuit sends the renderer its final notification BEFORE it starts the
// normal app.quit flow. The before-quit handler below owns disposal and the
// existing best-effort native CleanUp call.
const shutdown = createShutdownCoordinator({
  notifyRenderer: () => {
    try {
      if (mainWindow && isValidatedClipdockFrame(mainWindow.webContents.mainFrame)) {
        mainWindow.webContents.send(IPC_CHANNELS.resolveQuit);
      }
    } catch {
      /* a stale or navigating renderer never receives the final notification */
    }
  },
  requestQuit: () => {
    app.quit();
  },
});

function registerResolveCallbacks(): void {
  try {
    WorkflowIntegration.RegisterCallback('ResolveQuit', () => {
      statusProvider.noteResolveQuit();
      transfer.noteResolveQuit();
      currentProjectName = null; currentProjectReadAt = null;
      // Final renderer notification first, then the single idempotent shutdown
      // (any second quit event — another ResolveQuit or a window close — is a no-op).
      shutdown.beginShutdown('resolve-quit');
    });
  } catch {
    /* callback registration is best-effort */
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    useContentSize: true,
    title: 'ClipDock',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  (mainWindow as unknown as { setMinimumSize(width: number, height: number): void }).setMinimumSize(560, 560);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  mainWindow.on('resize', () => { if (youtubePreviewBounds) applyYoutubePreviewBounds(youtubePreviewBounds); });
  mainWindow.on('close', () => {
    closeYoutubePreview('closed', false);
    app.quit();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools(); // uncomment for development
}

app.whenReady().then(() => {
  // One panel process per persistent store also prevents cross-process workspace cleanup during a live download.
  const instanceApp = app as typeof app & { requestSingleInstanceLock(): boolean };
  if (!instanceApp.requestSingleInstanceLock()) { app.quit(); return; }
  // Handler registration and window creation stay synchronous; credential
  // restoration continues in the background afterwards.
  runStartupSequence({
    registerHandlers: () => {
      registerExternalOpenHandlers();
      registerYoutubePreviewHandlers();
      registerTransferEventHandlers();
      registerProviderHandlers();
      registerStockHandlers();
      registerWorkspaceHandlers();
      registerHistoryHandlers();
      registerFolderHandlers();
      registerResolveEventHandlers();
      registerWindowHandlers();
      registerResolveCallbacks();
    },
    createWindow,
    startBackgroundServices: () => { void engineHost.start(discoverEnginePaths()); },
  });
});

// Always quit when the window closes (no macOS dock persistence): the plugin must
// release the WorkflowIntegration.node file handle so Resolve can be restarted or
// the plugin updated cleanly (known trap: lingering Electron processes lock the file).
app.on('window-all-closed', () => {
  app.quit();
});

let quitReady = false;
let quitPending = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  shutdown.beginShutdown('window-quit');
  closeYoutubePreview('closed', false);
  void engineHost.dispose().finally(() => {
    try { WorkflowIntegration.CleanUp(); } catch { /* best-effort cleanup */ }
    quitReady = true;
    app.quit();
  });
});
