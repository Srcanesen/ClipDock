// Stock-media BYOK boundary shared by Pexels and Pixabay. Node-only: main owns
// this module and never exposes its key or paths. A StockSource adapter supplies
// the provider's endpoints, authentication placement, parsing and host allowlists.
import { createWriteStream, lstatSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { ProviderJobRunner, abortable, abortableFetch, cancelBody } from './provider-job';
import { isValidPexelsKey as isValidStockKey } from './pexels-credential';
import { LruCache } from './provider-platform';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, createDirectory, openExclusive, prepareDirectory, publishNoReplace, verifyFile } from './safe-fs';

export type StockKind = 'photo' | 'video';
export type StockFile = { id: string; url: string; width: number | null; height: number | null; label: string; mime: 'image/jpeg' | 'image/png' | 'video/mp4'; size: number | null };
export type StockAsset = { id: number; kind: StockKind; title: string; creator: string | null; creatorUrl: string | null; sourceUrl: string; duration: number | null; width: number | null; height: number | null; thumbnailUrl: string | null; files: StockFile[]; previewUrl: string | null };
export type StockPage = { query: string; page: number; pageSize: number; results: StockAsset[]; hasPrevious: boolean; hasNext: boolean; totalResults: number | null };
export type StockEvent = { jobId: string; state: 'downloading' | 'processing' | 'completed' | 'cancelled' | 'failed'; percent: number | null; message: string; cardId?: string; fileName?: string };
export type StockConnectionStatus = { connected: boolean; persisted: boolean; message: string };

export interface StockSource {
  /** Display name; every user-facing message starts with it. */
  label: string;
  /** Downloaded file names start with `${prefix}-`. */
  prefix: string;
  mediaHosts: ReadonlySet<string>;
  kinds: readonly StockKind[];
  maxPage: number;
  /** 'header' sends `Authorization: key`; 'query' appends `key=` only at fetch time. */
  auth: 'header' | 'query';
  cacheTtlMs: number;
  /** X-RateLimit-Reset carries remaining seconds instead of an epoch second. */
  resetIsRelative: boolean;
  rejectedStatuses: readonly number[];
  /** Statuses that mean a rejected key only while validating one (Pixabay answers 400 for a bad key and for bad parameters). */
  validationRejectedStatuses?: readonly number[];
  validateUrl(): URL;
  searchUrl(kind: StockKind, query: string, page: number): URL;
  loadUrl(kind: StockKind, id: number): URL;
  parsePage(raw: unknown, kind: StockKind, query: string, page: number): StockPage;
  parseAsset(raw: Record<string, unknown>, kind: StockKind, id: number): StockAsset | null;
}

const MAX_API_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const METADATA_CACHE_MAX = 60;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 3;

export const safeText = (value: unknown, max = 240): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
export const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const positiveInteger = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : finite(value);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
};
export const fileLabel = (width: number | null, height: number | null, name: string): string =>
  width && height ? `${name} · ${width}×${height}` : name;
const inRoot = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
};
const contentType = (response: Response): string =>
  response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';

/** HTTPS URL on an allowlisted host, without credentials, port or fragment. */
export function safeHostUrl(value: unknown, hosts: ReadonlySet<string>): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (hosts.has(url.hostname)) return url;
  } catch {
    // Invalid URL.
  }
  return null;
}

// Node's web-stream adapter waits for the source to acknowledge cancellation;
// this proxy acknowledges at once and terminates the upstream body in the background.
function detachCancel(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      const {done, value} = await reader.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
    cancel(reason) { void reader.cancel(reason).catch(() => undefined); },
  });
}

type SharedMetadataRequest = {
  controller: AbortController;
  promise: Promise<Record<string, unknown>>;
  consumers: Set<symbol>;
  settled: boolean;
};

export type StockClientOptions = {now?: () => number; setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimeout?: typeof clearTimeout};

export class StockClient {
  #source: StockSource;
  #label: string;
  #cancelled: string;
  #noKey: string;
  #key: string | null = null;
  #persisted = false;
  #connectionMessage = 'Disconnected.';
  #downloads: ProviderJobRunner;
  #apiJobs: ProviderJobRunner;
  // Metadata steps of download jobs; browse cancellation must not reach them.
  #jobApiJobs: ProviderJobRunner;
  #metadataCache: LruCache<string, Record<string, unknown>>;
  #metadataPending = new Map<string, SharedMetadataRequest>();
  #terminations = new Set<Promise<unknown>>();
  #cooldowns: LruCache<string, number>;
  #setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  #clearTimeout: typeof clearTimeout;
  #root: string;
  #parent: AnchoredDir;
  #directory: AnchoredDir;
  #fetch: typeof fetch;
  #now: () => number;

