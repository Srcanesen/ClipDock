// ClipDock preview-only fixture adapter. Loaded ONLY by the local preview server
// (scripts/preview.mjs), which injects this script ahead of the production
// renderer. The real plugin never references this file (dist/index.html is the
// untouched static one), and even here the fake engages only when the URL
// carries an explicit ?preview= query — so the production UI is exercised in a
// browser without Resolve running.
//
// NOTE: this file must stay free of import/export statements. Any import would
// make TypeScript emit a CommonJS module prologue that crashes in a plain
// browser; the shapes are declared locally (same pattern as renderer.ts) so the
// compiled file is a bare browser script.

interface StatusSnapshot {
  phase: 'bridge-error' | 'no-project' | 'no-timeline' | 'ready';
  bridge: { connected: boolean; moduleVersion: string | null; resolveVersion: string | null; error: string | null };
  project: { name: string | null; loaded: boolean };
  timeline: { name: string | null; loaded: boolean };
  message: string;
  refreshHint: string | null;
}

interface PreviewTransferResult {
  ok: boolean;
  kind: string;
  message: string;
}

interface PreviewSelectResult {
  canceled: boolean;
  cardId?: string;
  fileName?: string;
}

interface PreviewYoutubeMetadata { id: string; title: string; duration: number | null; channel: string | null; thumbnailUrl: string | null; heights: number[]; formatSummary: string[]; }
interface PreviewYoutubeSearchItem { id: string; title: string; channel: string | null; duration: number | null; url: string; thumbnailUrl: string | null; viewCount: number | null; publishedAt: number | null; channelVerified: boolean; }
interface PreviewYoutubeSearchPage { query: string; page: number; pageSize: 10; results: PreviewYoutubeSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; }
interface PreviewYoutubeEvent { jobId: string; state: string; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; subtitle?: { cardId: string; fileName: string }; warning?: string; }
interface PreviewSocialMetadata { id: string; platform: 'instagram' | 'twitter' | 'facebook'; source: string; title: string; duration: number | null; channel: string | null; thumbnailDataUrl: string | null; heights: number[]; formatSummary: string[]; }
interface PreviewSocialEvent { jobId: string; state: string; percent: number | null; message: string; cardId?: string; fileName?: string; warning?: string; }
interface PreviewPinterestItem { index: number; kind: 'image' | 'video'; title: string; creator: string | null; extension: string; }
interface PreviewPinterestMetadata { pinId: string; source: string; title: string; creator: string | null; kind: 'image' | 'video' | 'carousel'; items: PreviewPinterestItem[]; thumbnailUrl: string | null; }
interface PreviewPinterestSearchItem { id: string; title: string; creator: string | null; kind: 'image' | 'video' | 'carousel'; url: string; thumbnailUrl: string | null; }
interface PreviewPinterestSearchPage { query: string; page: number; pageSize: 10; results: PreviewPinterestSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: { failed: number; total: number; reason: string; node: string }; }
interface PreviewPinterestEvent { jobId: string; state: string; percent: number | null; message: string; cardId?: string; fileName?: string; warning?: string; }
interface PreviewHistoryRecord { id: string; provider: 'youtube' | 'pexels' | 'social' | 'pinterest'; source: string; project: string | null; fileName: string; bytes: number; assetId: string | null; title: string; creator: string | null; profile: string; quality: string | null; mediaMode: string; selection: null; automation: { provider: 'youtube' | 'pexels' | 'social' | 'pinterest'; source: string; selection: null; chapters: [] }; createdAt: number; lastUsedAt: number; available: boolean; cardId?: string; }

