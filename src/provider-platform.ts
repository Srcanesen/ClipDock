// ProviderPlatform — single deep module for the three provider adapters.
// Absorbs the duplicated discover / search-cache / spawn patterns so
// cache/spawn policy lives in exactly one place. Behaviour preserving,
// shell:false invariant enforced here.

import { spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { homedir } from 'node:os';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, SafeFsError, captureEntry, removeEntry, removeEmptyDir } from './safe-fs';
import { StringDecoder } from 'node:string_decoder';

// ---------------------------------------------------------------------------
// Binary discovery (PATH enumeration + spawnSync version probe + override)
// ---------------------------------------------------------------------------

const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BYTES = 256 * 1024;

export function executable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

export function absoluteForPlatform(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(p) : isAbsolute(p);
}

export type VersionProbe = (candidate: string) => { code: number | null; text: string } | null;

/** Bounded shell:false version probe; null when the candidate cannot run. */
export function probeVersion(candidate: string, versionArgs: string[]): { code: number | null; text: string } | null {
  try {
    const result = spawnSync(candidate, versionArgs, {
      shell: false,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: VERSION_PROBE_MAX_BYTES,
    });
    return { code: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } catch { return null; }
}

/** The discovered binary, or the provider's install guidance as an error. */
export function requireBinary(binary: string | null, missingMessage: string): string {
  if (!binary) throw new Error(missingMessage);
  return binary;
}

export type DiscoverBinaryOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEntries?: string[];
  envKey?: string;
  extraCandidates?: string[];
  versionIdentity?: string | null;
  versionCheck?: (result: { code: number | null; text: string }) => boolean;
  probe?: VersionProbe;
};

/**
 * Single candidate+probe+override discovery.
 * - an absolute envKey override is the first candidate; an invalid one never blocks fallback
 * - PATH candidates + extraCandidates are enumerated, de-duplicated via seen Set
 * - each candidate must be absoluteForPlatform, executable, and pass versionIdentity/versionCheck if given
 * Returns first match or null. shell:false is enforced in every spawnSync probe.
 */
export function discoverBinary(
  names: string[],
  versionArgs: string[] | null,
  opts: DiscoverBinaryOptions = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const pathEntries = opts.pathEntries ?? (env.PATH ?? '').split(platform === 'win32' ? ';' : ':');
  const probe: VersionProbe = opts.probe ?? (versionArgs ? candidate => probeVersion(candidate, versionArgs) : () => null);

  const candidates: string[] = [];
  const configured = opts.envKey ? env[opts.envKey] : undefined;
  if (configured && absoluteForPlatform(configured, platform)) candidates.push(configured);
  for (const dir of pathEntries.filter(Boolean)) {
    for (const name of names) candidates.push(join(dir, name));
  }
  if (opts.extraCandidates) candidates.push(...opts.extraCandidates);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!absoluteForPlatform(candidate, platform)) continue;
    if (!executable(candidate)) continue;
    if (opts.versionIdentity || opts.versionCheck) {
      const result = probe(candidate);
      if (!result) continue;
      if (opts.versionIdentity && (result.code !== 0 || !result.text.toLowerCase().includes(opts.versionIdentity.toLowerCase()))) continue;
      if (opts.versionCheck && !opts.versionCheck(result)) continue;
    }
    return candidate;
  }
  return null;
}

/** Common per-user and Homebrew install locations for a provider binary. */
export function installCandidates(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, options: {homeBin?: boolean; programDir?: string; localAppDataDir?: string} = {}): string[] {
  if (platform === 'darwin') return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, ...(options.homeBin ? [join(env.HOME || homedir(), 'bin', name)] : [])];
  if (platform !== 'win32') return [];
  const exe = `${name}.exe`;
  return [
    ...(options.programDir ? [join(env.ProgramFiles ?? 'C:\\Program Files', ...options.programDir.split('/'), exe)] : []),
    ...(options.localAppDataDir ? [join(env.LOCALAPPDATA ?? '', ...options.localAppDataDir.split('/'), exe)] : []),
    ...(options.homeBin ? [join(env.USERPROFILE ?? '', 'bin', exe)] : []),
  ];
}

// ---------------------------------------------------------------------------
// LRU Search Cache with pristine-copy discipline
// ---------------------------------------------------------------------------