  constructor(source: StockSource, root = join(tmpdir(), `clipdock-${source.prefix}`, randomUUID()), fetchFn?: typeof fetch, options: StockClientOptions = {}) {
    this.#source = source;
    this.#label = source.label;
    this.#cancelled = `${source.label} request cancelled.`;
    this.#noKey = `Connect a ${source.label} API key.`;
    const disposedMessage = `${source.label} client is shut down.`;
    this.#downloads = new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage});
    this.#apiJobs = new ProviderJobRunner({cancelledMessage: this.#cancelled, disposedMessage});
    this.#jobApiJobs = new ProviderJobRunner({cancelledMessage: this.#cancelled, disposedMessage});
    this.#fetch = fetchFn ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.#metadataCache = new LruCache(METADATA_CACHE_MAX, source.cacheTtlMs, this.#now);
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

  status(): StockConnectionStatus {
    return { connected: this.#key !== null, persisted: this.#persisted, message: this.#connectionMessage };
  }

  restoreKey(key: string, persisted: boolean, message: string): boolean {
    if (!isValidStockKey(key)) return false;
    if (this.#key !== key) this.#resetMetadata();
    this.#key = key;
    this.#persisted = persisted;
    this.#connectionMessage = message;
    return true;
  }

  #resetMetadata(): void {
    this.abortApiRequests();
    this.#jobApiJobs.cancel();
    this.#metadataCache.clear();
    this.#metadataPending.clear();
  }

  restoreStatus(message: string): void { this.#connectionMessage = message; }

  async validateKey(value: unknown): Promise<string> {
    if (!isValidStockKey(value)) throw new Error(`Enter a valid ${this.#label} API key.`);
    await this.#runApi('validate', (signal) => this.#requestJson(this.#source.validateUrl(), signal, value, false, true));
    return value;
  }

  setKey(value: string, persisted: boolean): StockConnectionStatus {
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
    const pending = [this.#downloads.cancel(jobId), this.#apiJobs.cancel(jobId), this.#jobApiJobs.cancel(jobId)].filter((done): done is Promise<void> => done !== null);
    return pending.length ? Promise.all(pending).then(() => undefined) : null;
  }

  async #runApi<T>(name: 'search' | 'load' | 'validate', task: (signal: AbortSignal, metadataReady: () => void) => Promise<T>, jobId?: string): Promise<T> {
    const slot = jobId ?? `${name}-${randomUUID()}`;
    const jobs = jobId ? this.#jobApiJobs : this.#apiJobs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await jobs.run(slot, context => {
        timeout = this.#setTimeout(() => { jobs.cancel(slot, new Error(`${this.#label} request timed out.`)); }, API_TIMEOUT_MS);
        return task(context.signal, () => this.#clearTimeout(timeout));
      }, {cancelledEventMessage: jobId ? 'Download cancelled.' : undefined, mapError: error => error.message.startsWith(`${this.#label} `) || error.message === this.#noKey ? error : new Error(`${this.#label} request failed.`)});
    } finally { this.#clearTimeout(timeout); }
  }

  async #requestJson(url: URL, signal: AbortSignal, key = this.#key, reusable = true, validating = false): Promise<Record<string, unknown>> {
    if (!key) throw new Error(this.#noKey);
    // The URL never carries the key here; query authentication is added at fetch time.
    const cacheKey = `${key}:${url}`;
    const cached = reusable ? this.#metadataCache.get(cacheKey) : undefined;
    if (cached) return structuredClone(cached);
    let request = reusable ? this.#metadataPending.get(cacheKey) : undefined;
    if (!request) {
      const cooldown = this.#cooldowns.get(key) ?? 0;
      if (cooldown > this.#now()) throw new Error(`${this.#label} quota reached. Try again after the provider rate limit resets.`);
      // Key validation shares quota accounting, but never joins cached/shared work.
      if (!reusable) return this.#fetchJson(url, signal, key, validating);
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
    try { return structuredClone(await abortable(shared.promise, signal, this.#cancelled)); }
    finally {
      signal.removeEventListener('abort', detach);
      detach();
      await termination;
    }
  }

  async #fetchJson(url: URL, signal: AbortSignal, key: string, validating = false): Promise<Record<string, unknown>> {
    const label = this.#label;
    const target = new URL(url);
    if (this.#source.auth === 'query') target.searchParams.set('key', key);
    let response: Response;
    try {
      response = await this.#fetchResponse(target, { headers: this.#source.auth === 'header' ? { Authorization: key } : {}, signal, redirect: 'error' }, signal);
    } catch {
      // Never surface the underlying error: with query authentication it can carry the key.
      if (signal.aborted) throw new Error(this.#cancelled);
      throw new Error(`${label} request failed.`);
    }
    if (response.status === 429) {
      const now = this.#now();
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 + now : Date.parse(retry ?? '');
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const reset = resetHeader && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 + (this.#source.resetIsRelative ? now : 0) : NaN;
      const deadlines = [seconds, reset].filter(value => Number.isFinite(value) && value > now);
      const until = Math.min(now + MAX_COOLDOWN_MS, deadlines.length ? Math.max(...deadlines) : now + 60_000);
      this.#cooldowns.set(key, until);
      cancelBody(response);
      throw new Error(`${label} quota reached. Try again after the provider rate limit resets.`);
    }
    if (!response.ok || contentType(response) !== 'application/json') cancelBody(response);
    if (this.#source.rejectedStatuses.includes(response.status) || (validating && this.#source.validationRejectedStatuses?.includes(response.status))) throw new Error(`${label} rejected the API key.`);
    if (!response.ok) throw new Error(`${label} request failed (${response.status}).`);
    if (contentType(response) !== 'application/json') throw new Error(`${label} returned invalid API data.`);
    const bytes = await this.#readBody(response, MAX_API_BYTES, signal, `${label} API response is too large.`);
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${label} returned invalid API data.`);
    }
  }

  async search(kind: unknown, query: unknown, page: unknown): Promise<StockPage> {
    const {kinds, maxPage} = this.#source;
    if (!kinds.includes(kind as StockKind)) throw new Error(`Invalid ${this.#label} media type.`);
    // Both providers count the query in characters (a 60-letter Turkish query, 360 bytes URL-encoded, is accepted by Pixabay).
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) {
      throw new Error(`Enter 2–100 characters to search ${this.#label}.`);
    }
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > maxPage) throw new Error(`${this.#label} page must be between 1 and ${maxPage}.`);
    return this.#runApi('search', async (signal, metadataReady) => {
      const raw = await this.#requestJson(this.#source.searchUrl(kind as StockKind, query.trim(), page as number), signal);
      metadataReady();
      return this.#source.parsePage(raw, kind as StockKind, query.trim(), page as number);
    });
  }

  async load(kind: unknown, id: unknown, context?: {jobId: string}): Promise<StockAsset> {
    if (!this.#source.kinds.includes(kind as StockKind) || !Number.isInteger(id) || (id as number) < 1) throw new Error(`Invalid ${this.#label} asset.`);
    return this.#runApi('load', async (signal, metadataReady) => {
      const raw = await this.#requestJson(this.#source.loadUrl(kind as StockKind, id as number), signal);
      metadataReady();
      const result = this.#source.parseAsset(raw, kind as StockKind, id as number);
      if (!result) throw new Error(`${this.#label} returned invalid media metadata.`);
      if (signal.aborted) throw new Error(this.#cancelled);
      return result;
    }, context?.jobId);
  }

  async download(jobId: unknown, file: StockFile, emit: (event: StockEvent) => void): Promise<{ filePath: string; fileName: string }> {
    const label = this.#label;
    if (typeof jobId !== 'string' || !safeHostUrl(file.url, this.#source.mediaHosts)) throw new Error(`Invalid ${label} download request.`);
    const max = file.mime === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const ext = file.mime === 'video/mp4' ? '.mp4' : file.mime === 'image/png' ? '.png' : '.jpg';
    let directory: AnchoredDir;
    try { directory = this.#outputDirectory(); } catch { throw new Error(`${label} media download failed.`); }
    const final = directory.child(`${this.#source.prefix}-${randomUUID()}${ext}`);
    const temp = `${final}.part`;
    if (!inRoot(this.#root, final)) throw new Error(`Unsafe ${label} output path.`);

    return await this.#downloads.run(jobId, async context => {
      const expire = (): void => { this.#downloads.cancel(jobId, new Error(`${label} media download timed out.`)); };
      let idle = this.#setTimeout(expire, DOWNLOAD_IDLE_TIMEOUT_MS);
      const overall = this.#setTimeout(expire, DOWNLOAD_TIMEOUT_MS);
      const resetIdle = (): void => { this.#clearTimeout(idle); idle = this.#setTimeout(expire, DOWNLOAD_IDLE_TIMEOUT_MS); };
      let out: ReturnType<typeof createWriteStream> | null = null;
      try {
        emit({ jobId, state: 'downloading', percent: 0, message: `Downloading from ${label}…` });
        const response = await this.#fetchMedia(file.url, context.signal);
        const lengthHeader = response.headers.get('content-length');
        const length = lengthHeader === null ? NaN : Number(lengthHeader);
        if (Number.isFinite(length) && (length < 1 || length > max)) {
          cancelBody(response);
          throw new Error(`${label} media exceeds the download size limit.`);
        }
        if (contentType(response) !== file.mime) {
          cancelBody(response);
          throw new Error(`${label} returned an unexpected media type.`);
        }
        if (!response.body) throw new Error(`${label} returned no media body.`);

        let written = 0;
        let lastProgressAt = -Infinity;
        const emitProgress = (percent: number | null, force = false): void => {
          const now = Date.now();
          if (!force && now - lastProgressAt < 150) return;
          lastProgressAt = now;
          emit({ jobId, state: 'downloading', percent, message: `Downloading from ${label}…` });
        };
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            resetIdle();
            written += chunk.byteLength;
            if (written > max) {
              callback(new Error(`${label} media exceeds the download size limit.`));
              return;
            }
            emitProgress(Number.isFinite(length) && length > 0 ? Math.min(99.9, written / length * 100) : null);
            callback(null, chunk);
          },
        });
        const opened = openExclusive(directory, basename(temp));
        context.register(opened.file);
        out = createWriteStream(temp, {fd: opened.fd, autoClose: true});
        await pipeline(Readable.fromWeb(detachCancel(response.body) as never), meter, out, {signal: context.signal});
        emitProgress(100, true);
        context.check();
        const temporary = context.owned(temp);
        if (statSync(verifyFile(temporary)).size < 1) throw new Error(`${label} media download was empty.`);
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
    }, {invalidMessage: `Invalid ${label} download request.`, notifyFailure: error => error.message === `${label} media download timed out.`, mapError: error => {
      const message = error.message;
      if (message.startsWith(`${label} `) || message === `Unsafe ${label} output path.`) return error;
      return new Error(`${label} media download failed.`);
    }});
  }

  #fetchResponse(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    // The job ends now; only disposal waits for a late response and its body.
    return abortableFetch(url, init, {fetch: this.#fetch, signal, cancelledMessage: this.#cancelled, terminations: this.#terminations});
  }

  async #fetchMedia(value: string, signal: AbortSignal): Promise<Response> {
    const hosts = this.#source.mediaHosts;
    let url = safeHostUrl(value, hosts);
    for (let redirects = 0; url && redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetchResponse(url, { signal, redirect: 'manual' }, signal);
      } catch {
        if (signal.aborted) throw new Error('Download cancelled.');
        throw new Error(`${this.#label} media request failed.`);
      }
      if (response.status >= 300 && response.status < 400) {
        cancelBody(response);
        const location = response.headers.get('location');
        url = location ? safeHostUrl(new URL(location, url).toString(), hosts) : null;
        continue;
      }
      if (!response.ok) cancelBody(response);
      if (!response.ok) throw new Error(`${this.#label} media request failed (${response.status}).`);
      return response;
    }
    throw new Error(`${this.#label} media redirect was rejected.`);
  }

  async #readBody(response: Response, max: number, signal: AbortSignal, tooLargeMessage: string): Promise<Buffer> {
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    if (Number.isFinite(length) && (length < 0 || length > max)) { cancelBody(response); throw new Error(tooLargeMessage); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${this.#label} returned no response body.`);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error(this.#cancelled);
        const { done, value } = await abortable(reader.read(), signal, this.#cancelled);
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          throw new Error(tooLargeMessage);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
  }

  async dispose(): Promise<void> {
    this.clearKey();
    await Promise.all([this.#downloads.dispose(), this.#apiJobs.dispose(), this.#jobApiJobs.dispose()]);
    await Promise.all([...this.#terminations]);
  }
}