interface PreviewApi {
  openYoutubeExternal(videoId: string, startSeconds?: number): Promise<boolean>;
  openYoutubePreview(videoId: string, startSeconds: number | undefined, bounds: {x: number; y: number; width: number; height: number}): Promise<boolean>;
  closeYoutubePreview(): Promise<boolean>;
  setYoutubePreviewBounds(bounds: {x: number; y: number; width: number; height: number}): Promise<boolean>;
  onYoutubePreviewState(callback: (state: {state: 'closed' | 'failed'; reason: 'closed' | 'escape' | 'load' | 'crash'}) => void): () => void;
  searchSubtitles(url: string, language: string): Promise<Array<{start: number; end: number; text: string}>>;
  historyRevealSubtitle(id: string): Promise<boolean>;
  getStatus(): Promise<StatusSnapshot>;
  downloadFolderStatus(): Promise<{ folder: string; userSelected: boolean }>;
  chooseDownloadFolder(): Promise<{ folder: string; userSelected: boolean }>;
  onResolveQuit(callback: () => void): () => void;
  selectFile(): Promise<PreviewSelectResult>;
  startNativeDrag(cardId: string): void;
  importToMediaPool(cardId: string, targetBin: 'active' | 'clipdock'): Promise<PreviewTransferResult>;
  addToTimeline(cardId: string, targetBin: 'active' | 'clipdock', placement: 'end' | 'playhead'): Promise<PreviewTransferResult>;
  searchYoutube(query: string, page: number): Promise<PreviewYoutubeSearchPage>;
  prefetchYoutube(url: string): Promise<void>;
  loadYoutube(url: string): Promise<PreviewYoutubeMetadata>;
  loadSocialThumbnail(url: string): Promise<string | null>;
  loadSocial(url: string): Promise<PreviewSocialMetadata>;
  downloadSocial(url: string, quality: 'best' | `${number}p`, profile: 'original' | 'fast' | 'editing', jobId: string): Promise<{ cardId: string; fileName: string; warning?: string }>;
  cancelSocial(jobId: string): Promise<boolean>;
  onSocialEvent(callback: (event: PreviewSocialEvent) => void): () => void;
  loadPinterest(url: string): Promise<PreviewPinterestMetadata>;
  searchPinterest(query: string, page: number): Promise<PreviewPinterestSearchPage>;
  downloadPinterest(url: string, itemIndex: number, profile: 'original' | 'fast' | 'editing', jobId: string): Promise<{ cardId: string; fileName: string; warning?: string }>;
  cancelPinterest(jobId: string): Promise<boolean>;
  onPinterestEvent(callback: (event: PreviewPinterestEvent) => void): () => void;
  downloadYoutube(url: string, quality: 'best' | `${number}p`, profile: 'original' | 'fast' | 'editing', jobId: string, options: { mediaMode: 'video' | 'audio'; audioFormat: 'wav' | 'mp3' | 'm4a'; subtitles: boolean; subtitleLanguage: 'en' | 'es' | 'fr' | 'de' | 'tr' }): Promise<{ cardId: string; fileName: string; subtitle?: { cardId: string; fileName: string }; warning?: string }>;
  cancelYoutube(jobId: string): Promise<boolean>;
  onYoutubeEvent(callback: (event: PreviewYoutubeEvent) => void): () => void;
  setAlwaysOnTop(pinned: boolean): Promise<boolean>;
  pexelsKeyStatus(): Promise<{ connected: boolean; persisted: boolean; message: string }>;
  setPexelsKey(key: string): Promise<{ connected: boolean; persisted: boolean; message: string }>;
  clearPexelsKey(): Promise<{ connected: boolean; persisted: boolean; message: string }>;
  searchPexels(kind: 'photo' | 'video', query: string, page: number): Promise<any>;
  loadPexels(kind: 'photo' | 'video', id: number): Promise<any>;
  downloadPexels(asset: any, fileId: string, profile: string, jobId: string): Promise<{ cardId: string; fileName: string }>;
  cancelPexels(jobId: string): Promise<boolean>;
  cancelPexelsRequests(): Promise<boolean>;
  onPexelsEvent(callback: (event: any) => void): () => void;
  openPexelsExternal(url: string): Promise<boolean>;
  workspaceStatus(): Promise<{ fileCount: number; totalBytes: number; cleanupFileCount: number; cleanupBytes: number }>;
  openWorkspace(): Promise<boolean>;
  cleanupWorkspace(): Promise<{ deletedFileCount: number; deletedBytes: number; fileCount: number; totalBytes: number }>;
  queueDelete(cardId: string): Promise<{ deleted: boolean; message: string }>;
  historyList(): Promise<PreviewHistoryRecord[]>;
  historyReuse(id: string): Promise<null>;
  historyReveal(id: string): Promise<boolean>;
  historySource(id: string): Promise<boolean>;
  historyCopy(id: string): Promise<boolean>;
  historyRelink(id: string): Promise<null>;
  historyDelete(id: string): Promise<{ deleted: boolean; removed: boolean; warning?: string; removedCardIds?: string[] }>;
}

const MODULE_VERSION = '2.0.0-preview';
const RESOLVE_VERSION = '21.0.3.7';
const PROJECT_NAME = 'Demo Project';
const TIMELINE_NAME = 'Main Edit';

// Synthetic, self-contained preview-only source frame; it never makes a network request.
const SYNTHETIC_THUMBNAIL_DATA_URL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#1b1d1e"/><rect width="960" height="350" fill="#b7a184"/><path d="M0 95h960M0 190h960M0 285h960" stroke="#d4c4ad" stroke-opacity=".45"/><path d="M0 350h960v190H0z" fill="#25272a"/><path d="M78 386h804v94H78z" fill="#101214"/><path d="M102 408h218v16H102zm238 0h168v16H340zm188 0h300v16H528z" fill="#c9a35c"/><path d="M102 440h95v16h-95zm114 0h286v16H216zm306 0h134v16H522z" fill="#6c6250"/><path d="M320 136h206l38 49v111H282V185z" fill="#292b2c"/><circle cx="423" cy="234" r="68" fill="#111214" stroke="#c9a35c" stroke-width="10"/><circle cx="423" cy="234" r="38" fill="#574b3b"/><path d="M514 158l108-43v143l-108-43z" fill="#333638"/><path d="M316 305h216v25H316z" fill="#17191a"/><path d="M600 212l92-52 72 54-72 54z" fill="#d9c7aa"/><path d="M652 212l40-23 34 25-34 25z" fill="#665b48"/><rect x="57" y="64" width="176" height="76" rx="4" fill="#151719"/><text x="78" y="100" fill="#ead5a9" font-family="system-ui, sans-serif" font-size="22" font-weight="700">CUT 04</text><text x="78" y="124" fill="#c7c5bd" font-family="system-ui, sans-serif" font-size="13">SOURCE MONITOR</text></svg>')}`;

