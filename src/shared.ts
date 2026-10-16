// Shared IPC contract between main, preload and renderer.
// Preload imports ONLY types from this module (`import type`), which TypeScript
// erases at compile time. The renderer is a plain browser script with no imports.

import type { StatusSnapshot } from './status';
import type { TargetBin, TimelinePlacement, TransferResult } from './transfer';
// Re-export so main/preload import the narrow transfer types from the shared IPC contract.
export type { TargetBin, TimelinePlacement };

// Single contract source: canonical values live in scripts/lib/contracts.mjs
// @ts-ignore — plain .mjs contract module, no declaration file needed; re-exported as canonical runtime values
import { IPC_CHANNELS as CONTRACT_IPC_CHANNELS } from '../scripts/lib/contracts.mjs';
export const IPC_CHANNELS = CONTRACT_IPC_CHANNELS as typeof CONTRACT_IPC_CHANNELS;
// Re-export contract constants for runtime consumers that import from shared
// (and for type parity checks). The verifier imports the contracts directly.
// @ts-ignore — contracts.mjs is plain JS
// eslint-disable-next-line @typescript-eslint/no-require-imports
// @ts-expect-error no types for .mjs contract
export { PLUGIN_ID, DOWNLOAD_INTENTS, MEDIA_PROFILES, DIST_REQUIRED_FILES, REQUIRED_HTML_IDS, REQUIRED_HTML_IDS_FLAT } from '../scripts/lib/contracts.mjs';



/** History deletion also invalidates any session cards bound to the removed record. */
export type HistoryDeleteResult = { deleted: boolean; removed: boolean; warning?: string; removedCardIds?: string[] };

/** Result of selecting a local file. The absolute path NEVER crosses IPC: only a cardId. */
export type SelectFileResult = { canceled: true } | { canceled: false; cardId: string; fileName: string };

/**
 * Current managed download folder. The absolute path may cross IPC ONLY as the
 * display/status value chosen through the main-process directory dialog; all
 * downloads and workspace operations stay main-owned.
 */
export interface DownloadFolderStatus {
  folder: string;
  /** True when the user explicitly chose this folder (vs the Downloads/ClipDock default). */
  userSelected: boolean;
}

