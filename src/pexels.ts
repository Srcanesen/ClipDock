// Pexels BYOK boundary. Node-only: main owns this module and never exposes its key or paths.
import { createWriteStream, lstatSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { ProviderJobRunner, ProviderJobCancelledError } from './provider-job';
import { isValidPexelsKey } from './pexels-credential';
import { LruCache } from './provider-platform';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, createDirectory, openExclusive, prepareDirectory, publishNoReplace, verifyFile } from './safe-fs';

export type PexelsKind = 'photo' | 'video';
export type PexelsFile = { id: string; url: string; width: number | null; height: number | null; label: string; mime: 'image/jpeg' | 'image/png' | 'video/mp4'; size: number | null };
export type PexelsAsset = { id: number; kind: PexelsKind; title: string; creator: string | null; creatorUrl: string | null; sourceUrl: string; duration: number | null; width: number | null; height: number | null; thumbnailUrl: string | null; files: PexelsFile[]; previewUrl: string | null };
export type PexelsPage = { query: string; page: number; pageSize: number; results: PexelsAsset[]; hasPrevious: boolean; hasNext: boolean; totalResults: number | null };
export type PexelsEvent = { jobId: string; state: 'downloading' | 'processing' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; cardId?: string; fileName?: string };
export type PexelsConnectionStatus = { connected: boolean; persisted: boolean; message: string };

const API = 'api.pexels.com';
const MAX_SEARCH_PAGE = 100;
const CDN_HOSTS = new Set(['images.pexels.com', 'videos.pexels.com']);
const MAX_API_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const METADATA_CACHE_MAX = 60;
const METADATA_CACHE_TTL = 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 3;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

const safeText = (value: unknown, max = 240): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positiveInteger = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : finite(value);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
};
const inRoot = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
};
const contentType = (response: Response): string =>
  response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';

// Cancellation must not wait for a hostile upstream body to acknowledge it.
function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('Pexels request cancelled.'));
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, {once: true});
  });
}

export function safePexelsUrl(value: unknown, api = false): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (api ? url.hostname === API : CDN_HOSTS.has(url.hostname)) return url;
  } catch {
    // Invalid URL.
  }
  return null;
}

export function safePexelsExternal(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.pexels.com' || url.username || url.password || url.port || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function title(raw: Record<string, unknown>, kind: PexelsKind, id: number): string {
  if (kind === 'photo') return safeText(raw.alt) ?? `Pexels photo ${id}`;
  return safeText(raw.title) ?? `Pexels video ${id}`;
}

function dimensionsFromUrl(url: URL, width: number | null, height: number | null): [number | null, number | null] {
  if (width === null || height === null) return [null, null];
  const boundWidth = positiveInteger(url.searchParams.get('w') ?? url.searchParams.get('width'));
  const boundHeight = positiveInteger(url.searchParams.get('h') ?? url.searchParams.get('height'));
  if (boundWidth === null && boundHeight === null) return [width, height];
  // The uncropped src renditions fit inside these bounds, preserving the
  // original aspect ratio. DPR scales the fitted size, not the bounding box label.
  const requestedDpr = Number(url.searchParams.get('dpr') ?? '1');
  const dpr = Number.isFinite(requestedDpr) && requestedDpr > 0 ? requestedDpr : 1;
  const scale = Math.min(boundWidth === null ? Infinity : boundWidth / width, boundHeight === null ? Infinity : boundHeight / height) * dpr;
  return [positiveInteger(Math.round(width * scale)), positiveInteger(Math.round(height * scale))];
}

function fileLabel(width: number | null, height: number | null, name: string): string {
  return width && height ? `${name} · ${width}×${height}` : name;
}

function imageFile(id: string, value: unknown, width: number | null, height: number | null, name: string): PexelsFile | null {
  const url = safePexelsUrl(value);
  if (!url) return null;
  const dimensions = dimensionsFromUrl(url, width, height);
  const mime = /\.png$/i.test(url.pathname) ? 'image/png' : 'image/jpeg';
  return {
    id,
    url: url.toString(),
    width: dimensions[0],
    height: dimensions[1],
    label: fileLabel(dimensions[0], dimensions[1], name),
    mime,
    size: null,
  };
}