const READY: StatusSnapshot = {
  phase: 'ready',
  bridge: { connected: true, moduleVersion: MODULE_VERSION, resolveVersion: RESOLVE_VERSION, error: null },
  project: { name: PROJECT_NAME, loaded: true },
  timeline: { name: TIMELINE_NAME, loaded: true },
  message: `Connected to project "${PROJECT_NAME}" — timeline "${TIMELINE_NAME}".`,
  refreshHint: null,
};

const NO_PROJECT: StatusSnapshot = {
  phase: 'no-project',
  bridge: { connected: true, moduleVersion: MODULE_VERSION, resolveVersion: RESOLVE_VERSION, error: null },
  project: { name: null, loaded: false },
  timeline: { name: null, loaded: false },
  message: 'DaVinci Resolve is connected, but no project is currently open.',
  refreshHint: 'Open a project in Resolve, then click Refresh.',
};

const NO_TIMELINE: StatusSnapshot = {
  phase: 'no-timeline',
  bridge: { connected: true, moduleVersion: MODULE_VERSION, resolveVersion: RESOLVE_VERSION, error: null },
  project: { name: PROJECT_NAME, loaded: true },
  timeline: { name: null, loaded: false },
  message: `Project "${PROJECT_NAME}" is open, but it has no active timeline.`,
  refreshHint: 'Open or create a timeline in Resolve, then click Refresh.',
};

const BRIDGE_ERROR: StatusSnapshot = {
  phase: 'bridge-error',
  bridge: { connected: false, moduleVersion: null, resolveVersion: null, error: 'Preview fixture: simulated bridge failure.' },
  project: { name: null, loaded: false },
  timeline: { name: null, loaded: false },
  message: 'Preview fixture: simulated bridge failure.',
  refreshHint: 'Click Refresh to re-initialize the bridge.',
};

const FIXTURES: Record<string, StatusSnapshot> = {
  ready: READY,
  'no-project': NO_PROJECT,
  'no-timeline': NO_TIMELINE,
  'bridge-error': BRIDGE_ERROR,
};

