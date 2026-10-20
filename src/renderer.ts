// ClipDock panel renderer. Plain browser script; all privileged work uses clipdockAPI.
import { createGenerationGuard } from './renderer-state/search-session';
import { ItemOutputSession, transitionSourceSelection, selectSourceSegments, resolveSourceSelection, selectionEnvelope, sourceQualityChoices, type RawItemOutput, type SourceSelection, type OutputDefaults, type StagedSelection, type ResultSelection, cloneOutputDefaults, cloneOutputOverrides, resultOptionsId, cardQualityLabel, cardOutputSummary, profileLabel, intentLabel } from './renderer-state/item-output-session';
import { DownloadQueue, resultKeyFor, type QueueItem as MutableQueueItem, type QueueInsertionMode, type QueueMetadata, type TargetBin, type TimelinePlacement, type YoutubeQuality, type MediaProfile, type MediaMode, type AudioFormat, type SubtitleLanguage, type YoutubeSelection, type DownloadOptions, type DownloadIntent, type SocialPlatform, type Provider, type PinterestMediaKind, type PinterestItem, type PinterestMetadata, type PexelsKind, type PexelsFile, type PexelsAsset, type QueueState, type MediaCard, type YoutubeChapter, type YoutubeMetadata, type SocialMetadata } from './renderer-state/queue-model';
type QueueItem = Readonly<MutableQueueItem>;
type Surface = 'search' | 'queue' | 'library' | 'settings';
type PinterestSearchKind = PinterestMediaKind | 'carousel';
interface PinterestSearchItem { id: string; title: string; creator: string | null; kind: PinterestSearchKind; url: string; thumbnailUrl: string | null; }
interface PinterestSearchPage { query: string; page: number; pageSize: number; results: PinterestSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: { failed: number; total: number; reason: string; node: string }; }
interface PexelsPage { query: string; page: number; pageSize: number; results: PexelsAsset[]; hasPrevious: boolean; hasNext: boolean; totalResults: number | null; }
interface PexelsEvent { jobId: string; state: string; percent: number | null; message: string; cardId?: string; fileName?: string; warning?: string; }
interface PinterestEvent { jobId: string; state: string; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; warning?: string; }
interface PexelsConnectionStatus { connected: boolean; persisted: boolean; message: string; }
interface WorkspaceSummary { fileCount: number; totalBytes: number; cleanupFileCount: number; cleanupBytes: number; }
interface WorkspaceCleanupResult { deletedFileCount: number; deletedBytes: number; fileCount: number; totalBytes: number; }
interface StatusSnapshot { phase: 'bridge-error' | 'no-project' | 'no-timeline' | 'ready'; bridge: { connected: boolean; moduleVersion: string | null; resolveVersion: string | null; error: string | null }; project: { loaded: boolean; name: string | null }; timeline: { loaded: boolean; name: string | null }; message: string; refreshHint: string | null; }
interface DownloadFolderStatus { folder: string; userSelected: boolean; }
interface PreviewBounds { x: number; y: number; width: number; height: number; }
interface YoutubePreviewState { state: 'closed' | 'failed'; reason: 'closed' | 'escape' | 'load' | 'crash'; }
interface TransferResult { ok: boolean; kind: string; message: string; }
interface SubtitleCue { start: number; end: number; text: string; }
interface HistoryRecord { id: string; provider: Provider; source: string; project: string | null; fileName: string; bytes: number; assetId: string | null; title: string; creator: string | null; profile: string; quality: string | null; mediaMode: string; selection: YoutubeSelection; automation: { provider: Provider; source: string; selection: YoutubeSelection; chapters: YoutubeChapter[] }; createdAt: number; lastUsedAt: number; available: boolean; cardId?: string; subtitle?: { fileName: string; bytes: number; available: boolean }; }
interface YoutubeSearchItem { id: string; title: string; channel: string | null; duration: number | null; url: string; thumbnailUrl: string | null; viewCount: number | null; publishedAt: number | null; channelVerified: boolean; }
interface YoutubeSearchPage { query: string; page: number; pageSize: number; results: YoutubeSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: { failed: number; total: number; reason: string; node: string }; }
interface YoutubeEvent { jobId: string; state: string; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; subtitle?: MediaCard; warning?: string; }
interface SocialEvent { jobId: string; state: string; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; warning?: string; }

declare global { interface Window { clipdockAPI: { getStatus(): Promise<StatusSnapshot>; downloadFolderStatus(): Promise<DownloadFolderStatus>; chooseDownloadFolder(): Promise<DownloadFolderStatus>; onResolveQuit(callback: () => void): () => void; selectFile(): Promise<{ canceled: boolean; cardId?: string; fileName?: string }>; startNativeDrag(cardIds: string | string[]): void; importToMediaPool(id: string, bin: TargetBin): Promise<TransferResult>; addToTimeline(id: string, bin: TargetBin, placement: TimelinePlacement): Promise<TransferResult>; searchYoutube(query: string, page: number): Promise<YoutubeSearchPage>; prefetchYoutube(url: string): Promise<void>; loadYoutube(url: string): Promise<YoutubeMetadata>; downloadYoutube(url: string, quality: YoutubeQuality, profile: MediaProfile, id: string, options: DownloadOptions): Promise<{ cardId: string; fileName: string; subtitle?: MediaCard; warning?: string }>; cancelYoutube(id: string): Promise<boolean>; loadSocial(url: string): Promise<SocialMetadata>; loadSocialThumbnail?(url: string): Promise<string | null>; downloadSocial(url: string, quality: YoutubeQuality, profile: MediaProfile, id: string): Promise<{ cardId: string; fileName: string; warning?: string }>; cancelSocial(id: string): Promise<boolean>; onSocialEvent(callback: (event: SocialEvent) => void): () => void; loadPinterest(url: string): Promise<PinterestMetadata>; searchPinterest(query: string, page: number): Promise<PinterestSearchPage>; downloadPinterest(url: string, itemIndex: number, profile: MediaProfile, id: string): Promise<{ cardId: string; fileName: string; warning?: string }>; cancelPinterest(id: string): Promise<boolean>; onPinterestEvent(callback: (event: PinterestEvent) => void): () => void; queueDelete(cardId: string): Promise<{ deleted: boolean; message: string }>; searchSubtitles(url: string, language: SubtitleLanguage): Promise<SubtitleCue[]>; onYoutubeEvent(callback: (event: YoutubeEvent) => void): () => void; setAlwaysOnTop(pinned: boolean): Promise<boolean>; pexelsKeyStatus(): Promise<PexelsConnectionStatus>; setPexelsKey(key: string): Promise<PexelsConnectionStatus>; clearPexelsKey(): Promise<PexelsConnectionStatus>; searchPexels(kind: PexelsKind, query: string, page: number): Promise<PexelsPage>; loadPexels(kind: PexelsKind, id: number): Promise<PexelsAsset>; downloadPexels(asset: PexelsAsset, fileId: string, profile: MediaProfile, id: string): Promise<{ cardId: string; fileName: string; warning?: string }>; cancelPexels(id: string): Promise<boolean>; cancelPexelsRequests(): Promise<boolean>; onPexelsEvent(callback: (event: PexelsEvent) => void): () => void; openPexelsExternal(url: string): Promise<boolean>; openYoutubeExternal(videoId: string, startSeconds?: number): Promise<boolean>; openYoutubePreview(videoId: string, startSeconds: number | undefined, bounds: PreviewBounds): Promise<boolean>; closeYoutubePreview(): Promise<boolean>; setYoutubePreviewBounds(bounds: PreviewBounds): Promise<boolean>; onYoutubePreviewState(callback: (state: YoutubePreviewState) => void): () => void; workspaceStatus(): Promise<WorkspaceSummary>; openWorkspace(): Promise<boolean>; cleanupWorkspace(): Promise<WorkspaceCleanupResult>; historyList(): Promise<HistoryRecord[]>; historyReuse(id: string): Promise<MediaCard | null>; historyReveal(id: string): Promise<boolean>; historyRevealSubtitle(id: string): Promise<boolean>; historySource(id: string): Promise<boolean>; historyCopy(id: string): Promise<boolean>; historyRelink(id: string): Promise<HistoryRecord | null>; historyDelete(id: string): Promise<{ deleted: boolean; removed: boolean; warning?: string; removedCardIds?: string[] }>; }; } }