function normalize(raw: unknown, kind: PexelsKind): PexelsAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const id = positiveInteger(source.id);
  const width = positiveInteger(source.width);
  const height = positiveInteger(source.height);
  if (id === null) return null;

  const sourceUrl = safePexelsExternal(source.url) ?? `https://www.pexels.com/${kind === 'photo' ? 'photo' : 'video'}/${id}/`;
  const user = source.user && typeof source.user === 'object' ? source.user as Record<string, unknown> : {};
  const creator = safeText(source.photographer ?? user.name);
  const creatorUrl = safePexelsExternal(source.photographer_url ?? user.url);
  const files: PexelsFile[] = [];

  if (kind === 'photo') {
    const src = source.src && typeof source.src === 'object' ? source.src as Record<string, unknown> : {};
    const variants: Array<[string, string]> = [
      ['original', 'Original'],
      ['large2x', 'Large 2×'],
      ['large', 'Large'],
      ['medium', 'Medium'],
      ['small', 'Small'],
    ];
    for (const [name, displayName] of variants) {
      const file = imageFile(name, src[name], width, height, displayName);
      if (file && !files.some((item) => item.url === file.url)) files.push(file);
    }
  } else {
    const seen = new Set<string>();
    const rawFiles = Array.isArray(source.video_files) ? source.video_files : [];
    for (const rawFile of rawFiles) {
      if (!rawFile || typeof rawFile !== 'object') continue;
      const file = rawFile as Record<string, unknown>;
      const fileId = positiveInteger(file.id);
      const url = safePexelsUrl(file.link);
      const mime = safeText(file.file_type, 40);
      const fileWidth = positiveInteger(file.width);
      const fileHeight = positiveInteger(file.height);
      if (fileId === null || !url || mime !== 'video/mp4') continue;
      const choice = `${mime}:${fileWidth ?? ''}x${fileHeight ?? ''}`;
      if (seen.has(choice)) continue;
      seen.add(choice);
      files.push({
        id: String(fileId),
        url: url.toString(),
        width: fileWidth,
        height: fileHeight,
        label: fileLabel(fileWidth, fileHeight, safeText(file.quality, 30) ?? 'MP4'),
        mime: 'video/mp4',
        size: positiveInteger(file.file_size),
      });
    }
    files.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || (b.height ?? 0) - (a.height ?? 0));
  }

  const src = source.src && typeof source.src === 'object' ? source.src as Record<string, unknown> : {};
  const thumbValue = kind === 'photo' ? src.medium ?? src.small : source.image;
  const thumbnail = safePexelsUrl(thumbValue);
  const thumbnailUrl = thumbnail?.hostname === 'images.pexels.com' ? thumbnail.href : null;
  const previewUrl = kind === 'video'
    ? files.find((file) => (file.height ?? Infinity) <= 540)?.url ?? files.at(-1)?.url ?? null
    : null;

  return {
    id,
    kind,
    title: title(source, kind, id),
    creator,
    creatorUrl,
    sourceUrl,
    duration: finite(source.duration),
    width,
    height,
    thumbnailUrl,
    files,
    previewUrl,
  };
}

export function parsePexelsPage(raw: unknown, kind: PexelsKind, query: string, page: number): PexelsPage {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const key = kind === 'photo' ? 'photos' : 'videos';
  const data = Array.isArray(value[key]) ? value[key] as unknown[] : [];
  const seen = new Set<number>();
  const results = data.flatMap((item): PexelsAsset[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const asset = normalize(item, kind);
    if (!asset || seen.has(asset.id)) return [];
    seen.add(asset.id);
    return [asset];
  });
  return {
    query,
    page,
    pageSize: 15,
    results,
    hasPrevious: page > 1,
    hasNext: page < MAX_SEARCH_PAGE && typeof value.next_page === 'string',
    totalResults: finite(value.total_results),
  };
}

type SharedMetadataRequest = {
  controller: AbortController;
  promise: Promise<Record<string, unknown>>;
  consumers: Set<symbol>;
  settled: boolean;
};