/** Narrow API surface exposed to the renderer via contextBridge (see preload.ts). */
export type YoutubeQuality = 'best' | `${number}p`;
export type MediaProfile = 'original' | 'fast' | 'editing';
export type MediaMode = 'video' | 'audio';
/** AAC is delivered as an M4A container so the extension is unambiguous. */
export type AudioFormat = 'wav' | 'mp3' | 'm4a';
export type SubtitleLanguage = 'en' | 'es' | 'fr' | 'de' | 'tr';
export type YoutubeSelection = { start: number; end: number; label: string } | null;
export type YoutubeDownloadOptions = { mediaMode: MediaMode; audioFormat: AudioFormat; subtitles: boolean; subtitleLanguage: SubtitleLanguage; selection?: YoutubeSelection };
export type SocialPlatform = 'instagram' | 'twitter' | 'facebook';
export type PinterestMediaKind = 'image' | 'video';
export type PinterestItem = { index: number; kind: PinterestMediaKind; title: string; creator: string | null; extension: string };
export type PinterestMetadata = { pinId: string; source: string; title: string; creator: string | null; kind: PinterestMediaKind | 'carousel'; items: PinterestItem[]; thumbnailUrl: string | null };
export type PinterestSearchKind = PinterestMediaKind | 'carousel';
export type PinterestSearchItem = { id: string; title: string; creator: string | null; kind: PinterestSearchKind; url: string; thumbnailUrl: string | null };
export type PinterestSearchPage = { query: string; page: number; pageSize: 10; results: PinterestSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: { failed: number; total: number; reason: string; node: string } };
export type SocialMetadata = { id: string; platform: SocialPlatform; source: string; title: string; duration: number | null; channel: string | null; thumbnailDataUrl: string | null; heights: number[]; formatSummary: string[] };
export type DownloadArtifact = { cardId: string; fileName: string };
export type QueueDeleteResult = { deleted: boolean; message: string };
export type YoutubeChapter = { start: number; end: number; title: string };
export type SubtitleCue = { start: number; end: number; text: string };
export type YoutubeMetadata = { id: string; title: string; duration: number | null; channel: string | null; thumbnailUrl: string | null; heights: number[]; formatSummary: string[]; chapters: YoutubeChapter[] };
export type HistorySelection = { start: number; end: number; label: string } | null;
export type HistoryAutomation = { provider: 'youtube' | 'pexels' | 'social' | 'pinterest'; source: string; selection: HistorySelection; chapters: YoutubeChapter[] };
export type HistoryRecord = { id: string; provider: 'youtube' | 'pexels' | 'social' | 'pinterest'; source: string; project: string | null; fileName: string; bytes: number; assetId: string | null; title: string; creator: string | null; profile: string; quality: string | null; mediaMode: string; selection: HistorySelection; automation: HistoryAutomation; createdAt: number; lastUsedAt: number; available: boolean; /** Optional companion subtitle persisted by main; safe metadata only, never a path. */ subtitle?: { fileName: string; bytes: number; available: boolean }; /** Main-enriched opaque cardId bound for native drag. Present only when the record's file resolves and a card is registered; the absolute path never crosses IPC. */ cardId?: string };
export type YoutubeSearchItem = { id: string; title: string; channel: string | null; duration: number | null; url: string; thumbnailUrl: string | null; viewCount: number | null; publishedAt: number | null; channelVerified: boolean };
export type ThumbnailDiagnostic = { failed: number; total: number; reason: string; node: string };
export type YoutubeSearchPage = { query: string; page: number; pageSize: 10; results: YoutubeSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: ThumbnailDiagnostic };
export type YoutubeEvent = { jobId: string; state: 'idle' | 'metadata' | 'downloading' | 'processing' | 'cancelling' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; subtitle?: DownloadArtifact; warning?: string };
export type SocialEvent = { jobId: string; state: 'idle' | 'metadata' | 'downloading' | 'processing' | 'cancelling' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; warning?: string };
export type PexelsKind = 'photo' | 'video';
export type PexelsFile = { id: string; url: string; width: number | null; height: number | null; label: string; mime: 'image/jpeg' | 'image/png' | 'video/mp4'; size: number | null };
export type PexelsAsset = { id: number; kind: PexelsKind; title: string; creator: string | null; creatorUrl: string | null; sourceUrl: string; duration: number | null; width: number | null; height: number | null; thumbnailUrl: string | null; files: PexelsFile[]; previewUrl: string | null };
export type PexelsPage = { query: string; page: number; pageSize: number; results: PexelsAsset[]; hasPrevious: boolean; hasNext: boolean; totalResults: number | null };
export type PexelsEvent = { jobId: string; state: 'downloading' | 'processing' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; cardId?: string; fileName?: string; warning?: string };
export type PinterestEvent = { jobId: string; state: 'downloading' | 'processing' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; warning?: string };
export type PexelsConnectionStatus = { connected: boolean; persisted: boolean; message: string };
export type WorkspaceSummary = { fileCount: number; totalBytes: number; cleanupFileCount: number; cleanupBytes: number };
export type WorkspaceCleanupResult = { deletedFileCount: number; deletedBytes: number; fileCount: number; totalBytes: number };
export type PreviewBounds = { x: number; y: number; width: number; height: number };
export type YoutubePreviewState = { state: 'closed' | 'failed'; reason: 'closed' | 'escape' | 'load' | 'crash' };