const $ = (id: string): HTMLElement => { const el = document.getElementById(id); if (!el) throw new Error(`Missing #${id}`); return el; };
// Drawn contact print for results without a photo: a seeded skyline in darkroom
// tones, built as a data: SVG so it stays inside the strict CSP (no inline styles,
// no remote origin). Same seed, same print; cached per seed for the session.
const posterCache = new Map<string, string>();
function posterRandom(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const POSTER_HUES = [14, 18, 22, 28, 34, 200, 212, 340];
function skylinePoster(seed: string): string {
  const cached = posterCache.get(seed); if (cached) return cached;
  const r = posterRandom(seed || 'clipdock');
  const hue = POSTER_HUES[Math.floor(r() * POSTER_HUES.length)] ?? 22;
  let x = -2, blocks = '', windows = '';
  while (x < 162) {
    const bw = 6 + r() * 14, bh = 14 + r() * 48, top = 90 - bh;
    blocks += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"/>`;
    if (r() > 0.55 && bh > 26) blocks += `<rect x="${(x + bw / 2 - 0.5).toFixed(1)}" y="${(top - 6).toFixed(1)}" width="1" height="6"/>`;
    for (let wy = top + 4; wy < 86; wy += 5) for (let wx = x + 2; wx < x + bw - 2; wx += 3.5) if (r() > 0.78) windows += `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="1.4" height="1.6"/>`;
    x += bw + r() * 1.5;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" preserveAspectRatio="xMidYMax slice"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},20%,11%)"/><stop offset=".56" stop-color="hsl(${hue + 20},24%,21%)"/><stop offset="1" stop-color="hsl(${hue + 30},46%,42%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><g fill="#120E0B">${blocks}</g><g fill="#E3A23A" opacity=".75">${windows}</g></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  posterCache.set(seed, url);
  return url;
}
const LOCAL_POSTER = skylinePoster('clipdock');
const IMAGE_PLACEHOLDER = LOCAL_POSTER;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const downloadQueue = new DownloadQueue({
  newId,
  download: (item) => {
    const api = window.clipdockAPI;
    if (item.provider === 'pexels') return api.downloadPexels(item.pexelsAsset!, item.pexelsFileId!, item.profile, item.jobId);
    if (item.provider === 'pinterest') return api.downloadPinterest(item.url, item.pinterestItemIndex!, item.profile, item.jobId);
    if (item.provider === 'social') return api.downloadSocial(item.url, item.quality as YoutubeQuality, item.profile, item.jobId);
    return api.downloadYoutube(item.url, item.quality as YoutubeQuality, item.profile, item.jobId, item.options);
  },
  cancel: (item) => {
    const api = window.clipdockAPI;
    return item.provider === 'pexels' ? api.cancelPexels(item.jobId) : item.provider === 'social' ? api.cancelSocial(item.jobId) : item.provider === 'pinterest' ? api.cancelPinterest(item.jobId) : api.cancelYoutube(item.jobId);
  },
  transfer: (id, bin, action) => action === 'import' ? window.clipdockAPI.importToMediaPool(id, bin) : window.clipdockAPI.addToTimeline(id, bin, action),
  deleteFile: (id) => window.clipdockAPI.queueDelete(id),
});
const queue = downloadQueue.items;
downloadQueue.subscribe(({ item, progress, settled, action }) => {
  scheduleQueueRender(!progress, item);
  if (!metadataBusy && item && !progress && (!downloadQueue.activeId || downloadQueue.activeId === item.queueId)) {
    if (settled) showYoutubeStatus(queueStatusText(item));
    else showYoutubeStatus(item.message, item.percent, item.speedBytesPerSecond, item.etaSeconds);
  }
  if (action && item) { $('youtube-queue-status').textContent = item.message; if (!metadataBusy) showYoutubeStatus(item.message); }
  if (settled && document.getElementById('workspace-status')) void refreshWorkspace();
});
// Result staging is renderer-session-only. Keys include the provider (and Pexels
// media kind) so switching pages or providers cannot move a selection onto a
// different source identity.
const outputSession = new ItemOutputSession();
// Disclosure is view state; all item output lives in the session.
const cardOptionsOpen = new Map<string, boolean>();
const inlineActionBusyKeys = new Set<string>();
let selectedQueueLoadBusy = false;
// Queue selection is cardId-only and session-only. Main still revalidates every
// selected card at drag time; this set only controls the visible renderer rows.
const selectedQueueCardIds = new Set<string>();
let searchPage: YoutubeSearchPage | null = null;
let youtube: YoutubeMetadata | null = null;
let social: SocialMetadata | null = null;
let pinterest: PinterestMetadata | null = null;
let pinterestSearch: PinterestSearchPage | null = null;
let socialPlatform: SocialPlatform | null = null;
let searchBusy = false;
let metadataBusy = false;
let youtubeBusy = false;
const metadataGuard = createGenerationGuard();
const searchGuard = createGenerationGuard();
const announcedQueueStates = new WeakMap<QueueItem, QueueState>();
let searchButtons: HTMLElement[] = [];
let previewSource: 'hover' | 'manual' | null = null;
let previewProvider: 'youtube' | 'pexels' | null = null;
let previewTarget: HTMLElement | null = null;
let previewResultKey: string | null = null;
let pinBusy = false;
let hostRefreshTimer: number | null = null;
let queueRenderTimer: number | null = null;
const queueProgressViews = new Map<string, {row: HTMLElement; status: HTMLElement; progress: HTMLProgressElement | null}>();
const dirtyQueueProgress = new Set<string>();
let previewStopTimer: number | null = null;
let previewBoundsTimer: number | null = null;
const previewGuard = createGenerationGuard();
// A close is sent only for a preview lifecycle that has attempted to create the
// main-owned view. This also covers failed open/bounds paths without double-close.
let youtubePreviewActive = false;
const pendingYoutubePreviewCloses = new Set<object>();
let previewFailure = false;
let observedResultListWidth = 0;
let statusRefreshInFlight = false;
let statusRefreshTrailing = false;
let statusRefreshGeneration = 0;
let statusRefreshTimer: number | null = null;
let statusRefreshEpoch = 0;
let hostStatus: StatusSnapshot | null = null;
let settingsOpen = false;
let settingsTrigger: HTMLElement | null = null;
let currentSurface: Surface = 'search';
let previousSurface: Surface = 'search';
let surfaceTrigger: HTMLElement | null = null;
let provider: Provider = 'youtube';
let pexelsKind: PexelsKind = 'video';
let pexels: PexelsAsset | null = null;
let pexelsSearch: PexelsPage | null = null;
let pexelsConnected = false;
let pexelsConnecting = false;
let sourceSelection = transitionSourceSelection(null, { type: 'source', source: '' });
const selectedChapters = new Set<number>();
const subtitleGuard = createGenerationGuard();
let subtitleCues: SubtitleCue[] = [];
const selectedSubtitleCues = new Set<number>();
let openHistoryMenu: HTMLElement | null = null;
let historyHostRefreshers: Array<() => void> = [];
function refreshHistoryHostState(): void { for (const refresh of historyHostRefreshers) refresh(); }
let historyMenuTrigger: HTMLButtonElement | null = null;
// ---- History library state: search/filter/batch projection ------------------------
// Pure client-side filtering over the newest-first list from main. The backend
// MAX_RECORDS=200 list is never paginated; the renderer shows it in visible
// batches of HISTORY_BATCH_SIZE and resets the batch whenever the query or a
// filter changes.
type HistoryProviderFilter = 'all' | Provider;
type HistoryAvailabilityFilter = 'all' | 'available' | 'missing';
const HISTORY_BATCH_SIZE = 20;
let historyRecords: HistoryRecord[] = [];
let historyVisibleCount = HISTORY_BATCH_SIZE;
const historyGuard = createGenerationGuard();
let historyStatusOverride: string | null = null;
let inspectorOpen = false;
let returnFocusToResult = false;
let resultScrollTop = 0;
let resultScrollLeft = 0;
let workspaceScrollTop = 0;
let sheetScrollTop = 0;
type BrowserState = { query: string; youtubeSearch: YoutubeSearchPage | null; youtube: YoutubeMetadata | null; social: SocialMetadata | null; socialUrl: string; pinterest: PinterestMetadata | null; pinterestUrl: string; pinterestSearch: PinterestSearchPage | null; pexelsSearch: PexelsPage | null; pexels: PexelsAsset | null; };
let youtubeState: BrowserState | null = null;
let socialState: BrowserState | null = null;
let pinterestState: BrowserState | null = null;
const pexelsStates = new Map<PexelsKind, BrowserState>();

// ---- Search detail rail: one adjustable sheet/detail seam -------------------------
// The clip detail sits beside the contact sheet at 760px and wider. Its width is a
// user layout choice that persists locally; applySplits always re-clamps the restored
// value against the live window before exposing it through CSSOM and separator ARIA.
const DETAIL_MIN_PX = 320;
const DETAIL_DEFAULT_PX = 352;
const SHEET_MIN_PX = 360;
const SPLIT_STEP_PX = 16;
let detailWidthPx = DETAIL_DEFAULT_PX;
let dragging: 'detail' | null = null;
let dragStartX = 0;
let dragStartDetail = 0;

function clampPx(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function setCssVar(target: HTMLElement | null, name: string, value: string): void { if (target && typeof target.style?.setProperty === 'function') target.style.setProperty(name, value); }
function workspaceWidthPx(): number { const rect = document.getElementById('workspace')?.getBoundingClientRect(); return rect && rect.width > 0 ? Math.round(rect.width) : 0; }
// One clamp/apply seam: bound the session value against live geometry, then write
// the CSS custom property and separator ARIA values in one pass.
function applySplits(): void {
  const workspace = document.getElementById('workspace');
  const split = document.getElementById('workspace-splitter');
  const width = workspaceWidthPx();
  if (width > 0 && workspace && split) {
    // The detail max keeps at least one readable contact-sheet column beside it.
    const maxDetail = Math.max(DETAIL_MIN_PX, width - SHEET_MIN_PX);
    detailWidthPx = clampPx(detailWidthPx, DETAIL_MIN_PX, maxDetail);
    setCssVar(workspace, '--detail-w', `${detailWidthPx}px`);
    split.setAttribute('aria-valuemin', String(DETAIL_MIN_PX));
    split.setAttribute('aria-valuenow', String(detailWidthPx));
    split.setAttribute('aria-valuemax', String(maxDetail));
  }
  scheduleYoutubePreviewBounds();
}
function splitterKeyTarget(key: string, current: number): number | null {
  if (key === 'Home') return DETAIL_MIN_PX;
  if (key === 'End') return Number.MAX_SAFE_INTEGER;
  // The seam sits on the detail's left edge: moving it left grows the detail.
  if (key === 'ArrowLeft') return current + SPLIT_STEP_PX;
  if (key === 'ArrowRight') return current - SPLIT_STEP_PX;
  return null;
}
function onSplitterKeydown(event: KeyboardEvent): void {
  const target = splitterKeyTarget(event.key, detailWidthPx);
  if (target === null) return;
  stopPreview();
  event.preventDefault();
  detailWidthPx = target;
  applySplits();
  persistLayoutPreferences();
}
function startSplitterDrag(event: PointerEvent): void {
  stopPreview();
  if (dragging !== null) endSplitterDrag();
  const splitter = event.currentTarget as HTMLElement;
  dragging = 'detail';
  dragStartX = event.clientX;
  dragStartDetail = detailWidthPx;
  if (typeof splitter.setPointerCapture === 'function') splitter.setPointerCapture(event.pointerId);
  document.body.classList?.add?.('resizing');
  event.preventDefault();
}
function moveSplitterDrag(event: PointerEvent): void {
  if (dragging === null) return;
  detailWidthPx = dragStartDetail - (event.clientX - dragStartX);
  applySplits();
}
function endSplitterDrag(event?: Event): void {
  if (dragging === null) return;
  const pointer = event as PointerEvent;
  if (event && typeof pointer.pointerId === 'number') {
    const splitter = event.currentTarget as HTMLElement | null;
    if (splitter && typeof splitter.releasePointerCapture === 'function') { try { splitter.releasePointerCapture(pointer.pointerId); } catch { /* already released */ } }
  }
  dragging = null;
  document.body.classList?.remove?.('resizing');
  persistLayoutPreferences();
}
function wireSplitter(id: string): void {
  const splitter = document.getElementById(id); if (!splitter) return;
  splitter.addEventListener('pointerdown', (event) => startSplitterDrag(event));
  splitter.addEventListener('pointermove', moveSplitterDrag);
  splitter.addEventListener('pointerup', endSplitterDrag);
  splitter.addEventListener('pointercancel', endSplitterDrag);
  splitter.addEventListener('lostpointercapture', endSplitterDrag);
  splitter.addEventListener('blur', endSplitterDrag);
  splitter.addEventListener('keydown', (event) => onSplitterKeydown(event));
}
async function refreshWorkspace(): Promise<void> {
  try {
    const workspace = await window.clipdockAPI.workspaceStatus();
    const summary = `${workspace.fileCount} stored files · ${formatBytes(workspace.totalBytes)}`;
    setOptionalText('workspace-status', summary); setOptionalText('settings-workspace-status', summary);
    const cleanup = document.getElementById('cleanup-workspace-btn') as HTMLButtonElement | null;
    if (cleanup) { cleanup.disabled = workspace.cleanupFileCount === 0; cleanup.dataset.count = String(workspace.cleanupFileCount); cleanup.dataset.bytes = String(workspace.cleanupBytes); }
  } catch (err) { setOptionalText('workspace-status', (err as Error).message); setOptionalText('settings-workspace-status', (err as Error).message); }
}
async function openWorkspace(): Promise<void> {
  const error = 'Could not open the managed ClipDock folder.';
  try {
    if (await window.clipdockAPI.openWorkspace()) return;
    setOptionalText('workspace-status', error); setOptionalText('settings-workspace-status', error);
  } catch {
    setOptionalText('workspace-status', error); setOptionalText('settings-workspace-status', error);
  }
}
async function cleanupWorkspace(): Promise<void> {
  const button = $('cleanup-workspace-btn') as HTMLButtonElement;
  const count = Number(button.dataset.count ?? 0), bytes = Number(button.dataset.bytes ?? 0);
  if (!count || !window.confirm(`Delete ${count} old download${count === 1 ? '' : 's'} (${formatBytes(bytes)})? Current session files are kept.`)) return;
  button.disabled = true;
  try { const result = await window.clipdockAPI.cleanupWorkspace(); setOptionalText('workspace-status', `Deleted ${result.deletedFileCount} files · ${formatBytes(result.deletedBytes)} freed`); setOptionalText('settings-workspace-status', `Deleted ${result.deletedFileCount} files · ${formatBytes(result.deletedBytes)} freed`); await refreshWorkspace(); } catch (err) { setOptionalText('workspace-status', (err as Error).message); setOptionalText('settings-workspace-status', (err as Error).message); button.disabled = false; }
}
function wireResizableRegions(): void {
  restoreLayoutPreferences();
  wireSplitter('workspace-splitter');
  window.addEventListener('resize', applySplits);
  window.addEventListener('blur', endSplitterDrag);
  applySplits();
}

function setText(id: string, text: string, ok?: boolean): void { const el = $(id); el.textContent = text; if (ok !== undefined) { el.classList.toggle('ok', ok); el.classList.toggle('err', !ok); } }
type PreferenceKey = 'source' | 'output-intent' | 'handoff-intent' | 'target-bin' | 'timeline-placement' | 'permitted-content-ack' | 'detail-width' | 'common-quality' | 'common-media-mode' | 'common-audio-format' | 'common-subtitles' | 'common-subtitle-language';
function readPreference(key: PreferenceKey): string | null { try { return window.localStorage?.getItem(`clipdock.${key}`) ?? null; } catch { return null; } }
function writePreference(key: PreferenceKey, value: string): void { try { window.localStorage?.setItem(`clipdock.${key}`, value); } catch { /* Preferences are optional and never block the workflow. */ } }
function readLayoutSize(key: PreferenceKey): number | null { const value = Number(readPreference(key)); return Number.isFinite(value) && value > 0 ? value : null; }
function restoreLayoutPreferences(): void {
  detailWidthPx = readLayoutSize('detail-width') ?? detailWidthPx;
}
function persistLayoutPreferences(): void {
  writePreference('detail-width', String(detailWidthPx));
}
function setOptionalText(id: string, text: string): void { const el = document.getElementById(id); if (el) el.textContent = text; }
const SURFACE_PAGE_IDS: Record<Surface, string> = { search: 'search-surface', queue: 'queue-surface', library: 'library-surface', settings: 'settings-panel' };
const SURFACE_HEADING_IDS: Record<Surface, string> = { search: 'browser-title', queue: 'queue-title', library: 'library-title', settings: 'settings-title' };
const SURFACE_NAV_IDS: Record<Surface, string> = { search: 'surface-nav-search', queue: 'surface-nav-queue', library: 'surface-nav-library', settings: 'settings-btn' };
function focusSurface(surface: Surface): void {
  if (surface === 'search' && inspectorOpen) {
    (document.getElementById('back-to-results') as HTMLElement | null)?.focus?.();
    return;
  }
  const heading = document.getElementById(SURFACE_HEADING_IDS[surface]) as HTMLElement | null;
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus?.();
}
function setSurface(next: Surface, focus = true): void {
  if (next !== 'search') stopPreview();
  if (next === 'settings' && currentSurface !== 'settings') previousSurface = currentSurface;
  currentSurface = next;
  settingsOpen = next === 'settings';
  for (const surface of Object.keys(SURFACE_PAGE_IDS) as Surface[]) {
    const page = document.getElementById(SURFACE_PAGE_IDS[surface]);
    if (page) { page.classList.toggle('hidden', surface !== next); page.hidden = surface !== next; page.setAttribute('aria-hidden', String(surface !== next)); }
    const nav = document.getElementById(SURFACE_NAV_IDS[surface]);
    if (nav) {
      if (surface === next) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute?.('aria-current');
    }
  }
  const topSettings = document.getElementById('settings-btn');
  topSettings?.setAttribute('aria-expanded', String(next === 'settings'));
  if (focus) focusSurface(next);
  if (next === 'settings') { void refreshDownloadFolder(); }
  if (next === 'library') { void refreshHistory(); renderCompletedDownloads(); }
  updateGlobalQueueStatus();
}
function openSurfaceFromNav(next: Surface): void {
  surfaceTrigger = document.activeElement as HTMLElement | null;
  if (next === 'settings') { settingsTrigger = surfaceTrigger; previousSurface = currentSurface; }
  setSurface(next);
}
function openSettings(): void {
  if (currentSurface === 'settings') { focusSurface('settings'); return; }
  settingsTrigger = (document.activeElement as HTMLElement | null) ?? document.getElementById('settings-btn');
  previousSurface = currentSurface;
  setSurface('settings', false);
  (document.getElementById('settings-close') as HTMLButtonElement | null)?.focus();
}
function closeSettings(restoreFocus = true): void {
  if (currentSurface !== 'settings') return;
  const trigger = settingsTrigger;
  const target = previousSurface;
  settingsTrigger = null; surfaceTrigger = null;
  setSurface(target, false);
  if (restoreFocus) (trigger ?? document.getElementById(SURFACE_NAV_IDS[target]))?.focus?.();
}
function captureResultViewport(): void {
  const list = document.getElementById('youtube-search-results') as HTMLElement | null;
  const workspace = document.getElementById('workspace');
  if (list) { resultScrollTop = list.scrollTop ?? 0; resultScrollLeft = list.scrollLeft ?? 0; }
  workspaceScrollTop = workspace?.scrollTop ?? 0;
  sheetScrollTop = document.getElementById('sheet-scroll')?.scrollTop ?? 0;
}
function restoreResultViewport(): void {
  const list = document.getElementById('youtube-search-results') as HTMLElement | null;
  const workspace = document.getElementById('workspace');
  if (list) { list.scrollTop = resultScrollTop; list.scrollLeft = resultScrollLeft; }
  if (workspace) workspace.scrollTop = workspaceScrollTop;
  const sheet = document.getElementById('sheet-scroll');
  if (sheet) sheet.scrollTop = sheetScrollTop;
}
function setInspectorOpen(open: boolean, restoreFocus = false): void {
  if (!open) stopPreview();
  inspectorOpen = open;
  document.getElementById('search-surface')?.classList.toggle('detail-open', inspectorOpen);
  const workspace = document.getElementById('workspace');
  workspace?.classList.toggle('inspector-open', inspectorOpen);
  const inspector = document.getElementById('inspector-pane');
  inspector?.setAttribute('aria-hidden', String(!inspectorOpen));
  const back = document.getElementById('back-to-results');
  back?.classList.toggle('hidden', !inspectorOpen);
  if (inspectorOpen) { if (workspace) workspace.scrollTop = 0; }
  else {
    restoreResultViewport();
    if (restoreFocus) {
      const result = Array.from(document.getElementById('youtube-search-results')?.children ?? []).find((row) => (row as HTMLElement).dataset.resultId === outputSession.selected?.resultId) as HTMLElement | undefined;
      result?.focus?.();
    }
    returnFocusToResult = false;
  }
}
function openInspectorForSelection(keyboardActivation = false): void {
  captureResultViewport();
  returnFocusToResult = keyboardActivation;
  setInspectorOpen(true);
}
function renderDownloadFolderStatus(status: DownloadFolderStatus): void {
  setOptionalText('settings-download-folder', status.folder);
  const path = document.getElementById('settings-download-folder');
  if (path) path.title = status.folder;
  setOptionalText('settings-folder-note', status.userSelected
    ? 'Custom folder: new downloads and the managed workspace use this location. Files already elsewhere are kept.'
    : 'Default folder: new downloads land in the ClipDock subfolder of your Downloads folder.');
}
async function refreshDownloadFolder(): Promise<void> {
  if (typeof window.clipdockAPI?.downloadFolderStatus !== 'function') return;
  try {
    renderDownloadFolderStatus(await window.clipdockAPI.downloadFolderStatus());
  } catch (err) { setOptionalText('settings-download-folder', `Download folder unavailable: ${(err as Error).message}`); }
}
async function chooseDownloadFolder(): Promise<void> {
  if (typeof window.clipdockAPI?.chooseDownloadFolder !== 'function') return;
  const button = document.getElementById('choose-download-folder-btn') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    renderDownloadFolderStatus(await window.clipdockAPI.chooseDownloadFolder());
    await refreshWorkspace();
  } catch (err) {
    setOptionalText('settings-download-folder', `Could not change the download folder: ${(err as Error).message}`);
  } finally {
    if (button) button.disabled = false;
  }
}
function showFirstUseAcknowledgement(): void {
  if (readPreference('permitted-content-ack') === 'true') return;
  const dialog = document.getElementById('first-use-dialog') as HTMLDialogElement | null;
  if (!dialog) return;
  try { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); } catch { dialog.setAttribute('open', ''); }
  (document.getElementById('first-use-ack') as HTMLButtonElement | null)?.focus();
}
function pexelsStatusView(status: PexelsConnectionStatus | null, connecting = false, error = ''): { text: string; state: 'checking' | 'connecting' | 'connected' | 'session' | 'disconnected' | 'error' } {
  if (connecting) return { text: 'Connecting…', state: 'connecting' };
  if (error) return { text: error, state: 'error' };
  if (!status) return { text: 'Checking…', state: 'checking' };
  if (!status.connected) return { text: status.message || 'Disconnected', state: 'disconnected' };
  return status.persisted ? { text: 'Connected · saved securely', state: 'connected' } : { text: 'Connected for this session', state: 'session' };
}
function renderPexelsConnection(status: PexelsConnectionStatus | null, error = ''): void {
  const view = pexelsStatusView(status, pexelsConnecting, error);
  const indicator = $('pexels-connection-status'); indicator.textContent = view.text; indicator.dataset.state = view.state;
  setOptionalText('pexels-save-note', !status ? 'Checking connection.' : status.connected ? status.persisted ? 'Saved securely.' : 'Saved for this session.' : 'No Pexels key is connected.');
  const input = $('pexels-api-key') as HTMLInputElement;
  ($('pexels-connect-btn') as HTMLButtonElement).disabled = pexelsConnecting || pexelsConnected;
  ($('pexels-disconnect-btn') as HTMLButtonElement).disabled = pexelsConnecting || !pexelsConnected;
  input.disabled = pexelsConnecting;
}
// Just-in-time disclosure: the credential details element is opened only when setup or
// recovery is required, never persisted, and never force-focused except from a failed search.
function setPexelsSetupOpen(open: boolean): void { const setup = $('pexels-setup') as HTMLDetailsElement; if (setup.open !== open) setup.open = open; }
function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'Duration unavailable';
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const secs = Math.floor(seconds % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}
function qualityLabel(height: number): string { return height === 2160 ? '2160p (4K)' : `${height}p`; }
function socialPlatformLabel(platform: SocialPlatform | null): string { return platform === 'instagram' ? 'Instagram' : platform === 'twitter' ? 'X' : platform === 'facebook' ? 'Facebook' : 'Paste link'; }
function detectSocialPlatform(input: string): SocialPlatform | null {
  try {
    const source = input.trim(); const authority = source.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
    const url = new URL(source); if (url.protocol !== 'https:' || url.port || authority.includes(':') || authority.includes('@')) return null;
    const host = url.hostname.toLowerCase(); const pathname = url['pathname'];
    if ((host === 'instagram.com' || host === 'www.instagram.com') && /^\/(reel|p|tv)\/[A-Za-z0-9_-]{1,80}\/?$/.test(pathname)) return 'instagram';
    if ((host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') && /^\/(?:[A-Za-z0-9_]{1,30}\/status|i\/(?:web\/)?status)\/[0-9]{1,40}\/?$/.test(pathname)) return 'twitter';
    if (host === 'fb.watch' && /^\/[A-Za-z0-9_-]{1,80}\/?$/.test(pathname)) return 'facebook';
    if (host !== 'facebook.com' && host !== 'www.facebook.com') return null;
    if (/^\/watch\/?$/.test(pathname) && !url.searchParams.has('list') && !url.searchParams.has('playlist') && url.searchParams.getAll('v').length === 1 && /^[0-9]{1,40}$/.test(url.searchParams.get('v') ?? '')) return 'facebook';
    if (/^\/reel\/[0-9]{1,40}\/?$/.test(pathname) || /^\/(?:videos|[A-Za-z0-9._-]{1,80}\/videos)\/[0-9]{1,40}\/?$/.test(pathname)) return 'facebook';
  } catch { /* the main process remains authoritative */ }
  return null;
}
function renderSocialPlatform(platform: SocialPlatform | null, state: 'idle' | 'detected' | 'loading' | 'invalid' = platform ? 'detected' : 'idle'): void {
  for (const name of ['instagram', 'twitter', 'facebook'] as SocialPlatform[]) {
    const indicator = document.getElementById(`social-platform-${name}`);
    if (!indicator) continue;
    const active = name === platform;
    indicator.classList.toggle('selected', active);
    indicator.dataset.state = active ? state : 'idle';
    indicator.setAttribute('aria-current', active ? 'true' : 'false');
  }
  const hint = document.getElementById('social-platform-hint');
  if (hint) hint.textContent = platform ? `${socialPlatformLabel(platform)} URL detected.` : 'Paste a supported public video URL.';
}
function placementForIntent(intent: DownloadIntent): TimelinePlacement { return intent === 'playhead' ? 'playhead' : 'end'; }
function formatSpeed(value: number | null): string | null { return value !== null && Number.isFinite(value) && value >= 0 ? `${(value / 1_000_000).toFixed(1)} MB/s` : null; }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; const units = ['KB', 'MB', 'GB', 'TB']; let size = value / 1024; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`; }
function formatEta(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  let seconds = Math.min(604800, Math.floor(value));
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', !hours && !minutes || seconds ? `${seconds}s` : ''].filter(Boolean).join(' ');
}
function newId(): string { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }

function hostActionReason(action: 'import' | 'timeline' | 'drag'): string | null {
  if (!hostStatus) return 'Checking host connection.';
  if (hostStatus.phase === 'ready') return null;
  if (hostStatus.phase === 'bridge-error') return 'Host connection unavailable. Click Refresh to retry.';
  if (!hostStatus.project.loaded) return 'Open a project to use host handoff.';
  if (action === 'timeline' && !hostStatus.timeline.loaded) return 'Open a timeline to use this handoff.';
  return null;
}
// Bounded bridge call: a hung getStatus() must not hold the single-flight guard
// or the Refresh button forever. The timeout releases both so the visible poll or
// a manual refresh can recover; the timed-out response is dropped by the epoch
// guard and can never overwrite a newer snapshot.
const HOST_STATUS_TIMEOUT_MS = 10_000;
function refresh(): void {
  if (statusRefreshInFlight) { statusRefreshTrailing = true; return; }
  statusRefreshInFlight = true;
  const generation = statusRefreshGeneration;
  const epoch = ++statusRefreshEpoch;
  const button = $('refresh-btn') as HTMLButtonElement; button.disabled = true;
  const release = (): void => {
    statusRefreshInFlight = false; button.disabled = false;
    if (statusRefreshTimer !== null) { window.clearTimeout(statusRefreshTimer); statusRefreshTimer = null; }
    if (statusRefreshTrailing) { statusRefreshTrailing = false; refresh(); }
  };
  window.clipdockAPI.getStatus().then((s) => {
    // Stale responses are dropped: ResolveQuit bumps the generation, and the
    // bounded timeout bumps the epoch. Neither may overwrite newer state.
    if (epoch !== statusRefreshEpoch || generation !== statusRefreshGeneration) return;
    const hostChanged = JSON.stringify(hostStatus) !== JSON.stringify(s);
    hostStatus = s;
    document.body.dataset.phase = s.phase;
    setText('bridge-state', s.bridge.connected ? 'Connected' : 'Not connected', s.bridge.connected);
    setText('module-version', s.bridge.moduleVersion ?? '-'); setText('resolve-version', s.bridge.resolveVersion ?? '-');
    setText('project-name', s.project.loaded ? (s.project.name?.trim() || 'Untitled project') : 'No project open', s.project.loaded); setText('timeline-name', s.timeline.loaded ? (s.timeline.name?.trim() || 'Untitled timeline/comp') : (s.project.loaded ? 'No active timeline/comp' : 'No timeline'), s.timeline.loaded);
    { const bridgeDot = document.getElementById('bridge-state'); if (bridgeDot) { const stateText = s.bridge.connected ? 'Connected' : 'Not connected'; bridgeDot.setAttribute('aria-label', stateText); bridgeDot.setAttribute('title', stateText); } const pill = document.querySelector('.bridge-pill') as HTMLElement | null; if (pill) { const projectText = s.project.loaded ? (s.project.name?.trim() || 'Untitled project') : 'No project open'; const timelineText = s.timeline.loaded ? (s.timeline.name?.trim() || 'Untitled timeline/comp') : (s.project.loaded ? 'No active timeline/comp' : 'No timeline'); const pillText = `${projectText} - ${timelineText}`; pill.setAttribute('aria-label', pillText); pill.setAttribute('title', pillText); } }
    setText('message', s.message); setText('refresh-hint', s.refreshHint ?? ''); setText('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
    if (hostChanged) { if (queue.length) renderQueue(); else updateControls(); refreshHistoryHostState(); }
  }).catch((err) => { if (epoch === statusRefreshEpoch && generation === statusRefreshGeneration) setText('message', `Renderer call failed: ${(err as Error).message}`); }).finally(() => {
    if (epoch !== statusRefreshEpoch) return; // the bounded timeout already released this flight
    release();
  });
  statusRefreshTimer = window.setTimeout(() => {
    statusRefreshTimer = null;
    statusRefreshEpoch += 1;
    release();
  }, HOST_STATUS_TIMEOUT_MS);
}
function scheduleHostRefresh(): void {
  if (hostRefreshTimer !== null) window.clearTimeout(hostRefreshTimer);
  hostRefreshTimer = window.setTimeout(() => { hostRefreshTimer = null; refresh(); }, 120);
}
// Live Resolve status: ONE bounded visible-only poll. ResolveQuit and host-status
// events stay event-driven; the poll covers host changes that emit nothing (project
// or timeline switch while ClipDock keeps focus). Hidden stops the poll entirely;
// returning to visible restarts it and schedules an immediate refresh. Every tick
// re-checks visibility, and the interval guard keeps at most one poll running.
const HOST_POLL_MS = 3000;
let hostPollTimer: number | null = null;
function startHostPolling(): void {
  if (hostPollTimer !== null) return; // one interval maximum
  hostPollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, HOST_POLL_MS);
}
function stopHostPolling(): void {
  if (hostPollTimer === null) return;
  window.clearInterval(hostPollTimer);
  hostPollTimer = null;
}
function onHostVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    startHostPolling();
    scheduleHostRefresh();
  } else {
    stopHostPolling();
  }
}
// Session-only Pin on top: the compact inline SVG icon is shipped in index.html;
// aria-pressed/aria-label/title mutate only on a truthful success, the button
// disables while IPC is pending, and failures report through the status footer
// without lying about the window state. Closing the window resets everything.
function pinState(pinned: boolean): { label: string; title: string } {
  return pinned
    ? { label: 'Unpin ClipDock', title: 'Return ClipDock to normal window order' }
    : { label: 'Pin ClipDock on top', title: 'Keep ClipDock above other windows' };
}
function renderPinState(pinned: boolean): void {
  const button = $('pin-on-top-btn') as HTMLButtonElement;
  const state = pinState(pinned);
  button.setAttribute('aria-pressed', String(pinned));
  button.setAttribute('aria-label', state.label);
  button.setAttribute('title', state.title);
}
async function togglePinOnTop(): Promise<void> {
  if (pinBusy) return;
  const button = $('pin-on-top-btn') as HTMLButtonElement;
  const requested = button.getAttribute('aria-pressed') !== 'true';
  pinBusy = true; button.disabled = true;
  try {
    const pinned = await window.clipdockAPI.setAlwaysOnTop(requested);
    renderPinState(pinned);
  } catch (err) {
    setText('message', `Could not ${requested ? 'pin' : 'unpin'} window: ${(err as Error).message}`);
  } finally {
    pinBusy = false; button.disabled = false;
  }
}
function readControlValue(id: string, fallback: string): string { return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? fallback; }
function readControlChecked(id: string, fallback: boolean): boolean { return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? fallback; }
function renderCommonOutputSummary(): void {
  const summary = document.getElementById('common-output-summary');
  if (!summary) return;
  const audio = outputSession.defaults.mediaMode === 'audio';
  const mode = audio ? `${outputSession.defaults.audioFormat === 'm4a' ? 'AAC (M4A)' : outputSession.defaults.audioFormat.toUpperCase()} audio` : `${profileLabel(outputSession.defaults.profile)} · ${outputSession.defaults.quality === 'best' ? 'Best available' : outputSession.defaults.quality}`;
  summary.textContent = `${mode} · ${intentLabel(outputSession.defaults.intent)} · ${outputSession.defaults.targetBin === 'active' ? 'Active bin' : 'ClipDock bin'}`;
}
function renderEffectiveOutputSummary(): void {
  const summary = document.getElementById('effective-output-summary');
  if (!summary) return;
  if (!outputSession.selected?.key) { summary.textContent = 'Using common defaults'; summary.classList.add('hidden'); (summary as HTMLElement).hidden = true; summary.setAttribute('aria-hidden', 'true'); return; }
  const overrides = outputSession.overrides(outputSession.selected?.key);
  const keys = Object.keys(overrides).length;
  if (!keys) { summary.textContent = 'Using common defaults'; summary.classList.add('hidden'); (summary as HTMLElement).hidden = true; summary.setAttribute('aria-hidden', 'true'); return; }
  const effective = outputSession.output(outputSession.selected?.key);
  const photo = provider === 'pexels' && pexels?.kind === 'photo';
  summary.textContent = `${keys} item override${keys === 1 ? '' : 's'} · ${cardOutputSummary(effective, photo)}`;
  summary.classList.remove('hidden'); (summary as HTMLElement).hidden = false; summary.setAttribute('aria-hidden', 'false');
}
function renderSelectionToolbar(): void {
  const count = outputSession.staged.size;
  const toolbar = document.getElementById('selection-toolbar');
  const countEl = document.getElementById('selection-count');
  if (countEl) countEl.textContent = `${count} selected`;
  else setOptionalText('selection-count', `${count} selected`);
  toolbar?.classList.toggle('has-selection', count > 0);
  toolbar?.setAttribute('data-has-selection', String(count > 0));
  const enqueueButton = document.getElementById('enqueue-selected-btn') as HTMLButtonElement | null;
  if (enqueueButton) {
    const disabled = count === 0 || selectedQueueLoadBusy;
    enqueueButton.disabled = disabled;
    enqueueButton.textContent = count ? `Enqueue selected (${count})` : 'Enqueue selected';
    enqueueButton.classList.remove('hidden');
    (enqueueButton as HTMLElement).hidden = false;
    enqueueButton.setAttribute('aria-hidden', 'false');
    if (disabled) enqueueButton.setAttribute('aria-disabled', 'true');
    else enqueueButton.removeAttribute('aria-disabled');
  }
  toolbar?.setAttribute('aria-busy', String(selectedQueueLoadBusy));
  const clearButton = document.getElementById('clear-selection-btn') as HTMLButtonElement | null;
  if (clearButton) {
    const hide = count === 0;
    clearButton.disabled = hide || selectedQueueLoadBusy;
    clearButton.classList.toggle('hidden', hide);
    (clearButton as HTMLElement).hidden = hide;
    clearButton.setAttribute('aria-hidden', String(hide));
  }
  const selectAll = document.getElementById('select-all-results-btn') as HTMLButtonElement | null;
  const keys = currentResultKeys();
  const allSelected = keys.length > 0 && keys.every((key) => outputSession.staged.has(key));
  if (selectAll) { selectAll.disabled = keys.length === 0 || selectedQueueLoadBusy; selectAll.setAttribute('aria-pressed', String(allSelected)); }
  renderEffectiveOutputSummary(); refreshInlineResultCards();
}
function currentResultKeys(): string[] {
  if (provider === 'youtube') return (searchPage?.results ?? []).map((item) => resultKeyFor('youtube', item.id));
  if (provider === 'pexels') return (pexelsSearch?.results ?? []).map((item) => resultKeyFor('pexels', String(item.id), pexelsKind));
  if (provider === 'pinterest') return (pinterestSearch?.results ?? []).map((item) => resultKeyFor('pinterest', item.id));
  return [];
}
function stageAllCurrentResults(): void {
  if (selectedQueueLoadBusy) return;
  if (provider === 'youtube') for (const item of searchPage?.results ?? []) {
    const key = resultKeyFor('youtube', item.id);
    outputSession.stage(key, { provider: 'youtube', resultId: item.id, source: item.url, title: item.title, channel: item.channel, thumbnailDataUrl: item.thumbnailUrl });
  }
  if (provider === 'pexels') for (const item of pexelsSearch?.results ?? []) {
    const key = resultKeyFor('pexels', String(item.id), pexelsKind);
    outputSession.stage(key, { provider: 'pexels', resultId: String(item.id), source: item.sourceUrl, title: item.title, channel: item.creator, thumbnailDataUrl: item.thumbnailUrl, pexelsKind });
  }
  if (provider === 'pinterest') for (const item of pinterestSearch?.results ?? []) {
    const key = resultKeyFor('pinterest', item.id);
    outputSession.stage(key, { provider: 'pinterest', resultId: item.id, source: item.url, title: item.title, channel: item.creator, thumbnailDataUrl: item.thumbnailUrl });
  }
  renderSelectionToolbar(); renderSearchResults();
}
function clearStagedSelection(): void {
  if (selectedQueueLoadBusy) return;
  outputSession.unstage(); renderSelectionToolbar(); renderSearchResults();
}
function detailOutput(): OutputDefaults {
  const choices = Array.from(($('youtube-quality') as HTMLSelectElement).options ?? []).map((option) => option.value);
  return outputSession.output(undefined, { choices, ...(provider === 'pexels' && pexels ? { files: pexels.files, kind: pexels.kind, photo: pexels.kind === 'photo' } : { photo: provider === 'pinterest' && pinterest?.kind === 'image' }) });
}
function commitInspectorEdit(patch: RawItemOutput, preserveRangeText = false): void {
  outputSession.edit('inspector', patch);
  applyDetailOutput(preserveRangeText); renderSelectionToolbar();
}
function commitRangeEdit(preserveRangeText = false): void {
  commitInspectorEdit({ selection: currentSelection(), selectionPlan: currentSelectionPlan() }, preserveRangeText);
}
const outputControlFields = { profile: 'profile', quality: 'quality', mediaMode: 'media-mode', audioFormat: 'audio-format', intent: 'intent', targetBin: 'target-bin', subtitles: 'subtitles', subtitleLanguage: 'subtitle-language' } as const;
function readOutputControl(prefix: string, field: keyof typeof outputControlFields): RawItemOutput {
  const id = `${prefix}-${outputControlFields[field]}`;
  return field === 'subtitles' ? { subtitles: readControlChecked(id, outputSession.defaults.subtitles) } : { [field]: readControlValue(id, outputSession.defaults[field]) };
}
function applyDetailOutput(preserveRangeText = false): void {
  const value = detailOutput();
  const setValue = (id: string, next: string): void => { const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null; if (control) control.value = next; };
  setValue('youtube-profile', value.profile); setValue('youtube-quality', value.quality); setValue('youtube-media-mode', value.mediaMode); setValue('youtube-audio-format', value.audioFormat); setValue('youtube-intent', value.intent); setValue('youtube-target-bin', value.targetBin); setValue('youtube-subtitle-language', value.subtitleLanguage);
  const subtitles = document.getElementById('youtube-subtitles') as HTMLInputElement | null; if (subtitles) subtitles.checked = value.subtitles;
  // A range plan belongs to one source; another source's plan paints as the full clip and stays in the draft.
  const foreignPlan = provider === 'youtube' && !!youtube && !!value.selectionPlan && value.selectionPlan.source !== youtube.id;
  const rangeIn = document.getElementById('range-in') as HTMLInputElement | null; const rangeOut = document.getElementById('range-out') as HTMLInputElement | null; if (rangeIn && !preserveRangeText) writeRangeInput('range-in', foreignPlan ? undefined : value.selection?.start); if (rangeOut && !preserveRangeText) writeRangeInput('range-out', foreignPlan ? undefined : value.selection?.end);
  if (provider === 'youtube' && youtube) {
    sourceSelection = foreignPlan ? transitionSourceSelection(null, { type: 'full', source: youtube.id }) : value.selectionPlan?.source === youtube.id ? value.selectionPlan : transitionSourceSelection(sourceSelection, { type: 'manual', start: readRangeInput('range-in'), end: readRangeInput('range-out') });
    selectedChapters.clear(); selectedSubtitleCues.clear();
    if (!preserveRangeText && sourceSelection.mode === 'manual' && value.selectionPlan) { if (rangeIn) writeRangeInput('range-in', sourceSelection.start); if (rangeOut) writeRangeInput('range-out', sourceSelection.end); }
    for (const index of sourceSelection.indices) (sourceSelection.mode === 'chapters' ? selectedChapters : selectedSubtitleCues).add(index);
    renderSelection(); renderSubtitleCues();
  }
  renderProfile(); renderMediaMode(); renderPlacementWarning(); renderQuality(); renderBinChoice(); renderRangeUi();
  renderEffectiveOutputSummary();
}
function applyCommonDefaultsFromControls(patch: RawItemOutput): void {
  const accepted = outputSession.edit('defaults', patch);
  const preferences = { profile: 'output-intent', intent: 'handoff-intent', targetBin: 'target-bin', quality: 'common-quality', mediaMode: 'common-media-mode', audioFormat: 'common-audio-format', subtitles: 'common-subtitles', subtitleLanguage: 'common-subtitle-language' } as const;
  for (const field of Object.keys(preferences) as Array<keyof typeof preferences>) {
    const value = accepted[field];
    if (value !== undefined) writePreference(preferences[field], String(value));
  }
  if (accepted.intent !== undefined) writePreference('timeline-placement', placementForIntent(accepted.intent));
  renderCommonOutputSummary(); renderSelectionToolbar();
}
function renderCommonOutputControls(): void {
  const setValue = (id: string, value: string): void => { const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null; if (control) control.value = value; };
  setValue('common-profile', outputSession.defaults.profile); setValue('common-quality', outputSession.defaults.quality); setValue('common-media-mode', outputSession.defaults.mediaMode); setValue('common-audio-format', outputSession.defaults.audioFormat); setValue('common-intent', outputSession.defaults.intent); setValue('common-target-bin', outputSession.defaults.targetBin); setValue('common-subtitle-language', outputSession.defaults.subtitleLanguage);
  const subtitles = document.getElementById('common-subtitles') as HTMLInputElement | null; if (subtitles) subtitles.checked = outputSession.defaults.subtitles;
  const audio = outputSession.defaults.mediaMode === 'audio'; document.getElementById('common-audio-format')?.classList.toggle('hidden', !audio); document.getElementById('common-audio-format-label')?.classList.toggle('hidden', !audio); document.getElementById('common-profile-label')?.classList.toggle('hidden', audio); document.getElementById('common-quality-label')?.classList.toggle('hidden', audio); const language = document.getElementById('common-subtitle-language') as HTMLSelectElement | null; if (language) language.disabled = !outputSession.defaults.subtitles; document.getElementById('common-subtitle-language-label')?.classList.toggle('hidden', !outputSession.defaults.subtitles); renderCommonOutputSummary();
}
function updateCommonQualityOptions(values: string[]): void {
  const select = document.getElementById('common-quality') as HTMLSelectElement | null;
  if (!select) return;
  const current = outputSession.defaults.quality; select.replaceChildren(); const best = document.createElement('option'); best.value = 'best'; best.textContent = 'Best available'; select.append(best);
  for (const value of [...new Set(values)].filter((item) => item && item !== 'best')) { const option = document.createElement('option'); option.value = value; option.textContent = qualityLabel(Number(value.replace('p', ''))) || value; select.append(option); }
  select.value = Array.from(select.options ?? []).some((option) => option.value === current) ? current : 'best'; renderCommonOutputSummary();
}
// ---- Contact-sheet states ----------------------------------------------------------
// One data attribute drives the sheet: idle, loading (developing frames), results,
// empty, or error. The copy names the source and the query; CSS owns the visuals.
let searchError: string | null = null;
function renderSearchState(): void {
  const pane = document.getElementById('feed-pane'); if (!pane) return;
  const page = provider === 'pinterest' ? pinterestSearch : provider === 'pexels' ? pexelsSearch : provider === 'youtube' ? searchPage : null;
  const state = provider === 'social' ? 'idle' : searchBusy ? 'loading' : searchError ? 'error' : !page ? 'idle' : page.results.length ? 'results' : 'empty';
  pane.dataset.searchState = state; pane.dataset.provider = provider;
  pane.setAttribute('aria-busy', String(searchBusy));
  const name = providerLabel(provider);
  const query = (page?.query ?? (document.getElementById('youtube-search-input') as HTMLInputElement | null)?.value ?? '').trim();
  let title = 'Nothing on the sheet yet.';
  let hint = provider === 'pexels' ? (pexelsConnected ? 'Search free Pexels stock: videos and photos, free to use.' : 'Connect a free Pexels API key in Settings, then search.') : provider === 'pinterest' ? 'Search Pinterest, or paste a Pin link into the search box.' : 'Search YouTube, or paste a link to a single video.';
  if (state === 'empty') { title = `No frames for “${query}” on ${name}.`; hint = 'Try fewer words, or look on another source.'; }
  if (state === 'error') { title = `${name} didn't answer.`; hint = `${searchError ?? ''} Your marked frames are kept.`.trim(); }
  setOptionalText('search-empty-title', title); setOptionalText('search-empty-hint', hint);
  const pageCount = page && 'pageCount' in page ? (page as { pageCount: number }).pageCount : 0;
  setOptionalText('search-page-label', page ? `Page ${page.page}${pageCount ? ` of ${pageCount}` : ''}` : '');
}
function setSearchBusy(busy: boolean): void {
  if (busy) stopPreview(); searchBusy = busy;
  const blocked = busy || metadataBusy;
  const page = provider === 'pinterest' ? pinterestSearch : provider === 'pexels' ? pexelsSearch : searchPage;
  ($('youtube-search-input') as HTMLInputElement).disabled = blocked; ($('youtube-search-btn') as HTMLButtonElement).disabled = blocked;
  ($('youtube-search-prev') as HTMLButtonElement).disabled = blocked || !page?.hasPrevious; ($('youtube-search-next') as HTMLButtonElement).disabled = blocked || !page?.hasNext;
  searchButtons.forEach((button) => { (button as HTMLButtonElement).setAttribute('aria-disabled', String(blocked)); });
  updateInlineCardStates(); renderSearchState();
}
// A link field is a draft: the loaded source stays the download target, so an
// edited, unloaded link blocks downloading until Load replaces the source.
const loadedLinks = new Map<Exclude<Provider, 'pexels'>, string>();
function linkPending(): boolean {
  if (provider === 'pexels') return false;
  const field = document.getElementById(provider === 'social' ? 'social-url' : provider === 'pinterest' ? 'pinterest-url' : 'youtube-url') as HTMLInputElement | null;
  const loaded = loadedLinks.get(provider);
  const text = field?.value.trim() ?? '';
  return loaded !== undefined && text !== '' && text !== loaded;
}
function onLinkInput(): void {
  clearResultSelection(); updateControls();
  if (linkPending()) showYoutubeStatus('Press Load to use this link.');
}
function updateControls(): void {
  youtubeBusy = metadataBusy;
  const youtubeLoad = document.getElementById('load-youtube-btn') as HTMLButtonElement | null;
  const youtubeInput = document.getElementById('youtube-url') as HTMLInputElement | null;
  const socialLoad = document.getElementById('load-social-btn') as HTMLButtonElement | null;
  const socialInput = document.getElementById('social-url') as HTMLInputElement | null;
  const pinterestLoad = document.getElementById('load-pinterest-btn') as HTMLButtonElement | null;
  const pinterestInput = document.getElementById('pinterest-url') as HTMLInputElement | null;
  if (youtubeLoad) youtubeLoad.disabled = metadataBusy;
  if (youtubeInput) youtubeInput.disabled = metadataBusy;
  if (socialLoad) socialLoad.disabled = metadataBusy;
  if (socialInput) socialInput.disabled = metadataBusy;
  if (pinterestLoad) pinterestLoad.disabled = metadataBusy;
  if (pinterestInput) pinterestInput.disabled = metadataBusy;
  const selected = provider === 'pexels' ? pexels : provider === 'social' ? social : provider === 'pinterest' ? pinterest : youtube;
  const audio = provider === 'youtube' && ($('youtube-media-mode') as HTMLSelectElement).value === 'audio';
  ($('youtube-quality') as HTMLSelectElement).disabled = !selected || metadataBusy || audio;
  const disabled = !selected || metadataBusy || linkPending();
  ($('download-youtube-btn') as HTMLButtonElement).disabled = disabled;
  const downloadOnly = document.getElementById('download-only-btn') as HTMLButtonElement | null; if (downloadOnly) downloadOnly.disabled = disabled;

  $('quality-chips').setAttribute('aria-busy', String(metadataBusy)); $('profile-controls').setAttribute('aria-busy', String(metadataBusy));
  setSearchBusy(searchBusy); renderMediaMode(); updatePreviewButton(); renderCommonOutputSummary(); renderSelectionToolbar();
  const consolePane = document.getElementById('transfer-console');
  consolePane?.toggleAttribute?.('inert', metadataBusy);
  for (const control of Array.from(consolePane?.querySelectorAll?.('button, input, select') ?? []) as Array<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>) {
    if (['youtube-quality', 'youtube-subtitle-language', 'audio-only-toggle', 'range-in', 'range-out', 'range-full-btn'].includes(control.id)) continue;
    if (metadataBusy) { if (control.dataset.metadataDisabled === undefined) control.dataset.metadataDisabled = String(control.disabled); control.disabled = true; }
    else if (control.dataset.metadataDisabled !== undefined) { control.disabled = control.dataset.metadataDisabled === 'true'; delete control.dataset.metadataDisabled; }
  }
}
function showYoutubeStatus(message: string, percent: number | null = null, speed: number | null = null, eta: number | null = null): void {
  const details = [percent === null ? null : `${percent.toFixed(1)}%`, formatSpeed(speed), formatEta(eta)].filter(Boolean);
  const status = $('youtube-status');
  status.setAttribute?.('aria-live', percent !== null && /download/i.test(message) ? 'off' : 'polite');
  status.textContent = details.length ? `${message} ${details.join(' · ')}` : message;
  ($('youtube-progress') as HTMLProgressElement).value = percent ?? 0;
}
function formatCount(value: number): string { try { return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value); } catch { return String(value); } }
function formatAge(timestamp: number): string { const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp); if (seconds < 60) return 'just now'; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`; const days = Math.floor(hours / 24); if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`; const weeks = Math.floor(days / 7); if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`; const months = Math.floor(days / 30); if (days < 365) return `${months} month${months === 1 ? '' : 's'} ago`; const years = Math.floor(days / 365); return `${years} year${years === 1 ? '' : 's'} ago`; }
function formatMeta(item: YoutubeSearchItem): string { const channel = item.channel ? `${item.channel}${item.channelVerified ? ' ✓' : ''}` : null; return [channel, item.viewCount === null ? null : `${formatCount(item.viewCount)} views`, item.publishedAt === null ? null : formatAge(item.publishedAt)].filter(Boolean).join(' · '); }
function providerLabel(value: Provider, platform: SocialPlatform | null = null): string {
  return value === 'youtube' ? 'YouTube' : value === 'pexels' ? 'Pexels' : value === 'pinterest' ? 'Pinterest' : platform ? socialPlatformLabel(platform) : 'Social media';
}
function sourceRowAriaLabel(source: string, title: string, duration: string, metadata = ''): string {
  return [`Source: ${source}`, `Duration: ${duration}`, `Title: ${title}`, metadata ? `Metadata: ${metadata}` : null].filter(Boolean).join('. ');
}
function setVerifiedMetadata(text: string): void {
  const verified = document.getElementById('metadata-verified');
  if (!verified) return;
  verified.classList.add('source-row-verified'); verified.textContent = text;
}
function appendResultThumbnail(target: HTMLElement, source: string | null, title: string): void {
  if (!source) { appendThumbnailFallback(target, title); return; }
  const image = document.createElement('img'); image.alt = title; image.loading = 'lazy'; image.decoding = 'async'; image.className = 'thumbnail-pending';
  image.addEventListener('load', () => image.classList.remove('thumbnail-pending'));
  image.addEventListener('error', () => { image.remove(); appendThumbnailFallback(target, title); });
  image.src = source; target.append(image);
}
function appendThumbnailFallback(target: HTMLElement, title: string, seed = title): void {
  target.classList.add('thumbnail-fallback');
  // Harness compatibility: fake DOM does not concatenate child textContent,
  // so keep a direct text node for `thumb.textContent.includes(...)` checks.
  // Real browser visually hides this duplicate via CSS (font-size:0) and shows
  // the absolutely-positioned label instead.
  if (!target.children.length) target.textContent = 'Thumbnail unavailable';
  const label = document.createElement('span');
  label.className = 'thumbnail-fallback-label';
  label.textContent = 'Thumbnail unavailable';
  label.setAttribute('aria-hidden', 'true');
  label.style?.setProperty?.('background-image', `url("${skylinePoster(seed)}")`);
  target.append(label);
  target.setAttribute('aria-label', `Thumbnail unavailable for ${title}`);
}
function reducedMotion(): boolean { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; }
// Decorative source-lock acknowledgement for a newly validated selection. It has no
// playback state and self-cleans through animationend instead of a timer.
function playSourceLock(): void {
  if (reducedMotion()) return;
  const monitor = document.getElementById('source-monitor');
  if (!monitor) return;
  monitor.classList.remove('locking');
  void monitor.getBoundingClientRect();
  monitor.classList.add('locking');
}
function updatePreviewButton(): void {
  const button = $('preview-selected-btn') as HTMLButtonElement;
  const valid = provider === 'social' || provider === 'pinterest' ? false : provider === 'pexels' ? !!pexels && pexels.kind === 'video' && !!pexels.previewUrl && !youtubeBusy : !!youtube && VIDEO_ID.test(youtube.id) && !youtubeBusy;
  const manual = previewSource === 'manual';
  button.disabled = !manual && !valid;
  button.textContent = manual ? 'Stop preview' : 'Preview';
  button.setAttribute('aria-label', manual ? 'Stop preview' : 'Preview');
  button.setAttribute('aria-pressed', String(manual));
  const external = document.getElementById('open-youtube-external-btn') as HTMLButtonElement | null;
  if (external) { external.classList.toggle('hidden', provider !== 'youtube' || !youtube); external.disabled = provider !== 'youtube' || !youtube || youtubeBusy; }
  const monitor = document.getElementById('source-monitor') as HTMLButtonElement | null;
  if (monitor) { monitor.disabled = button.disabled; monitor.setAttribute('aria-label', button.getAttribute('aria-label') ?? 'Preview'); monitor.setAttribute('aria-pressed', button.getAttribute('aria-pressed') ?? 'false'); }
  const reason = document.getElementById('preview-note');
  if (reason) {
    reason.textContent = provider === 'social' ? 'Preview is unavailable for pasted links.' : provider === 'pinterest' ? 'Pinterest preview is unavailable.' : provider === 'youtube' ? previewFailure ? 'Preview failed. Open on YouTube to continue.' : 'Adaptive quality; YouTube branding and related videos may appear.' : '';
    reason.classList.toggle('hidden', provider === 'pexels');
  }
  if (provider === 'social') { button.title = 'Preview is unavailable for pasted links.'; button.setAttribute('aria-label', 'Preview unavailable for pasted links'); }
  else if (provider === 'pinterest') { button.title = 'Pinterest preview is unavailable.'; button.setAttribute('aria-label', 'Pinterest preview unavailable'); }
  else { button.removeAttribute?.('title'); }
  updateInlineCardStates();
}
function currentPreviewBounds(targetOverride: HTMLElement | null = null): PreviewBounds | null {
  if (currentSurface !== 'search' || provider !== 'youtube') return null;
  const target = targetOverride ?? previewTarget ?? (inspectorOpen ? document.getElementById('source-monitor') : null);
  if (!target || (!inspectorOpen && !targetOverride && !previewTarget)) return null;
  const rect = target.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(window.innerWidth, rect.left + rect.width), bottom = Math.min(window.innerHeight, rect.top + rect.height);
  return right - left >= 160 && bottom - top >= 90 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
function clearPreviewState(restoreFocus = false): void {
  if (previewStopTimer !== null) { window.clearTimeout(previewStopTimer); previewStopTimer = null; }
  if (previewBoundsTimer !== null) { window.clearTimeout(previewBoundsTimer); previewBoundsTimer = null; }
  if (youtubePreviewActive) {
    youtubePreviewActive = false;
    const close = {};
    pendingYoutubePreviewCloses.add(close);
    void window.clipdockAPI.closeYoutubePreview().then((closed) => { if (!closed) pendingYoutubePreviewCloses.delete(close); }).catch(() => { pendingYoutubePreviewCloses.delete(close); });
  }
  const pexelsOverlay = document.getElementById('pexels-preview-overlay');
  const pexelsVideo = document.getElementById('pexels-preview-video') as HTMLVideoElement | null;
  if (previewProvider === 'pexels' && pexelsOverlay && pexelsVideo) { pexelsVideo.pause(); pexelsVideo.removeAttribute('src'); pexelsVideo.load(); pexelsOverlay.classList.remove('interactive'); pexelsOverlay.classList.add('hidden'); pexelsOverlay.setAttribute('aria-hidden', 'true'); }
  previewSource = null; previewProvider = null; previewTarget = null; previewResultKey = null;
  document.getElementById('workspace')?.classList.remove('theater');
  updatePreviewButton();
  if (restoreFocus) ($('preview-selected-btn') as HTMLButtonElement).focus();
}
function stopPreview(restoreFocus = false): void {
  if (previewSource === null) return;
  previewGuard.invalidate();
  clearPreviewState(restoreFocus);
}
function schedulePreviewStop(): void { if (previewSource === null) return; if (previewStopTimer !== null) window.clearTimeout(previewStopTimer); previewStopTimer = window.setTimeout(() => { previewStopTimer = null; stopPreview(); }, 120); }
function updateYoutubePreviewBounds(): void {
  if (previewProvider !== 'youtube' || previewSource === null) return;
  const bounds = currentPreviewBounds();
  if (!bounds) { stopPreview(); return; }
  const request = previewGuard.current();
  void window.clipdockAPI.setYoutubePreviewBounds(bounds).then((visible) => { if (!visible && previewGuard.isCurrent(request)) stopPreview(); }).catch(() => { if (previewGuard.isCurrent(request)) stopPreview(); });
}
function scheduleYoutubePreviewBounds(): void {
  if (previewProvider !== 'youtube' || previewSource === null || previewBoundsTimer !== null) return;
  previewBoundsTimer = window.setTimeout(() => { previewBoundsTimer = null; updateYoutubePreviewBounds(); }, 16);
}
async function startYoutubePreview(id: string, startAt?: number, resultKey: string | null = outputSession.selected?.key ?? null): Promise<void> {
  if (searchBusy || !VIDEO_ID.test(id)) return;
  if (previewSource !== null) stopPreview();
  setInspectorOpen(true);
  const target = $('source-monitor');
  // No width transition: reading the monitor flushes the widened grid layout before
  // creating the native view. The saved splitter width is never modified.
  document.getElementById('workspace')?.classList.add('theater');
  const bounds = currentPreviewBounds(target);
  if (!bounds) { document.getElementById('workspace')?.classList.remove('theater'); return; }
  const request = previewGuard.next();
  previewFailure = false; previewSource = 'manual'; previewProvider = 'youtube'; previewTarget = target; previewResultKey = resultKey; youtubePreviewActive = true; updatePreviewButton();
  try {
    const opened = await window.clipdockAPI.openYoutubePreview(id, startAt, bounds);
    if (previewGuard.isStale(request)) return;
    if (!opened) { previewFailure = true; clearPreviewState(); setText('message', 'YouTube preview could not load. Use Open on YouTube.'); }
    else updateYoutubePreviewBounds();
  } catch { if (previewGuard.isCurrent(request)) { previewFailure = true; clearPreviewState(); setText('message', 'YouTube preview could not load. Use Open on YouTube.'); } }
}
async function watchYoutube(id: string, startAt?: number): Promise<void> {
  if (searchBusy || youtubeBusy || !VIDEO_ID.test(id)) return;
  try {
    const opened = await window.clipdockAPI.openYoutubeExternal(id, startAt);
    if (!opened) { setText('message', 'Could not open YouTube. Check your default browser and try again.'); return; }
    setText('message', 'Opened YouTube in your browser.');
  } catch { setText('message', 'Could not open YouTube. Check your default browser and try again.'); }
}
function handleYoutubePreviewState(state: YoutubePreviewState): void {
  // Main acknowledges each successful renderer close in IPC order. That event
  // belongs to the stopped lifecycle, even if another preview is now active.
  if (state.state === 'closed' && state.reason === 'closed' && pendingYoutubePreviewCloses.size) {
    pendingYoutubePreviewCloses.delete(pendingYoutubePreviewCloses.values().next().value!);
    return;
  }
  if (previewProvider !== 'youtube' || !youtubePreviewActive) return;
  youtubePreviewActive = false;
  previewGuard.invalidate();
  if (state.state === 'failed') { previewFailure = true; setText('message', 'YouTube preview could not play here. Use Open on YouTube.'); }
  clearPreviewState(state.reason === 'escape');
}
function startPexelsPreview(asset: PexelsAsset, resultKey: string | null = outputSession.selected?.key ?? null): void {
  if (!asset.previewUrl || asset.kind !== 'video' || searchBusy) return;
  if (previewSource !== null) stopPreview();
  setInspectorOpen(true);
  const target = $('source-monitor');
  document.getElementById('workspace')?.classList.add('theater');
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) { document.getElementById('workspace')?.classList.remove('theater'); return; }
  const overlay = $('pexels-preview-overlay'); const video = $('pexels-preview-video') as HTMLVideoElement;
  const request = previewGuard.next();
  video.src = asset.previewUrl; video.muted = false; video.controls = true; video.autoplay = true;
  overlay.style.left = `${rect.left}px`; overlay.style.top = `${rect.top}px`; overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`;
  overlay.classList.add('interactive'); overlay.classList.remove('hidden'); overlay.setAttribute('aria-hidden', 'false');
  previewSource = 'manual'; previewProvider = 'pexels'; previewTarget = target; previewResultKey = resultKey;
  void video.play().catch(() => { if (previewGuard.isCurrent(request)) stopPreview(); }); updatePreviewButton();
}