function cloneValue<V>(value: V): V {
  // Prefer structuredClone for full fidelity (handles Map, Set, Dates)
  try {
    if (typeof (globalThis as unknown as { structuredClone?: (v: unknown) => unknown }).structuredClone === 'function') {
      return (globalThis as unknown as { structuredClone: (v: V) => V }).structuredClone(value);
    }
  } catch { /* fall through to manual */ }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => (item && typeof item === 'object' ? { ...(item as object) } : item)) as unknown as V;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rec };
    if (Array.isArray(rec.results)) {
      out.results = (rec.results as unknown[]).map((item) => (item && typeof item === 'object' ? { ...(item as object) } : item));
    }
    if (rec.thumbnailUrls instanceof Map) out.thumbnailUrls = new Map(rec.thumbnailUrls as Map<unknown, unknown>);
    if (rec.results instanceof Map) out.results = new Map(rec.results as Map<unknown, unknown>);
    return out as V;
  }
  return value;
}

export class LruCache<K, V> {
  private store = new Map<K, { value: V; createdAt: number }>();
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (maxEntries < 1) throw new Error('LruCache maxEntries must be >=1');
  }

  get(key: K): V | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt >= this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    // LRU: move to most-recently-used
    this.store.delete(key);
    this.store.set(key, entry);
    // pristine-copy discipline: return cloned copy so mutation does not pollute cache
    return cloneValue(entry.value);
  }

  /** Peek without LRU move or clone — internal use */
  private peekRaw(key: K): V | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt >= this.ttlMs) { this.store.delete(key); return null; }
    return entry.value;
  }

  set(key: K, value: V): void {
    const createdAt = (value as unknown as { createdAt?: unknown })?.createdAt != null
      && typeof (value as unknown as { createdAt: unknown }).createdAt === 'number'
      ? (value as unknown as { createdAt: number }).createdAt
      : this.now();
    const stored: V = value;
    // If key exists, refresh order
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value: stored, createdAt });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as K;
      this.store.delete(oldest);
    }
  }

  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.now() - entry.createdAt >= this.ttlMs) { this.store.delete(key); return false; }
    return true;
  }

  delete(key: K): boolean { return this.store.delete(key); }
  clear(): void { this.store.clear(); }
  get size(): number { return this.store.size; }
  keys(): IterableIterator<K> { return this.store.keys(); }
  values(): IterableIterator<V> {
    const raw = this.store.values();
    const self = this;
    return (function* () {
      for (const { value, createdAt } of raw) {
        if (self.now() - createdAt < self.ttlMs) yield cloneValue(value);
      }
    })() as IterableIterator<V>;
  }
  entries(): IterableIterator<[K, V]> {
    const raw = this.store.entries();
    const self = this;
    return (function* () {
      for (const [k, { value, createdAt }] of raw) {
        if (self.now() - createdAt < self.ttlMs) yield [k, cloneValue(value)] as [K, V];
      }
    })() as IterableIterator<[K, V]>;
  }
  // Compat: allow iteration like Map
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.entries(); }
  forEach(callback: (value: V, key: K) => void): void {
    for (const [k, v] of this.entries()) callback(v, k);
  }
}

export type SearchCacheEntry<R> = { query: string; createdAt: number; results: R[]; thumbnailUrls?: Map<string, string> };
export type ThumbnailCacheEntry = { createdAt: number; data: string };

/**
 * Factory returning LRU caches with pristine-get.
 * Mirrors the previously duplicated SEARCH_CACHE_MAX / THUMBNAIL_CACHE_MAX pattern.
 */
export function createSearchCache<R>(
  maxResults: number,
  maxThumbnails: number,
  opts: { ttlMs?: number; thumbnailTtlMs?: number; now?: () => number } = {},
): { search: LruCache<string, SearchCacheEntry<R>>; thumbnails: LruCache<string, ThumbnailCacheEntry> } {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 5 * 60 * 1000;
  const thumbTtl = opts.thumbnailTtlMs ?? 10 * 60 * 1000;
  return {
    search: new LruCache<string, SearchCacheEntry<R>>(maxResults, ttl, now),
    thumbnails: new LruCache<string, ThumbnailCacheEntry>(maxThumbnails, thumbTtl, now),
  };
}

// Legacy helper: createSearchCache with single max for callers that only need one cache
export function createSingleCache<V>(maxEntries: number, ttlMs: number, now: () => number = Date.now): LruCache<string, V> {
  return new LruCache<string, V>(maxEntries, ttlMs, now);
}

// ---------------------------------------------------------------------------
// Bounded spawn helper — the single shell:false spawn site with capture/timeout
// ---------------------------------------------------------------------------

export type Spawn = (binary: string, args: string[], options: { shell: false; detached?: boolean; env?: NodeJS.ProcessEnv }) => ChildProcess;

export type SpawnBoundedOptions = {
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  maxStdout?: number;
  maxStderr?: number;
  maxBufferBytes?: number;
  onLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  processSpawn?: Spawn;
};

export type SpawnBoundedResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stdoutBytes: number;
  timedOut: boolean;
};