export interface ClipdockApi {
  /** Latest Resolve bridge status snapshot. Main never caches; every call is fresh. */
  getStatus(): Promise<StatusSnapshot>;
  /** Read the current managed download folder (main-owned, validated). */
  downloadFolderStatus(): Promise<DownloadFolderStatus>;
  /**
   * Open the native directory chooser and persist the selection. Cancelling
   * changes nothing. Applies to subsequent downloads/workspace operations.
   */
  chooseDownloadFolder(): Promise<DownloadFolderStatus>;
  /** Subscribe to Resolve-quit events. Returns an unsubscribe function. */
  onResolveQuit(callback: () => void): () => void;
  /** Open the OS file dialog (main process). Returns a cardId, never a path. */
  selectFile(): Promise<SelectFileResult>;
  /** Fire-and-forget Resolve fallback: ask main to start an OS-native file drag for one or more opaque cards. */
  startNativeDrag(cardIds: string | string[]): void;
  /** Import the card's file into the Media Pool (API fallback) into the chosen destination bin. */
  importToMediaPool(cardId: string, targetBin: TargetBin): Promise<TransferResult>;
  /** Import the card's file and add it at the selected timeline position in the chosen destination bin. */
  addToTimeline(cardId: string, targetBin: TargetBin, placement: TimelinePlacement): Promise<TransferResult>;
  searchYoutube(query: string, page: number): Promise<YoutubeSearchPage>;
  prefetchYoutube(url: string): Promise<void>;
  loadYoutube(url: string): Promise<YoutubeMetadata>;
  downloadYoutube(url: string, quality: YoutubeQuality, profile: MediaProfile, jobId: string, options: YoutubeDownloadOptions): Promise<DownloadArtifact & { subtitle?: DownloadArtifact; warning?: string }>;
  cancelYoutube(jobId: string): Promise<boolean>;
  loadSocialThumbnail(url: string): Promise<string | null>;
  loadSocial(url: string): Promise<SocialMetadata>;
  downloadSocial(url: string, quality: YoutubeQuality, profile: MediaProfile, jobId: string): Promise<DownloadArtifact & { warning?: string }>;
  cancelSocial(jobId: string): Promise<boolean>;
  onSocialEvent(callback: (event: SocialEvent) => void): () => void;
  searchPinterest(query: string, page: number): Promise<PinterestSearchPage>;
  loadPinterest(url: string): Promise<PinterestMetadata>;
  downloadPinterest(url: string, itemIndex: number, profile: MediaProfile, jobId: string): Promise<DownloadArtifact & { warning?: string }>;
  cancelPinterest(jobId: string): Promise<boolean>;
  onPinterestEvent(callback: (event: PinterestEvent) => void): () => void;
  queueDelete(cardId: string): Promise<QueueDeleteResult>;
  searchSubtitles(url: string, language: SubtitleLanguage): Promise<SubtitleCue[]>;
  onYoutubeEvent(callback: (event: YoutubeEvent) => void): () => void;
  /** Keep the ClipDock window above other windows (session-only, default off). Returns the resulting state. */
  setAlwaysOnTop(pinned: boolean): Promise<boolean>;
  pexelsKeyStatus(): Promise<PexelsConnectionStatus>;
  setPexelsKey(key: string): Promise<PexelsConnectionStatus>;
  clearPexelsKey(): Promise<PexelsConnectionStatus>;
  searchPexels(kind: PexelsKind, query: string, page: number): Promise<PexelsPage>;
  loadPexels(kind: PexelsKind, id: number): Promise<PexelsAsset>;
  downloadPexels(asset: PexelsAsset, fileId: string, profile: MediaProfile, jobId: string): Promise<DownloadArtifact & { warning?: string }>;
  cancelPexels(jobId: string): Promise<boolean>;
  cancelPexelsRequests(): Promise<boolean>;
  onPexelsEvent(callback: (event: PexelsEvent) => void): () => void;
  openPexelsExternal(url: string): Promise<boolean>;
  /** Open a validated YouTube watch URL in the system browser. */
  openYoutubeExternal(videoId: string, startSeconds?: number): Promise<boolean>;
  /** Create the single main-owned YouTube player over validated renderer DIP bounds. */
  openYoutubePreview(videoId: string, startSeconds: number | undefined, bounds: PreviewBounds): Promise<boolean>;
  closeYoutubePreview(): Promise<boolean>;
  setYoutubePreviewBounds(bounds: PreviewBounds): Promise<boolean>;
  onYoutubePreviewState(callback: (state: YoutubePreviewState) => void): () => void;
  workspaceStatus(): Promise<WorkspaceSummary>;
  openWorkspace(): Promise<boolean>;
  cleanupWorkspace(): Promise<WorkspaceCleanupResult>;
  historyList(): Promise<HistoryRecord[]>;
  historyReuse(id: string): Promise<DownloadArtifact | null>;
  historyReveal(id: string): Promise<boolean>;
  /** Reveal the record's subtitle companion in the OS file manager; resolves the path only in main and never returns it. */
  historyRevealSubtitle(id: string): Promise<boolean>;
  historySource(id: string): Promise<boolean>;
  historyCopy(id: string): Promise<boolean>;
  historyRelink(id: string): Promise<HistoryRecord | null>;
  historyDelete(id: string): Promise<HistoryDeleteResult>;
}
