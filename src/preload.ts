// Sandboxed preload script. Runs in the same sandbox as a Chrome extension:
// only a whitelist of Electron built-ins can be required — no local files and
// no Node.js APIs. Mirrors the official SamplePlugin preload pattern
// (`require('electron/renderer')` + contextBridge).

// `electron/renderer` is a whitelisted module in sandboxed preloads (same require
// pattern as the official SamplePlugin). Local module imports stay type-only:
// they are erased at compile time, so this file has no runtime requires of local files.
import { contextBridge, ipcRenderer } from 'electron/renderer';
import type { ClipdockApi, DownloadFolderStatus, HistoryDeleteResult, HistoryRecord, MediaProfile, PexelsAsset, PexelsEvent, PexelsKind, PexelsPage, PinterestEvent, PinterestMetadata, PinterestSearchPage, PreviewBounds, QueueDeleteResult, SelectFileResult, SocialEvent, SocialMetadata, SubtitleCue, TargetBin, TimelinePlacement, YoutubeDownloadOptions, YoutubeEvent, YoutubeMetadata, YoutubePreviewState, YoutubeQuality, YoutubeSearchPage, SubtitleLanguage } from './shared';
import type { TransferResult } from './transfer';
import type { StatusSnapshot } from './status';

const api: ClipdockApi = {
  getStatus: () =>
    ipcRenderer.invoke('clipdock:getStatus') as Promise<StatusSnapshot>,
  downloadFolderStatus: () => ipcRenderer.invoke('clipdock:download-folder-status') as Promise<DownloadFolderStatus>,
  chooseDownloadFolder: () => ipcRenderer.invoke('clipdock:choose-download-folder') as Promise<DownloadFolderStatus>,
  onResolveQuit: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('clipdock:resolve-quit', listener);
    return () => {
      ipcRenderer.removeListener('clipdock:resolve-quit', listener);
    };
  },
  selectFile: () => ipcRenderer.invoke('clipdock:select-file') as Promise<SelectFileResult>,
  // Fire-and-forget: the native drag is started synchronously in main on the
  // `dragstart` IPC; the renderer must not await it. Only opaque cardIds cross
  // this boundary; main resolves every card to its current safe path.
  startNativeDrag: (cardIds: string | string[]) => {
    ipcRenderer.send('clipdock:native-drag-start', cardIds);
  },
  importToMediaPool: (cardId: string, targetBin: TargetBin) =>
    ipcRenderer.invoke('clipdock:import-to-media-pool', cardId, targetBin) as Promise<TransferResult>,
  addToTimeline: (cardId: string, targetBin: TargetBin, placement: TimelinePlacement) =>
    ipcRenderer.invoke('clipdock:add-to-timeline', cardId, targetBin, placement) as Promise<TransferResult>,
  searchYoutube: (query: string, page: number) => ipcRenderer.invoke('clipdock:search-youtube', query, page) as Promise<YoutubeSearchPage>,
  prefetchYoutube: (url: string) => ipcRenderer.invoke('clipdock:prefetch-youtube', url) as Promise<void>,
  loadYoutube: (url: string) => ipcRenderer.invoke('clipdock:load-youtube', url) as Promise<YoutubeMetadata>,
  downloadYoutube: (url: string, quality: YoutubeQuality, profile: MediaProfile, jobId: string, options: YoutubeDownloadOptions) =>
    ipcRenderer.invoke('clipdock:download-youtube', url, quality, profile, jobId, options) as Promise<{ cardId: string; fileName: string; subtitle?: { cardId: string; fileName: string }; warning?: string }>,
  cancelYoutube: (jobId: string) => ipcRenderer.invoke('clipdock:cancel-youtube', jobId) as Promise<boolean>,
  loadSocialThumbnail: (url: string) => ipcRenderer.invoke('clipdock:load-social-thumbnail', url) as Promise<string | null>,
  loadSocial: (url: string) => ipcRenderer.invoke('clipdock:load-social', url) as Promise<SocialMetadata>,
  downloadSocial: (url: string, quality: YoutubeQuality, profile: MediaProfile, jobId: string) => ipcRenderer.invoke('clipdock:download-social', url, quality, profile, jobId) as Promise<{ cardId: string; fileName: string; warning?: string }>,
  cancelSocial: (jobId: string) => ipcRenderer.invoke('clipdock:cancel-social', jobId) as Promise<boolean>,
  onSocialEvent: (callback: (event: SocialEvent) => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => callback(args[0] as SocialEvent);
    ipcRenderer.on('clipdock:social-event', listener);
    return () => ipcRenderer.removeListener('clipdock:social-event', listener);
  },
  searchPinterest: (query: string, page: number) => ipcRenderer.invoke('clipdock:search-pinterest', query, page) as Promise<PinterestSearchPage>,
  loadPinterest: (url: string) => ipcRenderer.invoke('clipdock:load-pinterest', url) as Promise<PinterestMetadata>,
  downloadPinterest: (url: string, itemIndex: number, profile: MediaProfile, jobId: string) => ipcRenderer.invoke('clipdock:download-pinterest', url, itemIndex, profile, jobId) as Promise<{ cardId: string; fileName: string; warning?: string }>,
  cancelPinterest: (jobId: string) => ipcRenderer.invoke('clipdock:cancel-pinterest', jobId) as Promise<boolean>,
  onPinterestEvent: (callback: (event: PinterestEvent) => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => callback(args[0] as PinterestEvent);
    ipcRenderer.on('clipdock:pinterest-event', listener);
    return () => ipcRenderer.removeListener('clipdock:pinterest-event', listener);
  },
  queueDelete: (cardId: string) => ipcRenderer.invoke('clipdock:queue-delete', cardId) as Promise<QueueDeleteResult>,
  searchSubtitles: (url: string, language: SubtitleLanguage) => ipcRenderer.invoke('clipdock:search-subtitles', url, language) as Promise<SubtitleCue[]>,
  onYoutubeEvent: (callback: (event: YoutubeEvent) => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => callback(args[0] as YoutubeEvent);
    ipcRenderer.on('clipdock:youtube-event', listener);
    return () => ipcRenderer.removeListener('clipdock:youtube-event', listener);
  },
  setAlwaysOnTop: (pinned: boolean) => ipcRenderer.invoke('clipdock:set-always-on-top', pinned) as Promise<boolean>,
  pexelsKeyStatus: () => ipcRenderer.invoke('clipdock:pexels-key-status') as Promise<{ connected: boolean; persisted: boolean; message: string }>,
  setPexelsKey: (key: string) => ipcRenderer.invoke('clipdock:set-pexels-key', key) as Promise<{ connected: boolean; persisted: boolean; message: string }>,
  clearPexelsKey: () => ipcRenderer.invoke('clipdock:clear-pexels-key') as Promise<{ connected: boolean; persisted: boolean; message: string }>,
  searchPexels: (kind: PexelsKind, query: string, page: number) => ipcRenderer.invoke('clipdock:search-pexels', kind, query, page) as Promise<PexelsPage>,
  loadPexels: (kind: PexelsKind, id: number) => ipcRenderer.invoke('clipdock:load-pexels', kind, id) as Promise<PexelsAsset>,
  downloadPexels: (asset: PexelsAsset, fileId: string, profile: MediaProfile, jobId: string) => ipcRenderer.invoke('clipdock:download-pexels', asset, fileId, profile, jobId) as Promise<{ cardId: string; fileName: string; warning?: string }>,
  cancelPexels: (jobId: string) => ipcRenderer.invoke('clipdock:cancel-pexels', jobId) as Promise<boolean>,
  cancelPexelsRequests: () => ipcRenderer.invoke('clipdock:cancel-pexels-requests') as Promise<boolean>,
  onPexelsEvent: (callback: (event: PexelsEvent) => void) => { const listener = (_event: unknown, ...args: unknown[]) => callback(args[0] as PexelsEvent); ipcRenderer.on('clipdock:pexels-event', listener); return () => ipcRenderer.removeListener('clipdock:pexels-event', listener); },
  openPexelsExternal: (url: string) => ipcRenderer.invoke('clipdock:open-pexels-external', url) as Promise<boolean>,
  openYoutubeExternal: (videoId: string, startSeconds?: number) => ipcRenderer.invoke('clipdock:open-youtube-external', videoId, startSeconds) as Promise<boolean>,
  openYoutubePreview: (videoId: string, startSeconds: number | undefined, bounds: PreviewBounds) => ipcRenderer.invoke('clipdock:youtube-preview-open', videoId, startSeconds, bounds) as Promise<boolean>,
  closeYoutubePreview: () => ipcRenderer.invoke('clipdock:youtube-preview-close') as Promise<boolean>,
  setYoutubePreviewBounds: (bounds: PreviewBounds) => ipcRenderer.invoke('clipdock:youtube-preview-bounds', bounds) as Promise<boolean>,
  onYoutubePreviewState: (callback: (state: YoutubePreviewState) => void) => { const listener = (_event: unknown, ...args: unknown[]) => callback(args[0] as YoutubePreviewState); ipcRenderer.on('clipdock:youtube-preview-state', listener); return () => ipcRenderer.removeListener('clipdock:youtube-preview-state', listener); },
  workspaceStatus: () => ipcRenderer.invoke('clipdock:workspace-status') as Promise<{ fileCount: number; totalBytes: number; cleanupFileCount: number; cleanupBytes: number }>,
  openWorkspace: () => ipcRenderer.invoke('clipdock:open-workspace') as Promise<boolean>,
  cleanupWorkspace: () => ipcRenderer.invoke('clipdock:cleanup-workspace') as Promise<{ deletedFileCount: number; deletedBytes: number; fileCount: number; totalBytes: number }>,
  historyList: () => ipcRenderer.invoke('clipdock:history-list') as Promise<HistoryRecord[]>,
  historyReuse: (id: string) => ipcRenderer.invoke('clipdock:history-reuse', id) as Promise<{ cardId: string; fileName: string } | null>,
  historyReveal: (id: string) => ipcRenderer.invoke('clipdock:history-reveal', id) as Promise<boolean>,
  historyRevealSubtitle: (id: string) => ipcRenderer.invoke('clipdock:history-reveal-subtitle', id) as Promise<boolean>,
  historySource: (id: string) => ipcRenderer.invoke('clipdock:history-source', id) as Promise<boolean>,
  historyCopy: (id: string) => ipcRenderer.invoke('clipdock:history-copy', id) as Promise<boolean>,
  historyRelink: (id: string) => ipcRenderer.invoke('clipdock:history-relink', id) as Promise<HistoryRecord | null>,
  historyDelete: (id: string) => ipcRenderer.invoke('clipdock:history-delete', id) as Promise<HistoryDeleteResult>,
};

contextBridge.exposeInMainWorld('clipdockAPI', api);