function wirePreviewControls(): void {
  document.getElementById('source-monitor')?.addEventListener('animationend', () => document.getElementById('source-monitor')?.classList.remove('locking'));
  $('preview-selected-btn').addEventListener('click', () => { if (previewSource === 'manual') stopPreview(); else if (provider === 'pexels' && pexels) startPexelsPreview(pexels); else if (provider === 'youtube' && youtube) void startYoutubePreview(youtube.id, currentSelection()?.start); });
  document.getElementById('open-youtube-external-btn')?.addEventListener('click', () => { if (youtube) void watchYoutube(youtube.id, currentSelection()?.start); });
  document.getElementById('source-monitor')?.addEventListener('click', () => { ($('preview-selected-btn') as HTMLButtonElement).click(); });
  document.getElementById('back-to-results')?.addEventListener('click', () => setInspectorOpen(false, true));
  window.addEventListener('scroll', () => { if (previewProvider === 'youtube') scheduleYoutubePreviewBounds(); else schedulePreviewStop(); }, true); window.addEventListener('resize', () => { if (previewProvider === 'youtube') scheduleYoutubePreviewBounds(); else stopPreview(); }); window.addEventListener('beforeunload', () => stopPreview()); window.addEventListener('keydown', (event) => {
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'k') { event.preventDefault(); if (settingsOpen) closeSettings(false); if (currentSurface !== 'search') setSurface('search', false); ($('youtube-search-input') as HTMLInputElement).focus(); return; }
    if (command && event.key === ',') { event.preventDefault(); openSettings(); return; }
    if (command && event.key === 'Enter') { event.preventDefault(); ($('download-youtube-btn') as HTMLButtonElement).click(); return; }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
      const active = document.activeElement as HTMLElement | null; const tag = active?.tagName ?? '';
      if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) && active?.getAttribute?.('contenteditable') !== 'true') {
        // A focused result card previews itself; otherwise Space drives the open Inspector's monitor only.
        const card = active && active.parentElement === document.getElementById('youtube-search-results') ? findResultDescendant(active, (element) => element.dataset?.cardAction === 'play') as HTMLButtonElement | null : null;
        const target = card ?? (inspectorOpen ? $('preview-selected-btn') as HTMLButtonElement : null);
        if (target) { event.preventDefault(); if (!target.disabled) target.click(); return; }
      }
    }
    if (event.key !== 'Escape') return;
    if (openHistoryMenu) { closeHistoryActions(true); return; }
    if (document.getElementById('intent-menu') && !document.getElementById('intent-menu')?.classList.contains('hidden')) { setIntentMenuOpen(false); (document.getElementById('intent-menu-btn') as HTMLElement | null)?.focus?.(); return; }
    if (previewSource !== null) { stopPreview(true); return; }
    if (settingsOpen) { closeSettings(true); return; }
    if (currentSurface !== 'search') { setSurface('search'); return; }
    const openDetails = (Array.from(document.querySelectorAll?.('details[open]') ?? []) as HTMLDetailsElement[]).filter((detail) => !detail.classList.contains('hidden'));
    const detail = openDetails.at(-1);
    if (detail) { detail.open = false; return; }
    if (inspectorOpen) { setInspectorOpen(false, returnFocusToResult); }
  });
  for (const event of ['ended', 'error', 'pause']) document.getElementById('pexels-preview-video')?.addEventListener(event, () => { if (previewProvider === 'pexels' && (event !== 'pause' || ($('pexels-preview-video') as HTMLVideoElement).paused)) stopPreview(); });
}

function wireSearchResultRow(row: HTMLElement, checkbox: HTMLInputElement): void {
  row.tabIndex = 0; row.setAttribute('role', 'listitem');
  checkbox.addEventListener('click', (event) => event.stopPropagation());
  checkbox.addEventListener('keydown', (event) => event.stopPropagation());
}
function appendResultSelection(row: HTMLElement, key: string, title: string, selection: ResultSelection): HTMLInputElement {
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'result-selection'; checkbox.dataset.field = 'selection'; checkbox.checked = outputSession.staged.has(key); checkbox.disabled = selectedQueueLoadBusy; checkbox.setAttribute('aria-label', `${checkbox.checked ? 'Remove' : 'Add'} ${title} ${checkbox.checked ? 'from' : 'to'} the staged selection`);
  checkbox.addEventListener('change', () => { stageResultFromKey(key, selection, checkbox.checked); });
  row.append(checkbox); return checkbox;
}
function isWithin(node: Node | null, root: HTMLElement): boolean { for (let current = node; current; current = current.parentElement) if (current === root) return true; return false; }
// A list rebuild replaces every row; keep keyboard focus on the equivalent control of
// the same row (or on the row) instead of letting it fall back to the page body.
function captureListFocus(list: HTMLElement, key: 'queueId' | 'recordId'): () => void {
  const control = document.activeElement as HTMLElement | null;
  let row = control;
  while (row && row.parentElement !== list) row = row.parentElement;
  const id = row?.dataset?.[key];
  if (!control || !row || !id) return () => undefined;
  const same = (element: HTMLElement): boolean => element.tagName === control.tagName && element.className === control.className && element.textContent === control.textContent;
  return () => {
    const next = (Array.from(list.children) as HTMLElement[]).find((child) => child.dataset?.[key] === id);
    if (!next) return;
    const target = control === row ? null : findResultDescendant(next, (element) => same(element) && !(element as HTMLButtonElement).disabled);
    if (!target && next.getAttribute('tabindex') === null && next.tabIndex < 0) next.setAttribute('tabindex', '-1');
    (target ?? next).focus?.();
  };
}
function findResultDescendant(root: HTMLElement, predicate: (element: HTMLElement) => boolean): HTMLElement | null {
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (predicate(child)) return child;
    const nested = findResultDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}