const PREVIEW_HISTORY: PreviewHistoryRecord[] = [
  { id: 'preview-history-1', provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', project: PROJECT_NAME, fileName: 'Preview video [dQw4w9WgXcQ].mp4', bytes: 48_000_000, assetId: 'dQw4w9WgXcQ', title: 'Preview video', creator: 'ClipDock Preview', profile: 'original', quality: '2160p', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection: null, chapters: [] }, createdAt: Date.now() - 86_400_000, lastUsedAt: Date.now() - 86_400_000, available: true, cardId: 'preview-history-card-1' },
  { id: 'preview-history-2', provider: 'pexels', source: 'https://www.pexels.com/video/101/', project: PROJECT_NAME, fileName: 'preview-pexels.mp4', bytes: 12_000_000, assetId: 'video:101', title: 'Preview Pexels video', creator: 'ClipDock Preview', profile: 'fast', quality: '1920×1080 · HD', mediaMode: 'video', selection: null, automation: { provider: 'pexels', source: 'https://www.pexels.com/video/101/', selection: null, chapters: [] }, createdAt: Date.now() - 172_800_000, lastUsedAt: Date.now() - 172_800_000, available: true, cardId: 'preview-history-card-2' },
  { id: 'preview-history-3', provider: 'social', source: 'https://www.instagram.com/reel/ABC_def-123', project: PROJECT_NAME, fileName: 'preview-social.mp4', bytes: 3_500_000, assetId: 'instagram:preview-social-1', title: 'Preview public video link', creator: 'ClipDock Preview', profile: 'original', quality: '1080p', mediaMode: 'video', selection: null, automation: { provider: 'social', source: 'https://www.instagram.com/reel/ABC_def-123', selection: null, chapters: [] }, createdAt: Date.now() - 259_200_000, lastUsedAt: Date.now() - 259_200_000, available: true },
  { id: 'preview-history-4', provider: 'youtube', source: 'https://www.youtube.com/watch?v=9bZkp7q19f0', project: null, fileName: 'Preview second video [9bZkp7q19f0].mp4', bytes: 5_000_000, assetId: '9bZkp7q19f0', title: 'Preview second video', creator: null, profile: 'original', quality: '1080p', mediaMode: 'video', selection: null, automation: { provider: 'youtube', source: 'https://www.youtube.com/watch?v=9bZkp7q19f0', selection: null, chapters: [] }, createdAt: Date.now() - 345_600_000, lastUsedAt: Date.now() - 345_600_000, available: false },
];

// Sample card the ready fixture auto-selects; other fixtures still let the user
// pick a card and exercise the controlled error results below.
const SAMPLE_CARD: PreviewSelectResult = { canceled: false, cardId: 'preview-card-1', fileName: 'sample-clip.mp4' };

const IMPORT_OK: PreviewTransferResult = {
  ok: true,
  kind: 'imported',
  message: 'Imported 1 clip to the Media Pool.',
};
const TIMELINE_OK: PreviewTransferResult = {
  ok: true,
  kind: 'timeline-appended',
  message: 'Added to the active timeline.',
};
const IMPORT_FAILED: PreviewTransferResult = {
  ok: false,
  kind: 'import-failed',
  message: 'Import failed: Resolve added no clips. Make sure a project is open in Resolve.',
};
const NO_PROJECT_RESULT: PreviewTransferResult = {
  ok: false,
  kind: 'no-project',
  message: 'No project is open in Resolve. Open a project, then retry.',
};
const NO_TIMELINE_RESULT: PreviewTransferResult = {
  ok: false,
  kind: 'no-timeline',
  message: 'The current project has no active timeline. Open a timeline, then retry.',
};
const SEARCH_ITEMS: PreviewYoutubeSearchItem[] = Array.from({ length: 23 }, (_, index) => {
  const id = `preview${String(index + 1).padStart(4, '0')}`;
  return {
    id,
    title: `Preview search result ${index + 1}`,
    channel: index % 3 ? 'ClipDock Preview' : null,
    duration: index % 5 ? 60 + index : null,
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnailUrl: index % 3 === 0 ? SYNTHETIC_THUMBNAIL_DATA_URL : null,
    viewCount: index % 4 ? 1_200_000 + index * 1000 : null,
    publishedAt: index % 4 ? Math.floor(Date.now() / 1000) - (index + 1) * 86400 : null,
    channelVerified: index % 3 === 0,
  };
});

// Deterministic 25-result Pinterest search corpus: three pages of ten, mixing
// Image/Video/Carousel kinds and missing-creator/missing-thumbnail fallbacks so
// every row state is exercised without any network or raw CDN reference.
const PINTEREST_SEARCH_ITEMS: PreviewPinterestSearchItem[] = Array.from({ length: 25 }, (_, index) => {
  const id = String(9_000_000_001 + index);
  const kind = index % 3 === 0 ? 'video' : index % 3 === 1 ? 'image' : 'carousel';
  return {
    id,
    title: `Preview Pinterest Pin ${index + 1}`,
    creator: index % 4 === 0 ? null : 'ClipDock Preview',
    kind,
    url: `https://www.pinterest.com/pin/${id}/`,
    thumbnailUrl: index % 4 === 0 ? null : SYNTHETIC_THUMBNAIL_DATA_URL,
  };
});

// Metadata shape per search kind; carousels queue each item separately.
function previewPinterestItems(found: PreviewPinterestSearchItem): PreviewPinterestItem[] {
  if (found.kind === 'carousel') {
    return [
      { index: 1, kind: 'image', title: `${found.title} · image 1`, creator: found.creator, extension: 'jpg' },
      { index: 2, kind: 'video', title: `${found.title} · video`, creator: found.creator, extension: 'mp4' },
      { index: 3, kind: 'image', title: `${found.title} · image 2`, creator: found.creator, extension: 'png' },
    ];
  }
  return [{ index: 1, kind: found.kind, title: found.title, creator: found.creator, extension: found.kind === 'image' ? 'jpg' : 'mp4' }];
}

const BRIDGE_RESULT: PreviewTransferResult = {
  ok: false,
  kind: 'bridge-error',
  message: 'Preview fixture: simulated bridge failure.',
};

// Import is duplicate-aware per (targetBin, cardId): the second import of the same
// card into the same bin previews the already-imported result.
const importedOnce = new Set<string>();
const binLabel = (targetBin: 'active' | 'clipdock'): string => (targetBin === 'clipdock' ? 'ClipDock' : 'Active');

// Engage only on an explicit preview query; unknown values default to READY.
const previewParams = new URLSearchParams(window.location.search);
const previewParam = previewParams.get('preview');
if (previewParam !== null) {
  const snapshot = FIXTURES[previewParam] ?? READY;
  let youtubeListener: ((event: PreviewYoutubeEvent) => void) | null = null;
  let socialListener: ((event: PreviewSocialEvent) => void) | null = null;
  let pinterestListener: ((event: PreviewPinterestEvent) => void) | null = null;
  let pexelsListener: ((event: PreviewYoutubeEvent) => void) | null = null;
  let previewStateListener: ((state: {state: 'closed'; reason: 'closed'}) => void) | null = null;
  let previewOpen = false;
  let previewDownloadJob: string | null = null;
  let previewDownloadSequence = 0;
  const metadata: PreviewYoutubeMetadata = { id: 'dQw4w9WgXcQ', title: 'Preview video', duration: 213, channel: 'ClipDock Preview', thumbnailUrl: SYNTHETIC_THUMBNAIL_DATA_URL, heights: [360, 720, 1080, 1440, 2160], formatSummary: ['360p', '720p', '1080p', '1440p', '2160p'] };
  const api: PreviewApi = {
    openYoutubeExternal: async () => true,
    openYoutubePreview: async () => { previewOpen = true; document.getElementById('source-monitor')?.setAttribute('data-preview-playing', 'true'); return true; },
    closeYoutubePreview: async () => { document.getElementById('source-monitor')?.removeAttribute('data-preview-playing'); if (previewOpen) { previewOpen = false; previewStateListener?.({state: 'closed', reason: 'closed'}); } return true; },
    setYoutubePreviewBounds: async () => previewOpen,
    onYoutubePreviewState: (callback) => { previewStateListener = callback; return () => { if (previewStateListener === callback) previewStateListener = null; }; },
    searchSubtitles: async () => [{start: 0, end: 2, text: 'Preview subtitle'}],
    historyRevealSubtitle: async () => false,
    getStatus: async () => snapshot,
    // Browser preview has no real directory dialog: report the default and apply
    // the requested change in-memory so the Settings folder UI stays exercisable.
    downloadFolderStatus: async () => ({ folder: '/tmp/ClipDock (preview)', userSelected: false }),
    chooseDownloadFolder: async () => ({ folder: '/tmp/ClipDock (preview)', userSelected: true }),
    onResolveQuit: () => () => undefined,
    selectFile: async () => SAMPLE_CARD,
    startNativeDrag: () => undefined,
    prefetchYoutube: async () => undefined,
    searchYoutube: async (query, page) => {
      if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2500));
      if (previewParam === 'error') throw new Error('Preview fixture: search unavailable.');
      if (query.trim().length < 2 || page < 1 || page > 3) throw new Error('Enter 2–100 characters to search YouTube.');
      if (previewParam === 'loading') await new Promise((resolve) => setTimeout(resolve, 900));
      if (previewParam === 'empty') return { query: query.trim(), page, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 };
      const start = (page - 1) * 10;
      return { query: query.trim(), page, pageSize: 10, results: SEARCH_ITEMS.slice(start, start + 10), hasPrevious: page > 1, hasNext: start + 10 < SEARCH_ITEMS.length, totalResults: SEARCH_ITEMS.length, pageCount: Math.min(3, Math.max(1, Math.ceil(SEARCH_ITEMS.length / 10))) };
    },
    loadYoutube: async (url) => {
      if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2000));
      if (previewParam === 'empty' || previewParam === 'error') throw new Error('Preview fixture: no video metadata.');
      if (previewParam === 'loading') await new Promise((resolve) => setTimeout(resolve, 900));
      const second = url.includes('preview0002');
      return second ? { ...metadata, id: '9bZkp7q19f0', title: 'Preview second video' } : metadata;
    },
    downloadYoutube: async (_url, _quality, profile, jobId, options) => {
      if (previewParam === 'empty' || previewParam === 'error' || previewParam === 'download-failed') throw new Error('Preview fixture: download failed.');
      if (previewDownloadJob) throw new Error('Preview fixture: only one backend job may be active.');
      previewDownloadJob = jobId;
      try {
        youtubeListener?.({ jobId, state: 'downloading', percent: 42, message: 'Downloading…', speedBytesPerSecond: 2_500_000, etaSeconds: 4 });
        await new Promise((resolve) => setTimeout(resolve, previewParam === 'queue' ? 1500 : 60));
        if (previewDownloadJob !== jobId) throw new Error('Download cancelled.');
        if (profile !== 'original') youtubeListener?.({ jobId, state: 'processing', percent: 68, message: 'Preparing for Resolve…' });
        await new Promise((resolve) => setTimeout(resolve, previewParam === 'queue' ? 1500 : 60));
        if (previewDownloadJob !== jobId) throw new Error('Download cancelled.');
        const fileName = options.mediaMode === 'audio' ? `Preview audio [dQw4w9WgXcQ].${options.audioFormat}` : profile === 'editing' ? 'Preview video [dQw4w9WgXcQ].resolve.mov' : profile === 'original' ? 'Preview video [dQw4w9WgXcQ].mp4' : 'Preview video [dQw4w9WgXcQ].resolve.mp4';
        const result = { cardId: `preview-download-card-${++previewDownloadSequence}`, fileName, ...(options.subtitles ? { subtitle: { cardId: `preview-subtitle-card-${previewDownloadSequence}`, fileName: 'Preview video [dQw4w9WgXcQ].en.srt' } } : {}) };
        youtubeListener?.({ jobId, state: 'completed', percent: 100, message: 'Ready for Resolve.', ...result });
        return result;
      } finally { if (previewDownloadJob === jobId) previewDownloadJob = null; }
    },
    cancelYoutube: async (jobId) => { if (previewDownloadJob !== jobId) return false; previewDownloadJob = null; youtubeListener?.({ jobId, state: 'cancelled', percent: null, message: 'Download cancelled.' }); return true; },
    onYoutubeEvent: (callback) => { youtubeListener = callback; return () => { youtubeListener = null; }; },
    loadSocialThumbnail: async () => null,
    loadSocial: async (url) => {
      const source = url.trim().split(/[?#]/, 1)[0];
      const platform = source.includes('x.com') || source.includes('twitter.com') ? 'twitter' : source.includes('facebook.com') || source.includes('fb.watch') ? 'facebook' : 'instagram';
      return { id: 'preview-social-1', platform, source, title: 'Preview public video link', duration: 42, channel: 'ClipDock Preview', thumbnailDataUrl: SYNTHETIC_THUMBNAIL_DATA_URL, heights: [720, 1080], formatSummary: ['720p', '1080p'] };
    },
    downloadSocial: async (_url, _quality, _profile, jobId) => {
      if (previewDownloadJob) throw new Error('Preview fixture: only one backend job may be active.');
      previewDownloadJob = jobId;
      try { socialListener?.({ jobId, state: 'downloading', percent: 50, message: 'Downloading…' }); await new Promise((resolve) => setTimeout(resolve, 60)); if (previewDownloadJob !== jobId) throw new Error('Download cancelled.'); const result = { cardId: `preview-social-${++previewDownloadSequence}`, fileName: 'preview-social.mp4' }; socialListener?.({ jobId, state: 'completed', percent: 100, message: 'Ready for Resolve.', ...result }); return result; }
      finally { if (previewDownloadJob === jobId) previewDownloadJob = null; }
    },
    cancelSocial: async (jobId) => { if (previewDownloadJob !== jobId) return false; previewDownloadJob = null; socialListener?.({ jobId, state: 'cancelled', percent: null, message: 'Download cancelled.' }); return true; },
    onSocialEvent: (callback) => { socialListener = callback; return () => { socialListener = null; }; },
    loadPinterest: async (url) => {
      if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2000));
      if (previewParam === 'error' || previewParam === 'download-failed') throw new Error('Preview fixture: Pinterest Pin unavailable.');
      // Search-driven selections resolve to metadata coherent with the clicked row;
      // the direct Pin fixture URL keeps its dedicated carousel below.
      const found = PINTEREST_SEARCH_ITEMS.find((item) => item.url === url);
      if (found) {
        return { pinId: found.id, source: url, title: found.title, creator: found.creator, kind: found.kind, thumbnailUrl: found.thumbnailUrl, items: previewPinterestItems(found) };
      }
      return {
        pinId: '123456789', source: url, title: 'Preview Pinterest Pin', creator: 'ClipDock Preview', kind: 'carousel', thumbnailUrl: SYNTHETIC_THUMBNAIL_DATA_URL,
        items: [
          { index: 1, kind: 'image', title: 'Preview Pinterest image', creator: 'ClipDock Preview', extension: 'jpg' },
          { index: 2, kind: 'video', title: 'Preview Pinterest video', creator: 'ClipDock Preview', extension: 'mp4' },
        ],
      };
    },
    searchPinterest: async (query, page) => {
      if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2500));
      if (previewParam === 'error') throw new Error('Preview fixture: Pinterest search unavailable.');
      if (query.trim().length < 2 || page < 1 || page > 3) throw new Error('Enter 2–100 characters to search Pinterest.');
      if (previewParam === 'empty') return { query: query.trim(), page, pageSize: 10, results: [], hasPrevious: false, hasNext: false, totalResults: 0, pageCount: 1 };
      const start = (page - 1) * 10;
      return { query: query.trim(), page, pageSize: 10, results: PINTEREST_SEARCH_ITEMS.slice(start, start + 10), hasPrevious: page > 1, hasNext: start + 10 < PINTEREST_SEARCH_ITEMS.length, totalResults: PINTEREST_SEARCH_ITEMS.length, pageCount: 3 };
    },
    downloadPinterest: async (_url, itemIndex, profile, jobId) => {
      if (previewDownloadJob) throw new Error('Preview fixture: only one backend job may be active.');
      previewDownloadJob = jobId;
      try {
        pinterestListener?.({ jobId, state: 'downloading', percent: 50, message: 'Downloading from Pinterest…' });
        await new Promise((resolve) => setTimeout(resolve, previewParam === 'queue' ? 300 : 60));
        if (previewDownloadJob !== jobId) throw new Error('Download cancelled.');
        const image = itemIndex === 1;
        const fileName = image ? `Preview Pinterest image ${itemIndex}.jpg` : profile === 'editing' ? 'Preview Pinterest video.resolve.mov' : profile === 'fast' ? 'Preview Pinterest video.resolve.mp4' : 'Preview Pinterest video.mp4';
        const result = { cardId: `preview-pinterest-${++previewDownloadSequence}`, fileName };
        pinterestListener?.({ jobId, state: 'completed', percent: 100, message: 'Ready for Resolve.', ...result });
        return result;
      } finally { if (previewDownloadJob === jobId) previewDownloadJob = null; }
    },
    cancelPinterest: async (jobId) => { if (previewDownloadJob !== jobId) return false; previewDownloadJob = null; pinterestListener?.({ jobId, state: 'cancelled', percent: null, message: 'Download cancelled.' }); return true; },
    onPinterestEvent: (callback) => { pinterestListener = callback; return () => { pinterestListener = null; }; },
    // Browser preview: truthfully report the requested state; no real window stacking.
    setAlwaysOnTop: async (pinned) => pinned,
    pexelsKeyStatus: async () => ({ connected: previewParam === 'pexels-photo' || previewParam === 'pexels-video', persisted: true, message: 'Connected · saved securely' }),
    setPexelsKey: async () => ({ connected: true, persisted: true, message: 'Connected · saved securely' }), clearPexelsKey: async () => ({ connected: false, persisted: false, message: 'Disconnected.' }),
    searchPexels: async (kind, query, page) => { if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2500)); return { query, page, pageSize: 15, hasPrevious: false, hasNext: false, totalResults: 1, results: [{ id: 101, kind, title: `Preview Pexels ${kind}`, creator: 'ClipDock Preview', creatorUrl: 'https://www.pexels.com/', sourceUrl: 'https://www.pexels.com/', duration: kind === 'video' ? 12 : null, width: 1920, height: 1080, thumbnailUrl: SYNTHETIC_THUMBNAIL_DATA_URL, previewUrl: null, files: [{ id: 'original', url: 'https://videos.pexels.com/preview.mp4', width: 1920, height: 1080, label: '1920×1080 · HD', mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', size: null }] }] }; },
    loadPexels: async (kind) => { if (previewParam === 'slow') await new Promise(resolve => setTimeout(resolve, 2000)); return { id: 101, kind, title: `Preview Pexels ${kind}`, creator: 'ClipDock Preview', creatorUrl: 'https://www.pexels.com/', sourceUrl: 'https://www.pexels.com/', duration: kind === 'video' ? 12 : null, width: 1920, height: 1080, thumbnailUrl: SYNTHETIC_THUMBNAIL_DATA_URL, previewUrl: null, files: [{ id: 'original', url: 'https://videos.pexels.com/preview.mp4', width: 1920, height: 1080, label: '1920×1080 · HD', mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', size: null }] }; },
    downloadPexels: async (asset, _fileId, profile, jobId) => {
      if (previewDownloadJob) throw new Error('Preview fixture: only one backend job may be active.');
      previewDownloadJob = jobId;
      try {
        pexelsListener?.({jobId, state: 'downloading', percent: 50, message: 'Downloading from Pexels…'});
        await new Promise(resolve => setTimeout(resolve, 60));
        if (previewDownloadJob !== jobId) throw new Error('Download cancelled.');
        if (profile !== 'original') pexelsListener?.({jobId, state: 'processing', percent: 75, message: 'Preparing for Resolve…'});
        const result = {cardId: `preview-pexels-${jobId}`, fileName: asset.kind === 'video' ? 'preview-pexels.mp4' : 'preview-pexels.jpg'};
        pexelsListener?.({jobId, state: 'completed', percent: 100, message: 'Ready for Resolve.', ...result});
        return result;
      } finally { if (previewDownloadJob === jobId) previewDownloadJob = null; }
    },
    cancelPexels: async (jobId) => { if (previewDownloadJob !== jobId) return false; previewDownloadJob = null; pexelsListener?.({jobId, state: 'cancelled', percent: null, message: 'Download cancelled.'}); return true; },
    cancelPexelsRequests: async () => true,
    onPexelsEvent: (callback) => { pexelsListener = callback; return () => { if (pexelsListener === callback) pexelsListener = null; }; },
    openPexelsExternal: async () => true,
    workspaceStatus: async () => ({ fileCount: 3, totalBytes: 48_000_000, cleanupFileCount: 2, cleanupBytes: 32_000_000 }), openWorkspace: async () => true, cleanupWorkspace: async () => ({ deletedFileCount: 2, deletedBytes: 32_000_000, fileCount: 1, totalBytes: 16_000_000 }), queueDelete: async () => previewParam === 'missing-file' ? { deleted: false, message: 'The file is no longer available. It remains in the queue.' } : { deleted: true, message: 'File deleted.' }, historyList: async () => PREVIEW_HISTORY, historyReuse: async () => null, historyReveal: async () => false, historySource: async () => false, historyCopy: async () => false, historyRelink: async () => null, historyDelete: async () => ({ deleted: false, removed: false, removedCardIds: [] }),
    // Import only needs MediaStorage (no project/timeline); timeline append is stricter.
    importToMediaPool: async (cardId, targetBin) => {
      if (previewParam === 'error') return { ok: false, kind: 'transfer-failed', message: 'Preview fixture: transfer failed.' };
      if (previewParam === 'no-project') return IMPORT_FAILED;
      if (previewParam === 'bridge-error') return BRIDGE_RESULT;
      const key = `${targetBin}:${cardId}`;
      if (importedOnce.has(key)) {
        return { ok: true, kind: 'already-imported', message: `Already imported to the ${binLabel(targetBin)} bin — using the existing clip.` };
      }
      importedOnce.add(key);
      return IMPORT_OK;
    },
    addToTimeline: async (_cardId, _targetBin, placement) => {
      switch (previewParam) {
        case 'error':
          return { ok: false, kind: 'transfer-failed', message: 'Preview fixture: transfer failed.' };
        case 'no-project':
          return NO_PROJECT_RESULT;
        case 'no-timeline':
          return NO_TIMELINE_RESULT;
        case 'bridge-error':
          return BRIDGE_RESULT;
        default:
          return placement === 'playhead'
            ? { ok: true, kind: 'timeline-inserted', message: 'Added at the playhead.' }
            : TIMELINE_OK;
      }
    },
  };
  (window as unknown as { clipdockAPI: PreviewApi }).clipdockAPI = api;

  // Each fixture URL opens directly into the named state. Ready, queue and
  // download-failed use the production renderer's download flow; queue slows
  // jobs so active/pending rows remain visible, download-failed rejects the job
  // so a failed queue row renders.
  window.addEventListener('DOMContentLoaded', () => setTimeout(async () => {
    if (previewParam === 'loading' || previewParam === 'empty' || previewParam === 'error') {
      const search = document.getElementById('youtube-search-input') as HTMLInputElement | null;
      if (search) search.value = 'editing workflow';
      (document.getElementById('youtube-search-form') as HTMLFormElement | null)?.requestSubmit();
      return;
    }
    if (previewParam === 'pinterest-search') {
      (document.getElementById('provider-pinterest') as HTMLButtonElement | null)?.click();
      const search = document.getElementById('youtube-search-input') as HTMLInputElement | null;
      if (search) search.value = 'editing workflow';
      (document.getElementById('youtube-search-form') as HTMLFormElement | null)?.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('youtube-search-results')?.children[0] as HTMLButtonElement | undefined)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
      return;
    }
    if (previewParam === 'pinterest') {
      (document.getElementById('provider-pinterest') as HTMLButtonElement | null)?.click();
      const input = document.getElementById('pinterest-url') as HTMLInputElement | null;
      if (input) input.value = 'https://www.pinterest.com/pin/123456789/';
      (document.getElementById('load-pinterest-btn') as HTMLButtonElement | null)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
      return;
    }
    if (previewParam === 'pexels-photo' || previewParam === 'pexels-video') {
      (document.getElementById('provider-pexels') as HTMLButtonElement | null)?.click();
      // Explicit kind selection: photo fixture must open the Photos flow, video stays on Videos.
      if (previewParam === 'pexels-photo') (document.getElementById('pexels-photo-kind') as HTMLButtonElement | null)?.click();
      if (previewParam === 'pexels-video') (document.getElementById('pexels-video-kind') as HTMLButtonElement | null)?.click();
      const search = document.getElementById('youtube-search-input') as HTMLInputElement | null;
      if (search) search.value = 'editing workflow';
      (document.getElementById('youtube-search-form') as HTMLFormElement | null)?.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('youtube-search-results')?.children[0] as HTMLButtonElement | undefined)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
      return;
    }
    if (!['ready', 'queue', 'audio', 'download-failed', 'no-project', 'no-timeline', 'bridge-error', 'duplicate', 'missing-file'].includes(previewParam)) return;
    const search = document.getElementById('youtube-search-input') as HTMLInputElement | null;
    if (search) search.value = 'editing workflow';
    (document.getElementById('youtube-search-form') as HTMLFormElement | null)?.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.getElementById('youtube-search-results')?.children[0] as HTMLButtonElement | undefined)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const quality = document.getElementById('youtube-quality') as HTMLSelectElement | null;
    if (quality) quality.value = '2160p';
    if (previewParam === 'audio') { const mode = document.getElementById('youtube-media-mode') as HTMLSelectElement | null; if (mode) { mode.value = 'audio'; mode.dispatchEvent(new Event('change')); } const subtitles = document.getElementById('youtube-subtitles') as HTMLInputElement | null; if (subtitles) { subtitles.checked = true; subtitles.dispatchEvent(new Event('change')); } }
    (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
    if (previewParam === 'queue') {
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('youtube-search-results')?.children[1] as HTMLButtonElement | undefined)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
    }
    if (previewParam === 'duplicate') {
      await new Promise((resolve) => setTimeout(resolve, 0));
      (document.getElementById('download-youtube-btn') as HTMLButtonElement | null)?.click();
    }
  }, 0));
}