/** Own each POSIX process group, including descendants that outlive the parent. */
export function spawnBounded(
  binary: string, args: string[], spawn: Spawn, opts: SpawnBoundedOptions = {},
): Promise<SpawnBoundedResult> & { child: ChildProcess; cancel: () => Promise<void> } {
  const platform = opts.platform ?? process.platform;
  const maxStdout = opts.maxStdout ?? 4 * 1024 * 1024;
  const maxStderr = opts.maxStderr ?? 64 * 1024;
  const child = spawn(binary, args, { shell: false, ...(platform !== 'win32' ? {detached: true} : {}), ...(opts.env ? {env: opts.env} : {}) });
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  let stdout = '', stderr = '', pending = '', pendingStderr = '', stdoutBytes = 0, stderrBytes = 0;
  let timedOut = false, overflow = false, stopping = false, settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined, reapTimer: NodeJS.Timeout | undefined;
  let finish: (code: number | null, error?: Error) => void;
  function signalTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (platform === 'win32' && child.pid) {
      try {
        const killer = opts.processSpawn
          ? opts.processSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {shell: false})
          : spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {shell: false, timeout: 1000});
        (killer as ChildProcess).once?.('error', () => undefined);
      } catch { /* already exited */ }
    } else {
      if (child.pid && child.pid > 1) {
        try { process.kill(-child.pid, signal); return; } catch { /* no group (injected child or already reaped) */ }
      }
      try { child.kill(signal); } catch { /* already exited */ }
    }
  }
  function stop(): void {
    if (settled || stopping) return;
    stopping = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Install escalation before TERM: injected children may close synchronously.
    killTimer = setTimeout(() => {
      signalTree('SIGKILL');
      reapTimer = setTimeout(() => {
        child.stdout?.destroy?.(); child.stderr?.destroy?.();
        finish(null);
      }, 1000);
    }, opts.killGraceMs ?? 3000);
    signalTree('SIGTERM');
  }
  function deliver(text: string): void {
    stdout += text;
    if (!opts.onLine) return;
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) opts.onLine(line);
  }
  function deliverStderr(text: string): void {
    stderr += text;
    if (!opts.onStderrLine) return;
    pendingStderr += text;
    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop() ?? '';
    for (const line of lines) opts.onStderrLine(line);
  }
  const promise = new Promise<SpawnBoundedResult>((resolve, reject) => {
    finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (platform !== 'win32' && child.pid && child.pid > 1) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already reaped */ }
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (!overflow) deliver(outDecoder.end());
      deliverStderr(errDecoder.end());
      if (pendingStderr && opts.onStderrLine) opts.onStderrLine(pendingStderr);
      if (pending && opts.onLine && !overflow) opts.onLine(pending);
      if (error) reject(error);
      else resolve({code, stdout, stderr, stdoutTruncated: overflow, stdoutBytes, timedOut});
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled || overflow) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxStdout - stdoutBytes);
      stdoutBytes += bytes.length;
      deliver(outDecoder.write(bytes.subarray(0, remaining)));
      if (stdoutBytes > maxStdout) { overflow = true; pending = ''; stop(); }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      deliverStderr(errDecoder.write(bytes.subarray(0, Math.max(0, maxStderr - stderrBytes))));
      stderrBytes += bytes.length;
    });
    child.once('error', (error) => { signalTree('SIGKILL'); finish(null, error); });
    child.once('close', (code) => finish(code));
  }) as Promise<SpawnBoundedResult> & {child: ChildProcess; cancel: () => Promise<void>};
  if (opts.timeoutMs && opts.timeoutMs > 0) timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
  promise.child = child;
  promise.cancel = () => { stop(); return promise.then(() => undefined, () => undefined); };
  return promise;
}

export function spawnBoundedWithChild(binary: string, args: string[], spawn: Spawn, opts: SpawnBoundedOptions = {}) {
  const promise = spawnBounded(binary, args, spawn, opts);
  return {promise, child: promise.child, cancel: promise.cancel};
}