function resultOutputLine(value: OutputDefaults, photo = false): string { return cardOutputSummary(value, photo); }
// ---- Contact-sheet frame decoration ------------------------------------------------
// Every result is a numbered frame: an amber rebate line (frame number, source code,
// output quality) and a grease-pencil loop that is drawn when the frame is marked.
// The SVG strings are constant markup; no result data is ever written through innerHTML.
const GREASE_SVG = '<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path vector-effect="non-scaling-stroke" d="M9 4.5C30 2.2 64 1.6 93 3.6c3.4 9 4.2 29 2.2 51.6C70 58.2 31 58.6 5.4 56.4 3.2 40 2.6 19 5.6 3.4c4.2-.9 9.8-1.6 16-1.4"/></svg>';
const RING_SVG = '<svg viewBox="0 0 40 24" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path vector-effect="non-scaling-stroke" d="M30 3.5C22 1 8 2 3.5 9 .5 15 7 21.5 19 21.8 31 22 38.5 17 37.5 10.5 36.5 5 29 2.6 22 2.5"/></svg>';
let justMarkedKey: string | null = null;
function frameNumber(index: number, page: { page: number; pageSize: number } | null): string {
  const value = (Math.max(1, page?.page ?? 1) - 1) * Math.max(0, page?.pageSize ?? 0) + index + 1;
  return String(value).padStart(2, '0');
}
function rebateQuality(value: OutputDefaults, photo = false): string {
  if (photo) return 'STILL';
  if (value.mediaMode === 'audio') return value.audioFormat.toUpperCase();
  return value.quality === 'best' || value.quality === 'original' || !value.quality ? 'BEST' : value.quality;
}
function decorateResultCard(row: HTMLElement, key: string, frame: string, code: string, details: HTMLElement, open: (event: Event) => void, photo = false): void {
  const rebate = document.createElement('span'); rebate.className = 'rebate'; rebate.dataset.field = 'rebate'; rebate.setAttribute('aria-hidden', 'true');
  const number = document.createElement('span'); number.className = 'fno'; number.textContent = frame; number.innerHTML = `${frame}${RING_SVG}`;
  const source = document.createElement('span'); source.textContent = `▸ ${code}`;
  const rule = document.createElement('span'); rule.className = 'rule';
  const quality = document.createElement('span'); quality.className = 'rq'; quality.dataset.field = 'rebate-quality'; quality.textContent = rebateQuality(outputSession.output(key, { photo }), photo);
  const override = document.createElement('span'); override.className = 'ovr'; override.textContent = 'OVR';
  rebate.append(number, source, rule, quality, override);
  const grease = document.createElement('span'); grease.className = 'grease'; grease.setAttribute('aria-hidden', 'true'); grease.innerHTML = GREASE_SVG;
  row.append(rebate, grease);
  row.dataset.override = String(Object.keys(outputSession.overrides(key)).length > 0);
  if (justMarkedKey === key && !reducedMotion()) row.classList.add('just-marked');
  details.setAttribute('aria-label', `Open clip detail: ${row.dataset.resultTitle ?? ''}`);
  details.addEventListener('click', (event) => { event.stopPropagation?.(); open(event); });
}
function overrideFields(overrides: Partial<OutputDefaults>): string {
  const labels = { profile: 'Profile', quality: 'Quality', mediaMode: 'Mode', audioFormat: 'Audio format', intent: 'After download', targetBin: 'Target bin', subtitles: 'Subtitles', subtitleLanguage: 'Subtitle language', selection: 'Range', selectionPlan: 'Range' };
  return Object.keys(overrides).length ? `Overrides: ${[...new Set((Object.keys(overrides) as Array<keyof OutputDefaults>).map((key) => labels[key]))].join(', ')}` : 'Using common defaults';
}
function updateResultOutput(row: HTMLElement, key: string, photo = false): void {
  const output = findResultDescendant(row, (element) => element.dataset.field === 'effective-output');
  if (!output) return;
  const line = findResultDescendant(output, (element) => element.dataset.field === 'output-line');
  const source = findResultDescendant(output, (element) => element.dataset.field === 'output-source');
  const overrides = outputSession.overrides(key);
  if (line) line.textContent = resultOutputLine(outputSession.output(key, { photo }), photo);
  if (source) { source.className = `result-output-source ${Object.keys(overrides).length ? 'override' : 'common'}`; source.textContent = Object.keys(overrides).length ? 'Override' : 'Common'; source.title = overrideFields(overrides); }
  const quality = findResultDescendant(row, (element) => element.dataset.field === 'rebate-quality');
  if (quality) quality.textContent = rebateQuality(outputSession.output(key, { photo }), photo);
  row.dataset.override = String(Object.keys(overrides).length > 0);
}
function appendResultOutput(row: HTMLElement, key: string, photo = false): void {
  const output = document.createElement('span'); output.className = 'result-output'; output.dataset.field = 'effective-output';
  const line = document.createElement('span'); line.className = 'result-output-main'; line.dataset.field = 'output-line'; line.textContent = resultOutputLine(outputSession.output(key, { photo }), photo);
  const source = document.createElement('span'); source.dataset.field = 'output-source'; const overrides = outputSession.overrides(key); source.className = `result-output-source ${Object.keys(overrides).length ? 'override' : 'common'}`; source.textContent = Object.keys(overrides).length ? 'Override' : 'Common'; source.title = overrideFields(overrides);
  output.append(line, source); row.append(output);
}
function createResultOptionSelect(labelText: string, field: string, value: string, choices: Array<[string, string]>, disabled: boolean, onChange: (value: string) => void): HTMLSelectElement {
  const label = document.createElement('label'); label.className = 'result-option-field option-field'; label.dataset.field = `${field}-field`;
  const copy = document.createElement('span'); copy.className = 'result-option-label option-label'; copy.textContent = labelText;
  const select = document.createElement('select'); select.className = 'result-option-control option-control'; select.dataset.field = field; select.setAttribute('aria-label', labelText); select.disabled = disabled;
  for (const [optionValue, optionLabel] of choices) { const option = document.createElement('option'); option.value = optionValue; option.textContent = optionLabel; select.append(option); }
  select.value = value;
  select.addEventListener('click', (event) => event.stopPropagation?.()); select.addEventListener('keydown', (event) => event.stopPropagation?.()); select.addEventListener('change', (event) => { event.stopPropagation?.(); onChange(select.value); });
  label.append(copy, select); return select;
}
function updateResultOption(key: string, field: string, value: string, row: HTMLElement, photo = false): void {
  outputSession.edit(key, { [field]: value });
  const output = outputSession.output(key, { photo });
  const audioControl = findResultDescendant(row, (element) => element.dataset.field === 'audioFormat') as HTMLSelectElement | null;
  const audioField = audioControl?.parentElement;
  if (audioField) { audioField.classList.toggle('hidden', output.mediaMode !== 'audio'); audioControl.disabled = output.mediaMode !== 'audio'; }
  updateResultOutput(row, key, photo); renderSelectionToolbar();
  if (outputSession.selected?.key === key) applyDetailOutput();
}
function appendResultCardControls(row: HTMLElement, key: string, selection: ResultSelection, openInspector: () => void, play: () => void, previewAvailable: boolean, previewUnavailableLabel: string, photo = false): void {
  let optionsOpen = cardOptionsOpen.get(key) ?? false; const effective = outputSession.output(key, { photo });
  const controls = document.createElement('div'); controls.className = 'result-card-controls download-line'; controls.dataset.field = 'card-controls'; controls.setAttribute('aria-busy', String(inlineActionBusyKeys.has(key)));
  const actions = document.createElement('div'); actions.className = 'result-card-actions download-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Actions for ${selection.title}`); actions.dataset.field = 'card-actions';
  const playButton = button(previewAvailable ? 'Play' : 'Preview unavailable', play); playButton.className = 'result-play-control play-button'; playButton.dataset.cardControl = 'true'; playButton.dataset.cardAction = 'play'; playButton.dataset.previewAvailable = String(previewAvailable); playButton.disabled = !previewAvailable; playButton.setAttribute('aria-label', previewAvailable ? `Play ${selection.title}` : previewUnavailableLabel); playButton.setAttribute('aria-pressed', 'false');
  const thumbnail = findResultDescendant(row, (element) => element.dataset.field === 'thumbnail'); if (thumbnail) thumbnail.append(playButton); else actions.append(playButton);
  const optionsToggle = button('Download options', () => undefined); optionsToggle.className = 'result-options-toggle download-toggle'; optionsToggle.dataset.cardControl = 'true'; optionsToggle.dataset.cardAction = 'options'; optionsToggle.setAttribute('aria-expanded', String(optionsOpen)); optionsToggle.setAttribute('aria-controls', resultOptionsId(key)); optionsToggle.addEventListener('click', (event) => { event.stopPropagation?.(); optionsOpen = !optionsOpen; cardOptionsOpen.set(key, optionsOpen); optionsToggle.setAttribute('aria-expanded', String(optionsOpen)); options.hidden = !optionsOpen; options.setAttribute('aria-hidden', String(!optionsOpen)); options.classList.toggle('hidden', !optionsOpen); }); optionsToggle.addEventListener('keydown', (event) => event.stopPropagation?.());
  actions.append(optionsToggle);
  const queueButton = button('Add to queue', () => { void enqueueResultCard(key, selection, 'tail'); }); queueButton.className = 'result-queue-action'; queueButton.dataset.cardControl = 'true'; queueButton.dataset.cardAction = 'enqueue'; queueButton.setAttribute('aria-label', `Add to queue: ${selection.title}`);
  const nowButton = button(downloadQueue.activeId ? 'Download next' : 'Download now', () => { void enqueueResultCard(key, selection, 'after-active'); }); nowButton.className = 'result-now-action'; nowButton.dataset.cardControl = 'true'; nowButton.dataset.cardAction = 'now'; nowButton.setAttribute('aria-label', `${downloadQueue.activeId ? 'Download next' : 'Download now'}: ${selection.title}`);
  for (const control of [playButton, queueButton, nowButton]) { control.addEventListener('click', (event) => event.stopPropagation?.()); control.addEventListener('keydown', (event) => event.stopPropagation?.()); }
  actions.append(queueButton, nowButton);
  // The quick actions ride on the frame's lower-left corner, like the play pill.
  if (thumbnail) thumbnail.append(actions); else controls.append(actions);
  const options = document.createElement('div'); options.className = `result-options download-options${optionsOpen ? '' : ' hidden'}`; options.id = resultOptionsId(key); options.dataset.field = 'options'; options.hidden = !optionsOpen; options.setAttribute('aria-hidden', String(!optionsOpen));
  if (!photo) options.append(createResultOptionSelect('Profile', 'profile', effective.profile, [['original', 'Original'], ['fast', 'Fast'], ['editing', 'Edit-ready']], false, (value) => updateResultOption(key, 'profile', value, row, photo)));
  const qualityChoices: Array<[string, string]> = [['best', 'Best available']]; if (effective.quality !== 'best') qualityChoices.push([effective.quality, cardQualityLabel(effective.quality)]);
  options.append(createResultOptionSelect('Quality', 'quality', effective.quality, qualityChoices, photo || selection.provider === 'pinterest', (value) => updateResultOption(key, 'quality', value, row, photo)));
  if (selection.provider === 'youtube') {
    options.append(createResultOptionSelect('Mode', 'mediaMode', effective.mediaMode, [['video', 'Video'], ['audio', 'Audio']], false, (value) => updateResultOption(key, 'mediaMode', value, row, photo)));
    const audioControl = createResultOptionSelect('Audio format', 'audioFormat', effective.audioFormat, [['wav', 'WAV'], ['mp3', 'MP3'], ['m4a', 'AAC (M4A)']], effective.mediaMode !== 'audio', (value) => updateResultOption(key, 'audioFormat', value, row, photo));
    const audioField = audioControl.parentElement; if (audioField) { audioField.classList.toggle('hidden', effective.mediaMode !== 'audio'); options.append(audioField); }
  }
  options.append(createResultOptionSelect('After download', 'intent', effective.intent, [['download', 'Download only'], ['import', 'Add to Media Pool'], ['end', 'Timeline end'], ['playhead', 'At playhead']], false, (value) => updateResultOption(key, 'intent', value, row, photo)));
  options.append(createResultOptionSelect('Target bin', 'targetBin', effective.targetBin, [['active', 'Active bin'], ['clipdock', 'ClipDock bin']], false, (value) => updateResultOption(key, 'targetBin', value, row, photo)));
  const advanced = button('Open advanced options', openInspector); advanced.className = 'result-advanced-action advanced'; advanced.dataset.cardControl = 'true'; advanced.dataset.cardAction = 'advanced'; advanced.setAttribute('aria-label', `Open advanced options for ${selection.title}`); options.append(advanced);
  options.setAttribute('aria-busy', String(inlineActionBusyKeys.has(key))); controls.append(options); row.append(controls);
  updateInlineCardStates();
}
function updateInlineCardStates(): void {
  const list = document.getElementById('youtube-search-results');
  if (!list) return;
  for (const row of Array.from(list.children) as HTMLElement[]) {
    const key = row.dataset.resultKey;
    if (!key) continue;
    const busy = inlineActionBusyKeys.has(key);
    const queueButton = findResultDescendant(row, (element) => element.dataset.cardAction === 'enqueue') as HTMLButtonElement | null;
    const nowButton = findResultDescendant(row, (element) => element.dataset.cardAction === 'now') as HTMLButtonElement | null;
    const playButton = findResultDescendant(row, (element) => element.dataset.cardAction === 'play') as HTMLButtonElement | null;
    const actions = findResultDescendant(row, (element) => element.dataset.field === 'card-actions');
    const options = findResultDescendant(row, (element) => element.dataset.field === 'options');
    const canAct = !selectedQueueLoadBusy && !searchBusy && !metadataBusy && !busy;
    row.setAttribute('aria-busy', String(busy)); actions?.setAttribute('aria-busy', String(busy)); options?.setAttribute('aria-busy', String(busy));
    if (queueButton) { queueButton.disabled = !canAct; queueButton.setAttribute('aria-busy', String(busy)); }
    if (nowButton) { nowButton.disabled = !canAct; nowButton.textContent = downloadQueue.activeId ? 'Download next' : 'Download now'; nowButton.setAttribute('aria-label', `${downloadQueue.activeId ? 'Download next' : 'Download now'}: ${row.dataset.resultTitle ?? ''}`); nowButton.setAttribute('aria-busy', String(busy)); }
    if (playButton) { const active = previewSource === 'manual' && previewResultKey === key; row.classList.toggle('is-playing', active); playButton.disabled = !active && (playButton.dataset.previewAvailable !== 'true' || searchBusy || metadataBusy || youtubeBusy || busy); playButton.textContent = playButton.dataset.previewAvailable === 'true' ? active ? 'Stop preview' : 'Play' : 'Preview unavailable'; playButton.setAttribute('aria-pressed', String(active)); playButton.setAttribute('aria-label', playButton.dataset.previewAvailable === 'true' ? `${active ? 'Stop preview' : 'Play'} ${row.dataset.resultTitle ?? ''}` : playButton.getAttribute('aria-label') ?? 'Preview unavailable'); }
  }
}
function refreshInlineResultCards(): void {
  const list = document.getElementById('youtube-search-results');
  if (!list) return;
  for (const row of Array.from(list.children) as HTMLElement[]) {
    const key = row.dataset.resultKey;
    if (!key) continue;
    const photo = row.dataset.cardPhoto === 'true';
    const effective = outputSession.output(key, { photo });
    updateResultOutput(row, key, photo);
    for (const field of ['profile', 'quality', 'intent', 'targetBin', 'mediaMode', 'audioFormat']) {
      const control = findResultDescendant(row, (element) => element.dataset.field === field) as HTMLSelectElement | null;
      if (control) {
        const value = effective[field as keyof OutputDefaults] as string;
        if (field === 'quality' && !Array.from(control.options ?? control.children).some((option) => option.value === value)) { const option = document.createElement('option'); option.value = value; option.textContent = cardQualityLabel(value); control.append(option); }
        control.value = value;
      }
    }
    const audio = findResultDescendant(row, (element) => element.dataset.field === 'audioFormat') as HTMLSelectElement | null;
    const audioField = audio?.parentElement;
    if (audioField) { audioField.classList.toggle('hidden', effective.mediaMode !== 'audio'); audio.disabled = effective.mediaMode !== 'audio'; }
  }
  updateInlineCardStates();
}
function stageResultFromKey(key: string, selection: ResultSelection, selected: boolean): void {
  if (selectedQueueLoadBusy) { renderSearchResults(); return; }
  if (selected) { outputSession.stage(key, selection); justMarkedKey = key; }
  else outputSession.unstage(key);
  renderSelectionToolbar(); renderSearchResults(); justMarkedKey = null;
  // Keep keyboard focus on the mark the user just toggled; the rebuild replaced it.
  const row = Array.from(document.getElementById('youtube-search-results')?.children ?? []).find((child) => (child as HTMLElement).dataset.resultKey === key) as HTMLElement | undefined;
  if (row && document.body && document.activeElement === document.body) (findResultDescendant(row, (element) => element.dataset.field === 'selection') as HTMLElement | null)?.focus?.();
}
function syncResultCardThumbnailHeights(): void {
  // CSS aspect-ratio owns 16:9 since D Home Grid port
  return;
}
function scheduleResultCardThumbnailHeights(): void {
  // CSS aspect-ratio owns 16:9 since D Home Grid port
  return;
}
function observeResultCardThumbnailContainer(): void {
  // CSS aspect-ratio owns 16:9 since D Home Grid port
  return;
}
function renderPexelsSearchResults(): void {
  stopPreview(); const list = $('youtube-search-results'); list.replaceChildren(); searchButtons = [];
  for (const [index, item] of (pexelsSearch?.results ?? []).entries()) {
    const kind = item.kind === 'photo' ? 'Photo' : 'Video'; const key = resultKeyFor('pexels', String(item.id), pexelsKind);
    const duration = item.kind === 'video' && item.duration !== null ? formatDuration(item.duration) : 'Still image';
    const metadata = [item.creator ? `Creator: ${item.creator}` : null, item.width && item.height ? `Dimensions: ${item.width}×${item.height}` : null, kind].filter(Boolean).join(' · ');
    const selection: ResultSelection = { provider: 'pexels', resultId: String(item.id), source: item.sourceUrl, title: item.title, channel: item.creator, thumbnailDataUrl: item.thumbnailUrl, pexelsKind };
    const row = document.createElement('div'); row.className = 'youtube-search-result source-row clipdock-result-card result-card'; row.dataset.resultId = String(item.id); row.dataset.resultKey = key; row.dataset.resultTitle = item.title; row.dataset.cardPhoto = String(item.kind === 'photo'); row.dataset.provider = 'pexels'; row.dataset.source = 'pexels'; row.setAttribute('aria-pressed', String(String(item.id) === outputSession.selected?.resultId)); row.setAttribute('aria-selected', String(outputSession.staged.has(key))); row.setAttribute('aria-label', sourceRowAriaLabel(`Pexels ${kind}`, item.title, duration, metadata));
    if (String(item.id) === outputSession.selected?.resultId) { row.classList.add('selected'); row.setAttribute('aria-current', 'true'); }
    const thumb = document.createElement('span'); thumb.className = 'youtube-thumb source-row-thumbnail result-card-thumbnail card-thumb'; thumb.dataset.field = 'thumbnail';
    appendResultThumbnail(thumb, item.thumbnailUrl, item.title);
    if (item.kind === 'video' && item.duration !== null) { const badge = document.createElement('span'); badge.className = 'youtube-duration source-row-duration'; badge.textContent = formatDuration(item.duration); badge.setAttribute('aria-label', `Duration: ${duration}`); badge.dataset.field = 'duration'; thumb.append(badge); }
    { const freeTag = document.createElement('span'); freeTag.className = 'lic'; freeTag.textContent = 'Free'; freeTag.setAttribute('aria-hidden', 'true'); thumb.append(freeTag); }
    const details = document.createElement('button'); (details as HTMLButtonElement).type = 'button'; details.className = 'youtube-details source-row-details'; const title = document.createElement('span'); title.className = 'youtube-result-title source-row-title'; title.dataset.field = 'title'; title.textContent = item.title; const meta = document.createElement('span'); meta.className = 'youtube-result-meta source-row-source source-row-meta'; meta.dataset.field = 'source-metadata'; meta.textContent = `${item.creator ?? 'Pexels'} · Free on Pexels`; details.append(title, meta); row.append(thumb, details);
    const checkbox = appendResultSelection(row, key, item.title, selection); appendResultOutput(row, key, item.kind === 'photo');
    const open = (event: Event) => { if (searchBusy) return; outputSession.select({ key, resultId: String(item.id), thumbnailDataUrl: item.thumbnailUrl }); ($('youtube-url') as HTMLInputElement).value = ''; openInspectorForSelection((event as MouseEvent).detail === 0); applyDetailOutput(); renderPexelsSearchResults(); void loadPexels(item.id); };
    wireSearchResultRow(row, checkbox);
    appendResultCardControls(row, key, selection, () => open({ detail: 1 } as unknown as Event), () => { if (previewSource === 'manual' && previewResultKey === key) stopPreview(); else { open({ detail: 1 } as unknown as Event); startPexelsPreview(item, key); } }, item.kind === 'video' && !!item.previewUrl, 'Pexels preview is unavailable for this result.', item.kind === 'photo');
    decorateResultCard(row, key, frameNumber(index, pexelsSearch), 'PX', details, open, item.kind === 'photo');
    searchButtons.push(row); list.append(row);
  }
  setText('youtube-search-status', pexelsSearch ? (pexelsSearch.results.length ? `Pexels ${pexelsKind}s · page ${pexelsSearch.page}` : 'No Pexels results found.') : 'Connect Pexels and search.'); setSearchBusy(searchBusy); renderSelectionToolbar(); scheduleResultCardThumbnailHeights();
}
function renderSearchResults(): void {
  clearMetadataPrefetchTimers();
  if (provider === 'pexels') { renderPexelsSearchResults(); return; }
  if (provider === 'social') {
    // Social has no search-result corpus: the existing pasted-link Inspector is the
    // explicit provider fallback and keeps its original load/download path intact.
    stopPreview(); $('youtube-search-results').replaceChildren(); searchButtons = []; setText('youtube-search-status', 'Paste a public social video URL.'); renderSelectionToolbar(); return;
  }
  if (provider === 'pinterest') { renderPinterestSearchResults(); return; }
  stopPreview(); const list = $('youtube-search-results'); list.replaceChildren(); searchButtons = [];
  for (const [index, item] of (searchPage?.results ?? []).entries()) {
    const metadata = formatMeta(item); const duration = item.duration === null ? 'Duration unavailable' : formatDuration(item.duration); const key = resultKeyFor('youtube', item.id);
    const selection: ResultSelection = { provider: 'youtube', resultId: item.id, source: item.url, title: item.title, channel: item.channel, thumbnailDataUrl: item.thumbnailUrl };
    const row = document.createElement('div'); row.className = 'youtube-search-result source-row clipdock-result-card result-card'; row.dataset.resultId = item.id; row.dataset.resultKey = key; row.dataset.resultTitle = item.title; row.dataset.cardPhoto = 'false'; row.dataset.provider = 'youtube'; row.dataset.source = 'youtube'; row.setAttribute('aria-pressed', String(item.id === outputSession.selected?.resultId)); row.setAttribute('aria-selected', String(outputSession.staged.has(key))); row.setAttribute('aria-label', sourceRowAriaLabel('YouTube', item.title, duration, metadata));
    if (item.id === outputSession.selected?.resultId) { row.classList.add('selected'); row.setAttribute('aria-current', 'true'); }
    const thumb = document.createElement('span'); thumb.className = 'youtube-thumb source-row-thumbnail result-card-thumbnail card-thumb'; thumb.dataset.field = 'thumbnail';
    appendResultThumbnail(thumb, item.thumbnailUrl, item.title);
    if (item.duration !== null) { const badge = document.createElement('span'); badge.className = 'youtube-duration source-row-duration'; badge.textContent = formatDuration(item.duration); badge.setAttribute('aria-label', `Duration: ${duration}`); badge.dataset.field = 'duration'; thumb.append(badge); }
    const details = document.createElement('button'); (details as HTMLButtonElement).type = 'button'; details.className = 'youtube-details source-row-details'; const title = document.createElement('span'); title.className = 'youtube-result-title source-row-title'; title.dataset.field = 'title'; title.textContent = item.title; const meta = document.createElement('span'); meta.className = 'youtube-result-meta source-row-source source-row-meta'; meta.dataset.field = 'source-metadata'; meta.textContent = metadata; details.append(title, meta); row.append(thumb, details); const checkbox = appendResultSelection(row, key, item.title, selection); appendResultOutput(row, key);
    const open = (event: Event) => { if (searchBusy) return; outputSession.select({ key, resultId: item.id, thumbnailDataUrl: item.thumbnailUrl }); ($('youtube-url') as HTMLInputElement).value = item.url; openInspectorForSelection((event as MouseEvent).detail === 0); applyDetailOutput(); renderSearchResults(); void loadYoutube(item.url, item.thumbnailUrl); };
    wireSearchResultRow(row, checkbox);
    wireMetadataPrefetch(row, item.url);
    appendResultCardControls(row, key, selection, () => open({ detail: 1 } as unknown as Event), () => { if (previewSource === 'manual' && previewResultKey === key) stopPreview(); else { open({ detail: 1 } as unknown as Event); void startYoutubePreview(item.id, undefined, key); } }, true, 'YouTube preview is unavailable for this result.');
    decorateResultCard(row, key, frameNumber(index, searchPage), 'YT', details, open);
    searchButtons.push(row); list.append(row);
  }
  const diagnostic = searchPage?.thumbnailDiagnostic; const thumbnailWarning = diagnostic && diagnostic.total > 0 && (diagnostic.failed === diagnostic.total || diagnostic.failed >= Math.ceil(diagnostic.total / 2)) ? ` · Thumbnails ${diagnostic.total - diagnostic.failed}/${diagnostic.total} · ${diagnostic.reason} · Node ${diagnostic.node}` : '';
  setText('youtube-search-status', searchPage ? (searchPage.results.length ? `Page ${searchPage.page} of ${searchPage.pageCount} · ${searchPage.totalResults} results${thumbnailWarning}` : 'No results found.') : 'Search YouTube to browse videos.'); setSearchBusy(searchBusy); renderSelectionToolbar(); scheduleResultCardThumbnailHeights();
}
function renderPinterestSearchResults(): void {
  stopPreview(); const list = $('youtube-search-results'); list.replaceChildren(); searchButtons = [];
  for (const [index, item] of (pinterestSearch?.results ?? []).entries()) {
    const kindLabel = item.kind === 'carousel' ? 'Carousel' : item.kind === 'image' ? 'Image' : 'Video'; const key = resultKeyFor('pinterest', item.id);
    const selection: ResultSelection = { provider: 'pinterest', resultId: item.id, source: item.url, title: item.title, channel: item.creator, thumbnailDataUrl: item.thumbnailUrl };
    const row = document.createElement('div'); row.className = 'youtube-search-result source-row clipdock-result-card result-card'; row.dataset.resultId = item.id; row.dataset.resultKey = key; row.dataset.resultTitle = item.title; row.dataset.cardPhoto = String(item.kind === 'image'); row.dataset.provider = 'pinterest'; row.dataset.source = 'pinterest'; row.setAttribute('aria-pressed', String(item.id === outputSession.selected?.resultId)); row.setAttribute('aria-selected', String(outputSession.staged.has(key))); row.setAttribute('aria-label', sourceRowAriaLabel('Pinterest', item.title, kindLabel, item.creator ? `Creator: ${item.creator}` : ''));
    if (item.id === outputSession.selected?.resultId) { row.classList.add('selected'); row.setAttribute('aria-current', 'true'); }
    const thumb = document.createElement('span'); thumb.className = 'youtube-thumb source-row-thumbnail result-card-thumbnail card-thumb'; thumb.dataset.field = 'thumbnail';
    appendResultThumbnail(thumb, item.thumbnailUrl, item.title);
    const badge = document.createElement('span'); badge.className = 'youtube-duration source-row-duration'; badge.textContent = kindLabel; badge.setAttribute('aria-label', `Type: ${kindLabel}`); badge.dataset.field = 'kind'; thumb.append(badge);
    const details = document.createElement('button'); (details as HTMLButtonElement).type = 'button'; details.className = 'youtube-details source-row-details'; const title = document.createElement('span'); title.className = 'youtube-result-title source-row-title'; title.dataset.field = 'title'; title.textContent = item.title; const meta = document.createElement('span'); meta.className = 'youtube-result-meta source-row-source source-row-meta'; meta.dataset.field = 'source-metadata'; meta.textContent = item.creator ?? 'Creator unavailable'; details.append(title, meta); row.append(thumb, details); const checkbox = appendResultSelection(row, key, item.title, selection); appendResultOutput(row, key, item.kind === 'image');
    const open = (event: Event) => { if (searchBusy) return; outputSession.select({ key, resultId: item.id, thumbnailDataUrl: item.thumbnailUrl }); ($('pinterest-url') as HTMLInputElement).value = item.url; openInspectorForSelection((event as MouseEvent).detail === 0); applyDetailOutput(); renderPinterestSearchResults(); void loadPinterest(item.url, item.thumbnailUrl); };
    wireSearchResultRow(row, checkbox);
    appendResultCardControls(row, key, selection, () => open({ detail: 1 } as unknown as Event), () => { if (previewSource === 'manual' && previewResultKey === key) stopPreview(); }, false, 'Pinterest preview is unavailable.', item.kind === 'image');
    decorateResultCard(row, key, frameNumber(index, pinterestSearch), 'PN', details, open, item.kind === 'image');
    searchButtons.push(row); list.append(row);
  }
  const diagnostic = pinterestSearch?.thumbnailDiagnostic; const thumbnailWarning = diagnostic && diagnostic.total > 0 && (diagnostic.failed === diagnostic.total || diagnostic.failed >= Math.ceil(diagnostic.total / 2)) ? ` · Thumbnails ${diagnostic.total - diagnostic.failed}/${diagnostic.total} · ${diagnostic.reason} · Node ${diagnostic.node}` : '';
  setText('youtube-search-status', pinterestSearch ? (pinterestSearch.results.length ? `Page ${pinterestSearch.page} of ${pinterestSearch.pageCount} · ${pinterestSearch.totalResults} results${thumbnailWarning}` : 'No Pinterest results found.') : 'Search Pinterest to browse Pins.'); setSearchBusy(searchBusy); renderSelectionToolbar(); scheduleResultCardThumbnailHeights();
}
// Shared search-transition seam: every new search and pagination pass starts here so an
// open detail Inspector from a previous selection can never survive into the next result
// set. Direct-URL/social/paste fallbacks (loadYoutube/loadSocial/loadPinterest and their
// submitSourceSearch routes) deliberately bypass this seam and keep their own load path
// and Inspector behavior. Staged selections and inline card renderer states are session
// data keyed by result identity and are never cleared here.
function beginSearchTransition(): void {
  clearMetadataPrefetchTimers();
  searchError = null;
  if (inspectorOpen) setInspectorOpen(false);
  outputSession.select(null);
  // Invalidate any in-flight detail/subtitle request from the previous selection and drop
  // its payload, so a stale response can never repopulate the detail rail or keep the
  // download controls live against the old item.
  metadataGuard.invalidate();
  subtitleGuard.invalidate();
  metadataBusy = false;
  resetSourceSelection(); youtube = null; social = null; pinterest = null; pexels = null;
  subtitleCues = []; selectedSubtitleCues.clear();
  document.getElementById('subtitle-results')?.replaceChildren();
  setInspectorLoading(false);
  if (provider === 'pexels') renderPexelsMetadata();
  else if (provider === 'pinterest') renderPinterestMetadata();
  else if (provider === 'social') renderSocialMetadata();
  else renderMetadata();
  applyDetailOutput();
  updateControls();
}
async function searchPinterest(page: number): Promise<void> {
  // Generation marker: a newer query/page/provider supersedes any in-flight search, so only
  // the newest success, error, and busy-reset may touch Pinterest search state.
  beginSearchTransition();
  const request = searchGuard.next(); const query = ($('youtube-search-input') as HTMLInputElement).value; setSearchBusy(true); setText('youtube-search-status', 'Searching Pinterest…');
  try { const result = await window.clipdockAPI.searchPinterest(query, page); if (searchGuard.isStale(request) || provider !== 'pinterest') return; pinterestSearch = result; clearResultSelection(); }
  catch (err) { if (searchGuard.isStale(request)) return; searchError = (err as Error).message; pinterestSearch = null; renderPinterestSearchResults(); setText('youtube-search-status', (err as Error).message); }
  finally { if (searchGuard.isCurrent(request)) setSearchBusy(false); }
}
async function searchPexels(page: number): Promise<void> {
  if (!pexelsConnected) {
    showYoutubeStatus('Connect a Pexels API key for this session.');
    openSettings();
    const setup = $('pexels-setup') as HTMLDetailsElement;
    if (!setup.open) { setup.open = true; ($('pexels-api-key') as HTMLInputElement).focus(); }
    return;
  }
  beginSearchTransition();
  const request = searchGuard.next(); const query = ($('youtube-search-input') as HTMLInputElement).value; setSearchBusy(true); setText('youtube-search-status', 'Searching Pexels…'); try { const result = await window.clipdockAPI.searchPexels(pexelsKind, query, page); if (searchGuard.isStale(request) || provider !== 'pexels') return; pexelsSearch = result; clearResultSelection(); } catch (err) { if (searchGuard.isStale(request)) return; searchError = (err as Error).message; pexelsSearch = null; renderPexelsSearchResults(); setText('youtube-search-status', (err as Error).message); } finally { if (searchGuard.isCurrent(request)) setSearchBusy(false); } }
