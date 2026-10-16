import { normalizeSourceOutput, resolvePexelsRendition, renditionHeight, resolveSourceSelection, transitionSourceSelection, type OutputDefaults } from './output-model';

export type TargetBin = 'active' | 'clipdock';
export type TimelinePlacement = 'end' | 'playhead';
export type YoutubeQuality = 'best' | `${number}p`;
export type MediaProfile = 'original' | 'fast' | 'editing';
export type MediaMode = 'video' | 'audio';
export type AudioFormat = 'wav' | 'mp3' | 'm4a';
export type SubtitleLanguage = 'en' | 'es' | 'fr' | 'de' | 'tr';
export type YoutubeSelection = { start: number; end: number; label: string } | null;
export type DownloadOptions = { mediaMode: MediaMode; audioFormat: AudioFormat; subtitles: boolean; subtitleLanguage: SubtitleLanguage; selection?: YoutubeSelection };
export type DownloadIntent = 'download' | 'import' | 'playhead' | 'end';
export type SocialPlatform = 'instagram' | 'twitter' | 'facebook';
export type Provider = 'youtube' | 'pexels' | 'social' | 'pinterest';
export type PinterestMediaKind = 'image' | 'video';
export interface PinterestItem { index: number; kind: PinterestMediaKind; title: string; creator: string | null; extension: string; }
export interface PinterestMetadata { pinId: string; source: string; title: string; creator: string | null; kind: PinterestMediaKind | 'carousel'; items: PinterestItem[]; thumbnailUrl: string | null; }
export type PexelsKind = 'photo' | 'video';
export interface PexelsFile { id: string; url: string; width: number | null; height: number | null; label: string; mime: 'image/jpeg' | 'image/png' | 'video/mp4'; size: number | null; }
export interface PexelsAsset { id: number; kind: PexelsKind; title: string; creator: string | null; creatorUrl: string | null; sourceUrl: string; duration: number | null; width: number | null; height: number | null; thumbnailUrl: string | null; files: PexelsFile[]; previewUrl: string | null; }
export type QueueState = 'queued' | 'downloading' | 'preparing' | 'transferring' | 'completed' | 'cancelled' | 'failed';
export interface MediaCard { cardId: string; fileName: string; }
export interface YoutubeChapter { start: number; end: number; title: string; }
export interface YoutubeMetadata { id: string; title: string; duration: number | null; channel: string | null; thumbnailUrl: string | null; heights: number[]; formatSummary: string[]; chapters: YoutubeChapter[]; }
export interface SocialMetadata { id: string; platform: SocialPlatform; source: string; title: string; duration: number | null; channel: string | null; thumbnailDataUrl: string | null; heights: number[]; formatSummary: string[]; }
export interface QueueItem {
  readonly queueId: string;
  readonly provider: Provider;
  readonly platform?: SocialPlatform;
  readonly pexelsAsset?: PexelsAsset;
  readonly pexelsFileId?: string;
  readonly pinterestItem?: PinterestItem;
  readonly pinterestItemIndex?: number;
  readonly jobId: string;
  readonly url: string;
  readonly videoId: string;
  readonly title: string;
  readonly channel: string | null;
  readonly thumbnailDataUrl: string | null;
  readonly quality: YoutubeQuality | 'original';
  readonly profile: MediaProfile;
  readonly options: DownloadOptions;
  readonly targetBin: TargetBin;
  readonly placement: TimelinePlacement;
  readonly intent: DownloadIntent;
  status: QueueState;
  percent: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
  message: string;
  cardId?: string;
  fileName?: string;
  fileDeleted?: boolean;
  subtitle?: MediaCard;
  warning?: string;
  transferError?: string;
  /** A failed queue action other than the Resolve handoff (delete, stop); never shown as a handoff failure. */
  actionError?: string;
  stopping?: boolean;
  deleting?: boolean;
  handingOff?: boolean;
}

// Key format is provider identity: `provider:id` except Pexels which includes kind
// (`pexels:kind:id`) so photo/video pages cannot move a selection onto the wrong kind.
// This string is the identity for stagedSelections and cardRendererStates.
export function resultKeyFor(providerValue: Provider, id: string, kind: PexelsKind = 'video'): string {
  return `${providerValue}:${providerValue === 'pexels' ? `${kind}:` : ''}${id}`;
}

function fingerprint(
  item: Pick<QueueItem, 'provider' | 'platform' | 'videoId' | 'quality' | 'profile' | 'options' | 'targetBin' | 'placement' | 'intent' | 'pexelsFileId'>,
): string {
  return [
    item.provider,
    item.platform ?? '',
    item.videoId,
    item.pexelsFileId ?? item.quality,
    item.profile,
    item.options.mediaMode,
    item.options.audioFormat,
    item.options.subtitles,
    item.options.subtitleLanguage,
    item.targetBin,
    item.placement,
    item.intent,
    ...(item.options.selection ? [Number(item.options.selection.start), Number(item.options.selection.end)] : []),
  ].join('|');
}