export type BoundedResponse = {
  ok: boolean; url?: string; status?: number; headers: {get(name: string): string | null};
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Deadline covers headers and body; byte limits apply while consuming the stream. */
export async function fetchBounded(
  fetcher: (url: string, init: {redirect: 'follow'; signal: AbortSignal}) => Promise<BoundedResponse>,
  url: string, maxBytes: number, parent?: AbortSignal, timeoutMs = 5000,
  validate?: (response: BoundedResponse) => string | null,
): Promise<{response: BoundedResponse; bytes: Buffer}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, {once: true});
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Thumbnail request cancelled or timed out.'));
    controller.signal.addEventListener('abort', fail, {once: true});
    if (controller.signal.aborted) fail();
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: BoundedResponse | undefined;
  let stage = 'request-error';
  try {
    response = await Promise.race([fetcher(url, {redirect: 'follow', signal: controller.signal}), aborted]);
    const rejection = validate?.(response);
    if (rejection) throw Object.assign(new Error('Thumbnail headers were rejected.'), {thumbnailReason: rejection});
    const length = response.headers.get('content-length');
    if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > maxBytes)) throw Object.assign(new Error('Thumbnail body exceeded its limit.'), {thumbnailReason: 'oversize'});
    stage = 'body-error';
    let bytes: Buffer;
    if (response.body) {
      reader = response.body.getReader();
      const chunks: Buffer[] = []; let total = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw Object.assign(new Error('Thumbnail body exceeded its limit.'), {thumbnailReason: 'oversize'});
        chunks.push(Buffer.from(chunk.value));
      }
      bytes = Buffer.concat(chunks, total);
    } else {
      // Compatibility for injected responses; native fetch always exposes a body stream.
      bytes = Buffer.from(await Promise.race([response.arrayBuffer(), aborted]));
      if (bytes.length > maxBytes) throw Object.assign(new Error('Thumbnail body exceeded its limit.'), {thumbnailReason: 'oversize'});
    }
    if (controller.signal.aborted) throw new Error('Thumbnail request cancelled or timed out.');
    return {response, bytes};
  } catch (error) {
    controller.abort();
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined);
    if (error && typeof error === 'object') Object.assign(error, {thumbnailStage: stage});
    throw error;
  } finally {
    clearTimeout(timer); parent?.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}

type SharedOutcome<T> = {ok: true; value: T} | {ok: false; error: unknown};

/** Independent subscriptions to one extraction. Only the final departure cancels
 * the underlying work; aborted subscribers are removed from its notification set.
 */
export class SharedProviderOperation<T> {
  private readonly subscribers = new Set<(outcome: SharedOutcome<T>) => void>();
  private outcome?: SharedOutcome<T>;
  constructor(
    private readonly operation: {result: Promise<T>; cancel(): Promise<void>},
    private readonly release: () => void,
  ) {
    void operation.result.then(value => this.finish({ok: true, value}), error => this.finish({ok: false, error}));
  }
  private finish(outcome: SharedOutcome<T>): void {
    this.outcome = outcome;
    this.release();
    for (const subscriber of this.subscribers) subscriber(outcome);
    this.subscribers.clear();
  }
  subscribe(signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const detach = () => { signal.removeEventListener('abort', abort); this.subscribers.delete(settle); };
      const settle = (outcome: SharedOutcome<T>) => {
        detach();
        if (outcome.ok) resolve(outcome.value); else reject(outcome.error);
      };
      const abort = () => {
        detach();
        if (!this.outcome && this.subscribers.size === 0) {
          // Evict before termination so a later request cannot join dying work.
          this.release();
          void this.operation.cancel().then(() => reject(signal.reason), reject);
        } else reject(signal.reason);
      };
      this.subscribers.add(settle);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      else if (this.outcome) settle(this.outcome);
    });
  }
}

/** Keep the application alive through termination and private-job cleanup. */
export async function awaitEngineShutdown(services: {dispose(): void | Promise<void>}[], deadlineMs = 8000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(services.map(async service => service.dispose())),
      new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Preserve only verified artifacts, using canonical identity on macOS /var aliases. */
export function cleanJobDirectory(root: string | AnchoredDir, retained: string[]): void {
  const dir = typeof root === 'string' ? (() => {
    const boundary = ManagedRoot.capture(root); return AnchoredDir.capture(boundary.verify(), boundary);
  })() : root;
  const keep = new Set(retained.map(file => join(realpathSync(dirname(file)), basename(file))));
  function visit(directory: AnchoredDir): void {
    // Capture every entry before mutation; never recurse through an old pathname.
    const entries = readdirSync(directory.verify()).map(name => {
      const path = directory.child(name), stat = lstatSync(path, {bigint: true});
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const child = AnchoredDir.capture(path, directory.root);
        const identity = child.snapshot().directories.at(-1)!;
        if (identity.dev !== stat.dev || identity.ino !== stat.ino) throw new SafeFsError('replaced');
        return {child};
      }
      const entry = captureEntry(directory, name);
      if (entry.identity.dev !== stat.dev || entry.identity.ino !== stat.ino) throw new SafeFsError('replaced');
      return {entry, keep: keep.has(path)};
    });
    for (const value of entries) {
      if (value.child) {
        visit(value.child);
        if (readdirSync(value.child.verify()).length === 0) removeEmptyDir(value.child);
      } else if (!value.keep) removeEntry(value.entry!);
    }
  }
  visit(dir);
}