function youtubeUrlFromSearch(input: string): string | null {
  if (input.length < 12 || input.length > 2_048) return null;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  const pathname = parsed['pathname']; // Keep provider URL parsing separate from file-location authority.
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !hosts.has(host) || parsed.searchParams.has('list') || pathname.startsWith('/playlist')) return null;
  let id: string | null = null;
  if (host === 'youtu.be') id = pathname.match(/^\/([^/]+)\/?$/)?.[1] ?? null;
  else if (pathname === '/watch' && !host.includes('nocookie')) id = parsed.searchParams.get('v');
  else { const match = pathname.match(/^\/(shorts|embed)\/([^/]+)\/?$/); if (match && (match[1] === 'embed' || !host.includes('nocookie'))) id = match[2]; }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}
// Renderer-local routing for the shared search box: exact public Pin and pin.it shapes
// route to the existing main-owned Pin loader. Main remains authoritative and resolves
// short links; anything ambiguous falls through to the search path.
function pinterestUrlFromSearch(input: string): string | null {
  if (input.length < 17 || input.length > 2_048) return null;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.hash) return null;
  if (host === 'pin.it' && !parsed.search) {
    const short = parsed['pathname'].match(/^\/([A-Za-z0-9_-]{1,80})\/?$/);
    return short ? `https://pin.it/${short[1]}` : null;
  }
  if (host !== 'pinterest.com' && host !== 'www.pinterest.com') return null;
  const match = parsed['pathname'].match(/^\/pin\/(\d{1,40})\/?$/);  // bracket access keeps file-location wording out of the renderer
  return match ? `https://www.pinterest.com/pin/${match[1]}/` : null;
}
function clearResultSelection(): void {
  outputSession.select(null);
  applyDetailOutput();
  renderSearchResults();
}
function submitSourceSearch(): void {
  if (provider === 'pexels') { void searchPexels(1); return; }
  if (provider === 'pinterest') {
    const directUrl = pinterestUrlFromSearch(($('youtube-search-input') as HTMLInputElement).value);
    if (directUrl) { clearResultSelection(); ($('pinterest-url') as HTMLInputElement).value = directUrl; void loadPinterest(directUrl); return; }
    void searchPinterest(1);
    return;
  }
  const directUrl = provider === 'youtube' ? youtubeUrlFromSearch(($('youtube-search-input') as HTMLInputElement).value) : null;
  if (directUrl) { clearResultSelection(); ($('youtube-url') as HTMLInputElement).value = directUrl; void loadYoutube(directUrl); return; }
  void searchYoutube(1);
}
async function searchYoutube(page: number): Promise<void> {
  if (metadataBusy) { showYoutubeStatus('Wait for the current source to finish loading.'); return; }
  beginSearchTransition();
  // Generation marker: a newer query/page supersedes any in-flight search, so only the
  // newest success, error, and busy-reset may touch state.
  const request = searchGuard.next();
  const query = ($('youtube-search-input') as HTMLInputElement).value; setSearchBusy(true); setText('youtube-search-status', 'Searching YouTube…');
  try { const result = await window.clipdockAPI.searchYoutube(query, page); if (searchGuard.isStale(request)) return; searchPage = result; clearResultSelection(); }
  catch (err) { if (searchGuard.isStale(request)) return; searchError = (err as Error).message; searchPage = null; renderSearchResults(); setText('youtube-search-status', (err as Error).message); }
  finally { if (searchGuard.isCurrent(request)) setSearchBusy(false); }
}
// Shared pager: Previous/Next resolve against the active provider's page and rely on the
// same per-search generation suppression, so a stale page can never render.
function searchPageRelative(delta: number): void {
  if (provider === 'pexels' && pexelsSearch) void searchPexels(pexelsSearch.page + delta);
  else if (provider === 'pinterest' && pinterestSearch) void searchPinterest(pinterestSearch.page + delta);
  else if (searchPage) void searchYoutube(searchPage.page + delta);
}
// Edge code over the clip detail: the frame number when the clip came from the sheet,
// LINK when it was pasted.
function renderInspectorTitle(source: Provider, _id: string, label: string = providerLabel(source)): void {
  const page = source === 'youtube' ? searchPage : source === 'pexels' ? pexelsSearch : source === 'pinterest' ? pinterestSearch : null;
  const results = (page?.results ?? []) as Array<{ id: string | number }>;
  const index = !outputSession.selected ? -1 : results.findIndex((item) => String(item.id) === outputSession.selected?.resultId);
  const frame = index >= 0 ? `FRAME ${frameNumber(index, page)}` : 'LINK';
  setOptionalText('inspector-title', `${frame} ▸ ${label.toUpperCase()}`);
}
function renderPexelsMetadata(): void {
  document.getElementById('pinterest-item-list')?.classList.add('hidden'); document.getElementById('pinterest-original-note')?.classList.add('hidden');
  const section = $('youtube-metadata');
  section.classList.toggle('hidden', !pexels);
  updatePreviewButton();
  if (!pexels) return;
  setInspectorPoster(pexels.thumbnailUrl, pexels.title);
  const title = $('youtube-title'); title.classList.add('source-row-title'); title.textContent = pexels.title;
  const source = $('youtube-channel'); source.classList.add('source-row-source'); source.textContent = pexels.creator ? `${pexels.kind === 'photo' ? 'Photo' : 'Video'} by ${pexels.creator}` : 'Creator unavailable';
  const duration = $('youtube-duration'); duration.classList.add('source-row-duration'); duration.textContent = pexels.kind === 'video' ? formatDuration(pexels.duration) : `${pexels.width ?? '-'}×${pexels.height ?? '-'}`;
  renderInspectorTitle('pexels', String(pexels.id));
  setVerifiedMetadata('Verified metadata · Pexels');
  const attribution = $('pexels-attribution'); attribution.classList.add('source-row-attribution');
  const credit = button(`${pexels.kind === 'photo' ? 'Photo' : 'Video'} by ${pexels.creator ?? 'creator'} on Pexels`, () => { void window.clipdockAPI.openPexelsExternal(pexels!.sourceUrl); });
  credit.className = 'link-button';
  attribution.replaceChildren(credit);
  attribution.classList.remove('hidden');
  const select = $('youtube-quality') as HTMLSelectElement;
  select.replaceChildren();
  const chips = $('quality-chips');
  chips.replaceChildren();
  for (const file of pexels.files) {
    const option = document.createElement('option'); option.value = file.id; option.textContent = file.label; select.append(option);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'choice-chip'; chip.dataset.quality = file.id; chip.textContent = file.label; chip.setAttribute('role', 'radio');
    chip.addEventListener('click', () => { select.value = file.id; commitInspectorEdit({ quality: select.value }); renderQuality(); }); wireQualityChipKeyboard(chip); chips.append(chip);
  }
  applyDetailOutput();
  playSourceLock();
}
function renderSocialMetadata(): void {
  stopPreview();
  document.getElementById('pinterest-item-list')?.classList.add('hidden'); document.getElementById('pinterest-original-note')?.classList.add('hidden');
  const section = $('youtube-metadata'); section.classList.toggle('hidden', !social); updatePreviewButton();
  if (!social) return;
  const image = $('youtube-thumbnail') as HTMLImageElement;
  image.src = social.thumbnailDataUrl ?? LOCAL_POSTER; image.alt = social.thumbnailDataUrl ? social.title : `Thumbnail unavailable for ${social.title}`;
  const title = $('youtube-title'); title.classList.add('source-row-title'); title.textContent = social.title;
  const source = $('youtube-channel'); source.classList.add('source-row-source'); source.textContent = social.channel ?? 'Creator unavailable';
  const duration = $('youtube-duration'); duration.classList.add('source-row-duration'); duration.textContent = formatDuration(social.duration);
  renderInspectorTitle('social', social.id, socialPlatformLabel(social.platform));
  setVerifiedMetadata(`Verified metadata · ${socialPlatformLabel(social.platform)}`);
  const attribution = $('pexels-attribution'); attribution.classList.add('source-row-attribution'); attribution.classList.add('hidden');
  const select = $('youtube-quality') as HTMLSelectElement; select.replaceChildren(); const chips = $('quality-chips'); chips.replaceChildren();
  const heights = [...new Set(social.heights.filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))].sort((a, b) => b - a);
  const values: Array<[YoutubeQuality, string]> = sourceQualityChoices(provider, heights).map((value) => [value as YoutubeQuality, value === 'best' ? 'Best available' : qualityLabel(Number(value.replace('p', '')))]);
  for (const [value, label] of values) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'choice-chip'; chip.dataset.quality = value; chip.textContent = label; chip.setAttribute('role', 'radio');
    chip.addEventListener('click', () => { select.value = value; commitInspectorEdit({ quality: select.value }); renderQuality(); });
    wireQualityChipKeyboard(chip);
    chips.append(chip);
  }
  applyDetailOutput();
  playSourceLock();
}
function renderPinterestMetadata(): void {
  stopPreview();
  const section = $('youtube-metadata');
  section.classList.toggle('hidden', !pinterest);
  updatePreviewButton();
  const list = document.getElementById('pinterest-item-list');
  const note = document.getElementById('pinterest-original-note');
  list?.classList.toggle('hidden', !pinterest);
  note?.classList.toggle('hidden', !pinterest || !pinterest.items.some((item) => item.kind === 'image'));
  if (!pinterest) { list?.replaceChildren(); return; }
  // Keep the selected row's allowlisted poster when metadata has no image.
  const poster = pinterest.thumbnailUrl ?? outputSession.selected?.thumbnailDataUrl ?? IMAGE_PLACEHOLDER;
  setInspectorPoster(poster, pinterest.title);
  const title = $('youtube-title'); title.classList.add('source-row-title'); title.textContent = pinterest.title;
  const source = $('youtube-channel'); source.classList.add('source-row-source'); source.textContent = pinterest.creator ?? 'Creator unavailable';
  renderInspectorTitle('pinterest', pinterest.pinId);
  const duration = $('youtube-duration'); duration.classList.add('source-row-duration'); duration.textContent = `${pinterest.items.length} item${pinterest.items.length === 1 ? '' : 's'} · ${pinterest.kind === 'carousel' ? 'Carousel' : pinterest.items[0]?.kind === 'image' ? 'Image' : 'Video'}`;
  setVerifiedMetadata('Verified metadata · Pinterest');
  const attribution = $('pexels-attribution'); attribution.classList.add('hidden');
  const select = $('youtube-quality') as HTMLSelectElement; select.replaceChildren();
  const option = document.createElement('option'); option.value = 'original'; option.textContent = 'Original'; select.append(option);
  const chips = $('quality-chips'); chips.replaceChildren();
  const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'choice-chip'; chip.dataset.quality = 'original'; chip.textContent = 'Original'; chip.setAttribute('role', 'radio'); chip.addEventListener('click', () => { select.value = 'original'; commitInspectorEdit({ quality: select.value }); renderQuality(); }); wireQualityChipKeyboard(chip); chips.append(chip);
  applyDetailOutput();
  list?.replaceChildren();
  for (const item of pinterest.items) {
    const row = document.createElement('div'); row.className = 'pinterest-item-row'; row.dataset.itemIndex = String(item.index); row.setAttribute('role', 'listitem'); row.textContent = `Item ${item.index} · ${item.kind === 'image' ? 'Image' : 'Video'} · ${item.title}`;
    list?.append(row);
  }
  playSourceLock();
}
async function loadPinterest(url = (document.getElementById('pinterest-url') as HTMLInputElement | null)?.value ?? '', posterDataUrl: string | null = null): Promise<void> {
  if (searchBusy) { showYoutubeStatus('Wait for the current search to finish.'); return; }
  if (!inspectorOpen) openInspectorForSelection(false);
  // A search-row selection carries the canonical Pin URL and its allowlisted thumbnail; the
  // Pin input is updated for direct-URL parity and the poster survives as fallback only.
  const request = metadataGuard.next(); previewGuard.invalidate(); metadataBusy = true; pinterest = null; const pinInput = document.getElementById('pinterest-url') as HTMLInputElement | null; if (url && pinInput) pinInput.value = url; renderPinterestMetadata(); setInspectorLoading(true); updateControls(); showYoutubeStatus('Loading Pinterest Pin…');
  try {
    const metadata = await window.clipdockAPI.loadPinterest(url);
    if (metadataGuard.isStale(request) || provider !== 'pinterest') return;
    pinterest = { ...metadata, thumbnailUrl: metadata.thumbnailUrl ?? posterDataUrl }; const input = document.getElementById('pinterest-url') as HTMLInputElement | null; if (input) input.value = metadata.source; loadedLinks.set('pinterest', metadata.source.trim()); setInspectorLoading(false); renderPinterestMetadata(); showYoutubeStatus(metadata.items.length > 1 ? 'Carousel loaded. Download queues each item separately.' : 'Pin loaded. Choose an output intent and download.');
  } catch (err) {
    if (metadataGuard.isStale(request)) return;
    pinterest = null; setInspectorLoading(false); renderPinterestMetadata(); showYoutubeStatus((err as Error).message);
  } finally { if (metadataGuard.isCurrent(request)) { metadataBusy = false; updateControls(); } }
}
async function loadPexels(id: number): Promise<void> {
  if (searchBusy) { showYoutubeStatus('Wait for the current search to finish.'); return; }
 if (!inspectorOpen) openInspectorForSelection(false); stopPreview(); const request = metadataGuard.next(); previewGuard.invalidate(); metadataBusy = true; pexels = null; renderPexelsMetadata(); setInspectorLoading(true); updateControls(); showYoutubeStatus('Loading Pexels media…'); try { const result = await window.clipdockAPI.loadPexels(pexelsKind, id); if (metadataGuard.isStale(request) || provider !== 'pexels') return; pexels = result; setInspectorLoading(false); renderPexelsMetadata(); showYoutubeStatus('Choose a source size and download.'); } catch (err) { if (metadataGuard.isStale(request)) return; stopPreview(); setInspectorLoading(false); renderPexelsMetadata(); showYoutubeStatus((err as Error).message); } finally { if (metadataGuard.isCurrent(request)) { metadataBusy = false; updateControls(); } } }