function isDuplicateState(status: QueueState): boolean {
  return ['queued', 'downloading', 'preparing', 'transferring', 'completed'].includes(status);
}

export type QueueMetadata = YoutubeMetadata | SocialMetadata | PexelsAsset | PinterestMetadata;
export type QueueInput = {
  provider: Provider;
  output: OutputDefaults;
  metadata: QueueMetadata;
  source: string;
  thumbnailDataUrl: string | null;
};
export type QueueInsertionMode = 'tail' | 'after-active';
type DownloadResult = { cardId: string; fileName: string; subtitle?: MediaCard; warning?: string };
export type QueueEvent = { jobId: string; state: string; message: string; percent: number | null; speedBytesPerSecond?: number | null; etaSeconds?: number | null; cardId?: string; fileName?: string; subtitle?: MediaCard; warning?: string };
export interface QueueAdapter {
  newId(): string;
  download(item: Readonly<QueueItem>): Promise<DownloadResult>;
  cancel(item: Readonly<QueueItem>): Promise<boolean>;
  transfer(cardId: string, bin: TargetBin, action: 'import' | TimelinePlacement): Promise<{ ok: boolean; message: string }>;
  deleteFile(cardId: string): Promise<{ deleted: boolean; message: string }>;
}
export type QueueChange = { item?: Readonly<QueueItem>; progress?: boolean; settled?: boolean; action?: boolean };
function placementForIntent(intent: DownloadIntent): TimelinePlacement { return intent === 'playhead' ? 'playhead' : 'end'; }

/** Session download queue. add() consumes resolved Item output, constructs a whole
 * batch before starting it, and preserves member order for priority insertion.
 * Downloads are serial; host transfers may overlap the next download. Provider
 * events report progress; only the download promise advances execution.
 * Reads are readonly views; all mutations notify subscribers.
 */