export class PexelsClient {
  #key: string | null = null;
  #persisted = false;
  #connectionMessage = 'Disconnected.';
  #downloads = new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'Pexels client is shut down.'});
  #apiJobs = new ProviderJobRunner({cancelledMessage: 'Pexels request cancelled.', disposedMessage: 'Pexels client is shut down.'});
  #metadataCache: LruCache<string, Record<string, unknown>>;
  #metadataPending = new Map<string, SharedMetadataRequest>();
  #cooldowns: LruCache<string, number>;
  #setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  #clearTimeout: typeof clearTimeout;
  #root: string;
  #parent: AnchoredDir;
  #directory: AnchoredDir;
  #fetch: typeof fetch;
  #now: () => number;

  constructor(root = join(tmpdir(), 'clipdock-pexels', randomUUID()), fetchFn?: typeof fetch, options: {now?: () => number; setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimeout?: typeof clearTimeout} = {}) {
    this.#fetch = fetchFn ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.#metadataCache = new LruCache(METADATA_CACHE_MAX, METADATA_CACHE_TTL, this.#now);
    this.#cooldowns = new LruCache(4, MAX_COOLDOWN_MS, this.#now);
    this.#root = prepareDirectory(resolve(root)).verify();
    const boundary = ManagedRoot.capture(dirname(this.#root));
    this.#parent = AnchoredDir.capture(boundary.verify(), boundary);
    this.#directory = AnchoredDir.capture(this.#root, boundary);
  }

  /**
   * Move future downloads to a new root (download folder change). In-flight
   * downloads keep their already-resolved output path.
   */
  setRoot(root: string): void {
    this.#root = prepareDirectory(resolve(root)).verify();
    const boundary = ManagedRoot.capture(dirname(this.#root));
    this.#parent = AnchoredDir.capture(boundary.verify(), boundary);
    this.#directory = AnchoredDir.capture(this.#root, boundary);
  }

  #outputDirectory(): AnchoredDir {
    try { this.#directory.verify(); }
    catch (error) {
      // Only a pruned (absent) entry may be recreated, through the captured parent.
      try { lstatSync(this.#root); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.#directory = createDirectory(this.#parent, basename(this.#root));
        return this.#directory;
      }
      throw error;
    }
    return this.#directory;
  }

  status(): PexelsConnectionStatus {
    return { connected: this.#key !== null, persisted: this.#persisted, message: this.#connectionMessage };
  }

  restoreKey(key: string, persisted: boolean, message: string): boolean {
    if (!isValidPexelsKey(key)) return false;
    if (this.#key !== key) this.#resetMetadata();
    this.#key = key;
    this.#persisted = persisted;
    this.#connectionMessage = message;
    return true;
  }

  #resetMetadata(): void {
    this.abortApiRequests();
    this.#metadataCache.clear();
    this.#metadataPending.clear();
  }

  restoreStatus(message: string): void { this.#connectionMessage = message; }

  async validateKey(value: unknown): Promise<string> {
    if (!isValidPexelsKey(value)) throw new Error('Enter a valid Pexels API key.');
    await this.#runApi('validate', (signal) => this.#requestJson(new URL('/v1/curated?per_page=1', `https://${API}`), signal, value));
    return value;
  }

  setKey(value: string, persisted: boolean): PexelsConnectionStatus {
    if (this.#key !== value) this.#resetMetadata();
    this.#key = value;
    this.#persisted = persisted;
    this.#connectionMessage = persisted ? 'Connected · saved securely' : 'Connected for this session; secure saving unavailable';
    return this.status();
  }

  clearKey(): void {
    this.#resetMetadata();
    this.#key = null;
    this.#persisted = false;
    this.#connectionMessage = 'Disconnected.';
    this.cancel();
  }

  abortApiRequests(): boolean {
    const pending = this.#apiJobs.cancel();
    // Retries must not attach to a request whose cancellation cleanup is pending.
    this.#metadataPending.clear();
    return pending !== null;
  }

  isDownloading(): boolean { return this.#downloads.isActive(); }

  cancel(jobId?: string): Promise<void> | null {
    const pending = [this.#downloads.cancel(jobId), this.#apiJobs.cancel(jobId)].filter((done): done is Promise<void> => done !== null);
    return pending.length ? Promise.all(pending).then(() => undefined) : null;
  }

  async #runApi<T>(name: 'search' | 'load' | 'validate', task: (signal: AbortSignal, metadataReady: () => void) => Promise<T>, jobId?: string): Promise<T> {
    const slot = jobId ?? `${name}-${randomUUID()}`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await this.#apiJobs.run(slot, context => {
        timeout = this.#setTimeout(() => { this.#apiJobs.cancel(slot, new Error('Pexels request timed out.')); }, API_TIMEOUT_MS);
        return task(context.signal, () => this.#clearTimeout(timeout));
      }, {cancelledEventMessage: jobId ? 'Download cancelled.' : undefined, mapError: error => error.message.startsWith('Pexels ') ? error : new Error('Pexels request failed.')});
    } finally { this.#clearTimeout(timeout); }
  }

  async #requestJson(url: URL, signal: AbortSignal, key = this.#key): Promise<Record<string, unknown>> {
    if (!key) throw new Error('Connect a Pexels API key.');
    const reusable = url.pathname !== '/v1/curated';
    const cacheKey = `${key}:${url}`;
    const cached = reusable ? this.#metadataCache.get(cacheKey) : undefined;
    if (cached) return structuredClone(cached);
    let request = reusable ? this.#metadataPending.get(cacheKey) : undefined;
    if (!request) {
      const cooldown = this.#cooldowns.get(key) ?? 0;
      if (cooldown > this.#now()) throw new Error('Pexels quota reached. Try again after the provider rate limit resets.');
      // Key validation shares quota accounting, but never joins cached/shared work.
      if (!reusable) return this.#fetchJson(url, signal, key);
      const controller = new AbortController();
      const promise = this.#fetchJson(url, controller.signal, key).then(raw => {
        if (!controller.signal.aborted && key === this.#key) this.#metadataCache.set(cacheKey, structuredClone(raw));
        return raw;
      }).finally(() => {
        entry.settled = true;
        if (this.#metadataPending.get(cacheKey) === entry) this.#metadataPending.delete(cacheKey);
      });
      const entry: SharedMetadataRequest = {controller, promise, consumers: new Set(), settled: false};
      if (this.#metadataPending.size < METADATA_CACHE_MAX) this.#metadataPending.set(cacheKey, entry);
      request = entry;
    }
    const shared = request;
    const consumer = Symbol();
    shared.consumers.add(consumer);
    let termination: Promise<unknown> | undefined;
    const detach = (): void => {
      shared.consumers.delete(consumer);
      if (!shared.settled && !shared.consumers.size && !shared.controller.signal.aborted) {
        // Remove synchronously: an immediate retry must never join abandoned work.
        if (this.#metadataPending.get(cacheKey) === shared) this.#metadataPending.delete(cacheKey);
        shared.controller.abort(signal.reason);
        // The last consumer owns upstream termination, including a late HTTP body.
        termination = shared.promise.catch(() => undefined);
      }
    };
    signal.addEventListener('abort', detach, {once: true});
    if (signal.aborted) detach();
    try { return structuredClone(await abortable(shared.promise, signal)); }
    finally {
      signal.removeEventListener('abort', detach);
      detach();
      await termination;
    }
  }

  async #fetchJson(url: URL, signal: AbortSignal, key: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetchResponse(url, { headers: { Authorization: key }, signal, redirect: 'error' }, signal);
    } catch {
      if (signal.aborted) throw new Error('Pexels request cancelled.');
      throw new Error('Pexels request failed.');
    }
    if (response.status === 429) {
      const now = this.#now();
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 + now : Date.parse(retry ?? '');
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const reset = resetHeader && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 : NaN;
      const deadlines = [seconds, reset].filter(value => Number.isFinite(value) && value > now);
      const until = Math.min(now + MAX_COOLDOWN_MS, deadlines.length ? Math.max(...deadlines) : now + 60_000);
      this.#cooldowns.set(key, until);
      cancelBody(response);
      throw new Error('Pexels quota reached. Try again after the provider rate limit resets.');
    }
    if (!response.ok || contentType(response) !== 'application/json') cancelBody(response);
    if (response.status === 401 || response.status === 403) throw new Error('Pexels rejected the API key.');
    if (!response.ok) throw new Error(`Pexels request failed (${response.status}).`);
    if (contentType(response) !== 'application/json') throw new Error('Pexels returned invalid API data.');
    const bytes = await this.#readBody(response, MAX_API_BYTES, signal, 'Pexels API response is too large.');
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('Pexels returned invalid API data.');
    }
  }

  async search(kind: unknown, query: unknown, page: unknown): Promise<PexelsPage> {
    if ((kind !== 'photo' && kind !== 'video') || typeof query !== 'string' || query.trim().length < 2 || query.length > 100) {
      throw new Error('Enter 2–100 characters to search Pexels.');
    }
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > MAX_SEARCH_PAGE) throw new Error(`Pexels page must be between 1 and ${MAX_SEARCH_PAGE}.`);
    return this.#runApi('search', async (signal, metadataReady) => {
      const url = new URL(kind === 'photo' ? '/v1/search' : '/videos/search', `https://${API}`);
      url.searchParams.set('query', query.trim());
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '15');
      const raw = await this.#requestJson(url, signal);
      metadataReady();
      return parsePexelsPage(raw, kind, query.trim(), page as number);
    });
  }

  async load(kind: unknown, id: unknown, context?: {jobId: string}): Promise<PexelsAsset> {
    if ((kind !== 'photo' && kind !== 'video') || !Number.isInteger(id) || (id as number) < 1) throw new Error('Invalid Pexels asset.');
    return this.#runApi('load', async (signal, metadataReady) => {
      const endpoint = kind === 'photo' ? `/v1/photos/${id}` : `/videos/videos/${id}`;
      const raw = await this.#requestJson(new URL(endpoint, `https://${API}`), signal);
      metadataReady();
      const result = normalize(raw, kind);
      if (!result) throw new Error('Pexels returned invalid media metadata.');
      if (signal.aborted) throw new Error('Pexels request cancelled.');
      return result;
    }, context?.jobId);
  }

  async download(jobId: unknown, file: PexelsFile, emit: (event: PexelsEvent) => void): Promise<{ filePath: string; fileName: string }> {
    if (typeof jobId !== 'string' || !safePexelsUrl(file.url)) throw new Error('Invalid Pexels download request.');
    const max = file.mime === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const ext = file.mime === 'video/mp4' ? '.mp4' : file.mime === 'image/png' ? '.png' : '.jpg';
    let directory: AnchoredDir;
    try { directory = this.#outputDirectory(); } catch { throw new Error('Pexels media download failed.'); }
    const final = directory.child(`pexels-${randomUUID()}${ext}`);
    const temp = `${final}.part`;
    if (!inRoot(this.#root, final)) throw new Error('Unsafe Pexels output path.');

    return await this.#downloads.run(jobId, async context => {
      const expire = (): void => { this.#downloads.cancel(jobId, new Error('Pexels media download timed out.')); };
      let idle = this.#setTimeout(expire, DOWNLOAD_IDLE_TIMEOUT_MS);
      const overall = this.#setTimeout(expire, DOWNLOAD_TIMEOUT_MS);
      const resetIdle = (): void => { this.#clearTimeout(idle); idle = this.#setTimeout(expire, DOWNLOAD_IDLE_TIMEOUT_MS); };
      let out: ReturnType<typeof createWriteStream> | null = null;
      try {
        emit({ jobId, state: 'downloading', percent: 0, message: 'Downloading from Pexels…' });
        const response = await this.#fetchMedia(file.url, context.signal);
        const lengthHeader = response.headers.get('content-length');
        const length = lengthHeader === null ? NaN : Number(lengthHeader);
        if (Number.isFinite(length) && (length < 1 || length > max)) {
          cancelBody(response);
          throw new Error('Pexels media exceeds the download size limit.');
        }
        if (contentType(response) !== file.mime) {
          cancelBody(response);
          throw new Error('Pexels returned an unexpected media type.');
        }
        if (!response.body) throw new Error('Pexels returned no media body.');

        let written = 0;
        let lastProgressAt = -Infinity;
        const emitProgress = (percent: number | null, force = false): void => {
          const now = Date.now();
          if (!force && now - lastProgressAt < 150) return;
          lastProgressAt = now;
          emit({ jobId, state: 'downloading', percent, message: 'Downloading from Pexels…' });
        };
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            resetIdle();
            written += chunk.byteLength;
            if (written > max) {
              callback(new Error('Pexels media exceeds the download size limit.'));
              return;
            }
            emitProgress(Number.isFinite(length) && length > 0 ? Math.min(99.9, written / length * 100) : null);
            callback(null, chunk);
          },
        });
        const opened = openExclusive(directory, basename(temp));
        context.register(opened.file);
        out = createWriteStream(temp, {fd: opened.fd, autoClose: true});
        await pipeline(Readable.fromWeb(response.body as never), meter, out, {signal: context.signal});
        emitProgress(100, true);
        context.check();
        const temporary = context.owned(temp);
        if (statSync(verifyFile(temporary)).size < 1) throw new Error('Pexels media download was empty.');
        const published = publishNoReplace(temporary, directory, basename(final));
        context.register(published);
        context.publish(final);
        return { filePath: final, fileName: basename(final) };
      } catch (error) {
        if (out && !out.destroyed) out.destroy();
        if (out) await finished(out).catch(() => undefined);
        throw error;
      } finally {
        this.#clearTimeout(idle);
        this.#clearTimeout(overall);
      }
    }, {invalidMessage: 'Invalid Pexels download request.', notifyFailure: error => error.message === 'Pexels media download timed out.', mapError: error => {
      const message = error.message;
      if (message.startsWith('Pexels ') || message === 'Unsafe Pexels output path.') return error;
      return new Error('Pexels media download failed.');
    }});
  }

  async #fetchResponse(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const pending = this.#fetch(url, init);
    void pending.then(response => {
      if (signal.aborted && !(signal.reason instanceof ProviderJobCancelledError)) cancelBody(response);
    }, () => undefined);
    try { return await abortable(pending, signal); }
    catch (error) {
      if (signal.reason instanceof ProviderJobCancelledError) {
        const response = await pending.catch(() => null);
        if (response) await response.body?.cancel();
      }
      throw error;
    }
  }