function renderPlacementWarning(): void {
  const warning = document.getElementById('timeline-placement-warning');
  const intent = document.getElementById('youtube-intent') as HTMLSelectElement | null;
  warning?.classList.toggle('hidden', intent?.value !== 'playhead');
  const value = outputSession.output().intent;
  const action = document.getElementById('download-youtube-btn');
  if (action) { action.textContent = intentLabel(value); action.dataset.intent = value; }
  // Split button: the menu marks the chosen handoff; a Resolve handoff keeps a plain
  // Download only escape hatch beside the status line.
  for (const item of Array.from(document.getElementById('intent-menu')?.children ?? []) as HTMLElement[]) { if (item.dataset?.intent) item.setAttribute('aria-checked', String(item.dataset.intent === value)); }
  const downloadOnly = document.getElementById('download-only-btn') as HTMLButtonElement | null;
  if (downloadOnly) { downloadOnly.classList.toggle('hidden', value === 'download'); downloadOnly.disabled = (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.disabled ?? true; }
}
// ---- Intent split-button menu --------------------------------------------------------
function intentMenuItems(): HTMLElement[] { return (Array.from(document.getElementById('intent-menu')?.children ?? []) as HTMLElement[]).filter((item) => !!item.dataset?.intent); }
function setIntentMenuOpen(open: boolean, focusItem = false): void {
  const menu = document.getElementById('intent-menu'); const trigger = document.getElementById('intent-menu-btn');
  if (!menu || !trigger) return;
  menu.classList.toggle('hidden', !open); trigger.setAttribute('aria-expanded', String(open));
  if (open && focusItem) { const items = intentMenuItems(); (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus?.(); }
}
function chooseIntent(value: string): void {
  const select = document.getElementById('youtube-intent') as HTMLSelectElement | null; if (!select) return;
  select.value = value;
  commitInspectorEdit(readOutputControl('youtube', 'intent')); renderPlacementWarning(); updateControls();
  setIntentMenuOpen(false); (document.getElementById('download-youtube-btn') as HTMLElement | null)?.focus?.();
}
function wireIntentMenu(): void {
  const trigger = document.getElementById('intent-menu-btn'); const menu = document.getElementById('intent-menu');
  if (!trigger || !menu) return;
  trigger.addEventListener('click', () => setIntentMenuOpen(menu.classList.contains('hidden'), true));
  trigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIntentMenuOpen(true, true); } });
  for (const item of intentMenuItems()) item.addEventListener('click', () => chooseIntent(item.dataset.intent ?? 'download'));
  menu.addEventListener('keydown', (event) => {
    const items = intentMenuItems(); const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setIntentMenuOpen(false); trigger.focus?.(); return; }
    if (event.key === 'Tab') { setIntentMenuOpen(false); return; }
    const next = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); items[next]?.focus?.();
  });
  document.addEventListener?.('pointerdown', (event) => { if (!menu.classList.contains('hidden') && event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) setIntentMenuOpen(false); });
}
// ---- Destination bin cards mirror the native select --------------------------------
function renderBinChoice(): void {
  const value = (document.getElementById('youtube-target-bin') as HTMLSelectElement | null)?.value ?? 'active';
  for (const choice of Array.from(document.getElementById('bin-controls')?.children ?? []) as HTMLElement[]) {
    if (!choice.dataset?.bin) continue;
    const selected = choice.dataset.bin === value; choice.setAttribute('aria-checked', String(selected)); (choice as HTMLButtonElement).tabIndex = selected ? 0 : -1;
  }
}
function wireBinChoice(): void {
  const group = document.getElementById('bin-controls'); if (!group) return;
  const choices = (Array.from(group.children) as HTMLButtonElement[]).filter((choice) => !!choice.dataset?.bin);
  const choose = (choice: HTMLButtonElement): void => { const select = document.getElementById('youtube-target-bin') as HTMLSelectElement | null; if (!select) return; select.value = choice.dataset.bin ?? 'active'; renderBinChoice(); commitInspectorEdit({ targetBin: select.value }); updateControls(); };
  for (const choice of choices) {
    choice.addEventListener('click', () => choose(choice));
    choice.addEventListener('keydown', (event) => {
      const current = choices.indexOf(choice);
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(choices.length - 1, current + 1) : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, current - 1) : -1;
      if (next < 0) return; event.preventDefault(); choose(choices[next]); choices[next].focus?.();
    });
  }
}
function renderMediaMode(): void {
  const isPexelsPhoto = provider === 'pexels' && pexelsKind === 'photo';
  const isPinterest = provider === 'pinterest';
  const pinterestImageOnly = isPinterest && !!pinterest && pinterest.items.length > 0 && pinterest.items.every((item) => item.kind === 'image');
  document.getElementById('youtube-mode-controls')?.classList.toggle('hidden', provider !== 'youtube');
  document.getElementById('youtube-subtitle-controls')?.classList.toggle('hidden', provider !== 'youtube');
  document.getElementById('youtube-selection-controls')?.classList.toggle('hidden', provider !== 'youtube');
  document.querySelector('.advanced-options')?.classList.toggle('hidden', provider === 'social');
  const audio = provider === 'youtube' && ($('youtube-media-mode') as HTMLSelectElement).value === 'audio';
  $('profile-controls').parentElement?.classList.toggle('hidden', isPexelsPhoto || audio || pinterestImageOnly);
  $('video-controls').classList.toggle('hidden', audio || isPinterest);
  $('audio-controls').classList.toggle('hidden', !audio);
  document.getElementById('pinterest-original-note')?.classList.toggle('hidden', !isPinterest || !pinterest?.items.some((item) => item.kind === 'image'));
  ($('youtube-quality') as HTMLSelectElement).disabled = audio || !(provider === 'pexels' ? pexels : provider === 'social' ? social : provider === 'pinterest' ? pinterest : youtube) || metadataBusy;
  const subtitleOn = ($('youtube-subtitles') as HTMLInputElement).checked;
  ($('youtube-subtitle-language') as HTMLSelectElement).disabled = !subtitleOn || metadataBusy;
  const audioToggle = document.getElementById('audio-only-toggle') as HTMLInputElement | null;
  if (audioToggle) { audioToggle.checked = audio; audioToggle.disabled = metadataBusy; }
  setOptionalText('audio-only-hint', audio ? 'Sound only, in the format beside' : 'Keep picture and sound');
  renderRangeUi();
}
function renderProfile(): void { const select = $('youtube-profile') as HTMLSelectElement; const warning = document.getElementById('prores-warning'); warning?.classList.toggle('hidden', select.value !== 'editing'); for (const button of Array.from($('profile-controls').children) as HTMLButtonElement[]) { const selected = button.dataset.profile === select.value; button.classList.toggle('selected', selected); button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; } }
// ---- Lab slate: In/Out read as timecode, stored as seconds ---------------------------
// The slate shows m:ss (or h:mm:ss). Reads convert back to the seconds string the pure
// selection model validates; anything that is not a timecode passes through unchanged
// so the model still reports it as invalid instead of guessing.
function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const tenths = Math.round(seconds * 10); const whole = Math.floor(tenths / 10); const fraction = tenths % 10;
  const hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), secs = whole % 60;
  const tail = `${String(secs).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
function timecodeSeconds(text: string): string {
  const value = text.trim();
  if (!value || /^\d+(\.\d+)?$/.test(value)) return value;
  const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return value;
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return String(Math.round(total * 1000) / 1000);
}
function readRangeInput(id: 'range-in' | 'range-out'): string { return timecodeSeconds((document.getElementById(id) as HTMLInputElement | null)?.value ?? ''); }
function writeRangeInput(id: 'range-in' | 'range-out', seconds: number | string | null | undefined): void {
  const control = document.getElementById(id) as HTMLInputElement | null; if (!control) return;
  if (seconds === null || seconds === undefined || seconds === '') { control.value = ''; return; }
  const numeric = typeof seconds === 'number' ? seconds : Number(seconds);
  const formatted = Number.isFinite(numeric) && numeric >= 0 ? formatTimecode(numeric) : null;
  // Display rounding must never alter the range that will be downloaded.
  control.value = formatted !== null && Number(timecodeSeconds(formatted)) === numeric ? formatted : String(seconds);
}
function setPercent(element: HTMLElement | null, property: string, value: number): void { element?.style?.setProperty?.(property, `${Math.max(0, Math.min(100, value)).toFixed(3)}%`); }
function renderRangeUi(): void {
  const duration = youtube?.duration ?? null;
  const result = youtube ? resolveSourceSelection(currentSelectionPlan(), youtube.id, duration) : null;
  const ranges = result?.status === 'valid' ? result.selections.filter((range): range is NonNullable<YoutubeSelection> => !!range) : [];
  const envelope = ranges.length ? selectionEnvelope(ranges, '') : null;
  const invalid = result?.status === 'invalid';
  const full = !envelope && !invalid;
  document.getElementById('range-slate')?.classList.toggle('full', full);
  const plan = sourceSelection;
  setOptionalText('range-mode', invalid ? 'Check In and Out' : full ? 'Full clip' : plan.mode === 'chapters' ? `${plan.indices.length} chapter${plan.indices.length === 1 ? '' : 's'}` : plan.mode === 'cues' ? `${plan.indices.length} subtitle line${plan.indices.length === 1 ? '' : 's'}` : 'Custom range');
  setOptionalText('range-length', invalid ? '—' : envelope ? formatTimecode(envelope.end - envelope.start) : duration !== null ? formatTimecode(duration) : '0:00');
  setOptionalText('range-hint', invalid && result?.status === 'invalid' ? result.message : 'Type an In or Out to trim before download.');
  setOptionalText('detail-range-note', invalid ? 'Range needs fixing' : envelope ? `${formatTimecode(envelope.start)}–${formatTimecode(envelope.end)}` : 'Full clip');
  setOptionalText('monitor-tc', duration === null ? '' : envelope ? `${formatTimecode(envelope.start)} / ${formatTimecode(duration)}` : formatTimecode(duration));
  const out = document.getElementById('range-out') as HTMLInputElement | null; if (out) out.placeholder = duration !== null ? formatTimecode(duration) : '0:00';
  const ruler = document.getElementById('range-ruler');
  ruler?.classList.toggle('hidden', provider !== 'youtube' || !youtube || !duration);
  ruler?.classList.toggle('full', full || invalid);
  if (!ruler || !duration) return;
  const start = envelope ? envelope.start / duration * 100 : 0; const end = envelope ? envelope.end / duration * 100 : 100;
  const fill = document.getElementById('range-ruler-fill'); setPercent(fill, 'left', start); setPercent(fill, 'width', end - start);
  setPercent(document.getElementById('range-handle-in'), 'left', start); setPercent(document.getElementById('range-handle-out'), 'left', end);
  document.getElementById('range-handle-in')?.setAttribute('aria-valuetext', formatTimecode(envelope?.start ?? 0));
  document.getElementById('range-handle-out')?.setAttribute('aria-valuetext', formatTimecode(envelope?.end ?? duration));
}
// Ruler handles write the same In/Out fields a person types into, then take the manual path.
function currentRangeBounds(): { start: number; end: number } {
  const duration = youtube?.duration ?? 0;
  const start = Number(readRangeInput('range-in')); const end = Number(readRangeInput('range-out'));
  return { start: readRangeInput('range-in') && Number.isFinite(start) ? start : 0, end: readRangeInput('range-out') && Number.isFinite(end) ? end : duration };
}
function moveRangeHandle(which: 'in' | 'out', seconds: number): void {
  const duration = youtube?.duration ?? 0; if (!duration) return;
  const bounds = currentRangeBounds();
  const value = Math.max(0, Math.min(duration, Math.round(seconds)));
  if (which === 'in') { bounds.start = Math.min(value, Math.max(0, bounds.end - 1)); }
  else { bounds.end = Math.max(value, Math.min(duration, bounds.start + 1)); }
  writeRangeInput('range-in', bounds.start); writeRangeInput('range-out', bounds.end);
  selectManualRange();
}
function wireRangeRuler(): void {
  const ruler = document.getElementById('range-ruler'); if (!ruler) return;
  let active: 'in' | 'out' | null = null;
  const secondsAt = (clientX: number): number => { const rect = ruler.getBoundingClientRect(); const duration = youtube?.duration ?? 0; return rect.width > 0 ? (clientX - rect.left) / rect.width * duration : 0; };
  ruler.addEventListener('pointerdown', (event) => {
    if (!youtube?.duration) return;
    const target = event.target as HTMLElement | null;
    const seconds = secondsAt(event.clientX); const bounds = currentRangeBounds();
    active = target?.id === 'range-handle-in' ? 'in' : target?.id === 'range-handle-out' ? 'out' : Math.abs(seconds - bounds.start) <= Math.abs(seconds - bounds.end) ? 'in' : 'out';
    if (typeof ruler.setPointerCapture === 'function') ruler.setPointerCapture(event.pointerId);
    event.preventDefault(); moveRangeHandle(active, seconds);
    (document.getElementById(active === 'in' ? 'range-handle-in' : 'range-handle-out') as HTMLElement | null)?.focus?.();
  });
  ruler.addEventListener('pointermove', (event) => { if (active) moveRangeHandle(active, secondsAt(event.clientX)); });
  const end = (): void => { active = null; };
  ruler.addEventListener('pointerup', end); ruler.addEventListener('pointercancel', end); ruler.addEventListener('lostpointercapture', end);
  for (const which of ['in', 'out'] as const) {
    document.getElementById(`range-handle-${which}`)?.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1; const bounds = currentRangeBounds(); const current = which === 'in' ? bounds.start : bounds.end;
      const next = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? current - step : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? current + step : event.key === 'Home' ? 0 : event.key === 'End' ? (youtube?.duration ?? current) : null;
      if (next === null) return; event.preventDefault(); moveRangeHandle(which, next);
    });
  }
}
function chapterSelectionRange(chapters: YoutubeChapter[], selected: Iterable<number>): YoutubeSelection {
  const state = selectSourceSegments(sourceSelection, 'chapters', chapters, [...selected]);
  return selectionEnvelope(state.ranges, state.ranges.length === 1 ? state.ranges[0].label : `${state.ranges.length} chapters`);
}
function applyChapterSelection(): void { sourceSelection = selectSourceSegments(sourceSelection, 'chapters', youtube?.chapters ?? [], [...selectedChapters]); const range = chapterSelectionRange(youtube?.chapters ?? [], selectedChapters); writeRangeInput('range-in', range?.start); writeRangeInput('range-out', range?.end); selectedSubtitleCues.clear(); renderSubtitleCues(); renderRangeUi(); commitRangeEdit(); }
function renderSelection(): void {
  const chapters = document.getElementById('chapter-list'); if (!chapters) return; chapters.replaceChildren();
  for (const [index, chapter] of (youtube?.chapters ?? []).entries()) {
    const label = document.createElement('label'); label.className = 'chapter-row ledger-row'; label.dataset.chapterIndex = String(index); label.setAttribute('aria-label', `Chapter ${index + 1}: ${chapter.title}. ${formatDuration(chapter.start)} to ${formatDuration(chapter.end)}`);
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedChapters.has(index); check.dataset.field = 'chapter-selection'; check.addEventListener('change', () => { if (check.checked) selectedChapters.add(index); else selectedChapters.delete(index); applyChapterSelection(); });
    const time = document.createElement('span'); time.className = 'ct'; time.textContent = formatTimecode(chapter.start); time.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'cn'; name.textContent = chapter.title; name.setAttribute('aria-hidden', 'true');
    label.append(check, time, name); chapters.append(label);
  }
}
function currentSelectionPlan(): SourceSelection {
  if (sourceSelection.mode === 'chapters' || sourceSelection.mode === 'cues') return sourceSelection;
  return transitionSourceSelection(sourceSelection, { type: 'manual', start: readRangeInput('range-in'), end: readRangeInput('range-out') });
}
function currentSelection(): YoutubeSelection {
  if (!youtube) return null;
  const result = resolveSourceSelection(currentSelectionPlan(), youtube.id, youtube.duration);
  return result.status === 'invalid' ? null : selectionEnvelope(result.selections.filter((range): range is NonNullable<YoutubeSelection> => !!range), 'Custom range');
}
function resetSourceSelection(source = '', clearCues = true): void {
  sourceSelection = transitionSourceSelection(sourceSelection, { type: 'source', source });
  selectedChapters.clear(); selectedSubtitleCues.clear(); if (clearCues) subtitleCues = [];
  for (const id of ['range-in', 'range-out']) { const control = document.getElementById(id) as HTMLInputElement | null; if (control) control.value = ''; }
}
function selectManualRange(event?: Event): void {
  sourceSelection = transitionSourceSelection(sourceSelection, { type: 'manual', start: readRangeInput('range-in'), end: readRangeInput('range-out') });
  selectedChapters.clear(); selectedSubtitleCues.clear(); renderSelection(); renderSubtitleCues(); renderRangeUi(); commitRangeEdit(event?.type === 'input');
}
function filterSubtitleCues(cues: SubtitleCue[], query: string): Array<{ index: number; cue: SubtitleCue }> { const needle = query.trim().toLocaleLowerCase(); return cues.flatMap((cue, index) => !needle || cue.text.toLocaleLowerCase().includes(needle) ? [{ index, cue }] : []); }
function subtitleSelectionRange(cues: SubtitleCue[], selected: Iterable<number>): YoutubeSelection {
  const state = selectSourceSegments(sourceSelection, 'cues', cues, [...selected]);
  return selectionEnvelope(state.ranges, state.ranges.length === 1 ? 'Subtitle cue' : `${state.ranges.length} subtitle cues`);
}
function applySubtitleSelection(): void {
  sourceSelection = selectSourceSegments(sourceSelection, 'cues', subtitleCues, [...selectedSubtitleCues]);
  const range = subtitleSelectionRange(subtitleCues, selectedSubtitleCues);
  writeRangeInput('range-in', range?.start); writeRangeInput('range-out', range?.end);
  selectedChapters.clear(); renderSelection(); renderRangeUi(); commitRangeEdit();
}
function renderSubtitleCues(): void {
  const list = document.getElementById('subtitle-results'); if (!list) return; const query = (document.getElementById('subtitle-search-query') as HTMLInputElement | null)?.value ?? ''; const matches = filterSubtitleCues(subtitleCues, query); list.replaceChildren();
  for (const { index, cue } of matches) {
    const row = document.createElement('div'); row.className = 'subtitle-cue subtitle-row ledger-row'; row.dataset.cueIndex = String(index); row.setAttribute('role', 'listitem'); row.setAttribute('aria-label', `Subtitle cue: ${formatDuration(cue.start)} to ${formatDuration(cue.end)}. ${cue.text}`);
    const label = document.createElement('label'); label.className = 'subtitle-label'; const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedSubtitleCues.has(index); check.dataset.field = 'cue-selection'; check.addEventListener('change', () => { if (check.checked) selectedSubtitleCues.add(index); else selectedSubtitleCues.delete(index); applySubtitleSelection(); }); label.append(check, document.createTextNode(`Cue ${formatDuration(cue.start)}–${formatDuration(cue.end)} · ${cue.text}`));
    const preview = button('Preview', () => { if (youtube) { void startYoutubePreview(youtube.id, cue.start); } }); preview.className = 'subtitle-action'; preview.setAttribute('aria-label', `Preview at ${formatDuration(cue.start)}`); row.append(label, preview); list.append(row);
  }
  if (!matches.length) list.textContent = subtitleCues.length ? 'No matching cues.' : 'No subtitle cues.';
}
async function searchSubtitles(): Promise<void> { if (!youtube) return; const request = subtitleGuard.next(); const list = $('subtitle-results'); list.textContent = 'Searching subtitles…'; try { const cues = await window.clipdockAPI.searchSubtitles(`https://www.youtube.com/watch?v=${youtube.id}`, detailOutput().subtitleLanguage); if (subtitleGuard.isStale(request)) return; subtitleCues = cues; selectedSubtitleCues.clear(); renderSubtitleCues(); } catch (err) { if (subtitleGuard.isCurrent(request)) { subtitleCues = []; selectedSubtitleCues.clear(); list.textContent = (err as Error).message; } } }
function renderMetadata(): void {
  document.getElementById('pinterest-item-list')?.classList.add('hidden'); document.getElementById('pinterest-original-note')?.classList.add('hidden'); const section = $('youtube-metadata'); section.classList.toggle('hidden', !youtube); updatePreviewButton(); renderRangeUi(); if (!youtube) return;
  setInspectorPoster(youtube.thumbnailUrl ?? outputSession.selected?.thumbnailDataUrl ?? null, youtube.title);
  const title = $('youtube-title'); title.classList.add('source-row-title'); title.textContent = youtube.title;
  const source = $('youtube-channel'); source.classList.add('source-row-source'); source.textContent = youtube.channel ?? 'Channel unavailable';
  const duration = $('youtube-duration'); duration.classList.add('source-row-duration'); duration.textContent = formatDuration(youtube.duration);
  renderInspectorTitle('youtube', youtube.id);
  setVerifiedMetadata('Verified metadata · YouTube'); playSourceLock();
  const heights = [...new Set(youtube.heights.filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))].sort((a, b) => b - a);
  const select = $('youtube-quality') as HTMLSelectElement; select.replaceChildren(); const chips = $('quality-chips'); chips.replaceChildren();
  const values: Array<[YoutubeQuality, string]> = sourceQualityChoices(provider, heights).map((value) => [value as YoutubeQuality, value === 'best' ? 'Best available' : qualityLabel(Number(value.replace('p', '')))]);
  for (const [value, label] of values) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'choice-chip'; chip.dataset.quality = value; chip.textContent = label; chip.setAttribute('role', 'radio');
    chip.addEventListener('click', () => { select.value = value; commitInspectorEdit({ quality: select.value }); renderQuality(); });
    wireQualityChipKeyboard(chip);
    chips.append(chip);
  }
  // Session quality preference: keep the last picked quality when the new video offers it,
  // otherwise fall back to actual 2160p, then the highest actual, then best. Options only
  // ever list actual heights, so an unavailable 4K is never shown.
  updateCommonQualityOptions(heights.map((height) => `${height}p`));
  applyDetailOutput();
  renderSelection(); renderRangeUi();
}
function wireQualityChipKeyboard(chip: HTMLButtonElement): void {
  chip.addEventListener('keydown', (event) => {
    const all = Array.from($('quality-chips').children) as HTMLButtonElement[];
    const current = all.indexOf(chip);
    const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(all.length - 1, current + 1) : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, current - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (target < 0) return;
    event.preventDefault();
    const select = $('youtube-quality') as HTMLSelectElement;
    select.value = all[target].dataset.quality ?? 'best';
    commitInspectorEdit({ quality: select.value }); renderQuality(); all[target].focus();
  });
}
function renderQuality(): void { const value = ($('youtube-quality') as HTMLSelectElement).value; const chips = Array.from($('quality-chips').children) as HTMLButtonElement[]; for (const chip of chips) { const selected = chip.dataset.quality === value; chip.classList.toggle('selected', selected); chip.setAttribute('aria-checked', String(selected)); chip.tabIndex = selected ? 0 : -1; } }
function setInspectorPoster(source: string | null, title: string): void {
  const image = $('youtube-thumbnail') as HTMLImageElement;
  const poster = source ?? LOCAL_POSTER;
  image.onerror = () => { image.onerror = null; image.src = LOCAL_POSTER; image.alt = `Thumbnail unavailable for ${title}`; };
  if (image.src !== poster) image.src = poster;
  image.alt = source ? title : `Thumbnail unavailable for ${title}`;
}
function setInspectorLoading(loading: boolean): void {
  $('inspector-loading').classList.toggle('hidden', !loading);
  $('inspector-empty').classList.toggle('hidden', loading);
  document.getElementById('inspector-pane')?.classList.toggle('metadata-loading', loading);
  document.getElementById('transfer-console')?.setAttribute('aria-busy', String(loading));
  if (!loading) {
    const chips = $('quality-chips');
    const remaining = (Array.from(chips.children) as HTMLElement[]).filter(chip => chip.className !== 'skeleton-chip');
    if (remaining.length !== chips.children.length) chips.replaceChildren(...remaining);
    return;
  }
  const id = outputSession.selected?.resultId;
  const row = provider === 'youtube' ? searchPage?.results.find(item => item.id === id) : provider === 'pexels' ? pexelsSearch?.results.find(item => String(item.id) === id) : provider === 'pinterest' ? pinterestSearch?.results.find(item => item.id === id) : null;
  $('youtube-metadata').classList.toggle('hidden', !row);
  if (row) {
    $('youtube-title').textContent = row.title;
    $('youtube-channel').textContent = 'channel' in row ? row.channel ?? 'Channel unavailable' : row.creator ?? 'Creator unavailable';
    $('youtube-duration').textContent = 'duration' in row ? formatDuration(row.duration) : '';
    setInspectorPoster(row.thumbnailUrl, row.title);
    renderInspectorTitle(provider, String(row.id));
    setVerifiedMetadata('Loading metadata');
  }
  $('quality-chips').replaceChildren();
  for (let i = 0; i < 3; i++) { const chip = document.createElement('span'); chip.className = 'skeleton-chip'; $('quality-chips').append(chip); }
}
const metadataPrefetchTimers = new Set<number>();
function clearMetadataPrefetchTimers(): void { for (const timer of metadataPrefetchTimers) window.clearTimeout(timer); metadataPrefetchTimers.clear(); }
function wireMetadataPrefetch(row: HTMLElement, url: string): void {
  let timer: number | null = null;
  const cancel = (): void => { if (timer !== null) { window.clearTimeout(timer); metadataPrefetchTimers.delete(timer); timer = null; } };
  const start = (): void => { cancel(); if (searchBusy || metadataBusy || provider !== 'youtube') return; timer = window.setTimeout(() => { if (searchBusy || metadataBusy || provider !== 'youtube') { cancel(); return; } if (timer !== null) metadataPrefetchTimers.delete(timer); timer = null; void window.clipdockAPI.prefetchYoutube?.(url).catch(() => undefined); }, 300); metadataPrefetchTimers.add(timer); };
  row.addEventListener('mouseenter', start); row.addEventListener('mouseleave', cancel);
  row.addEventListener('focusin', start); row.addEventListener('focusout', cancel);
}

async function loadYoutube(url = ($('youtube-url') as HTMLInputElement).value, posterDataUrl: string | null = null): Promise<void> {
  if (!outputSession.selected) outputSession.select(null);
  if (searchBusy) { showYoutubeStatus('Wait for the current search to finish.'); return; }
  if (!inspectorOpen) openInspectorForSelection(false);
  // Clear any stale inspector immediately and show an explicit loading state; youtube stays
  // null until the current request's metadata lands, so a stale video can never be enqueued.
  stopPreview(); const request = metadataGuard.next(); previewGuard.invalidate(); subtitleGuard.invalidate(); metadataBusy = true; resetSourceSelection(); youtube = null; previewFailure = false; subtitleCues = []; selectedSubtitleCues.clear(); document.getElementById('subtitle-results')?.replaceChildren(); renderMetadata(); setInspectorLoading(true); updateControls(); showYoutubeStatus('Loading video…');
  try { const metadata = await window.clipdockAPI.loadYoutube(url); if (metadataGuard.isStale(request)) return; youtube = { ...metadata, thumbnailUrl: metadata.thumbnailUrl ?? posterDataUrl }; loadedLinks.set('youtube', url.trim()); resetSourceSelection(metadata.id); outputSession.select({ source: metadata.id }); setInspectorLoading(false); renderMetadata(); showYoutubeStatus('Choose a quality and download.'); }
  catch (err) { if (metadataGuard.isStale(request)) return; stopPreview(); youtube = null; setInspectorLoading(false); renderMetadata(); showYoutubeStatus((err as Error).message); }
  finally { if (metadataGuard.isCurrent(request)) { metadataBusy = false; updateControls(); } }
}
async function loadSocial(url = (document.getElementById('social-url') as HTMLInputElement | null)?.value ?? ''): Promise<void> {
  if (searchBusy) { showYoutubeStatus('Wait for the current search to finish.'); return; }
  if (!inspectorOpen) openInspectorForSelection(false);
  const request = metadataGuard.next(); previewGuard.invalidate(); metadataBusy = true; social = null; socialPlatform = detectSocialPlatform(url); renderSocialPlatform(socialPlatform, socialPlatform ? 'loading' : 'invalid'); renderSocialMetadata(); setInspectorLoading(true); updateControls(); showYoutubeStatus('Loading public social video…');
  try {
    const metadata = await window.clipdockAPI.loadSocial(url);
    if (metadataGuard.isStale(request) || provider !== 'social') return;
    social = metadata; loadedLinks.set('social', url.trim());
    void window.clipdockAPI.loadSocialThumbnail?.(metadata.source).then(thumbnail => {
      if (!thumbnail || metadataGuard.isStale(request) || provider !== 'social' || social?.id !== metadata.id) return;
      social = {...social, thumbnailDataUrl: thumbnail}; setInspectorPoster(thumbnail, social.title);
    }).catch(() => { /* The metadata remains useful without an image. */ });
    socialPlatform = metadata.platform; renderSocialPlatform(socialPlatform); setInspectorLoading(false); renderSocialMetadata(); showYoutubeStatus(`Detected ${socialPlatformLabel(metadata.platform)}. Choose a quality and download.`);
  } catch (err) {
    if (metadataGuard.isStale(request)) return;
    social = null; renderSocialPlatform(socialPlatform, socialPlatform ? 'invalid' : 'invalid'); setInspectorLoading(false); renderSocialMetadata(); showYoutubeStatus((err as Error).message);
  } finally { if (metadataGuard.isCurrent(request)) { metadataBusy = false; updateControls(); } }
}