export class DownloadQueue {
  private queue: QueueItem[] = [];
  private active: string | null = null;
  private listeners = new Set<(change: QueueChange) => void>();
  constructor(private adapter: QueueAdapter) {}
  get items(): readonly Readonly<QueueItem>[] { return this.queue; }
  get activeId(): string | null { return this.active; }
  subscribe(listener: (change: QueueChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(change: QueueChange = {}): void { for (const listener of this.listeners) listener(change); }

  add(input: QueueInput, mode: QueueInsertionMode = 'tail'): { added: number; duplicate?: string } {
    const candidates: QueueItem[] = [];
    this.construct(input, (item) => { candidates.push(item); });
    let index = mode === 'after-active' && this.active ? this.queue.findIndex((item) => item.queueId === this.active) + 1 : this.queue.length;
    let added = 0;
    let duplicate: string | undefined;
    for (const item of candidates) {
      const existing = this.duplicate(item);
      if (existing) { duplicate = existing.queueId; continue; }
      this.queue.splice(index++, 0, item); added++;
    }
    if (added) { this.changed(); this.pump(); }
    return { added, duplicate };
  }
  private duplicate(item: QueueItem, includeCompleted = true): QueueItem | undefined {
    return this.queue.find((candidate) => isDuplicateState(candidate.status) && (includeCompleted || candidate.status !== 'completed') && fingerprint(candidate) === fingerprint(item));
  }
  private construct({ provider, output, metadata, source, thumbnailDataUrl }: QueueInput, insert: (item: QueueItem) => void): void {
    // Defensive normalization is idempotent. Session preference/capability
    // resolution stays with the Item output session before crossing this seam.
    const settings = normalizeSourceOutput(output, provider, 'files' in metadata && metadata.kind === 'photo');
    if (provider === 'youtube' && 'heights' in metadata && !('platform' in metadata)) {
      const plan = settings.selectionPlan ?? transitionSourceSelection(transitionSourceSelection(null, { type: 'source', source: metadata.id }), { type: 'manual', start: settings.selection ? String(settings.selection.start) : '', end: settings.selection ? String(settings.selection.end) : '' });
      const result = resolveSourceSelection(plan, metadata.id, metadata.duration);
      if (result.status === 'invalid') throw new Error(result.message);
      for (const selection of result.selections) {
        const options: DownloadOptions = { mediaMode: settings.mediaMode, audioFormat: settings.audioFormat, subtitles: settings.subtitles, subtitleLanguage: settings.subtitleLanguage, selection };
        const item: QueueItem = { queueId: this.adapter.newId(), jobId: this.adapter.newId(), provider: 'youtube', url: metadata.id ? `https://www.youtube.com/watch?v=${metadata.id}` : source, videoId: metadata.id, title: metadata.title, channel: metadata.channel, thumbnailDataUrl: metadata.thumbnailUrl ?? thumbnailDataUrl, quality: settings.quality as YoutubeQuality, profile: settings.mediaMode === 'audio' ? 'original' : settings.profile, options, targetBin: settings.targetBin, placement: placementForIntent(settings.intent), intent: settings.intent, status: 'queued', percent: null, speedBytesPerSecond: null, etaSeconds: null, message: 'Queued.' };
        insert(item);
      }
      return;
    }
    if (provider === 'social' && 'platform' in metadata) {
      const item: QueueItem = { queueId: this.adapter.newId(), jobId: this.adapter.newId(), provider: 'social', platform: metadata.platform, url: metadata.source, videoId: metadata.id, title: metadata.title, channel: metadata.channel, thumbnailDataUrl: metadata.thumbnailDataUrl ?? thumbnailDataUrl, quality: settings.quality as YoutubeQuality, profile: settings.profile, options: { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' }, targetBin: settings.targetBin, placement: placementForIntent(settings.intent), intent: settings.intent, status: 'queued', percent: null, speedBytesPerSecond: null, etaSeconds: null, message: 'Queued.' };
      insert(item); return;
    }
    if (provider === 'pexels' && 'files' in metadata) {
      const file = resolvePexelsRendition(metadata.kind, metadata.files, settings.quality);
      if (!file) throw new Error('Pexels returned no supported source rendition.');
      const height = renditionHeight(file);
      const item: QueueItem = { queueId: this.adapter.newId(), jobId: this.adapter.newId(), provider: 'pexels', pexelsAsset: metadata, pexelsFileId: file.id, url: metadata.sourceUrl, videoId: String(metadata.id), title: metadata.title, channel: metadata.creator, thumbnailDataUrl: metadata.thumbnailUrl ?? thumbnailDataUrl, quality: (metadata.kind === 'photo' ? 'original' : height ? `${height}p` : 'best') as QueueItem['quality'], profile: metadata.kind === 'photo' ? 'original' : settings.profile, options: { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' }, targetBin: settings.targetBin, placement: placementForIntent(settings.intent), intent: settings.intent, status: 'queued', percent: null, speedBytesPerSecond: null, etaSeconds: null, message: 'Queued.' };
      insert(item); return;
    }
    if (provider === 'pinterest' && 'items' in metadata) {
      if (!metadata.items.length) throw new Error('Pinterest returned no downloadable Pin items.');
      const intent = metadata.items.length > 1 ? 'download' : settings.intent;
      for (const pinterestItem of metadata.items) {
        const item: QueueItem = { queueId: this.adapter.newId(), jobId: this.adapter.newId(), provider: 'pinterest', pinterestItem, pinterestItemIndex: pinterestItem.index, url: metadata.source, videoId: `${metadata.pinId}:${pinterestItem.index}`, title: pinterestItem.title, channel: pinterestItem.creator ?? metadata.creator, thumbnailDataUrl: thumbnailDataUrl ?? metadata.thumbnailUrl, quality: 'original', profile: pinterestItem.kind === 'image' ? 'original' : settings.profile, options: { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' }, targetBin: settings.targetBin, placement: placementForIntent(intent), intent, status: 'queued', percent: null, speedBytesPerSecond: null, etaSeconds: null, message: 'Queued.' };
        insert(item);
      }
      return;
    }
  }

  remove(id: string): void {
    if (id === this.active) return;
    const index = this.queue.findIndex((item) => item.queueId === id);
    if (index >= 0) { this.queue.splice(index, 1); this.changed(); }
  }
  repeat(id: string, again = false): { added: number; duplicate?: string } {
    const item = this.queue.find((item) => item.queueId === id);
    if (!item || (again ? item.status !== 'completed' : !['failed', 'cancelled'].includes(item.status))) return { added: 0 };
    const duplicate = this.duplicate(item, !again);
    if (duplicate) return { added: 0, duplicate: duplicate.queueId };
    this.queue.push({ ...item, queueId: this.adapter.newId(), jobId: this.adapter.newId(), status: 'queued', percent: null, speedBytesPerSecond: null, etaSeconds: null, message: 'Queued.', cardId: undefined, fileName: undefined, fileDeleted: undefined, subtitle: undefined, warning: undefined, transferError: undefined, actionError: undefined, stopping: false, deleting: false, handingOff: false });
    this.changed(); this.pump();
    return { added: 1 };
  }
  async stop(id: string): Promise<void> {
    const item = this.queue.find((item) => item.queueId === id);
    if (!item || id !== this.active || !['downloading', 'preparing'].includes(item.status) || item.stopping) return;
    item.stopping = true; this.changed();
    try {
      if (!await this.adapter.cancel(item) && item.status !== 'cancelled') item.actionError = item.message = 'Could not stop this download. Try again.';
    } catch (error) { if (item.status !== 'cancelled') item.actionError = item.message = (error as Error).message; }
    finally { item.stopping = false; this.changed(); }
  }
  async transfer(id: string, action: 'import' | TimelinePlacement, reason?: string | null): Promise<void> {
    const item = this.queue.find((item) => item.queueId === id);
    if (!item || item.fileDeleted || !item.cardId || item.handingOff) return;
    if (reason) { item.message = item.transferError = reason; this.changed(); return; }
    item.handingOff = true; item.actionError = undefined; this.changed();
    await this.handoff(item, action, false);
    item.handingOff = false; this.changed({ item, action: true });
  }
  private async handoff(item: QueueItem, action: 'import' | TimelinePlacement, automatic: boolean): Promise<void> {
    try {
      const result = await this.adapter.transfer(item.cardId!, item.targetBin, action);
      item.transferError = result.ok ? undefined : result.message;
      item.message = automatic && !result.ok ? `Download complete. ${result.message}` : result.message;
    } catch (error) {
      item.transferError = (error as Error).message;
      item.message = automatic ? `Download complete. ${item.transferError}` : item.transferError;
    }
  }
  async deleteFile(id: string): Promise<void> {
    const item = this.queue.find((item) => item.queueId === id);
    if (!item || item.fileDeleted || item.status !== 'completed' || !item.cardId || id === this.active || item.deleting) return;
    item.deleting = true; this.changed();
    try {
      const result = await this.adapter.deleteFile(item.cardId);
      item.message = result?.message || 'File was not deleted safely. It remains in the queue.';
      item.actionError = result?.deleted === true ? undefined : item.message;
      if (result?.deleted === true) this.remove(id);
    } catch (error) { item.actionError = item.message = (error as Error).message; }
    finally { item.deleting = false; this.changed({ item, action: true }); }
  }
  invalidateCards(cardIds: readonly string[] = []): void {
    if (!cardIds.length) return;
    const removed = new Set(cardIds);
    for (const item of this.queue) if (item.cardId && removed.has(item.cardId)) item.fileDeleted = true;
    this.changed();
  }
  event(provider: Provider, event: QueueEvent): void {
    const item = this.queue.find((item) => item.provider === provider && item.jobId === event.jobId);
    if (!item || item.queueId !== this.active || !['downloading', 'preparing'].includes(item.status)) return;
    const previous = item.status;
    if (event.state === 'downloading') item.status = 'downloading';
    else if (event.state === 'processing') item.status = 'preparing';
    else if (event.state === 'cancelled') item.status = 'cancelled';
    else if (event.state === 'failed') item.status = 'failed';
    if (event.state === 'completed') {
      if (provider !== 'youtube') { item.cardId = event.cardId; item.fileName = event.fileName; }
      item.subtitle = event.subtitle; item.warning = event.warning;
    }
    if (event.state !== 'completed' || provider === 'pexels') item.message = event.message;
    item.percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(100, event.percent!)) : null;
    item.speedBytesPerSecond = item.status === 'downloading' && Number.isFinite(event.speedBytesPerSecond) && event.speedBytesPerSecond! >= 0 ? event.speedBytesPerSecond! : null;
    item.etaSeconds = item.status === 'downloading' && Number.isFinite(event.etaSeconds) && event.etaSeconds! >= 0 ? Math.min(604800, event.etaSeconds!) : null;
    this.changed({ item, progress: previous === item.status && !['completed', 'failed', 'cancelled'].includes(event.state) });
  }
  private pump(): void {
    if (this.active) return;
    const item = this.queue.find((item) => item.status === 'queued');
    if (!item) return;
    this.active = item.queueId; item.status = 'downloading'; item.message = 'Downloading…';
    this.changed({ item });
    void this.run(item);
  }
  private async run(item: QueueItem): Promise<void> {
    try {
      const result = await this.adapter.download(item);
      if (item.status === 'cancelled') return;
      Object.assign(item, { cardId: result.cardId, fileName: result.fileName, subtitle: result.subtitle, warning: result.warning, percent: 100 });
      if (item.intent === 'download') { item.status = 'completed'; item.message = 'Download complete.'; }
      else {
        item.status = 'transferring'; item.speedBytesPerSecond = null; item.etaSeconds = null;
        item.message = item.intent === 'import' ? 'Adding to Media Pool…' : item.intent === 'playhead' ? 'Adding at playhead…' : 'Adding to timeline end…';
        this.changed({ item });
        this.active = null; this.pump();
        await this.handoff(item, item.intent, true);
        item.status = 'completed';
      }
    } catch (error) { if (item.status !== 'cancelled') { item.status = 'failed'; item.message = (error as Error).message; } }
    finally {
      if (this.active === item.queueId) this.active = null;
      this.changed({ item, settled: true });
      this.pump();
    }
  }
}
