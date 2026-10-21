// Electron-free main-process dispatch seam. The Electron main module supplies the
// native window/IPC objects and the ownership ledger; this module owns the narrow
// validation and dispatch behavior so it can be exercised without Electron or
// WorkflowIntegration.node.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {dirname} from 'node:path';
import { isSafeMediaFile as pathIsSafeMediaFile } from './path-boundary';
import {validatePinterestUrl, validateSocialUrl} from './ytdlp-url';
import type {MediaPrepEvent} from './media-prep';
import type {PinterestMetadata, TargetBin, TimelinePlacement, MediaProfile, YoutubeDownloadOptions} from './shared';
import type {HistoryInput, HistoryRecord} from './history';
import type {DownloadLedger} from './download-ledger';
import {ManagedRoot} from './managed-root';
import type {OwnedFile} from './safe-fs';
import {ProviderJobRunner, ProviderJobCancelledError, ProviderJobFailureError, requireFfprobe, type ProviderJobContext} from './provider-job';
import type {TimelineAutomation, Transfer, TransferResult} from './transfer';
import type {DownloadEvent, DownloadOptions, Quality, YtdlpWorker} from './ytdlp';
import type {GalleryDlWorker, PinterestDownloadEvent} from './gallerydl';
import type {StockAsset, StockClient, StockEvent} from './stock';

/** Own the entire admitted operation, including provider preflight and host waits. */
export class ManagedOperations {
  private active = 0;
  private exclusive = false;
  isBusy(): boolean { return this.active > 0 || this.exclusive; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.exclusive) throw new Error('Wait for the download folder operation to finish.');
    this.active += 1;
    try { return await operation(); } finally { this.active -= 1; }
  }
  async changeFolder<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isBusy()) throw new Error('Wait for active downloads or media preparation to finish.');
    this.exclusive = true;
    try { return await operation(); } finally { this.exclusive = false; }
  }
}