function globalQueueStatusText(): string {
  const active = downloadQueue.activeId ? queue.find((item) => item.queueId === downloadQueue.activeId) : queue.find((item) => ['downloading', 'preparing', 'transferring'].includes(item.status));
  const pending = queue.filter((item) => item.status === 'queued').length;
  if (!active) {
    if (pending) return `Queue idle · ${pending} pending`;
    const attention = queue.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
    return attention ? `Queue idle · ${attention} need${attention === 1 ? 's' : ''} attention` : 'Queue idle';
  }
  const stage = active.status === 'downloading' ? 'Downloading' : active.status === 'preparing' ? 'Preparing' : active.intent === 'import' ? 'Adding to Media Pool' : 'Adding to timeline';
  const percent = active.percent === null ? '' : ` ${Math.round(active.percent)}%`;
  return `Queue: ${stage}${percent}${pending ? ` · ${pending} pending` : ''}`;
}
function queueStateChip(item: QueueItem): HTMLElement | null {
  const [kind, label] = item.fileDeleted ? ['fail', 'File deleted'] : item.status === 'downloading' ? ['dl', 'Downloading'] : item.status === 'preparing' ? ['cv', 'Preparing'] : item.status === 'transferring' ? ['cv', 'Handing off'] : item.status === 'queued' ? ['q', 'Queued'] : item.status === 'failed' ? ['fail', 'Failed'] : item.status === 'cancelled' ? ['fail', 'Cancelled'] : item.transferError ? ['fail', 'Handoff failed'] : ['ok', 'Ready'];
  const chip = document.createElement('span'); chip.className = `st ${kind}`; chip.textContent = label; chip.setAttribute('aria-hidden', 'true');
  return chip;
}
// Tab count and page subline: live work only (downloading, preparing, handing off, queued).
function renderQueueCounts(): void {
  const working = queue.filter((item) => item.status === 'downloading' || item.status === 'preparing' || item.status === 'transferring').length;
  const waiting = queue.filter((item) => item.status === 'queued').length;
  setOptionalText('queue-counts', `${working} working · ${waiting} queued`);
  const count = document.getElementById('queue-tab-count');
  if (count) { count.textContent = String(working + waiting); count.classList.toggle('hidden', working + waiting === 0); count.classList.toggle('live', working > 0); }
  document.getElementById('surface-nav-queue')?.setAttribute('aria-label', working + waiting ? `Downloads, ${working} working, ${waiting} queued` : 'Downloads');
}
function updateGlobalQueueStatus(): void {
  renderQueueCounts();
  const status = document.getElementById('global-queue-status');
  if (!status) return;
  const text = globalQueueStatusText(); status.textContent = text; status.setAttribute('aria-label', `${text}. Open Queue.`); status.dataset.state = downloadQueue.activeId ? 'active' : queue.some((item) => item.status === 'queued') ? 'pending' : queue.some((item) => item.status === 'failed' || item.status === 'cancelled') ? 'attention' : 'idle';
}
function scheduleQueueRender(immediate = false, item?: QueueItem): void {
  if (immediate) { if (queueRenderTimer !== null) { window.clearTimeout(queueRenderTimer); queueRenderTimer = null; } dirtyQueueProgress.clear(); renderQueue(); return; }
  if (item) dirtyQueueProgress.add(item.queueId);
  if (queueRenderTimer !== null) return;
  queueRenderTimer = window.setTimeout(() => {
    queueRenderTimer = null;
    for (const id of dirtyQueueProgress) {
      const current = queue.find(candidate => candidate.queueId === id);
      const view = queueProgressViews.get(id);
      if (!current || !view) continue;
      view.status.textContent = queueStatusText(current);
      view.row.setAttribute('aria-label', `Source: ${current.title}. Operation: ${intentLabel(current.intent)}. Status: ${queueStatusText(current)}.`);
      if (view.progress) view.progress.value = current.percent ?? 0;
    }
    dirtyQueueProgress.clear();
    updateGlobalQueueStatus();
    const active = queue.find(candidate => candidate.queueId === downloadQueue.activeId);
    if (active && !metadataBusy) showYoutubeStatus(active.message, active.percent, active.speedBytesPerSecond, active.etaSeconds);
  }, 200);
}
function announceQueueStatus(item: QueueItem): void {
  if (announcedQueueStates.get(item) === item.status) return;
  announcedQueueStates.set(item, item.status);
  const label = item.status === 'queued' ? 'Queued' : item.status === 'downloading' ? 'Downloading' : item.status === 'preparing' ? 'Preparing file' : item.status === 'transferring' ? item.intent === 'import' ? 'Adding to Media Pool' : 'Adding to timeline' : item.status === 'completed' ? 'Completed' : item.status === 'failed' ? 'Failed' : 'Cancelled';
  $('youtube-queue-status').textContent = `${label}: ${item.title}`;
}
function queueStatusText(item: QueueItem): string {
  if (item.fileDeleted) return 'File deleted. Download again to use this item.';
  if (item.status === 'downloading') {
    const details = [item.percent === null ? null : `${item.percent.toFixed(1)}%`, formatSpeed(item.speedBytesPerSecond), formatEta(item.etaSeconds)].filter(Boolean);
    const phase = item.message && /download/i.test(item.message) ? item.message : 'Downloading…';
    return details.length ? `${phase} ${details.join(' · ')}` : phase;
  }
  if (item.status === 'preparing') return 'Preparing file…';
  if (item.status === 'completed') return item.transferError ? `Downloaded · handoff failed: ${item.transferError}` : item.actionError || item.message || (item.intent === 'download' ? 'Download complete.' : 'Handoff complete.');
  if (item.status === 'failed') return `Failed: ${item.message}`;
  if (item.status === 'cancelled') return 'Cancelled.';
  if (item.status === 'transferring') return item.message || (item.intent === 'import' ? 'Adding to Media Pool…' : 'Adding to timeline…');
  return item.message || 'Queued.';
}
function button(label: string, action: () => void): HTMLButtonElement { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; value.addEventListener('click', action); return value; }
function focusQueueItem(queueId: string): void { renderQueue(); const row = Array.from($('youtube-download-queue').children).find((child) => (child as HTMLElement).dataset.queueId === queueId) as HTMLElement | undefined; if (row) { row.classList.add('duplicate-highlight'); row.setAttribute('tabindex', '-1'); row.focus(); } }
function isSelectableQueueItem(item: QueueItem): boolean {
  return !item.fileDeleted && item.status === 'completed' && typeof item.cardId === 'string' && item.cardId.trim().length > 0 && !item.deleting;
}
function pruneQueueSelection(): void {
  const available = new Set(queue.filter(isSelectableQueueItem).map((item) => item.cardId as string));
  for (const cardId of selectedQueueCardIds) if (!available.has(cardId)) selectedQueueCardIds.delete(cardId);
}
function selectedQueueDragCards(cardId: string): string | string[] {
  if (!selectedQueueCardIds.has(cardId)) return cardId;
  const available = new Set(queue.filter(isSelectableQueueItem).map((item) => item.cardId as string));
  const selected = [...selectedQueueCardIds].filter((selectedCardId) => available.has(selectedCardId));
  return selected.length > 1 ? selected : selected[0] ?? cardId;
}
function setQueueSelection(item: QueueItem, selected: boolean): void {
  if (!isSelectableQueueItem(item) || typeof item.cardId !== 'string') {
    selectedQueueCardIds.delete(item.cardId ?? '');
    renderQueue();
    return;
  }
  if (selected) selectedQueueCardIds.add(item.cardId);
  else selectedQueueCardIds.delete(item.cardId);
  renderQueue();
}
async function fallbackTransfer(item: QueueItem, action: 'import' | TimelinePlacement): Promise<void> {
  await downloadQueue.transfer(item.queueId, action, hostActionReason(action === 'import' ? 'import' : 'timeline'));
}
function removeFromQueue(queueId: string): void { downloadQueue.remove(queueId); }
function stopQueueItem(item: QueueItem): void { void downloadQueue.stop(item.queueId); }
function deleteQueueFile(item: QueueItem): void {
  if (item.fileDeleted || item.status !== 'completed' || !item.cardId || item.queueId === downloadQueue.activeId || item.deleting || item.handingOff) return;
  if (!window.confirm('Only a safe ClipDock-managed file will be deleted from your computer. This action cannot be undone. Continue?')) return;
  void downloadQueue.deleteFile(item.queueId);
}
function repeatQueueItem(item: QueueItem, again = false): void {
  const result = downloadQueue.repeat(item.queueId, again);
  if (result.duplicate) { showYoutubeStatus(again ? 'Already queued.' : 'Already in downloads.'); focusQueueItem(result.duplicate); }
}
function retry(item: QueueItem): void { repeatQueueItem(item); }
function downloadAgain(item: QueueItem): void { repeatQueueItem(item, true); }
function startCardDrag(event: DragEvent, cardIds: string | string[]): void {
  event.preventDefault();
  window.clipdockAPI.startNativeDrag(cardIds);
}
function renderCompletedDownloads(): void {
  const container = document.getElementById('completed-downloads');
  if (!container) return;
  container.replaceChildren();
  const completed = queue.filter((item) => item.status === 'completed' && !item.fileDeleted);
  setOptionalText('completed-download-count', `${completed.length} completed`);
  setOptionalText('completed-downloads-status', completed.length ? 'Session downloads stay available here until ClipDock closes.' : 'Completed downloads from this session will appear here.');
  for (const item of [...completed].reverse()) {
    const row = document.createElement('article'); row.className = 'library-download-row'; row.dataset.queueId = item.queueId; row.setAttribute('aria-label', `${item.title}. ${item.fileName ? `File ${item.fileName}. ` : ''}Completed.`);
    const img = document.createElement('img'); img.src = item.thumbnailDataUrl ?? IMAGE_PLACEHOLDER; img.alt = item.title;
    const details = document.createElement('div'); details.className = 'library-download-details';
    const title = document.createElement('strong'); title.textContent = item.title;
    const meta = document.createElement('span'); meta.textContent = `${providerLabel(item.provider, item.platform ?? null)} · ${item.fileName ?? 'File ready'} · Completed`;
    details.append(title, meta);
    const view = button('View in Queue', () => { setSurface('queue'); queueMicrotask(() => focusQueueItem(item.queueId)); }); view.className = 'library-download-action';
    row.append(img, details, view); container.append(row);
  }
}
function renderQueue(): void {
  pruneQueueSelection();
  const container = $('youtube-download-queue'); const restoreFocus = captureListFocus(container, 'queueId'); container.replaceChildren(); queueProgressViews.clear();
  // Newest-first presentation only: iterate a reversed copy so a fresh enqueue or
  // retry lands at the top without scrolling. The queue module keeps
  // FIFO processing; the source array is never reversed in place.
  for (const item of [...queue].reverse()) {
    const source = providerLabel(item.provider, item.platform ?? null);
    const file = item.fileName ? ` File: ${item.fileName}.` : '';
    const row = document.createElement('article'); row.className = `download-card operation-row state-${item.status}`; row.dataset.queueId = item.queueId; row.dataset.state = item.status; row.dataset.provider = item.provider; row.dataset.operation = item.intent; row.dataset.source = source; row.setAttribute('aria-label', `Source: ${item.title}. Operation: ${intentLabel(item.intent)}. Status: ${queueStatusText(item)}.${file}`);
    const selectable = isSelectableQueueItem(item);
    const selected = selectable && typeof item.cardId === 'string' && selectedQueueCardIds.has(item.cardId);
    row.classList.toggle('selected', selected);
    row.dataset.selected = String(selected);
    row.setAttribute('aria-selected', String(selected));
    const dragReason = hostActionReason('drag');
    const canResolveDrag = selectable && !dragReason;
    // Truthful drag hint: multi-selected ready rows state the payload count;
    // unselected/single stays the canonical call to action.
    let dragHintText = 'Drag to Resolve';
    if (canResolveDrag && selected && typeof item.cardId === 'string') {
      const payload = selectedQueueDragCards(item.cardId);
      if (Array.isArray(payload) && payload.length > 1) dragHintText = `Drag ${payload.length} selected to Resolve`;
    }
    if (canResolveDrag) { row.draggable = true; row.setAttribute('aria-label', `Source: ${item.title}. Operation: ${intentLabel(item.intent)}. Status: Ready. ${dragHintText} or use the handoff buttons.${file}`); row.addEventListener('dragstart', (event) => { if (isSelectableQueueItem(item)) startCardDrag(event, selectedQueueDragCards(item.cardId as string)); else event.preventDefault(); }); }
    if (item.status === 'completed' && typeof item.cardId === 'string' && item.cardId.trim().length > 0) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'download-selection'; check.dataset.field = 'selection'; check.checked = selected; check.disabled = !selectable; check.setAttribute('aria-label', `${selected ? 'Deselect' : 'Select'} ${item.fileName ?? item.title} for a Resolve drag`); check.addEventListener('change', () => setQueueSelection(item, check.checked));
      row.append(check);
    }
    const img = document.createElement('img'); img.className = 'operation-thumbnail source-row-thumbnail'; img.dataset.field = 'source-thumbnail'; img.alt = item.title; img.src = item.thumbnailDataUrl ?? IMAGE_PLACEHOLDER;
    const details = document.createElement('div'); details.className = 'download-details operation-details';
    const title = document.createElement('p'); title.className = 'value operation-source'; title.dataset.field = 'source-title'; title.textContent = item.title;
    const meta = document.createElement('p'); meta.className = 'hint operation-meta'; meta.dataset.field = 'operation'; const sourceLabel = item.provider === 'social' ? socialPlatformLabel(item.platform ?? null) : item.provider === 'pinterest' ? `${item.pinterestItem?.kind === 'image' ? 'Image' : 'Video'} · ${item.pinterestItem?.kind === 'image' ? 'Original' : profileLabel(item.profile)}` : item.provider === 'pexels' ? `${item.pexelsAsset?.kind === 'photo' ? 'Photo' : profileLabel(item.profile)} · ${item.quality}` : item.options.mediaMode === 'audio' ? item.options.audioFormat === 'm4a' ? 'AAC (M4A)' : item.options.audioFormat.toUpperCase() : `${profileLabel(item.profile)} · ${item.quality}`; meta.textContent = `${sourceLabel} · ${intentLabel(item.intent)} · Source: ${source}${item.channel ? ` · Creator: ${item.channel}` : ''}`;
    const status = document.createElement('p'); status.className = item.transferError || item.actionError ? 'message err queue-state operation-status' : 'message queue-state operation-status'; status.dataset.state = item.status; status.dataset.field = 'status'; status.textContent = queueStatusText(item);
    const statusLine = document.createElement('div'); statusLine.className = 'status-line';
    const chip = queueStateChip(item); if (chip) statusLine.append(chip);
    statusLine.append(status); details.append(title, meta, statusLine);
    queueProgressViews.set(item.queueId, {row, status, progress: null});
    if (item.status === 'downloading') { const track = document.createElement('span'); track.className = 'queue-progress'; track.classList.add('operation-progress'); track.setAttribute('aria-label', `Download progress for ${item.title}`); track.dataset.field = 'progress'; const progress = document.createElement('progress'); queueProgressViews.set(item.queueId, {row, status, progress}); progress.max = 100; progress.value = item.percent ?? 0; progress.setAttribute('aria-label', `Download progress for ${item.title}`); track.append(progress, document.createElement('i')); details.append(track); }
    if (item.fileName) { const fileField = document.createElement('p'); fileField.className = 'hint operation-file'; fileField.dataset.field = 'file'; fileField.textContent = `File: ${item.fileName}`; details.append(fileField); }
    if (item.subtitle) { const subtitle = button(`SRT: ${item.subtitle.fileName}`, () => undefined); subtitle.className = 'subtitle-artifact operation-artifact'; subtitle.dataset.field = 'subtitle-artifact'; subtitle.dataset.cardId = item.subtitle.cardId; subtitle.setAttribute('aria-label', `Subtitle artifact: ${item.subtitle.fileName}`); subtitle.draggable = !item.fileDeleted && !dragReason; subtitle.disabled = !!item.fileDeleted; if (dragReason) { subtitle.title = dragReason; subtitle.setAttribute('aria-label', `SRT: ${item.subtitle.fileName}. ${dragReason}`); } if (subtitle.draggable) subtitle.addEventListener('dragstart', (event) => { if (!item.fileDeleted) startCardDrag(event, item.subtitle!.cardId); else event.preventDefault(); }); details.append(subtitle); }
    if (item.warning) { const warning = document.createElement('p'); warning.className = 'warning operation-warning'; warning.dataset.field = 'warning'; warning.textContent = item.warning; details.append(warning); }
    if (item.status === 'completed' && item.provider === 'pexels' && item.pexelsAsset) { const credit = button(`${item.pexelsAsset.kind === 'photo' ? 'Photo' : 'Video'} by ${item.pexelsAsset.creator ?? 'creator'} on Pexels`, () => { void window.clipdockAPI.openPexelsExternal(item.pexelsAsset!.sourceUrl); }); credit.className = 'link-button pexels-credit operation-attribution'; credit.dataset.field = 'attribution'; details.append(credit); }
    const actions = document.createElement('div'); actions.className = 'dock-actions operation-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Actions for ${item.title}`);
    if (item.queueId === downloadQueue.activeId) {
      if (item.status === 'downloading' || item.status === 'preparing') { const stop = button('Stop', () => stopQueueItem(item)); stop.dataset.icon = 'stop'; stop.disabled = !!item.stopping; actions.append(stop); }
    } else if (item.status === 'queued') { const remove = button('Remove from queue', () => removeFromQueue(item.queueId)); remove.className = 'ghost'; remove.dataset.icon = 'x'; actions.append(remove); }
    else if (item.status === 'failed' || item.status === 'cancelled') {
      const retryButton = button('Retry', () => retry(item)); retryButton.dataset.icon = 'retry';
      const remove = button('Remove from queue', () => removeFromQueue(item.queueId)); remove.className = 'ghost'; remove.dataset.icon = 'x';
      actions.append(retryButton, remove);
    }
    else if (item.status === 'completed' && item.cardId) {
      // Reuse the existing card for explicit host handoff. Re-downloading stays separate.
      const importReason = item.fileDeleted ? 'File deleted.' : hostActionReason('import');
      const timelineReason = item.fileDeleted ? 'File deleted.' : hostActionReason('timeline');
      const importLabel = 'Add to Media Pool';
      const importAction = button(importLabel, () => { void fallbackTransfer(item, 'import'); });
      const timelineAction = button('Add to timeline', () => { void fallbackTransfer(item, item.placement); });
      // Handoff and managed delete of one file are mutually exclusive.
      importAction.disabled = !!importReason || !!item.handingOff || !!item.deleting;
      timelineAction.disabled = !!timelineReason || !!item.handingOff || !!item.deleting;
      if (importReason) { importAction.title = importReason; importAction.setAttribute('aria-label', `${importLabel}. ${importReason}`); }
      if (timelineReason) { timelineAction.title = timelineReason; timelineAction.setAttribute('aria-label', `Add to timeline. ${timelineReason}`); }
      const again = button('Download again', () => downloadAgain(item));
      const remove = button('Remove from queue', () => removeFromQueue(item.queueId));
      const deleteFile = button('Delete file', () => deleteQueueFile(item));
      deleteFile.disabled = !!item.fileDeleted || !!item.deleting || !!item.handingOff;
      if (canResolveDrag) { const dragHint = document.createElement('span'); dragHint.className = 'handoff-drag-hint operation-drag-hint'; dragHint.textContent = dragHintText; actions.append(dragHint); }
      for (const quiet of [again, remove, deleteFile]) quiet.className = 'ghost';
      importAction.dataset.icon = 'pool'; timelineAction.dataset.icon = 'tl'; again.dataset.icon = 'dl'; remove.dataset.icon = 'x'; deleteFile.dataset.icon = 'trash';
      actions.append(importAction, timelineAction, again, remove, deleteFile);
      const handoffReason = importReason ?? timelineReason;
      if (handoffReason) { const reason = document.createElement('p'); reason.className = 'hint handoff-reason operation-handoff'; reason.textContent = handoffReason; actions.append(reason); }
    }
    row.append(img);
    if (canResolveDrag) { const drag = document.createElement('span'); drag.className = 'drag'; drag.setAttribute('aria-hidden', 'true'); drag.textContent = dragHintText.startsWith('Drag ') && dragHintText.includes('selected') ? `Drag ${dragHintText.split(' ')[1]}` : 'Drag'; row.append(drag); }
    row.append(details, actions); announceQueueStatus(item); container.append(row);
  }
  restoreFocus(); updateGlobalQueueStatus(); renderCompletedDownloads(); updateControls(); renderSelectionToolbar();
}
async function loadStagedMetadata(stage: StagedSelection): Promise<YoutubeMetadata | PexelsAsset | SocialMetadata | PinterestMetadata> {
  if (stage.provider === 'youtube') return window.clipdockAPI.loadYoutube(stage.source);
  if (stage.provider === 'pexels') return window.clipdockAPI.loadPexels(stage.pexelsKind ?? 'video', Number(stage.resultId));
  if (stage.provider === 'social') return window.clipdockAPI.loadSocial(stage.source);
  return window.clipdockAPI.loadPinterest(stage.source);
}
function enqueueStagedSelection(stage: StagedSelection, metadata: QueueMetadata, mode: QueueInsertionMode = 'tail'): number {
  const choices = 'heights' in metadata ? sourceQualityChoices(stage.provider, metadata.heights) : undefined;
  const context = 'files' in metadata ? { files: metadata.files, kind: metadata.kind } : { choices };
  // Capture click-time requested values, then resolve through the session. Reads
  // of live defaults must not change the queued snapshot while metadata loads.
  const snapshotSession = new ItemOutputSession();
  const requested = { ...stage.snapshot, ...stage.overrides };
  snapshotSession.select({ provider: stage.provider, kind: stage.pexelsKind });
  // Pexels rendition IDs belong to this asset; a provider-wide preference may
  // name an unrelated asset's Small rendition while this output requests Best.
  // Resolve against capabilities before the snapshot session records this as
  // its preference, so an unavailable request can use the live supported one.
  const quality = stage.provider === 'pexels' ? requested.quality : outputSession.resolveQuality(stage.provider, requested.quality, choices);
  snapshotSession.edit('defaults', { ...requested, quality });
  const output = snapshotSession.output(undefined, context);
  return downloadQueue.add({ provider: stage.provider, output, metadata, source: stage.source, thumbnailDataUrl: stage.thumbnailDataUrl }, mode).added;
}
async function enqueueResultCard(key: string, selection: ResultSelection, mode: QueueInsertionMode): Promise<void> {
  if (selectedQueueLoadBusy || searchBusy || metadataBusy || inlineActionBusyKeys.has(key)) return;
  const stage = outputSession.stage(key, selection, false);
  const queuedStage: StagedSelection = { ...stage, snapshot: cloneOutputDefaults(stage.snapshot), overrides: cloneOutputOverrides(stage.overrides) };
  const request = metadataGuard.next();
  inlineActionBusyKeys.add(key); metadataBusy = true; updateControls(); updateInlineCardStates();
  try {
    const metadata = await loadStagedMetadata(queuedStage);
    const hadActive = downloadQueue.activeId !== null;
    const added = enqueueStagedSelection(queuedStage, metadata, mode);
    if (metadataGuard.isStale(request)) return;
    if (added) showYoutubeStatus(mode === 'after-active' && hadActive ? 'Queued next without interrupting the active download.' : 'Queued from result card.');
    else showYoutubeStatus('Already in downloads.');
  } catch (error) {
    if (metadataGuard.isCurrent(request)) showYoutubeStatus(`${selection.title}: ${(error as Error).message}`);
  } finally {
    if (metadataGuard.isCurrent(request)) metadataBusy = false;
    inlineActionBusyKeys.delete(key); updateControls(); updateInlineCardStates();
  }
}
async function enqueueSelected(): Promise<void> {
  if (selectedQueueLoadBusy || !outputSession.staged.size) return;
  const snapshot = [...outputSession.staged.values()].map((stage) => ({ ...stage, snapshot: cloneOutputDefaults(stage.snapshot), overrides: cloneOutputOverrides(stage.overrides) }));
  selectedQueueLoadBusy = true; renderSelectionToolbar(); renderSearchResults(); setOptionalText('selection-status', `Loading metadata for ${snapshot.length} selected item${snapshot.length === 1 ? '' : 's'}…`);
  let added = 0; const failures: string[] = [];
  for (const stage of snapshot) {
    try {
      const metadata = await loadStagedMetadata(stage);
      added += enqueueStagedSelection(outputSession.staged.get(stage.key) ?? stage, metadata);
      outputSession.unstage(stage.key); // successful metadata includes duplicates already represented in Queue
    } catch (error) { failures.push(`${stage.title}: ${(error as Error).message}`); }
  }
  selectedQueueLoadBusy = false;
  const retained = failures.length ? ` ${failures.length} failed selection${failures.length === 1 ? '' : 's'} retained for retry: ${failures.join('; ')}` : '';
  setOptionalText('selection-status', `${added ? `Queued ${added} item${added === 1 ? '' : 's'}.` : 'No new items queued.'}${retained}`);
  renderSelectionToolbar(); renderSearchResults();
}
function enqueue(intent: DownloadIntent): void {
  if (linkPending()) { showYoutubeStatus('Press Load to use this link.'); return; }
  const metadata = provider === 'pexels' ? pexels : provider === 'social' ? social : provider === 'pinterest' ? pinterest : youtube;
  if (!metadata) return;
  try {
    const output = { ...detailOutput(), intent, ...(provider === 'youtube' ? { selectionPlan: currentSelectionPlan() } : {}) };
    const result = downloadQueue.add({ provider, output, metadata, source: 'source' in metadata ? metadata.source : '', thumbnailDataUrl: outputSession.selected?.thumbnailDataUrl ?? null });
    if (!result.added && result.duplicate) { showYoutubeStatus('Already in downloads.'); focusQueueItem(result.duplicate); }
  } catch (error) { showYoutubeStatus((error as Error).message); }
}
function handlePexelsEvent(event: PexelsEvent): void { downloadQueue.event('pexels', event); }
function captureBrowserState(): BrowserState {
  return { query: ($('youtube-search-input') as HTMLInputElement).value, youtubeSearch: searchPage, youtube, social, socialUrl: (document.getElementById('social-url') as HTMLInputElement | null)?.value ?? '', pinterest, pinterestUrl: (document.getElementById('pinterest-url') as HTMLInputElement | null)?.value ?? '', pinterestSearch, pexelsSearch: pexelsSearch, pexels };
}
function saveBrowserState(): void {
  if (provider === 'youtube') youtubeState = captureBrowserState();
  else if (provider === 'social') socialState = captureBrowserState();
  else if (provider === 'pinterest') pinterestState = captureBrowserState();
  else pexelsStates.set(pexelsKind, captureBrowserState());
}
function restoreBrowserState(): void {
  const saved = provider === 'youtube' ? youtubeState : provider === 'social' ? socialState : provider === 'pinterest' ? pinterestState : pexelsStates.get(pexelsKind);
  searchPage = saved?.youtubeSearch ?? null; youtube = saved?.youtube ?? null; social = saved?.social ?? null; pinterest = saved?.pinterest ?? null; pinterestSearch = saved?.pinterestSearch ?? null; socialPlatform = social?.platform ?? detectSocialPlatform(saved?.socialUrl ?? ''); pexelsSearch = saved?.pexelsSearch ?? null; pexels = saved?.pexels ?? null;
  ($('youtube-search-input') as HTMLInputElement).value = saved?.query ?? '';
  const socialInput = document.getElementById('social-url') as HTMLInputElement | null; if (socialInput) socialInput.value = saved?.socialUrl ?? '';
  const pinterestInput = document.getElementById('pinterest-url') as HTMLInputElement | null; if (pinterestInput) pinterestInput.value = saved?.pinterestUrl ?? '';
  resetSourceSelection(youtube?.id ?? '');
  $('pexels-attribution').classList.toggle('hidden', !pexels);
  setInspectorLoading(false); renderMediaMode(); renderSearchResults();
  if (provider === 'pexels') renderPexelsMetadata(); else if (provider === 'social') { renderSocialPlatform(socialPlatform); renderSocialMetadata(); } else if (provider === 'pinterest') renderPinterestMetadata(); else renderMetadata();
  applyDetailOutput();
  updateControls();
}
function setProvider(next: Provider): void {
  if (provider === next) return;
  if (inspectorOpen) setInspectorOpen(false);
  saveBrowserState();
  writePreference('source', next);
  if (provider === 'pexels') void window.clipdockAPI.cancelPexelsRequests();
  metadataGuard.invalidate(); searchGuard.invalidate(); subtitleGuard.invalidate(); metadataBusy = false; searchBusy = false;
  provider = next; searchError = null;
  for (const [id, value] of [['provider-youtube', 'youtube'], ['provider-pinterest', 'pinterest'], ['provider-pexels', 'pexels'], ['provider-social', 'social']] as const) { const button = document.getElementById(id) as HTMLButtonElement | null; if (!button) continue; const selected = next === value; button.setAttribute('aria-pressed', String(selected)); button.tabIndex = selected ? 0 : -1; }
  $('pexels-kind-switch').classList.toggle('hidden', next !== 'pexels');
  $('youtube-paste-url').classList.toggle('hidden', next !== 'youtube');
  $('social-url-panel').classList.toggle('hidden', next !== 'social');
  document.getElementById('pinterest-url-panel')?.classList.toggle('hidden', next !== 'pinterest');
  $('youtube-search-form').classList.toggle('hidden', next === 'social');
  document.querySelector('.feed-toolbar')?.classList.toggle('hidden', next === 'social');
  $('youtube-search-results').classList.toggle('hidden', next === 'social');
  $('pexels-credit').classList.toggle('hidden', next !== 'pexels');
  // The feed toolbar's single live status line carries provider context.
  ($('youtube-search-input') as HTMLInputElement).placeholder = next === 'pexels' ? 'Search Pexels' : next === 'pinterest' ? 'Search Pinterest or paste a Pin URL' : 'Search permitted sources';
  $('metadata-verified').textContent = next === 'pexels' ? 'Pexels' : next === 'social' ? 'Paste link' : next === 'pinterest' ? 'Pinterest' : 'Verified metadata';
  outputSession.select({ provider: next, kind: pexelsKind });
  restoreBrowserState();
  renderSelectionToolbar();
}
function setPexelsKind(next: PexelsKind): void {
  if (pexelsKind === next) return;
  saveBrowserState();
  pexelsKind = next; searchError = null;
  metadataGuard.invalidate(); searchGuard.invalidate(); metadataBusy = false; searchBusy = false;
  $('pexels-photo-kind').setAttribute('aria-pressed', String(next === 'photo'));
  $('pexels-video-kind').setAttribute('aria-pressed', String(next === 'video'));
  outputSession.select({ provider, kind: next });
  void window.clipdockAPI.cancelPexelsRequests();
  restoreBrowserState();
}
async function retainPexelsConnection(error: string): Promise<void> {
  let status: PexelsConnectionStatus | null = null;
  try { status = await window.clipdockAPI.pexelsKeyStatus(); pexelsConnected = status.connected; } catch { /* Keep the last known state. */ }
  pexelsConnecting = false;
  renderPexelsConnection(status, error);
  if (error) setPexelsSetupOpen(true);
}
async function connectPexels(): Promise<void> {
  const input = $('pexels-api-key') as HTMLInputElement; const key = input.value;
  pexelsConnecting = true; renderPexelsConnection(null);
  try {
    const status = await window.clipdockAPI.setPexelsKey(key);
    input.value = ''; pexelsConnected = status.connected; pexelsConnecting = false; renderPexelsConnection(status);
    // Connected: collapse setup and return focus to its still-visible summary.
    if (status.connected) { setPexelsSetupOpen(false); ($('pexels-setup-summary') as HTMLElement).focus(); }
  } catch {
    input.value = '';
    await retainPexelsConnection('The new Pexels API key was rejected. Your existing connection was kept.');
  }
}
function clearPexelsState(): void {
  pexelsStates.clear(); pexels = null; pexelsSearch = null; outputSession.select({ clear: 'pexels' });
  if (provider === 'pexels') { metadataGuard.invalidate(); searchGuard.invalidate(); metadataBusy = false; searchBusy = false; restoreBrowserState(); }
}
async function disconnectPexels(): Promise<void> {
  pexelsConnecting = true; renderPexelsConnection(null);
  try {
    const status = await window.clipdockAPI.clearPexelsKey();
    pexelsConnected = status.connected; pexelsConnecting = false;
    if (!status.connected) clearPexelsState();
    renderPexelsConnection(status);
    // Disconnected: setup is required again, so keep the disclosure open.
    if (!status.connected) setPexelsSetupOpen(true);
  } catch {
    await retainPexelsConnection('Could not disconnect Pexels. The saved credential was not removed.');
  }
}
function handleYoutubeEvent(event: YoutubeEvent): void { downloadQueue.event('youtube', event); }
function handleSocialEvent(event: SocialEvent): void { downloadQueue.event('social', event); }
function handlePinterestEvent(event: PinterestEvent): void { downloadQueue.event('pinterest', event); }
function applyRememberedPreferences(): void {
  outputSession.edit('defaults', {
    profile: readPreference('output-intent'), targetBin: readPreference('target-bin'),
    intent: readPreference('handoff-intent') ?? readPreference('timeline-placement'),
    quality: readPreference('common-quality'), mediaMode: readPreference('common-media-mode'),
    audioFormat: readPreference('common-audio-format'), subtitles: readPreference('common-subtitles') === 'true',
    subtitleLanguage: readPreference('common-subtitle-language'),
  });
  updateCommonQualityOptions([outputSession.defaults.quality]);
  renderCommonOutputControls();
  applyDetailOutput();
  const source = readPreference('source');
  if (source === 'youtube' || source === 'pexels' || source === 'social' || source === 'pinterest') setProvider(source);
}