  async #fetchMedia(value: string, signal: AbortSignal): Promise<Response> {
    let url = safePexelsUrl(value);
    for (let redirects = 0; url && redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetchResponse(url, { signal, redirect: 'manual' }, signal);
      } catch {
        if (signal.aborted) throw new Error('Download cancelled.');
        throw new Error('Pexels media request failed.');
      }
      if (response.status >= 300 && response.status < 400) {
        cancelBody(response);
        const location = response.headers.get('location');
        url = location ? safePexelsUrl(new URL(location, url).toString()) : null;
        continue;
      }
      if (!response.ok) cancelBody(response);
      if (!response.ok) throw new Error(`Pexels media request failed (${response.status}).`);
      return response;
    }
    throw new Error('Pexels media redirect was rejected.');
  }

  async #readBody(response: Response, max: number, signal: AbortSignal, tooLargeMessage: string): Promise<Buffer> {
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    if (Number.isFinite(length) && (length < 0 || length > max)) { cancelBody(response); throw new Error(tooLargeMessage); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Pexels returned no response body.');
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error('Pexels request cancelled.');
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          throw new Error(tooLargeMessage);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally { reader.releaseLock(); }
  }

  async #downloadBuffer(url: string, max: number, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    const response = await this.#fetchMedia(url, signal);
    const mime = contentType(response);
    const bytes = await this.#readBody(response, max, signal, 'Pexels thumbnail exceeds the size limit.');
    return { bytes, mime };
  }

  async dispose(): Promise<void> {
    this.clearKey();
    await Promise.all([this.#downloads.dispose(), this.#apiJobs.dispose()]);
  }
}