/** Run executable discovery on a worker so synchronous version probes cannot stall Electron. */
export function discoverEnginePaths(): Promise<{ ffmpegPath: string | null; ffprobePath: string | null; ytdlpPath: string | null; galleryDlPath: string | null; jsRuntime: string | null }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { clipdockEngineDiscovery: true } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Engine discovery exited with code ${code}.`)); });
  });
}
if (!isMainThread && workerData?.clipdockEngineDiscovery) {
  const { discoverFfmpeg, discoverJsRuntime, discoverYtdlp } = require('./ytdlp') as typeof import('./ytdlp');
  const { discoverFfprobe } = require('./media-prep') as typeof import('./media-prep');
  const { discoverGalleryDl } = require('./gallerydl') as typeof import('./gallerydl');
  const ffmpegPath = discoverFfmpeg();
  parentPort!.postMessage({ ffmpegPath, ffprobePath: discoverFfprobe(ffmpegPath), ytdlpPath: discoverYtdlp(), galleryDlPath: discoverGalleryDl(), jsRuntime: discoverJsRuntime() });
}

export interface MainProcessCard {
  path: string;
  automation?: TimelineAutomation;
  /** Main-only registration-time managed boundary; omitted for user-selected files. */
  trustedRoot?: ManagedRoot;
}

export interface MainTransferHandlerDependencies {
  requireSender: (event: unknown) => void;
  resolveCard: (cardId: unknown) => MainProcessCard | null;
  transfer: Pick<Transfer, 'importToMediaPool' | 'addToTimeline'>;
  runTransfer?: (card: MainProcessCard, operation: () => Promise<TransferResult>) => Promise<TransferResult>;
  noteNativeDrag?: (filePath: string) => void;
  /** Main keeps these predicates close to its IPC registration for auditability. */
  invalidTargetBin?: (value: unknown) => boolean;
  invalidTimelinePlacement?: (value: unknown) => boolean;
}

/** Only provider completion may grant this proof; history and external cards cannot. */
export class SessionTransferCards {
  private readonly files = new Map<string, { pristine: boolean; exposed: boolean }>();
  registerDownloadedFile(filePath: string): void {
    if (!this.files.has(filePath)) this.files.set(filePath, { pristine: true, exposed: false });
  }
  takePristine(filePath: string): (() => boolean) | null {
    const file = this.files.get(filePath);
    if (!file) {
      // A user-selected card can expose a provider path before publication.
      this.noteExposed(filePath);
      return null;
    }
    if (!file?.pristine) return null;
    file.pristine = false;
    // Drag can revoke an admitted transfer's proof while it waits for the host.
    return () => !file.exposed;
  }
  /** Opening the download folder in Finder lets the user import any file by hand. */
  noteAllExposed(): void {
    for (const file of this.files.values()) { file.pristine = false; file.exposed = true; }
  }
  noteExposed(filePath: string): void {
    const file = this.files.get(filePath);
    if (file) { file.pristine = false; file.exposed = true; }
    else this.files.set(filePath, { pristine: false, exposed: true });
  }
}

export type MainTransferResult = TransferResult | {ok: false; kind: 'invalid-card'; message: string};

export interface MainTransferHandlers {
  importToMediaPool(event: unknown, cardId: unknown, targetBin: unknown): Promise<MainTransferResult>;
  addToTimeline(event: unknown, cardId: unknown, targetBin: unknown, placement: unknown): Promise<MainTransferResult>;
  /** Validate every opaque cardId and synchronously invoke the native drag callback. */
  nativeDragStart(event: unknown, cardIds: unknown, startDrag: (filePath: string | string[]) => void): void;
}

export interface MainIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface MainTransferChannels {
  importToMediaPool: string;
  addToTimeline: string;
}

export function isSafeMediaFile(filePath: unknown, trustedRoot?: unknown): boolean { return pathIsSafeMediaFile(filePath, trustedRoot); }

/** Resolve an opaque cardId only when its current artifact still satisfies its stored provenance. */
export function resolveMainProcessCard(ledger: Pick<DownloadLedger, 'resolve'>, cardId: unknown): ReturnType<DownloadLedger['resolve']> {
  return ledger.resolve(cardId);
}

/** Legacy path ingress for card callers; live downloads receive the captured value directly. */
export function captureManagedRoot(root: string, filePath: string): string {
  const captured = ManagedRoot.prepare(root);
  if (!captured.resolve(filePath)) throw new Error('Could not safely register managed download.');
  return captured.verify();
}

const invalidTargetBin = (value: unknown): boolean => value !== 'active' && value !== 'clipdock';
const invalidTimelinePlacement = (value: unknown): boolean => value !== 'end' && value !== 'playhead';

export const YOUTUBE_PREVIEW_REFERRER = 'https://com.clipdock.app/';
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_MAX_START_SECONDS = 604800;
const MIN_PREVIEW_WIDTH = 160;
const MIN_PREVIEW_HEIGHT = 90;

export interface PreviewBounds { x: number; y: number; width: number; height: number; }

/** Build the only upstream preview URL; renderer input is limited to an ID and optional start. */
export function youtubePreviewUrl(videoId: unknown, startSeconds?: unknown): string | null {
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID.test(videoId)) return null;
  if (startSeconds !== undefined && (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > YOUTUBE_MAX_START_SECONDS)) return null;
  const start = startSeconds === undefined ? 0 : Math.floor(startSeconds);
  const params = new URLSearchParams({ autoplay: '1', controls: '1', playsinline: '1', rel: '0' });
  if (start > 0) params.set('start', String(start));
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}

/** Validate finite renderer DIP geometry, clip it to the window content, and reject unusable views. */
export function normalizePreviewBounds(value: unknown, content: { width: number; height: number }): PreviewBounds | null {
  if (!value || typeof value !== 'object' || !Number.isFinite(content.width) || !Number.isFinite(content.height) || content.width <= 0 || content.height <= 0) return null;
  const input = value as Record<string, unknown>;
  if (!['x', 'y', 'width', 'height'].every((key) => typeof input[key] === 'number' && Number.isFinite(input[key]))) return null;
  const raw = input as unknown as PreviewBounds;
  if (raw.width <= 0 || raw.height <= 0) return null;
  const left = Math.max(0, Math.round(raw.x));
  const top = Math.max(0, Math.round(raw.y));
  const right = Math.min(Math.round(content.width), Math.round(raw.x + raw.width));
  const bottom = Math.min(Math.round(content.height), Math.round(raw.y + raw.height));
  const width = right - left;
  const height = bottom - top;
  return width >= MIN_PREVIEW_WIDTH && height >= MIN_PREVIEW_HEIGHT ? { x: left, y: top, width, height } : null;
}

/** Main-only, session-only Pinterest metadata snapshot; deliberately not a generic cache. */
const PINTEREST_METADATA_SNAPSHOT_LIMIT = 3;
export interface PinterestMetadataSnapshotStore {
  remember(metadata: PinterestMetadata): void;
  get(pinId: string): PinterestMetadata | null;
  size(): number;
}
export function createPinterestMetadataSnapshotStore(): PinterestMetadataSnapshotStore {
  const snapshots = new Map<string, PinterestMetadata>();
  return {
    remember(metadata) {
      if (!/^\d{1,40}$/.test(metadata.pinId)) return;
      snapshots.delete(metadata.pinId);
      snapshots.set(metadata.pinId, metadata);
      while (snapshots.size > PINTEREST_METADATA_SNAPSHOT_LIMIT) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
      }
    },
    get(pinId) {
      const metadata = snapshots.get(pinId);
      if (!metadata) return null;
      snapshots.delete(pinId);
      snapshots.set(pinId, metadata);
      return metadata;
    },
    size: () => snapshots.size,
  };
}

/**
 * Wrap a sensitive IPC operation so trusted-sender validation is the first
 * observable action. Operations that still cause side effects (dialogs,
 * delete/cleanup, history
 * mutation/reveal, status, window actions) use this seam; main.ts supplies the
 * trusted ClipDock sender check.
 */
export function createSensitiveIpcHandler(
  requireSender: (event: unknown) => void,
  operation: (event: unknown, ...args: unknown[]) => unknown,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  return async (event: unknown, ...args: unknown[]) => {
    requireSender(event);
    return operation(event, ...args);
  };
}

export function createMainTransferHandlers(deps: MainTransferHandlerDependencies): MainTransferHandlers {
  const runTransfer = deps.runTransfer ?? ((_card: MainProcessCard, operation: () => Promise<TransferResult>) => operation());
  const isInvalidTargetBin = deps.invalidTargetBin ?? invalidTargetBin;
  const isInvalidTimelinePlacement = deps.invalidTimelinePlacement ?? invalidTimelinePlacement;

  async function importToMediaPool(event: unknown, cardId: unknown, targetBin: unknown): Promise<MainTransferResult> {
    deps.requireSender(event);
    const card = deps.resolveCard(cardId);
    if (!card) return {ok: false, kind: 'invalid-card', message: 'No valid media card selected.'};
    if (isInvalidTargetBin(targetBin)) return {ok: false, kind: 'bin-error', message: 'Invalid destination bin.'};
    return runTransfer(card, () => deps.transfer.importToMediaPool(card.path, targetBin as TargetBin));
  }

  async function addToTimeline(event: unknown, cardId: unknown, targetBin: unknown, placement: unknown): Promise<MainTransferResult> {
    deps.requireSender(event);
    const card = deps.resolveCard(cardId);
    if (!card) return {ok: false, kind: 'invalid-card', message: 'No valid media card selected.'};
    if (isInvalidTargetBin(targetBin)) return {ok: false, kind: 'bin-error', message: 'Invalid destination bin.'};
    if (isInvalidTimelinePlacement(placement)) return {ok: false, kind: 'playhead-unsupported', message: 'Invalid timeline position.'};
    return runTransfer(card, () => deps.transfer.addToTimeline(card.path, targetBin as TargetBin, placement as TimelinePlacement, card.automation));
  }

  function normalizeNativeDragCardIds(value: unknown): string[] | null {
    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (values.length === 0 || values.some((cardId) => typeof cardId !== 'string' || cardId.length === 0)) return null;
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const cardId of values as string[]) {
      if (seen.has(cardId)) continue;
      seen.add(cardId);
      unique.push(cardId);
    }
    return unique;
  }

  function nativeDragStart(event: unknown, cardIds: unknown, startDrag: (filePath: string | string[]) => void): void {
    try {
      deps.requireSender(event);
    } catch { return; }
    const normalized = normalizeNativeDragCardIds(cardIds);
    if (!normalized) return;
    const paths: string[] = [];
    let valid = true;
    for (const cardId of normalized) {
      const card = deps.resolveCard(cardId);
      if (!card) { valid = false; continue; }
      paths.push(card.path);
    }
    if (!valid) return;
    for (const filePath of paths) deps.noteNativeDrag?.(filePath);
    // Preserve the existing single-file callback shape while allowing the
    // Electron caller to select the files[] overload for a multi-card drag.
    startDrag(paths.length === 1 ? paths[0] : paths);
  }

  return {importToMediaPool, addToTimeline, nativeDragStart};
}

/** Register the invoke handlers used by main.ts; native drag stays synchronous in main. */
export function registerMainTransferInvokeHandlers(
  ipc: MainIpcRegistrar,
  channels: MainTransferChannels,
  deps: MainTransferHandlerDependencies,
): MainTransferHandlers {
  const handlers = createMainTransferHandlers(deps);
  ipc.handle(channels.importToMediaPool, handlers.importToMediaPool);
  ipc.handle(channels.addToTimeline, handlers.addToTimeline);
  return handlers;
}

// ---- Non-blocking startup ordering seam ----
// The Electron main module supplies the concrete registration/window/background
// callbacks; this module owns the ORDER so it can be exercised without
// Electron: every IPC handler is registered synchronously, the panel is created
// before any network-backed background initialization is awaited, and
// background failures stay inside the caller's controlled async task.

export interface StartupSequence {
  registerHandlers(): void;
  createWindow(): void;
  /** Network-backed background initialization; must never be awaited here. */
  startBackgroundServices(): void;
}

export function runStartupSequence(sequence: StartupSequence): void {
  sequence.registerHandlers();
  sequence.createWindow();
  sequence.startBackgroundServices();
}

// ---- Shared download-completion artifact service ----
// One Electron-free completion seam for every provider's successful download
// path (YouTube, Social, Pexels). main.ts supplies the card registry, history
// store, project refresh, provider event channel, and the media-prep runner;
// this service owns the common orchestration: optional media preparation for
// the requested profile, final artifact validation, history record
// creation (always bound to the resolved final artifact), card binding, warning
// composition, completed-event emission, and the opaque cardId-only payload.
// Provider-specific decisions — which downloads prepare, metadata mapping,
// event channel — stay at the call sites, which hand over validated facts.

export type CompletionSubtitle = {cardId: string; fileName: string};
export type CompletedDownloadEvent = {
  jobId: string;
  state: 'completed';
  percent: 100;
  message: string;
  cardId: string;
  fileName: string;
  subtitle?: CompletionSubtitle;
  warning?: string;
};
export type CompletedDownloadResult = {cardId: string; fileName: string; subtitle?: CompletionSubtitle; warning?: string};

/** Provider-validated optional preparation; the service runs requested-profile preparation. */
export interface CompletionPrepareRequest {
  jobId: string;
  inputPath: string;
  allowedRoot: string;
  source?: OwnedFile;
  profile: 'fast' | 'editing';
  emit: (update: MediaPrepEvent) => void;
}

export interface ArtifactCompletionDependencies {
  /** Re-validate the final artifact exactly like the card registry does. */
  isSafeMediaFile(filePath: string): boolean;
  /** Refresh the Resolve project name before the history record is created. */
  refreshHistoryProject(): Promise<void>;
  /** Persist the download as a history record; failures become warnings, never throw. */
  recordHistory(input: HistoryInput): {record: HistoryRecord | null; warning?: string};
  /** Bind an opaque cardId to the artifact path (+ automation/historyId) and return the cardId. */
  registerCard(card: {path: string; automation: TimelineAutomation; historyId?: string}): string;
  /** Run media preparation; cancellation must rethrow so the download is not silently downgraded. */
  prepareMedia(request: CompletionPrepareRequest): Promise<{filePath: string; fileName: string}>;
  /** Send the provider-specific completed event to the renderer. */
  emitCompleted(event: CompletedDownloadEvent): void;
}

export interface CompleteDownloadRequest {
  jobId: string;
  /** Defer ownership and renderer publication until this job commits successfully. */
  job?: ProviderJobContext;
  bindSubtitle?: () => CompletionSubtitle;
  automation: TimelineAutomation;
  /** The downloaded artifact as resolved by the provider (final when no preparation applies). */
  artifact: {filePath: string; fileName: string; warning?: string; subtitle?: CompletionSubtitle};
  /** When present, the service resolves the final artifact through optional preparation. */
  prepare?: CompletionPrepareRequest;
  /** Provider-specific history metadata; the service fills filePath/profile from the resolved final artifact. */
  history: HistoryInput;
}

export interface ArtifactCompletionService {
  completeDownload(request: CompleteDownloadRequest): Promise<CompletedDownloadResult>;
}

const warningWith = (existing: string | undefined, next: string): string => existing ? `${existing} ${next}` : next;

type ResolvedArtifact = {filePath: string; fileName: string; profile: string; warning?: string; subtitle?: CompletionSubtitle};

/**
 * Prepare a video for the requested profile. Preparation failures and
 * cancellation propagate unchanged; an unsafe prepared file throws. The
 * downloaded subtitle companion and warning survive only on successful
 * preparation so they can be bound to the final card.
 */
async function prepareRequestedProfile(
  downloaded: {filePath: string; fileName: string; warning?: string; subtitle?: CompletionSubtitle},
  request: CompletionPrepareRequest,
  deps: Pick<ArtifactCompletionDependencies, 'isSafeMediaFile' | 'prepareMedia'>,
): Promise<ResolvedArtifact> {
  const prepared = await deps.prepareMedia(request);
  if (!deps.isSafeMediaFile(prepared.filePath)) throw new Error('Prepared file is no longer available.');
  return {filePath: prepared.filePath, fileName: prepared.fileName, profile: request.profile, warning: downloaded.warning, subtitle: downloaded.subtitle};
}

/** The single completion service seam; main constructs one per provider channel. */
export function createArtifactCompletionService(deps: ArtifactCompletionDependencies): ArtifactCompletionService {
  async function completeDownload(request: CompleteDownloadRequest): Promise<CompletedDownloadResult> {
    const {jobId, automation, history} = request;
    const final: ResolvedArtifact = request.prepare
      ? await prepareRequestedProfile(request.artifact, request.prepare, deps)
      : {...request.artifact, profile: history.profile};
    if (!deps.isSafeMediaFile(final.filePath)) throw new Error('Prepared file is no longer available.');
    await deps.refreshHistoryProject();
    // The runner fills this same result object during its synchronous commit,
    // before the public handler resolves; no staged card id reaches IPC.
    const result: CompletedDownloadResult = {cardId: '', fileName: final.fileName};
    let subtitle = final.subtitle;
    const subtitlePath = history.subtitle?.filePath;
    const bindSubtitle = () => { subtitle = request.bindSubtitle?.() ?? subtitle; };
    const retainReferences = () => {
      request.job?.retain(final.filePath);
      if (subtitlePath && request.bindSubtitle) request.job?.retain(subtitlePath);
    };
    const commit = () => {
      if (!request.job) bindSubtitle();
      const historyResult = deps.recordHistory({...history, filePath: final.filePath, profile: final.profile});
      // Persisted history cannot be rolled back here. Its media and companion
      // must survive even if the managed boundary changes before card binding.
      if (historyResult.record) retainReferences();
      let warning = final.warning;
      if (historyResult.warning) warning = warningWith(warning, historyResult.warning);
      const cardId = deps.registerCard({path: final.filePath, automation, historyId: historyResult.record?.id});
      retainReferences();
      Object.assign(result, {cardId, subtitle, warning});
      deps.emitCompleted({
        jobId, state: 'completed', percent: 100,
        message: warning ? 'Ready for Resolve with a warning.' : 'Ready for Resolve.',
        cardId, fileName: final.fileName, subtitle, warning,
      });
    };
    if (request.job) {
      // Bind the companion as its own publication: a later media-card failure
      // cannot revoke a successfully registered subtitle card.
      if (subtitlePath && request.bindSubtitle) request.job.publish(subtitlePath, bindSubtitle);
      request.job.publish(final.filePath, commit);
    } else commit();
    return result;
  }
  return {completeDownload};
}

// ---- Provider download orchestration seam ---------------------------------
// This is the deep module for the four provider download flows. Its interface
// is four provider-shaped handlers; its implementation owns validation, provider
// metadata authority, profile/rendition rules, optional preparation, artifact
// completion, and history/card facts. main.ts supplies only Electron wiring and
// adapters for workers, event channels, the Pinterest snapshot, and cards.

export type ProviderEventEmitter = (event: unknown, update: unknown) => void;

export interface YoutubeDownloadAdapter {
  worker: Pick<YtdlpWorker, 'metadata' | 'download' | 'cancel'>;
  emit: ProviderEventEmitter;
}

export interface SocialDownloadAdapter {
  worker: Pick<YtdlpWorker, 'metadataSocial' | 'downloadSocial' | 'cancel'>;
  emit: ProviderEventEmitter;
}

export interface PinterestDownloadAdapter {
  worker: Pick<GalleryDlWorker, 'metadata' | 'download' | 'cancel'>;
  snapshots: Pick<PinterestMetadataSnapshotStore, 'get' | 'remember'>;
  emit: ProviderEventEmitter;
}

export interface StockDownloadAdapter {
  worker: Pick<StockClient, 'load' | 'download' | 'cancel'>;
  emit: ProviderEventEmitter;
}

export interface ProviderDownloadDependencies {
  /** Common artifact side effects stay behind the existing Electron-free seam. */
  completion: Omit<ArtifactCompletionDependencies, 'emitCompleted'>;
  /** Provider-specific adapter fact: converted video needs ffprobe. */
  ffprobeAvailable: boolean;
  cancelMediaPreparation(jobId: string): Promise<void> | null;
  /** Main-only subtitle card binding; paths never enter this module's result. */
  registerSubtitle(filePath: string, fileName: string): CompletionSubtitle;
  youtube: YoutubeDownloadAdapter;
  social: SocialDownloadAdapter;
  pinterest: PinterestDownloadAdapter;
  pexels: StockDownloadAdapter;
  pixabay: StockDownloadAdapter;
}

export interface ProviderDownloadHandlers {
  cancel(jobId: string): boolean;
  shutdown(): Promise<void>;
  youtube(event: unknown, url: unknown, quality: unknown, profile: unknown, jobId: unknown, options: unknown): Promise<CompletedDownloadResult>;
  social(event: unknown, url: unknown, quality: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult>;
  pinterest(event: unknown, url: unknown, itemIndex: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult>;
  pexels(event: unknown, asset: unknown, fileId: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult>;
  pixabay(event: unknown, asset: unknown, fileId: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult>;
}

const validProfile = (value: unknown): value is MediaProfile => value === 'original' || value === 'fast' || value === 'editing';
const hasSender = (event: unknown): boolean => !!event && typeof event === 'object' && 'sender' in event;
const validSocialQuality = (value: unknown): boolean => {
  if (value === 'best') return true;
  if (typeof value !== 'string' || !/^[1-9]\d{2,3}p$/.test(value)) return false;
  const height = Number(value.slice(0, -1));
  return height >= 144 && height <= 4320;
};
const validPinterestItemIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50;

/** Create the provider download handlers; trusted-sender validation remains main's IPC adapter. */
export function createProviderDownloadHandlers(deps: ProviderDownloadDependencies): ProviderDownloadHandlers {
  const jobs = new ProviderJobRunner({
    cancelledMessage: 'Download cancelled.',
    disposedMessage: 'Download services are shutting down.',
  });
  const registerArtifact = (job: ProviderJobContext, artifact: {filePath: string; subtitlePath?: string}) => {
    job.register(artifact.filePath);
    if (artifact.subtitlePath) job.register(artifact.subtitlePath);
  };
  async function runJob(
    jobId: string,
    adapter: {emit: ProviderEventEmitter},
    event: unknown,
    body: (job: ProviderJobContext, emit: (update: unknown) => void, completion: ArtifactCompletionService) => Promise<CompletedDownloadResult>,
    stripSubtitle = false,
    normalizeWarning = false,
    admission: {invalidMessage?: string; busyMessage?: string; prerequisites?: () => void} = {},
  ): Promise<CompletedDownloadResult> {
    let completedEvent: CompletedDownloadEvent | undefined;
    const emit = (update: unknown) => adapter.emit(event, update);
    return jobs.run(jobId, job => body(job, emit, createArtifactCompletionService({
      ...deps.completion,
      prepareMedia: request => job.perform(
        () => deps.completion.prepareMedia({...request, source: job.owned(request.inputPath)}),
        () => deps.cancelMediaPreparation(request.jobId),
        prepared => registerArtifact(job, prepared)),
      refreshHistoryProject: () => {
        job.check();
        // Host refresh creates no files. Observe its eventual rejection while
        // allowing cancellation to interrupt this metadata-only wait.
        let interrupt!: (reason: Error) => void;
        const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
        return job.wait(Object.assign(Promise.race([deps.completion.refreshHistoryProject(), interrupted]), {
          cancel: async () => { interrupt(new ProviderJobCancelledError('Download cancelled.')); },
        }));
      },
      emitCompleted: completed => { completedEvent = completed; },
    })), {
      ...admission,
      terminal: outcome => {
        if (outcome.state !== 'completed') {
          if (outcome.state === 'failed' && !(outcome.error instanceof ProviderJobFailureError && outcome.error.notify)) return;
          emit({jobId, state: outcome.state, percent: null, message: outcome.state === 'cancelled' ? outcome.error.terminalMessage : outcome.error.message});
          return;
        }
        if (!completedEvent) throw new Error('Download completed without publication.');
        if (!stripSubtitle) { emit(completedEvent); return; }
        const {subtitle: _subtitle, ...withoutSubtitle} = completedEvent;
        emit(normalizeWarning ? {...withoutSubtitle, warning: withoutSubtitle.warning || undefined} : withoutSubtitle);
      },
    });
  }
  async function youtube(event: unknown, url: unknown, quality: unknown, profile: unknown, jobId: unknown, options: unknown): Promise<CompletedDownloadResult> {
    const downloadOptions = options as YoutubeDownloadOptions;
    const validOptions = !!downloadOptions
      && (downloadOptions.mediaMode === 'video' || downloadOptions.mediaMode === 'audio')
      && ['wav', 'mp3', 'm4a'].includes(downloadOptions.audioFormat)
      && typeof downloadOptions.subtitles === 'boolean'
      && ['en', 'es', 'fr', 'de', 'tr'].includes(downloadOptions.subtitleLanguage);
    if (typeof jobId !== 'string' || !validProfile(profile) || !validOptions || !hasSender(event)) throw new Error('Invalid download request.');

    return runJob(jobId, deps.youtube, event, async (job, emit, artifactCompletion) => {
      const metadata = await job.perform(
        () => deps.youtube.worker.metadata(url, {jobId, emit: emit as (update: DownloadEvent) => void}),
        () => deps.youtube.worker.cancel(jobId));
      const rawSelection = downloadOptions.selection;
      const selection = rawSelection === undefined || rawSelection === null ? null : (() => {
        const selected = rawSelection as {start?: unknown; end?: unknown; label?: unknown};
        return typeof selected.start === 'number' && typeof selected.end === 'number'
          && Number.isFinite(selected.start) && Number.isFinite(selected.end)
          && selected.start >= 0 && selected.end > selected.start
          && metadata.duration !== null && selected.end <= metadata.duration
          ? {start: selected.start, end: selected.end, label: typeof selected.label === 'string' ? selected.label.slice(0, 80) : 'Range'}
          : null;
      })();
      if (rawSelection && !selection) throw new Error('Invalid In/Out range.');
      const downloaded = await job.perform(() => deps.youtube.worker.download(
        url,
        quality as Quality,
        jobId,
        emit as (update: DownloadEvent) => void,
        {...downloadOptions, selection, preferH264: profile === 'fast'} as DownloadOptions,
      ), () => deps.youtube.worker.cancel(jobId), artifact => registerArtifact(job, artifact));
      if (!deps.completion.isSafeMediaFile(downloaded.filePath)) throw new Error('Downloaded file is no longer available.');
      const subtitlePath = downloaded.subtitlePath && downloaded.subtitleFileName && deps.completion.isSafeMediaFile(downloaded.subtitlePath)
        ? downloaded.subtitlePath
        : undefined;
      const bindSubtitle = subtitlePath && downloaded.subtitleFileName
        ? () => deps.registerSubtitle(subtitlePath, downloaded.subtitleFileName!)
        : undefined;
      const source = `https://www.youtube.com/watch?v=${metadata.id}`;
      const automation: TimelineAutomation = {provider: 'youtube', source, selection, chapters: metadata.chapters};
      return await artifactCompletion.completeDownload({
        jobId, job, bindSubtitle,
        automation,
        artifact: {filePath: downloaded.filePath, fileName: downloaded.fileName, warning: downloaded.warning},
        prepare: downloadOptions.mediaMode === 'video' && profile !== 'original'
          ? {jobId, inputPath: downloaded.filePath, allowedRoot: dirname(downloaded.filePath), profile, emit}
          : undefined,
        history: {
          provider: 'youtube', source, filePath: downloaded.filePath, assetId: metadata.id, title: metadata.title,
          creator: metadata.channel, profile: downloadOptions.mediaMode === 'audio' ? 'original' : profile,
          quality: String(quality), mediaMode: downloadOptions.mediaMode, selection, automation,
          subtitle: subtitlePath ? {filePath: subtitlePath} : undefined,
        },
      });
    }, false, false, {
      invalidMessage: 'Invalid download request.', busyMessage: 'Another YouTube job with this ID is already active.',
      prerequisites: () => { if (downloadOptions.mediaMode === 'video' && profile !== 'original') requireFfprobe(deps.ffprobeAvailable); },
    });
  }

  async function social(event: unknown, url: unknown, quality: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult> {
    const valid = validateSocialUrl(url);
    if (!valid || !validSocialQuality(quality) || typeof jobId !== 'string' || !validProfile(profile) || !hasSender(event)) throw new Error('Invalid social download request.');

    return runJob(jobId, deps.social, event, async (job, emit, artifactCompletion) => {
      const metadata = await job.perform(
        () => deps.social.worker.metadataSocial(valid.url, {jobId, emit: emit as (update: DownloadEvent) => void}),
        () => deps.social.worker.cancel(jobId));
      if (metadata.source !== valid.url || metadata.platform !== valid.platform) throw new Error('Social metadata did not match the requested source.');
      const downloaded = await job.perform(
        () => deps.social.worker.downloadSocial(valid.url, quality as Quality, jobId, emit as (update: DownloadEvent) => void),
        () => deps.social.worker.cancel(jobId), artifact => registerArtifact(job, artifact));
      if (!deps.completion.isSafeMediaFile(downloaded.filePath)) throw new Error('Downloaded file is no longer available.');
      const automation: TimelineAutomation = {provider: 'social', source: metadata.source, selection: null, chapters: []};
      return artifactCompletion.completeDownload({
        jobId, job,
        automation,
        artifact: {filePath: downloaded.filePath, fileName: downloaded.fileName, warning: downloaded.warning},
        prepare: profile !== 'original'
          ? {jobId, inputPath: downloaded.filePath, allowedRoot: dirname(downloaded.filePath), profile, emit}
          : undefined,
        history: {
          provider: 'social', source: metadata.source, filePath: downloaded.filePath, assetId: `${metadata.platform}:${metadata.id}`,
          title: metadata.title, creator: metadata.channel, profile: 'original', quality: String(quality), mediaMode: 'video',
          selection: null, automation,
        },
      });
    }, true, true, {invalidMessage: 'Invalid social download request.', prerequisites: () => { if (profile !== 'original') requireFfprobe(deps.ffprobeAvailable); }});
  }

  async function pinterest(event: unknown, url: unknown, itemIndex: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult> {
    const valid = validatePinterestUrl(url);
    if (!valid || !validPinterestItemIndex(itemIndex) || typeof jobId !== 'string' || !validProfile(profile) || !hasSender(event)) throw new Error('Invalid Pinterest download request.');

    return runJob(jobId, deps.pinterest, event, async (job, emit, artifactCompletion) => {
      let metadata = deps.pinterest.snapshots.get(valid.pinId);
      if (!metadata) {
        metadata = await job.perform(() => deps.pinterest.worker.metadata(valid.url, {jobId}), () => deps.pinterest.worker.cancel(jobId));
        deps.pinterest.snapshots.remember(metadata);
      }
      const item = metadata.items.find((candidate) => candidate.index === itemIndex);
      if (!item) throw new Error('The selected Pinterest carousel item is no longer available. Reload the Pin, then retry.');
      if (item.kind === 'image' && profile !== 'original') throw new Error('Pinterest images are Original-only.');
      if (item.kind === 'video' && profile !== 'original') requireFfprobe(deps.ffprobeAvailable);

      const downloaded = await job.perform(
        () => deps.pinterest.worker.download(valid.url, item.index, item.kind, jobId, emit as (update: PinterestDownloadEvent) => void),
        () => deps.pinterest.worker.cancel(jobId), artifact => registerArtifact(job, artifact));
      if (downloaded.kind !== item.kind) throw new Error('Pinterest media type changed while downloading. Reload the Pin, then retry.');
      const automation: TimelineAutomation = {provider: 'pinterest', source: valid.url, selection: null, chapters: []};
      const requestedProfile: MediaProfile = item.kind === 'image' ? 'original' : profile;
      return artifactCompletion.completeDownload({
        jobId, job,
        automation,
        artifact: {filePath: downloaded.filePath, fileName: downloaded.fileName},
        prepare: item.kind === 'video' && requestedProfile !== 'original'
          ? {jobId, inputPath: downloaded.filePath, allowedRoot: dirname(downloaded.filePath), profile: requestedProfile, emit}
          : undefined,
        history: {
          provider: 'pinterest', source: valid.url, filePath: downloaded.filePath, assetId: `${metadata.pinId}:${item.index}`,
          title: item.title, creator: item.creator ?? metadata.creator, profile: requestedProfile, quality: 'original',
          mediaMode: item.kind, selection: null, automation,
        },
      });
    }, true, false, {invalidMessage: 'Invalid Pinterest download request.'});
  }

  // Pexels and Pixabay share one stock download flow; the asset is re-read from the provider.
  const stock = (provider: 'pexels' | 'pixabay', label: string) => async function (event: unknown, asset: unknown, fileId: unknown, profile: unknown, jobId: unknown): Promise<CompletedDownloadResult> {
    const adapter = deps[provider];
    if (!asset || typeof asset !== 'object' || typeof fileId !== 'string' || typeof jobId !== 'string' || !validProfile(profile) || !hasSender(event)) throw new Error(`Invalid ${label} download request.`);
    const requested = asset as StockAsset;
    if ((requested.kind !== 'photo' && requested.kind !== 'video') || !Number.isInteger(requested.id)) throw new Error(`Invalid ${label} media selection.`);

    return runJob(jobId, adapter, event, async (job, emit, artifactCompletion) => {
      const authoritative = await job.perform(() => adapter.worker.load(requested.kind, requested.id, {jobId}), () => adapter.worker.cancel(jobId));
      const selected = authoritative.files.find((file) => file.id === fileId);
      if (!selected || (authoritative.kind === 'photo' && profile !== 'original')) throw new Error(`Invalid ${label} media selection.`);
      if (authoritative.kind === 'video' && profile !== 'original') requireFfprobe(deps.ffprobeAvailable);

      const downloaded = await job.perform(
        () => adapter.worker.download(jobId, selected, emit as (update: StockEvent) => void),
        () => adapter.worker.cancel(jobId), artifact => registerArtifact(job, artifact));
      if (!deps.completion.isSafeMediaFile(downloaded.filePath)) throw new Error('Downloaded file is no longer available.');
      const automation: TimelineAutomation = {provider, source: authoritative.sourceUrl, selection: null, chapters: []};
      return artifactCompletion.completeDownload({
        jobId, job,
        automation,
        artifact: {filePath: downloaded.filePath, fileName: downloaded.fileName},
        prepare: authoritative.kind === 'video' && profile !== 'original'
          ? {jobId, inputPath: downloaded.filePath, allowedRoot: dirname(downloaded.filePath), profile, emit}
          : undefined,
        history: {
          provider, source: authoritative.sourceUrl, filePath: downloaded.filePath, assetId: `${authoritative.kind}:${authoritative.id}`,
          title: authoritative.title, creator: authoritative.creator, profile, quality: selected.label,
          mediaMode: authoritative.kind, selection: null, automation,
        },
      });
    }, true, false, {invalidMessage: `Invalid ${label} download request.`});
  };

  return {youtube, social, pinterest, pexels: stock('pexels', 'Pexels'), pixabay: stock('pixabay', 'Pixabay'), cancel: jobId => jobs.cancel(jobId) !== null, shutdown: () => jobs.dispose()};
}