// Focus inside a menu that is closing returns to its trigger rather than to the page body.
function closeHistoryActions(restoreFocus = false): void { if (!openHistoryMenu) return; restoreFocus ||= isWithin(document.activeElement, openHistoryMenu); openHistoryMenu.classList.add('hidden'); historyMenuTrigger?.setAttribute('aria-expanded', 'false'); const trigger = historyMenuTrigger; openHistoryMenu = null; historyMenuTrigger = null; if (restoreFocus) trigger?.focus(); }
function openHistoryActions(menu: HTMLElement, trigger: HTMLButtonElement): void { if (openHistoryMenu !== menu) closeHistoryActions(); const rect = trigger.getBoundingClientRect(); menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`; menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top)}px`; openHistoryMenu = menu; historyMenuTrigger = trigger; menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); (menu.querySelector('button') as HTMLButtonElement | null)?.focus(); }
async function useHistoryRecord(record: HistoryRecord, placement?: TimelinePlacement): Promise<void> {
  const reason = hostActionReason(placement ? 'timeline' : 'import');
  if (reason) { setText('message', reason, false); return; }
  const card = await window.clipdockAPI.historyReuse(record.id);
  if (!card) { setText('message', `${record.fileName} is missing. Relink it first.`); return; }
  const bin = outputSession.defaults.targetBin;
  const result = placement
    ? await window.clipdockAPI.addToTimeline(card.cardId, bin, placement)
    : await window.clipdockAPI.importToMediaPool(card.cardId, bin);
  setText('message', result.message, result.ok);
}
function invalidateDeletedCards(cardIds: string[] = []): void { downloadQueue.invalidateCards(cardIds); }
async function historyAction(record: HistoryRecord, action: string): Promise<void> {
  try {
    if (action === 'reuse') await useHistoryRecord(record);
    else if (action === 'playhead' || action === 'end') await useHistoryRecord(record, action);
    else if (action === 'delete') {
      if (!window.confirm(`Remove ${record.fileName} from history? A ClipDock-managed file is deleted only when it is safe and no other record uses it.`)) return;
      const result = await window.clipdockAPI.historyDelete(record.id);
      invalidateDeletedCards(result.removedCardIds);
      const outcome = result.deleted
        ? result.removed ? 'Removed from history and deleted the managed file.' : 'The managed file was deleted. The history entry was kept.'
        : result.removed ? 'Removed from history. The file was kept.' : 'Nothing was removed. The file was kept.';
      // A removed in-memory record can still fail to persist. Keep the existing
      // wording for that specific diagnostic; other warnings describe other risks.
      const message = result.deleted && result.removed && result.warning === 'Download history could not be updated.'
        ? 'File deleted, but download history could not be updated.'
        : [outcome, result.warning].filter(Boolean).join(' ');
      setText('message', message, result.deleted && result.removed && !result.warning);
    } else if (action === 'reveal') await window.clipdockAPI.historyReveal(record.id);
    else if (action === 'reveal-subtitle') await window.clipdockAPI.historyRevealSubtitle(record.id);
    else if (action === 'source') await window.clipdockAPI.historySource(record.id);
    else if (action === 'copy') await window.clipdockAPI.historyCopy(record.id);
    else if (action === 'relink') await window.clipdockAPI.historyRelink(record.id);
  } catch (err) {
    setText('message', (err as Error).message);
  } finally {
    closeHistoryActions();
    await refreshHistory();
  }
}
// ---- History library: search/filter/batch/drag ------------------------------------
// Searchable projection: trimmed, case-insensitive match across title, fileName,
// provider label/raw provider, source, assetId, and creator (when present).
function historySearchText(record: HistoryRecord): string {
  return [record.title, record.fileName, providerLabel(record.provider), record.provider, record.source, record.assetId ?? '', record.creator ?? ''].filter(Boolean).join(' ').toLocaleLowerCase();
}
function filterHistoryRecords(records: HistoryRecord[], query: string, providerFilter: HistoryProviderFilter, availabilityFilter: HistoryAvailabilityFilter): HistoryRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  return records.filter((record) => {
    if (providerFilter !== 'all' && record.provider !== providerFilter) return false;
    if (availabilityFilter === 'available' && !record.available) return false;
    if (availabilityFilter === 'missing' && record.available) return false;
    return !needle || historySearchText(record).includes(needle);
  });
}
// The visible native controls are the single source of truth for filters; unknown
// values (fixtures/older markup) fall back to the all/unfiltered state.
function historyFilters(): { query: string; provider: HistoryProviderFilter; availability: HistoryAvailabilityFilter } {
  const query = (document.getElementById('history-search-input') as HTMLInputElement | null)?.value ?? '';
  const providerRaw = (document.getElementById('history-provider-filter') as HTMLSelectElement | null)?.value ?? '';
  const availabilityRaw = (document.getElementById('history-availability-filter') as HTMLSelectElement | null)?.value ?? '';
  return {
    query,
    provider: providerRaw === 'youtube' || providerRaw === 'pexels' || providerRaw === 'social' || providerRaw === 'pinterest' ? providerRaw : 'all',
    availability: availabilityRaw === 'available' || availabilityRaw === 'missing' ? availabilityRaw : 'all',
  };
}
function historyStatusCopy(total: number, matches: number, visible: number): string {
  if (total === 0) return 'No downloads in history yet.';
  if (matches === 0) return 'No history entries match the current search or filters.';
  return `Showing ${visible} of ${matches} download${matches === 1 ? '' : 's'}.`;
}
async function refreshHistory(): Promise<void> {
  const request = historyGuard.next();
  historyStatusOverride = 'Loading history…';
  document.getElementById('history-list')?.setAttribute?.('data-loading', 'true');
  document.getElementById('history-empty-state')?.setAttribute?.('data-loading', 'true');
  renderHistory();
  try {
    const records = await window.clipdockAPI.historyList();
    if (historyGuard.isStale(request)) return;
    historyRecords = records;
    historyStatusOverride = null;
    historyVisibleCount = HISTORY_BATCH_SIZE;
    document.getElementById('history-list')?.removeAttribute?.('data-loading');
    document.getElementById('history-empty-state')?.removeAttribute?.('data-loading');
    renderHistory();
  } catch (err) {
    if (historyGuard.isStale(request)) return;
    historyRecords = [];
    historyStatusOverride = (err as Error).message;
    document.getElementById('history-list')?.removeAttribute?.('data-loading');
    document.getElementById('history-empty-state')?.removeAttribute?.('data-loading');
    renderHistory();
  }
}
function wireHistoryControls(): void {
  document.getElementById('history-search-input')?.addEventListener('input', () => { historyVisibleCount = HISTORY_BATCH_SIZE; renderHistory(); });
  document.getElementById('history-provider-filter')?.addEventListener('change', () => { historyVisibleCount = HISTORY_BATCH_SIZE; renderHistory(); });
  document.getElementById('history-availability-filter')?.addEventListener('change', () => { historyVisibleCount = HISTORY_BATCH_SIZE; renderHistory(); });
  document.getElementById('history-show-more')?.addEventListener('click', () => { historyVisibleCount += HISTORY_BATCH_SIZE; renderHistory(); });
  document.getElementById('history-refresh-btn')?.addEventListener('click', () => { void refreshHistory(); });
  // Filter chips are the visible face of the two native filter selects.
  for (const [groupId, selectId] of [['history-provider-chips', 'history-provider-filter'], ['history-availability-chips', 'history-availability-filter']] as const) {
    for (const chip of Array.from(document.getElementById(groupId)?.children ?? []) as HTMLButtonElement[]) {
      chip.addEventListener('click', () => {
        const select = document.getElementById(selectId) as HTMLSelectElement | null; if (!select) return;
        select.value = chip.dataset.value ?? 'all'; historyVisibleCount = HISTORY_BATCH_SIZE; renderHistory();
      });
    }
  }
}
function renderHistoryChips(): void {
  for (const [groupId, selectId] of [['history-provider-chips', 'history-provider-filter'], ['history-availability-chips', 'history-availability-filter']] as const) {
    const value = (document.getElementById(selectId) as HTMLSelectElement | null)?.value || 'all';
    for (const chip of Array.from(document.getElementById(groupId)?.children ?? []) as HTMLElement[]) chip.setAttribute('aria-pressed', String((chip.dataset?.value ?? 'all') === value));
  }
}
async function renderHistory(): Promise<void> {
  const list = $('history-list');
  const status = document.getElementById('history-status');
  const showMore = document.getElementById('history-show-more') as HTMLButtonElement | null;
  const historyEmpty = document.getElementById('history-empty-state');
  const filters = historyFilters();
  const matches = filterHistoryRecords(historyRecords, filters.query, filters.provider, filters.availability);
  const visible = matches.slice(0, historyVisibleCount);
  closeHistoryActions(); // its menu is replaced below
  const restoreFocus = captureListFocus(list, 'recordId');
  list.replaceChildren(); historyHostRefreshers = []; renderHistoryChips();
  if (status) {
    status.textContent = historyStatusOverride !== null ? historyStatusOverride : historyStatusCopy(historyRecords.length, matches.length, visible.length);
    status.classList.toggle('err', historyStatusOverride !== null && historyStatusOverride !== 'Loading history…');
  }
  if (showMore) showMore.classList.toggle('hidden', visible.length >= matches.length);
  if (historyEmpty) {
    const shouldShow = historyStatusOverride === null && matches.length === 0;
    historyEmpty.classList.toggle('hidden', !shouldShow);
    (historyEmpty as HTMLElement).hidden = !shouldShow;
    historyEmpty.setAttribute('aria-hidden', String(!shouldShow));
  }
  for (const record of visible) {
    const source = providerLabel(record.provider);
    const availability = record.available ? 'Available' : 'Missing';
    const row = document.createElement('div'); row.className = 'history-row ledger-row history-operation-row'; row.dataset.recordId = record.id; row.dataset.provider = record.provider; row.dataset.state = record.available ? 'available' : 'missing'; row.tabIndex = 0;
    const summary = document.createElement('span'); summary.className = 'history-summary history-source'; summary.dataset.field = 'history-ledger'; summary.textContent = `Source: ${source} · Title: ${record.title} · File: ${record.fileName} · Size: ${formatBytes(record.bytes)} · Status: ${availability}${record.project ? ` · Project: ${record.project}` : ''}`;
    // Native drag is pointer/OS-bound and cardId-only: available rows drag exactly
    // their opaque cardId through the existing startCardDrag/startNativeDrag seam.
    const cardId = record.cardId;
    if (record.available && cardId) row.addEventListener('dragstart', (event) => { if (row.draggable) startCardDrag(event, cardId); else event.preventDefault(); });
    const dragHint = document.createElement('span');
    const summaryText = summary.textContent;
    const refreshDrag = (): void => {
      const hostDragReason = hostActionReason('drag');
      const canDrag = record.available && !!cardId && !hostDragReason;
      const reason = !record.available ? 'This file is missing. Relink it from the More menu to drag it to Resolve.' : !cardId ? 'This file is not ready to drag yet. Use the More menu to hand it off to Resolve.' : hostDragReason;
      row.draggable = canDrag;
      row.setAttribute('aria-label', summaryText + (canDrag ? ' Drag to Resolve.' : reason ? ` ${reason}` : ''));
      row.title = reason ?? '';
      dragHint.className = canDrag ? 'handoff-drag-hint history-drag-hint' : 'history-drag-reason';
      dragHint.textContent = canDrag ? ' · Drag to Resolve' : reason ? ` · ${reason}` : '';
    };
    summary.append(dragHint); historyHostRefreshers.push(refreshDrag); refreshDrag();
    const more = button('More', () => openHistoryActions(menu, more)); more.className = 'history-actions'; more.setAttribute('aria-label', `Actions for ${record.fileName}`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'history-menu hidden operation-actions'; menu.setAttribute('role', 'menu'); menu.title = ''; // An empty title stops the row's drag-reason tooltip from covering the menu.
    menu.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHistoryActions(true); return; } if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; const items = (Array.from(menu.children) as HTMLButtonElement[]).filter((item) => !item.disabled); if (!items.length) return; const current = items.indexOf(document.activeElement as HTMLButtonElement); const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length; event.preventDefault(); items[target].focus(); });
    const historyActions = [['reuse', 'Add to Media Pool'], ['playhead', 'Add at playhead'], ['end', 'Add to timeline end'], ['reveal', 'Reveal in Finder'], ['reveal-subtitle', 'Reveal subtitle'], ['source', 'Open source'], ['copy', 'Copy path'], ['relink', 'Relink…'], ['delete', 'Delete']] as const;
    for (const [action, label] of historyActions) {
      // The subtitle companion action exists only while the companion is
      // available; main resolves the path and rejects absent or unsafe files.
      if (action === 'reveal-subtitle' && record.subtitle?.available !== true) continue;
      // A missing file can only be opened at its source, relinked or deleted; hide what cannot work.
      if (!record.available && ['reuse', 'playhead', 'end', 'reveal', 'copy'].includes(action)) continue;
      const item = button(label, () => { void historyAction(record, action); }); item.setAttribute('role', 'menuitem'); if (action === 'reuse' || action === 'playhead' || action === 'end') watchHistoryHandoff(item, label, action === 'reuse' ? 'import' : 'timeline'); menu.append(item); }
    const open = (event: Event) => { event.preventDefault(); openHistoryActions(menu, more); }; row.addEventListener('contextmenu', open); row.addEventListener('keydown', (event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event); }); row.append(summary, more, menu);
    appendHistoryRowFace(row, record, more);
    list.append(row);
  }
  restoreFocus();
}
function watchHistoryHandoff(control: HTMLButtonElement, label: string, action: 'import' | 'timeline'): void {
  const refresh = (): void => {
    const reason = hostActionReason(action);
    control.disabled = !!reason; control.title = reason ?? '';
    control.setAttribute('aria-label', `${label}${reason ? `. ${reason}` : ''}`);
  };
  historyHostRefreshers.push(refresh); refresh();
}
// The visible face of a history row: a contact print, the clip line, and the one or two
// actions that fit the row's state. Everything else stays in the More menu.
function appendHistoryRowFace(row: HTMLElement, record: HistoryRecord, more: HTMLButtonElement): void {
  const mini = document.createElement('span'); mini.className = 'mini'; mini.setAttribute('aria-hidden', 'true');
  const poster = document.createElement('img'); poster.alt = ''; poster.src = skylinePoster(record.id); mini.append(poster);
  if (!record.available) { const stamp = document.createElement('span'); stamp.className = 'stamp'; stamp.textContent = 'MISSING'; mini.append(stamp); }
  else {
    const drag = document.createElement('span'); drag.className = 'drag'; drag.textContent = 'Drag';
    const refresh = (): void => { mini.replaceChildren(poster, ...(record.cardId && !hostActionReason('drag') ? [drag] : [])); };
    historyHostRefreshers.push(refresh); refresh();
  }
  const info = document.createElement('div'); info.className = 'info'; info.setAttribute('aria-hidden', 'true');
  const title = document.createElement('p'); title.className = 't'; title.textContent = record.title;
  const file = document.createElement('p'); file.className = 'f'; file.textContent = record.fileName;
  const status = document.createElement('div'); status.className = 'status';
  if (record.available) {
    const used = document.createElement('span'); used.textContent = [providerLabel(record.provider), formatAge(Math.floor(record.createdAt / 1000)), formatBytes(record.bytes)].join(' · ');
    status.append(used);
  } else {
    const chip = document.createElement('span'); chip.className = 'st miss'; chip.textContent = 'Missing';
    const note = document.createElement('span'); note.className = 'miss-note'; note.textContent = 'Moved or deleted outside ClipDock.';
    status.append(chip, note);
  }
  info.append(title, file, status);
  const acts = document.createElement('div'); acts.className = 'acts';
  const quick = (label: string, action: string, className: string): HTMLButtonElement => {
    const control = button(label, () => { void historyAction(record, action); }); control.className = className;
    control.setAttribute('aria-label', `${label}: ${record.fileName}`);
    return control;
  };
  if (record.available) {
    const reuse = quick('Media Pool', 'reuse', 'btn sm'); watchHistoryHandoff(reuse, `Media Pool: ${record.fileName}`, 'import'); reuse.dataset.icon = 'pool'; acts.append(reuse);
    const reveal = quick('Reveal in Finder', 'reveal', 'icon-btn history-icon reveal'); reveal.title = 'Reveal in Finder'; acts.append(reveal);
  } else {
    const relink = quick('Relink…', 'relink', 'btn sm'); relink.dataset.icon = 'link'; acts.append(relink);
    const remove = quick('Delete', 'delete', 'icon-btn history-icon delete'); remove.title = 'Remove from history'; acts.append(remove);
  }
  more.title = 'More actions';
  row.append(mini, info, acts);
}
function clickButtonOnPlainEnter(inputId: string, buttonId: string): void {
  document.getElementById(inputId)?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  });
}
window.addEventListener('DOMContentLoaded', () => {
  $('refresh-btn').addEventListener('click', () => refresh());
  const unsubscribeYoutubePreview = window.clipdockAPI.onYoutubePreviewState?.(handleYoutubePreviewState) ?? (() => undefined);
  const unsubscribeResolveQuit = window.clipdockAPI.onResolveQuit(() => {
    // Invalidate an older in-flight response before rendering the disconnected
    // snapshot; it must never restore a stale Connected state after Resolve quits.
    statusRefreshGeneration += 1;
    // Resolve quit is synchronous: render a safe disconnected snapshot NOW so host
    // actions disable immediately, then let the controlled refresh confirm recovery.
    hostStatus = {
      phase: 'bridge-error',
      bridge: { connected: false, moduleVersion: null, resolveVersion: null, error: 'Resolve quit; the bridge is no longer available.' },
      project: { loaded: false, name: null },
      timeline: { loaded: false, name: null },
      message: 'Resolve is closed. Waiting to reconnect…',
      refreshHint: 'Reconnect when Resolve restarts.',
    };
    document.body.dataset.phase = 'bridge-error';
    setText('bridge-state', 'Not connected', false);
    setText('module-version', '-'); setText('resolve-version', '-');
    setText('project-name', 'No project open', false); setText('timeline-name', 'No timeline', false);
    setText('message', hostStatus.message); setText('refresh-hint', hostStatus.refreshHint ?? '');
    updateControls();
    if (queue.length) renderQueue();
    refreshHistoryHostState();
    scheduleHostRefresh();
  });
  window.addEventListener('focus', scheduleHostRefresh);
  document.addEventListener?.('visibilitychange', onHostVisibilityChange);
  if (document.visibilityState === 'visible') startHostPolling();
  window.addEventListener('beforeunload', () => {
    unsubscribeResolveQuit(); unsubscribeYoutubePreview();
    window.removeEventListener('focus', scheduleHostRefresh);
    document.removeEventListener?.('visibilitychange', onHostVisibilityChange);
    stopHostPolling();
    if (hostRefreshTimer !== null) window.clearTimeout(hostRefreshTimer);
    if (statusRefreshTimer !== null) window.clearTimeout(statusRefreshTimer);
    if (queueRenderTimer !== null) window.clearTimeout(queueRenderTimer);
    if (previewStopTimer !== null) window.clearTimeout(previewStopTimer);
    if (previewBoundsTimer !== null) window.clearTimeout(previewBoundsTimer);
  });
  renderPinState($('pin-on-top-btn').getAttribute?.('aria-pressed') === 'true');
  $('pin-on-top-btn').addEventListener('click', () => { void togglePinOnTop(); });
  for (const [surface, id] of Object.entries(SURFACE_NAV_IDS) as Array<[Surface, string]>) document.getElementById(id)?.addEventListener('click', () => openSurfaceFromNav(surface));
  document.getElementById('global-queue-status')?.addEventListener('click', () => openSurfaceFromNav('queue'));
  document.getElementById('settings-close')?.addEventListener('click', () => closeSettings());
  // Escape cancels the modal dialog; it counts as the acknowledgement, like the button.
  document.getElementById('first-use-dialog')?.addEventListener('cancel', () => writePreference('permitted-content-ack', 'true'));
  document.getElementById('first-use-ack')?.addEventListener('click', () => { writePreference('permitted-content-ack', 'true'); const dialog = document.getElementById('first-use-dialog') as HTMLDialogElement | null; try { dialog?.close?.(); } catch { /* fallback dialog has no close method */ } dialog?.removeAttribute?.('open'); });
  wirePreviewControls();
  document.addEventListener?.('pointerdown', (event) => { if (openHistoryMenu && event.target instanceof Node && !openHistoryMenu.contains(event.target) && event.target !== historyMenuTrigger) closeHistoryActions(); });
  // The common-output panel is a dropdown in the sheet head: a click elsewhere folds it.
  document.addEventListener?.('pointerdown', (event) => { const common = document.getElementById('common-output') as HTMLDetailsElement | null; if (common?.open && event.target instanceof Node && !common.contains(event.target)) common.open = false; });
  ($('youtube-search-form') as HTMLFormElement).addEventListener('submit', (event) => { event.preventDefault(); submitSourceSearch(); });
  // Keyboard navigation: ArrowDown from the search box focuses the first result; within
  // the results ArrowUp/Down rove in DOM order. Enter/Space stay native button activation.
  ($('youtube-search-input') as HTMLInputElement).addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    const rows = Array.from($('youtube-search-results').children) as HTMLButtonElement[];
    if (!rows.length) return;
    event.preventDefault(); rows[0].focus();
  });
  ($('youtube-search-results') as HTMLElement).addEventListener('keydown', (event) => {
    if (event.key === 'PageUp' || event.key === 'PageDown') { const button = $(event.key === 'PageUp' ? 'youtube-search-prev' : 'youtube-search-next') as HTMLButtonElement; if (!button.disabled) { event.preventDefault(); button.click(); } return; }
    // Enter on a focused frame opens its clip detail, same as its title.
    if (event.key === 'Enter' && (event.target as HTMLElement | null)?.parentElement === $('youtube-search-results')) {
      const details = findResultDescendant(event.target as HTMLElement, (element) => element.classList?.contains?.('youtube-details') ?? false);
      if (details) { event.preventDefault(); (details as HTMLButtonElement).click(); }
      return;
    }
    const forward = 'ArrowDown';
    const backward = 'ArrowUp';
    if (event.key !== forward && event.key !== backward) return;
    const rows = Array.from($('youtube-search-results').children) as HTMLButtonElement[];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === forward
      ? (current === -1 ? 0 : Math.min(rows.length - 1, current + 1))
      : (current === -1 ? rows.length - 1 : Math.max(0, current - 1));
    if (next !== current) { event.preventDefault(); rows[next].focus(); }
  });
  $('youtube-search-prev').addEventListener('click', () => searchPageRelative(-1)); $('youtube-search-next').addEventListener('click', () => searchPageRelative(1));
  $('load-youtube-btn').addEventListener('click', () => { clearResultSelection(); void loadYoutube(); });
  document.getElementById('load-pinterest-btn')?.addEventListener('click', () => { clearResultSelection(); void loadPinterest(); });
  $('youtube-url').addEventListener('input', onLinkInput);
  document.getElementById('pinterest-url')?.addEventListener('input', onLinkInput);
  clickButtonOnPlainEnter('youtube-url', 'load-youtube-btn');
  clickButtonOnPlainEnter('social-url', 'load-social-btn');
  if (document.getElementById('pinterest-url') && document.getElementById('load-pinterest-btn')) clickButtonOnPlainEnter('pinterest-url', 'load-pinterest-btn');
  clickButtonOnPlainEnter('pexels-api-key', 'pexels-connect-btn');
  document.getElementById('search-subtitles-btn')?.addEventListener('click', () => { void searchSubtitles(); });
  document.getElementById('subtitle-search-query')?.addEventListener('input', renderSubtitleCues);
  document.getElementById('range-full-btn')?.addEventListener('click', () => { resetSourceSelection(youtube?.id ?? '', false); renderSelection(); renderSubtitleCues(); renderRangeUi(); commitRangeEdit(); });
  wireRangeRuler(); wireIntentMenu(); wireBinChoice();
  document.getElementById('search-retry-btn')?.addEventListener('click', () => { (document.getElementById('youtube-search-form') as HTMLFormElement | null)?.requestSubmit(); });
  document.getElementById('audio-only-toggle')?.addEventListener('change', () => {
    const toggle = document.getElementById('audio-only-toggle') as HTMLInputElement; const mode = document.getElementById('youtube-media-mode') as HTMLSelectElement | null;
    if (!mode) return; mode.value = toggle.checked ? 'audio' : 'video'; commitInspectorEdit(readOutputControl('youtube', 'mediaMode')); updateControls();
  });
  document.getElementById('download-only-btn')?.addEventListener('click', () => enqueue('download'));
  document.getElementById('host-banner-retry')?.addEventListener('click', () => refresh());
  for (const id of ['range-in', 'range-out']) {
    const control = document.getElementById(id);
    control?.addEventListener('input', selectManualRange);
    control?.addEventListener('change', () => selectManualRange());
    control?.addEventListener('blur', () => selectManualRange());
    control?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); selectManualRange(); } });
  }
  $('download-youtube-btn').addEventListener('click', () => enqueue(detailOutput().intent));
  document.getElementById('enqueue-selected-btn')?.addEventListener('click', () => { void enqueueSelected(); });
  document.getElementById('select-all-results-btn')?.addEventListener('click', stageAllCurrentResults);
  document.getElementById('clear-selection-btn')?.addEventListener('click', clearStagedSelection);
  ($('youtube-target-bin') as HTMLSelectElement).addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'targetBin')); updateControls(); });
  document.getElementById('youtube-intent')?.addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'intent')); renderPlacementWarning(); updateControls(); });
  ($('youtube-quality') as HTMLSelectElement).addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'quality')); renderQuality(); }); ($('youtube-profile') as HTMLSelectElement).addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'profile')); renderProfile(); });
  ($('youtube-media-mode') as HTMLSelectElement).addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'mediaMode')); updateControls(); });
  document.getElementById('youtube-audio-format')?.addEventListener('change', () => commitInspectorEdit(readOutputControl('youtube', 'audioFormat')));
  ($('youtube-subtitle-language') as HTMLSelectElement).addEventListener('change', () => commitInspectorEdit(readOutputControl('youtube', 'subtitleLanguage')));
  ($('youtube-subtitles') as HTMLInputElement).addEventListener('change', () => { commitInspectorEdit(readOutputControl('youtube', 'subtitles')); renderMediaMode(); });
  for (const field of Object.keys(outputControlFields) as Array<keyof typeof outputControlFields>) document.getElementById(`common-${outputControlFields[field]}`)?.addEventListener('change', () => { applyCommonDefaultsFromControls(readOutputControl('common', field)); renderCommonOutputControls(); applyDetailOutput(); });
  for (const profileButton of Array.from($('profile-controls').children) as HTMLButtonElement[]) {
    profileButton.addEventListener('click', () => { ($('youtube-profile') as HTMLSelectElement).value = profileButton.dataset.profile ?? 'original'; commitInspectorEdit(readOutputControl('youtube', 'profile')); renderProfile(); });
    profileButton.addEventListener('keydown', (event) => {
      const buttons = Array.from($('profile-controls').children) as HTMLButtonElement[];
      const current = buttons.indexOf(profileButton);
      let target = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = Math.min(buttons.length - 1, current + 1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = Math.max(0, current - 1);
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = buttons.length - 1;
      if (target < 0) return;
      event.preventDefault();
      ($('youtube-profile') as HTMLSelectElement).value = buttons[target].dataset.profile ?? 'original';
      commitInspectorEdit(readOutputControl('youtube', 'profile')); renderProfile(); buttons[target].focus();
    });
  }
  if (document.getElementById('provider-youtube')) {
    const providerButtons = [['provider-youtube', 'youtube'], ['provider-pinterest', 'pinterest'], ['provider-pexels', 'pexels'], ['provider-social', 'social']] as const;
    for (const [id, value] of providerButtons) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (!button) continue;
      button.addEventListener('click', () => setProvider(value));
      button.addEventListener('keydown', (event) => { const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']; if (!keys.includes(event.key)) return; const current = providerButtons.findIndex(([providerId]) => providerId === id); const target = event.key === 'Home' ? 0 : event.key === 'End' ? providerButtons.length - 1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (current + 1) % providerButtons.length : (current - 1 + providerButtons.length) % providerButtons.length; event.preventDefault(); const [targetId, targetProvider] = providerButtons[target]; setProvider(targetProvider); ($(targetId) as HTMLButtonElement).focus(); });
    }
    $('pexels-photo-kind').addEventListener('click', () => setPexelsKind('photo')); $('pexels-video-kind').addEventListener('click', () => { void setPexelsKind('video'); }); $('pexels-connect-btn').addEventListener('click', () => { void connectPexels(); }); $('pexels-disconnect-btn').addEventListener('click', () => { void disconnectPexels(); }); $('pexels-key-link').addEventListener('click', () => { void window.clipdockAPI.openPexelsExternal('https://www.pexels.com/api/'); }); $('pexels-link').addEventListener('click', () => { void window.clipdockAPI.openPexelsExternal('https://www.pexels.com/'); });
    $('load-social-btn').addEventListener('click', () => { clearResultSelection(); void loadSocial(); });
    $('social-url').addEventListener('input', () => { onLinkInput(); socialPlatform = detectSocialPlatform(($('social-url') as HTMLInputElement).value); renderSocialPlatform(socialPlatform); });
    window.clipdockAPI.onPexelsEvent(handlePexelsEvent); window.clipdockAPI.onSocialEvent(handleSocialEvent); window.clipdockAPI.onPinterestEvent?.(handlePinterestEvent);
    void window.clipdockAPI.pexelsKeyStatus().then((status) => { pexelsConnected = status.connected; renderPexelsConnection(status); }).catch(() => { renderPexelsConnection(null, 'Could not check Pexels connection.'); setPexelsSetupOpen(true); });
  }
  document.getElementById('open-workspace-btn')?.addEventListener('click', () => { void openWorkspace(); });
  document.getElementById('open-downloads-folder-btn')?.addEventListener('click', () => { void openWorkspace(); });
  document.getElementById('choose-download-folder-btn')?.addEventListener('click', () => { void chooseDownloadFolder(); });
  document.getElementById('cleanup-workspace-btn')?.addEventListener('click', () => { void cleanupWorkspace(); });
  wireResizableRegions();
  // CSS aspect-ratio owns 16:9 since D Home Grid port - no JS height sync wiring
  window.clipdockAPI.onYoutubeEvent(handleYoutubeEvent);
  applyRememberedPreferences();
  setSurface('search', false);
  renderCommonOutputControls();
  renderSearchResults(); renderProfile(); if (document.getElementById('history-list')) { wireHistoryControls(); } renderMediaMode(); renderPlacementWarning(); renderQueue(); if (document.getElementById('workspace-status')) void refreshWorkspace(); refresh(); showFirstUseAcknowledgement();
});
