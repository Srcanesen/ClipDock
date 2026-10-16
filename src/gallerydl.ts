// gallery-dl boundary for the approved, narrow Pinterest Pin integration.
// Node-only and Electron-free. The main process owns one GalleryDlWorker; this
// module owns executable discovery, bounded JSONL parsing, download containment,
// cancellation, and media-signature checks. No provider URL or filesystem path
// other than validated thumbnail URLs is ever sent to the renderer.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { AnchoredDir, createDirectory, prepareDirectory } from './safe-fs';
import { ManagedRoot } from './managed-root';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { contains as pathContains } from './path-boundary';
import { discoverBinary, executable, absoluteForPlatform, LruCache, spawnBounded, cleanJobDirectory } from './provider-platform';
import { ProviderJobRunner, type ProviderJobContext } from './provider-job';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validatePinterestSearchQuery, validatePinterestShortUrl, validatePinterestUrl, type ValidPinterestUrl } from './ytdlp-url';

export type PinterestMediaKind = 'image' | 'video';
export type PinterestItem = {
  index: number;
  kind: PinterestMediaKind;
  title: string;
  creator: string | null;
  extension: string;
};
export type PinterestMetadata = {
  pinId: string;
  source: string;
  title: string;
  creator: string | null;
  kind: PinterestMediaKind | 'carousel';
  items: PinterestItem[];
  /** HTTPS image URL restricted to i.pinimg.com. */
  thumbnailUrl: string | null;
};
export type PinterestSearchKind = PinterestMediaKind | 'carousel';
export type PinterestSearchItem = {
  id: string;
  title: string;
  creator: string | null;
  kind: PinterestSearchKind;
  url: string;
  thumbnailUrl: string | null;
};
export type PinterestSearchPage = {
  query: string;
  page: number;
  pageSize: 10;
  results: PinterestSearchItem[];
  hasPrevious: boolean;
  hasNext: boolean;
  totalResults: number;
  pageCount: number;
  thumbnailDiagnostic?: { failed: number; total: number; reason: string; node: string };
};
export type PinterestDownloadEvent = {
  jobId: string;
  state: 'downloading' | 'cancelled' | 'failed';
  percent: number | null;
  message: string;
  speedBytesPerSecond?: number | null;
  etaSeconds?: number | null;
};
export type PinterestDownloadResult = {
  filePath: string;
  fileName: string;
  kind: PinterestMediaKind;
};

export type GalleryDlProbe = (candidate: string) => { code: number | null; text: string } | null;
type Spawn = (binary: string, args: string[], options: { shell: false; detached?: boolean; env?: NodeJS.ProcessEnv }) => ChildProcess;
type FetchResponse = { ok: boolean; status: number; url?: string; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };
type Fetch = (url: string, init: { redirect: 'manual' | 'follow'; signal: AbortSignal }) => Promise<FetchResponse>;
type GalleryDlOptions = {
  sessionDir?: string;
  platform?: NodeJS.Platform;
  processSpawn?: Spawn;
  fetcher?: Fetch;
  killGraceMs?: number;
  metadataTimeoutMs?: number;
  downloadTimeoutMs?: number;
  now?: () => number;
  /** Verified absolute ffmpeg from main; its directory is prepended to the spawned gallery-dl child PATH so merged Pinterest video downloads can locate it under Finder-launched Resolve. */
  ffmpegPath?: string | null;
};
type JobDetails = { jobDir: string; kind: 'metadata' | 'download' | 'search'; jobId?: string; emit?: (event: PinterestDownloadEvent) => void };
type InternalArtifact = PinterestItem;
type SearchCacheEntry = {
  query: string;
  createdAt: number;
  results: PinterestSearchItem[];
  thumbnailUrls: Map<string, string>;
};
type SearchParseResult = { items: PinterestSearchItem[]; thumbnailUrls: Map<string, string> };


const MIN_GALLERYDL = [1, 28, 0] as const;
const MAX_STDERR = 64 * 1024;
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 30;
const SEARCH_PAGE_SIZE = 10;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 10;
const MAX_ARTIFACTS = 50;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const sizeLimitMessage = (kind: 'image' | 'video'): string => `This ${kind} exceeds ClipDock’s ${kind === 'image' ? '20 MB' : '2 GB'} download limit.`;
const NETWORK_HELPER_TIMEOUT_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BYTES = 256 * 1024;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_OUTPUT_FILES = 64;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXTENSIONS = new Set(['.mp4']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const HTTP_TIMEOUT_SECONDS = '30';
const HTTP_RETRIES = '2';
const HTTP_SLEEP_SECONDS = '0';
const PINTEREST_ERROR = 'Could not load this Pinterest Pin.';
const PINTEREST_STORY_ERROR = 'Pinterest Story Pins are not supported.';
const PINTEREST_SEARCH_ERROR = 'Could not search Pinterest.';
const PINTEREST_SEARCH_TIMEOUT = 'Pinterest search timed out.';
const PINTEREST_SEARCH_CANCELLED = 'Pinterest search cancelled.';
const PINTEREST_SEARCH_TOO_LARGE = 'Search results were too large.';
const PINTEREST_DOWNLOAD_ERROR = 'Pinterest download failed.';
const PINTEREST_PRIVATE_ERROR = 'This Pin is private or requires login. Only public Pins are supported.';
const PINTEREST_YTDLP_ERROR = 'Pinterest video download requires the yt-dlp Python module. Install yt-dlp, then retry.';

function probeVersion(candidate: string): { code: number | null; text: string } | null {
  try {
    const { spawnSync: sync } = require('node:child_process') as typeof import('node:child_process');
    const result = sync(candidate, ['--version'], { shell: false, timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: VERSION_PROBE_MAX_BYTES });
    return { code: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } catch { return null; }
}
function versionSupported(candidate: string, probe: GalleryDlProbe): boolean {
  const result = probe(candidate);
  return result?.code === 0 && galleryDlVersionSupported(result.text);
}

/** Parse the first semantic version printed by gallery-dl. */
export function parseGalleryDlVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/i);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return version.every((part) => Number.isSafeInteger(part) && part >= 0) ? version : null;
}
function versionAtLeast(version: [number, number, number], floor = MIN_GALLERYDL): boolean {
  for (let index = 0; index < floor.length; index += 1) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}
export function galleryDlVersionSupported(value: unknown): boolean {
  const version = parseGalleryDlVersion(value);
  return version !== null && versionAtLeast(version);
}

/**
 * Discover only an executable gallery-dl whose bounded --version probe is
 * successful and is at least the approved 1.28.0 floor. Invalid configured
 * paths do not prevent safe PATH/common-location discovery.
 */
export function discoverGalleryDl(
  env = process.env,
  platform = process.platform,
  pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':'),
  probe: GalleryDlProbe = probeVersion,
): string | null {
  const names = platform === 'win32' ? ['gallery-dl.exe'] : ['gallery-dl'];
  const extra = [...(platform === 'darwin' ? ['/opt/homebrew/bin/gallery-dl', '/usr/local/bin/gallery-dl', join(env.HOME || homedir(), 'bin', 'gallery-dl')] : []), ...(platform === 'win32' ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'gallery-dl', 'gallery-dl.exe'), join(env.LOCALAPPDATA ?? '', 'gallery-dl', 'gallery-dl.exe'), join(env.USERPROFILE ?? '', 'bin', 'gallery-dl.exe')] : [])];
  // Use provider-platform for candidate enumeration but preserve version floor check
  const configured = env.CLIPDOCK_GALLERYDL_PATH;
  const candidates = [
    ...(configured && absoluteForPlatform(configured, platform) ? [configured] : []),
    ...pathEntries.filter(Boolean).flatMap((directory) => names.map((name) => join(directory, name))),
    ...extra,
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate) || !absoluteForPlatform(candidate, platform) || !executable(candidate)) continue;
    seen.add(candidate);
    if (versionSupported(candidate, probe)) return candidate;
  }
  return null;
}

function safeText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\r\n\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}
function sanitizePinterestDisplayText(value: unknown, max = 300): string | null {
  const text = safeText(value, max);
  if (!text) return null;
  return text
    .replace(/(?:https?|file):\/\/\S+/gi, '[url]')
    .replace(/(^|[\s([{\"'=,:;])(?:\/|[A-Za-z]:[\\/]|\\\\)\S+/g, '$1[path]');
}
function safeErrorText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/https?:\/\/\S+/gi, '[url]').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_STDERR)
    : '';
}
function extensionFrom(value: unknown): string {
  const text = safeText(value, 120) ?? '';
  if (!text) return '';
  const ext = text.startsWith('.') ? text.toLowerCase() : `.${text.toLowerCase()}`;
  return ext.replace(/[^a-z0-9.]/g, '').slice(0, 12);
}
function pathExtension(value: unknown): string {
  return typeof value === 'string' ? extname(value).toLowerCase().slice(0, 12) : '';
}
function mediaKind(extension: string, raw: Record<string, unknown>): PinterestMediaKind | null {
  const marker = safeText(raw.media_type ?? raw.mime_type ?? raw.mime ?? raw.kind, 40)?.toLowerCase();
  if (marker && (/video/.test(marker) || marker === 'mp4' || marker === 'mov')) return 'video';
  if (marker && (/image/.test(marker) || IMAGE_MIMES.has(marker))) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return null;
}
function firstString(raw: Record<string, unknown>, keys: string[], max = 300): string | null {
  for (const key of keys) {
    const value = sanitizePinterestDisplayText(raw[key], max);
    if (value) return value;
  }
  return null;
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pinterestPinRedirect(value: string, base: string): ValidPinterestUrl | null {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value, base); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (host !== 'pinterest.com' && host !== 'www.pinterest.com') || parsed.port || parsed.username || parsed.password || parsed.hash) return null;
  const match = parsed.pathname.match(/^\/pin\/(\d{1,40})(?:\/sent)?\/?$/);
  return match ? {url: `https://www.pinterest.com/pin/${match[1]}/`, pinId: match[1]} : null;
}

function pinterestApiRedirect(value: string, base: string, token: string): string | null {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value, base); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.pinterest.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== `/url_shortener/${token}/redirect/`) return null;
  return parsed.toString();
}

function thumbnailCandidate(values: unknown[]): string | null {
  const records = values.flatMap((value) => { const record = tupleRecord(value, 3); return record ? [record] : []; });
  return searchThumbnailCandidate(records);
}

function safeThumbnailUrl(value: string): URL | null {
  if (/[\u0000-\u0020\u005c\u007f-\u009f]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'i.pinimg.com' && !parsed.port && !parsed.username && !parsed.password && !parsed.hash ? parsed : null;
  } catch { return null; }
}
function safeSearchThumbnailUrl(value: string): URL | null {
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
  return authority.toLowerCase() === 'i.pinimg.com' ? safeThumbnailUrl(value) : null;
}

function lineError(value: unknown): string | null {
  if (!Array.isArray(value) || (value[0] !== -1 && value[0] !== '-1')) return null;
  const detail = objectValue(value[1] ?? value[2]);
  return safeErrorText(detail?.message ?? detail?.error ?? value[1] ?? value[2]);
}

/** Parse bounded JSONL and preserve gallery-dl's message tuples verbatim. */
export function parseGalleryDlJsonl(text: string): unknown[] {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) throw new Error('Pinterest metadata output was too large.');
  const values: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(PINTEREST_ERROR); }
    const error = lineError(value);
    if (error !== null) throw new Error(error || PINTEREST_ERROR);
    values.push(value);
  }
  return values;
}

function tupleRecord(value: unknown, type: number): Record<string, unknown> | null {
  return Array.isArray(value) && value[0] === type ? objectValue(value[type === 2 ? 1 : 2]) : null;
}
function pinId(record: Record<string, unknown>): string | null {
  const value = record.pin_id ?? record.pinId ?? record.id;
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : null;
}
function storyRecord(record: Record<string, unknown>): boolean {
  return ['subcategory', 'type', 'kind'].some((key) => /story/i.test(safeText(record[key], 80) ?? '')) || record.story_pin_data != null;
}
function normalizeArtifact(raw: Record<string, unknown>, parent: Record<string, unknown>, outputIndex: number): InternalArtifact | null {
  const extension = extensionFrom(raw.extension ?? raw.ext) || pathExtension(raw.filename);
  const kind = mediaKind(extension, raw);
  if (!kind) return null;
  return {
    index: outputIndex,
    kind,
    title: firstString(raw, ['title', 'description', 'alt', 'name'], 300) ?? firstString(parent, ['title', 'description', 'alt', 'name'], 300) ?? `Pinterest item ${outputIndex}`,
    creator: firstString(raw, ['creator', 'author', 'username', 'uploader', 'owner'], 160) ?? firstString(parent, ['creator', 'author', 'username', 'uploader', 'owner'], 160),
    extension: extension.slice(1),
  };
}

/** Normalize actual [2]/[3] gallery-dl JSONL atomically; Directory records are context, never image renditions. */
export function parsePinterestMetadataJsonl(text: string, valid: ValidPinterestUrl): PinterestMetadata {
  return parsePinterestMetadataValues(parseGalleryDlJsonl(text), valid);
}

export function parsePinterestMetadataValues(values: unknown[], valid: ValidPinterestUrl): PinterestMetadata {
  if (values.some((value) => Array.isArray(value) && (value[0] === 6 || value[0] === '6') && storyRecord(objectValue(value[2]) ?? {}))) throw new Error(PINTEREST_STORY_ERROR);
  if (values.some((value) => Array.isArray(value) && (value[0] === 6 || value[0] === '6'))) throw new Error('Pinterest Queue and Story Pins are not supported.');
  const directories = values.flatMap((value) => { const record = tupleRecord(value, 2); return record ? [record] : []; });
  const urls = values.flatMap((value) => { const record = tupleRecord(value, 3); return record ? [record] : []; });
  if (directories.length !== 1 || urls.length < 1 || urls.length > MAX_ARTIFACTS || values.length !== directories.length + urls.length) throw new Error('Pinterest Pin metadata was incomplete or exceeded the 50-item limit.');
  const directory = directories[0];
  const reportedCount = directory.count;
  if (storyRecord(directory) || urls.some((record) => storyRecord(record))) throw new Error(PINTEREST_STORY_ERROR);
  if (pinId(directory) !== valid.pinId) throw new Error('Pinterest Pin metadata did not match the requested Pin.');
  if (typeof reportedCount !== 'number' || !Number.isInteger(reportedCount) || reportedCount !== urls.length || reportedCount > MAX_ARTIFACTS) throw new Error('Pinterest Pin metadata was incomplete or exceeded the 50-item limit.');
  const artifacts = urls.map((record, index) => {
    if (storyRecord(record)) throw new Error(PINTEREST_STORY_ERROR);
    if (pinId(record) !== valid.pinId) throw new Error('Pinterest Pin metadata did not match the requested Pin.');
    const artifact = normalizeArtifact(record, directory, index + 1);
    if (!artifact) throw new Error('Pinterest Pin contains an unsupported or malformed media item.');
    return artifact;
  });
  const title = firstString(directory, ['title', 'description', 'alt', 'name'], 300) ?? `Pinterest Pin ${valid.pinId}`;
  const creator = firstString(directory, ['creator', 'author', 'username', 'uploader', 'owner'], 160) ?? artifacts[0].creator;
  return {
    pinId: valid.pinId,
    source: valid.url,
    title,
    creator,
    kind: artifacts.length === 1 ? artifacts[0].kind : 'carousel',
    items: artifacts,
    thumbnailUrl: null,
  };
}

type SearchUrlRecord = { url: string; record: Record<string, unknown> };
type SearchDirectory = { id: string; record: Record<string, unknown>; urls: SearchUrlRecord[]; mediaUrls: Set<string> };

function searchThumbnailCandidate(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    const images = objectValue(record.images);
    for (const key of ['474x', '564x', '236x', 'orig']) {
      const candidate = safeThumbnailUrl(safeText(objectValue(images?.[key])?.url, 2_048) ?? '');
      if (candidate) return candidate.href;
    }
    const direct = safeThumbnailUrl(safeText(record.thumbnail, 2_048) ?? '');
    if (direct) return direct.href;
  }
  return null;
}

function searchMediaKind(value: string, record: Record<string, unknown>): PinterestMediaKind | null {
  const extension = extensionFrom(record.extension ?? record.ext)
    || pathExtension(record.filename)
    || (() => {
      const source = value.replace(/^ytdl:/i, '');
      try { return pathExtension(new URL(source).pathname); } catch { return pathExtension(source); }
    })();
  const kind = mediaKind(extension, record);
  if (!kind && /^ytdl:/i.test(value)) return !extension || extension === '.m3u8' || VIDEO_EXTENSIONS.has(extension) ? 'video' : null;
  if (!kind) return null;
  if (extension && (kind === 'image' ? !IMAGE_EXTENSIONS.has(extension) : !VIDEO_EXTENSIONS.has(extension))) return null;
  return kind;
}

function searchFirstString(record: Record<string, unknown>, keys: string[], max: number): string | null {
  for (const key of keys) {
    const value = sanitizePinterestDisplayText(record[key], max);
    if (value) return value;
  }
  return null;
}

function searchCreator(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    const pinner = objectValue(record.pinner);
    const pinnerName = searchFirstString(pinner ?? {}, ['username', 'name'], 160);
    if (pinnerName) return pinnerName;
    const board = objectValue(record.board);
    const owner = objectValue(board?.owner);
    const ownerName = searchFirstString(owner ?? {}, ['username', 'name'], 160);
    if (ownerName) return ownerName;
    const creator = searchFirstString(record, ['creator', 'author', 'username', 'uploader', 'owner'], 160);
    if (creator) return creator;
  }
  return null;
}

function searchTitle(records: Record<string, unknown>[], id: string): string {
  for (const record of records) {
    const title = searchFirstString(record, ['title', 'grid_title', 'description', 'seo_alt_text', 'alt_text', 'name'], 200);
    if (title) return title;
  }
  return `Pinterest Pin ${id}`;
}

function searchPromo(record: Record<string, unknown>): boolean {
  const storyType = safeText(record.story_type, 80)?.toLowerCase();
  return record.count === 0 || storyType === 'featured_boards';
}

function parsePinterestSearchValues(values: unknown[]): SearchParseResult {
  const directories: SearchDirectory[] = [];
  const firstDirectory = new Map<string, SearchDirectory>();
  const storyIds = new Set<string>();
  let current: SearchDirectory | null = null;

  for (const value of values) {
    if (!Array.isArray(value)) throw new Error('Pinterest search metadata was malformed.');
    const type = value[0];
    if (type === 6 || type === '6') {
      if (storyRecord(objectValue(value[2]) ?? {})) continue;
      throw new Error('Pinterest Queue and Story Pins are not supported.');
    }
    if (type === 2) {
      const record = objectValue(value[1]);
      if (!record) throw new Error('Pinterest search metadata was malformed.');
      const id = pinId(record);
      current = id ? {id, record, urls: [], mediaUrls: new Set<string>()} : null;
      if (id && storyRecord(record)) storyIds.add(id);
      if (id && current) {
        directories.push(current);
        if (!firstDirectory.has(id)) firstDirectory.set(id, current);
      }
      continue;
    }
    if (type !== 3) continue;
    const mediaUrl = value[1];
    if (typeof mediaUrl !== 'string' || mediaUrl.length > 2_048 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(mediaUrl)) throw new Error('Pinterest search metadata was malformed.');
    const record = objectValue(value[2]);
    if (!record) throw new Error('Pinterest search metadata was malformed.');
    const id = pinId(record);
    if (!id) continue;
    if (storyRecord(record)) storyIds.add(id);
    const url = {url: mediaUrl, record};
    const target = current?.id === id ? current : firstDirectory.get(id);
    if (target && !target.mediaUrls.has(mediaUrl)) {
      target.mediaUrls.add(mediaUrl);
      target.urls.push(url);
    }
  }

  const items: PinterestSearchItem[] = [];
  const thumbnailUrls = new Map<string, string>();
  const seen = new Set<string>();
  for (const directory of directories) {
    if (seen.has(directory.id) || storyIds.has(directory.id) || storyRecord(directory.record) || directory.urls.some(({record}) => storyRecord(record)) || searchPromo(directory.record) || directory.urls.length === 0) continue;
    const kinds = directory.urls.map(({url, record}) => searchMediaKind(url, record));
    if (kinds.some((kind) => kind === null)) continue;
    const count = typeof directory.record.count === 'number' && Number.isInteger(directory.record.count) ? directory.record.count : 0;
    if (directory.urls.length > MAX_ARTIFACTS || count > MAX_ARTIFACTS) continue;
    seen.add(directory.id);
    const records = [directory.record, ...directory.urls.map(({record}) => record)];
    const carousel = directory.urls.length > 1 || count > 1 || records.some((record) => record.carousel_data != null);
    items.push({
      id: directory.id,
      title: searchTitle(records, directory.id),
      creator: searchCreator(records),
      kind: carousel ? 'carousel' : kinds[0] as PinterestMediaKind,
      url: `https://www.pinterest.com/pin/${directory.id}/`,
      thumbnailUrl: null,
    });
    const thumbnail = searchThumbnailCandidate(records);
    if (thumbnail) thumbnailUrls.set(directory.id, thumbnail);
    if (items.length >= MAX_SEARCH_RESULTS) break;
  }
  return {items, thumbnailUrls};
}

/** Parse bounded Pinterest search JSONL without exposing media URLs or paths. */
export function parsePinterestSearchJsonl(text: string): PinterestSearchItem[] {
  return parsePinterestSearchValues(parseGalleryDlJsonl(text)).items;
}


function within(root: string, target: string): boolean { return pathContains(root, target); }
function readSignature(file: string): Buffer {
  const fd = openSync(file, 'r');
  const buffer = Buffer.alloc(64);
  try { const bytes = readSync(fd, buffer, 0, buffer.length, 0); return buffer.subarray(0, bytes); }
  finally { try { closeSync(fd); } catch { /* descriptor cleanup best-effort */ } }
}
function signatureKind(file: string): PinterestMediaKind | null {
  const extension = extname(file).toLowerCase();
  let signature: Buffer;
  try { signature = readSignature(file); } catch { return null; }
  const jpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const png = signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ftyp = signature.length >= 12 && signature.subarray(4, 8).toString('ascii') === 'ftyp';
  if (jpeg && (extension === '.jpg' || extension === '.jpeg')) return 'image';
  if (png && extension === '.png') return 'image';
  if (ftyp && extension === '.mp4') return 'video';
  return null;
}
function outputFiles(root: string): {files: string[]; symlink: boolean} {
  const files: string[] = [];
  let symlink = false;
  const visit = (directory: string): void => {
    let entries: Array<{name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean}>;
    try { entries = readdirSync(directory, {withFileTypes: true}) as unknown as Array<{name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean}>; } catch { return; }
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) { symlink = true; continue; }
      if (entry.isDirectory()) { visit(candidate); continue; }
      if (entry.isFile()) files.push(candidate);
      if (files.length > MAX_OUTPUT_FILES) return;
    }
  };
  visit(root);
  return {files, symlink};
}
function validateOutput(file: string, root: string): {path: string; kind: PinterestMediaKind} {
  if (!isAbsolute(file) || !existsSync(file)) throw new Error('Pinterest download failed its safety check.');
  let info;
  try { info = lstatSync(file); } catch { throw new Error('Pinterest download failed its safety check.'); }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Pinterest download failed its safety check.');
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  if (!within(realRoot, realFile)) throw new Error('Pinterest download failed its safety check.');
  const kind = signatureKind(realFile);
  if (!kind) throw new Error('Pinterest download failed its media-signature check.');
  const size = statSync(realFile).size;
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (size < 1 || size > max) throw new Error(sizeLimitMessage(kind));
  return {path: realFile, kind};
}
function mapError(detail: unknown, download = false): string {
  const text = safeErrorText(detail).toLowerCase();
  if (/private|login|required authentication|unauthori[sz]ed|sign in|cookies?/.test(text)) return PINTEREST_PRIVATE_ERROR;
  if (/no module named ['"]?yt[_-]?dlp|yt[_-]?dlp.*(?:module|required|not found|missing)|(?:module|package).*yt[_-]?dlp/.test(text)) return PINTEREST_YTDLP_ERROR;
  if (/timed? ?out|timeout/.test(text)) return 'Pinterest request timed out.';
  if (/no space|enospc|disk full/.test(text)) return 'There is not enough disk space to finish the Pinterest download.';
  return download ? PINTEREST_DOWNLOAD_ERROR : PINTEREST_ERROR;
}
function mapSearchError(detail: unknown): string {
  const text = safeErrorText(detail).toLowerCase();
  if (/private|login|required authentication|unauthori[sz]ed|sign in|cookies?/.test(text)) return PINTEREST_PRIVATE_ERROR;
  if (/timed? ?out|timeout/.test(text)) return PINTEREST_SEARCH_TIMEOUT;
  return PINTEREST_SEARCH_ERROR;
}
function searchStderrFailed(stderr: string): boolean {
  return /\[[^\]\r\n]+\]\[error\]|\b(?:traceback|http(?:error| error)|exception|private|login|required authentication|unauthori[sz]ed|sign in|cookies?|timed? ?out|timeout)\b/i.test(stderr);
}

export class GalleryDlWorker {
  private readonly jobs = new ProviderJobRunner({cancelledMessage: 'Download cancelled.', busyMessage: 'Another Pinterest job is already active.', disposedMessage: 'Pinterest worker is shut down.'});
  private current: (JobDetails & {context: ProviderJobContext}) | null = null;
  private sessionDir: string;
  private sessionDirectory!: AnchoredDir;
  private sessionParent!: AnchoredDir;
  private readonly jobDirectories = new Map<string, AnchoredDir>();
  private readonly platform: NodeJS.Platform;
  private readonly processSpawn: Spawn;
  private readonly killGraceMs: number;
  private readonly metadataTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly fetcher: Fetch;
  private readonly ffmpegPath: string | null;
  private readonly now: () => number;
  readonly searchCache: LruCache<string, SearchCacheEntry>;

  constructor(
    private readonly binary = discoverGalleryDl(),
    private readonly spawn: Spawn = nodeSpawn as Spawn,
    options: GalleryDlOptions = {},
  ) {
    this.sessionDir = resolve(options.sessionDir ?? join(tmpdir(), 'clipdock-gallerydl', randomUUID()));
    this.captureSessionDirectory();
    this.platform = options.platform ?? process.platform;
    this.processSpawn = options.processSpawn ?? nodeSpawn as Spawn;
    this.killGraceMs = options.killGraceMs ?? 3_000;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? globalThis.fetch as unknown as Fetch;
    this.ffmpegPath = options.ffmpegPath === undefined ? null : options.ffmpegPath;
    this.now = options.now ?? Date.now;
    this.searchCache = new LruCache<string, SearchCacheEntry>(SEARCH_CACHE_MAX, SEARCH_CACHE_TTL, this.now);
  }

  setSessionDir(directory: string): void { this.captureSessionDirectory(resolve(directory)); }
  private captureSessionDirectory(directory = this.sessionDir): void {
    const path = prepareDirectory(directory).verify();
    const root = ManagedRoot.capture(dirname(path));
    const parent = AnchoredDir.capture(root.verify(), root);
    const admitted = AnchoredDir.capture(path, root);
    this.sessionDir = path; this.sessionParent = parent; this.sessionDirectory = admitted;
  }
  private admitProviderDirectory(): void {
    try { this.sessionDirectory.verify(); }
    catch (error) {
      // Only the named provider is pruned by cleanup; a selected session root
      // remains immutable. Recreate absence through the original parent only.
      if (basename(this.sessionDir) !== 'pinterest') throw error;
      const path = this.sessionParent.child(basename(this.sessionDir));
      try { lstatSync(path); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        this.sessionDirectory = createDirectory(this.sessionParent, basename(path));
        return;
      }
      throw error;
    }
  }
  isActive(): boolean { return this.jobs.isActive(); }
  isDownloadActive(): boolean { return this.jobs.isActive() && this.current?.kind === 'download'; }
  private assertAvailable(): string {
    if (!this.binary) throw new Error('gallery-dl 1.28.0 or newer was not found. Install gallery-dl or set CLIPDOCK_GALLERYDL_PATH to an absolute executable path.');
    return this.binary;
  }
  private jobDirectory(prefix: 'metadata' | 'download' | 'search'): string {
    return join(this.sessionDir, `${prefix}-${randomUUID()}`);
  }
  private async runJob<T>(details: JobDetails, body: (context: ProviderJobContext) => Promise<T>, mapError?: (error: Error) => Error): Promise<T> {
    let current: typeof this.current = null;
    try {
      return await this.jobs.run(details.jobId ?? randomUUID(), context => {
        current = {...details, context}; this.current = current;
        if (details.jobDir) {
          this.admitProviderDirectory();
          context.createDirectory(details.jobDir);
          this.jobDirectories.set(details.jobDir, AnchoredDir.capture(details.jobDir, this.sessionDirectory.root));
        }
        return body(context);
      }, {
        mapError, notifyFailure: details.kind === 'download',
        cancelledEventMessage: details.kind === 'metadata' ? 'Download cancelled.' : undefined,
        invalidMessage: 'Invalid Pinterest download request.', prerequisites: () => { this.assertAvailable(); },
        cancelledMessage: details.kind === 'search' ? PINTEREST_SEARCH_CANCELLED : details.kind === 'metadata' ? 'Pinterest request cancelled.' : 'Download cancelled.',
        timeoutMs: details.kind === 'download' ? this.downloadTimeoutMs : this.metadataTimeoutMs,
        timeoutMessage: details.kind === 'search' ? PINTEREST_SEARCH_TIMEOUT : 'Pinterest request timed out.',
      });
    } finally { this.jobDirectories.delete(details.jobDir); if (this.current === current) this.current = null; }
  }
  private begin(
    args: string[],
    details: JobDetails,
    onLine: (line: string) => void,
  ): Promise<{code: number | null; stdout: string; stderr: string; stdoutTruncated: boolean}> {
    const context = this.current!.context;
    context.check();
    // Finder-launched Resolve can carry a PATH without Homebrew, which hides
    // ffmpeg from gallery-dl's video merge. Prepend only the verified ffmpeg directory.
    const inheritedPath = process.env.PATH ?? '';
    const ffmpegDir = this.ffmpegPath ? dirname(this.ffmpegPath) : null;
    const env = ffmpegDir
      ? {...process.env, PATH: `${ffmpegDir}${inheritedPath ? (this.platform === 'win32' ? ';' : ':') : ''}${inheritedPath}`}
      : undefined;
    // Single shell:false spawn site via provider-platform
    const bounded = spawnBounded(this.assertAvailable(), args, this.spawn as unknown as import('./provider-platform').Spawn, {
      detached: true,
      env,
      maxStdout: MAX_STDOUT,
      maxStderr: MAX_STDERR,
      timeoutMs: details.kind === 'download' ? this.downloadTimeoutMs : this.metadataTimeoutMs,
      killGraceMs: this.killGraceMs,
      onLine,
      platform: this.platform,
      processSpawn: this.processSpawn as unknown as import('./provider-platform').Spawn,
    });
    return context.wait(bounded).then(result => {
      if (result.timedOut) throw new Error(details.kind === 'search' ? PINTEREST_SEARCH_TIMEOUT : 'Pinterest request timed out.');
      return result;
    });
  }
  private parseOutput(lines: string[]): unknown[] {
    return parseGalleryDlJsonl(lines.join('\n'));
  }
  private async resolveInput(input: unknown, signal?: AbortSignal): Promise<ValidPinterestUrl> {
    const direct = validatePinterestUrl(input);
    if (direct) return direct;
    const short = validatePinterestShortUrl(input);
    if (!short) throw new Error('Enter a valid public Pinterest Pin URL.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, NETWORK_HELPER_TIMEOUT_MS);
    try {
      const first = await this.fetcher(short.url, {redirect: 'manual', signal: controller.signal});
      if (first.status < 300 || first.status > 399) throw new Error('Pinterest short link could not be resolved.');
      if (signal?.aborted) throw new Error('Pinterest request cancelled.');
      const firstLocation = first.headers.get('location') ?? '';
      const immediate = pinterestPinRedirect(firstLocation, short.url);
      if (immediate) return immediate;
      const apiUrl = pinterestApiRedirect(firstLocation, short.url, short.token);
      if (!apiUrl) throw new Error('Pinterest short link redirect was rejected.');
      const second = await this.fetcher(apiUrl, {redirect: 'manual', signal: controller.signal});
      if (second.status < 300 || second.status > 399) throw new Error('Pinterest short link could not be resolved.');
      if (signal?.aborted) throw new Error('Pinterest request cancelled.');
      const resolved = pinterestPinRedirect(second.headers.get('location') ?? '', apiUrl);
      if (!resolved) throw new Error('Pinterest short link did not resolve to a public Pin.');
      return resolved;
    } catch (error) {
      if (signal?.aborted) throw new Error('Pinterest request cancelled.');
      if (controller.signal.aborted) throw new Error('Pinterest short link resolution timed out.');
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('Pinterest short link')) throw error;
      throw new Error('Pinterest short link could not be resolved.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  private async searchPage(query: string, page: number, results: PinterestSearchItem[], thumbnailUrls: Map<string, string>, parentSignal?: AbortSignal): Promise<PinterestSearchPage> {
    if (parentSignal?.aborted) throw parentSignal.reason;
    const start = (page - 1) * SEARCH_PAGE_SIZE;
    const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE).map(item => ({ ...item, thumbnailUrl: safeSearchThumbnailUrl(thumbnailUrls.get(item.id) ?? '')?.href ?? null }));
    const totalResults = results.length;
    return { query, page, pageSize: SEARCH_PAGE_SIZE, results: pageResults, hasPrevious: page > 1, hasNext: start + SEARCH_PAGE_SIZE < totalResults, totalResults, pageCount: Math.min(3, Math.max(1, Math.ceil(totalResults / SEARCH_PAGE_SIZE))) };
  }

  async search(input: unknown, page: unknown): Promise<PinterestSearchPage> {
    const query = validatePinterestSearchQuery(input);
    if (!query) throw new Error('Enter 2–100 characters to search Pinterest.');
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 3) throw new Error('Invalid search request.');
    const key = query.toLocaleLowerCase('en-US');
    const cached = this.searchCache.get(key);
    if (cached) {
      return this.runJob({jobDir: '', kind: 'search'}, context => this.searchPage(cached.query, page, cached.results, cached.thumbnailUrls, context.signal));
    }
    const jobDir = this.jobDirectory('search');
    return await this.runJob({jobDir, kind: 'search'}, async context => {
      const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
      const args = ['--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--range', '1-60', '--http-timeout', HTTP_TIMEOUT_SECONDS, '--retries', HTTP_RETRIES, '--sleep-request', HTTP_SLEEP_SECONDS, searchUrl];
      const pending = this.begin(args, {jobDir, kind: 'search'}, () => undefined);
      const result = await pending;
      context.check();
      if (result.stdoutTruncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_METADATA_BYTES) throw new Error(PINTEREST_SEARCH_TOO_LARGE);
      const output = result.stdout;
      if (Buffer.byteLength(output, 'utf8') > MAX_METADATA_BYTES) throw new Error(PINTEREST_SEARCH_TOO_LARGE);
      if (result.code !== 0 || searchStderrFailed(result.stderr)) throw new Error(mapSearchError(result.stderr));
      let parsed: SearchParseResult;
      try {
        parsed = parsePinterestSearchValues(parseGalleryDlJsonl(output));
      } catch (error) {
        if (result.stderr.trim()) throw new Error(mapSearchError(result.stderr));
        throw error;
      }
      const entry: SearchCacheEntry = {query, createdAt: this.now(), results: parsed.items, thumbnailUrls: parsed.thumbnailUrls};
      const pageResult = await this.searchPage(query, page, entry.results, entry.thumbnailUrls, context.signal);
      context.check();
      this.searchCache.set(key, entry);
      return pageResult;
    }, error => {
      const message = error instanceof Error ? error.message : '';
      if (message === PINTEREST_SEARCH_TIMEOUT || message === PINTEREST_SEARCH_CANCELLED || message === PINTEREST_SEARCH_TOO_LARGE || message === PINTEREST_PRIVATE_ERROR || message === PINTEREST_SEARCH_ERROR || message.startsWith('gallery-dl 1.28.0')) return error;
      return new Error(mapSearchError(message));
    });
  }
  async metadata(input: unknown, context?: {jobId: string}): Promise<PinterestMetadata> {
    const jobDir = this.jobDirectory('metadata');
    return await this.runJob({jobDir, kind: 'metadata', jobId: context?.jobId}, async job => {
      const valid = await this.resolveInput(input, job.signal);
      job.check();
      const args = ['--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--post-range', '1', '--range', '1-50', '--http-timeout', HTTP_TIMEOUT_SECONDS, '--retries', HTTP_RETRIES, '--sleep-request', HTTP_SLEEP_SECONDS, valid.url];
      const pending = this.begin(args, {jobDir, kind: 'metadata', jobId: context?.jobId}, () => undefined);
      const result = await pending;
      job.check();
      if (result.stdoutTruncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_METADATA_BYTES) throw new Error('Pinterest metadata output was too large.');
      const output = result.stdout;
      if (result.code !== 0 || searchStderrFailed(result.stderr)) throw new Error(mapError(result.stderr));
      // One bounded JSONL parse catches [-1] even when gallery-dl exits zero;
      // normalization and thumbnail selection reuse the same values.
      const values = this.parseOutput(output.split(/\r?\n/));
      const metadata = parsePinterestMetadataValues(values, valid);
      job.check();
      metadata.thumbnailUrl = safeThumbnailUrl(thumbnailCandidate(values) ?? '')?.href ?? null;
      job.check();
      return metadata;
    }, error => {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Pinterest request timed out.') return new Error(message);
      if (message === 'Enter a valid public Pinterest Pin URL.' || message.startsWith('Pinterest short link') || message.startsWith('gallery-dl 1.28.0')) return error;
      if (message === PINTEREST_STORY_ERROR || message.includes('metadata was too large') || message.includes('incomplete') || message === PINTEREST_PRIVATE_ERROR || message === PINTEREST_YTDLP_ERROR) return error;
      return new Error(mapError(message || PINTEREST_ERROR));
    });
  }
  async download(input: unknown, itemIndex: unknown, expectedKind: unknown, jobId: unknown, emit: (event: PinterestDownloadEvent) => void): Promise<PinterestDownloadResult> {
    const valid = validatePinterestUrl(input);
    if (!valid || typeof itemIndex !== 'number' || !Number.isInteger(itemIndex) || itemIndex < 1 || itemIndex > MAX_ARTIFACTS || (expectedKind !== 'image' && expectedKind !== 'video') || typeof jobId !== 'string') throw new Error('Invalid Pinterest download request.');
    const jobDir = this.jobDirectory('download');
    return await this.runJob({jobDir, kind: 'download', jobId, emit}, async context => {
      emit({jobId, state: 'downloading', percent: null, message: 'Downloading from Pinterest (progress unavailable)…'});
      // Keep gallery-dl's .part behavior enabled: partial files are visible to
      // the worker while the process runs, never accepted as final artifacts,
      // and removed with the private job directory on terminal completion.
      const args = ['--config-ignore', '-D', jobDir, '-f', 'pinterest.{extension}', '--post-range', '1', '--range', String(itemIndex), '--filesize-max', expectedKind === 'image' ? '20M' : '2G', '--no-mtime', '--http-timeout', HTTP_TIMEOUT_SECONDS, '--retries', HTTP_RETRIES, '--sleep-request', HTTP_SLEEP_SECONDS, valid.url];
      const pending = this.begin(args, {jobDir, kind: 'download', jobId, emit}, () => undefined);
      const result = await pending;
      context.check();
      if (result.stdoutTruncated) throw new Error('Pinterest download output was too large.');
      // Download mode writes completed file paths to stdout, not metadata JSON.
      // Artifact discovery and validation are performed from the private job directory below.
      // gallery-dl treats --filesize-max rejection as a successful skip.
      if (/file size (?:is )?larger than allowed maximum/i.test(result.stderr)) throw new Error(sizeLimitMessage(expectedKind));
      if (result.code !== 0) throw new Error(mapError(result.stderr, true));
      if (/no module named ['"]?yt[_-]?dlp|yt[_-]?dlp.*(?:module|required|not found|missing)|(?:module|package).*yt[_-]?dlp/i.test(result.stderr)) throw new Error(PINTEREST_YTDLP_ERROR);
      const scanned = outputFiles(jobDir);
      if (scanned.symlink || scanned.files.length > MAX_OUTPUT_FILES) throw new Error('Pinterest download failed its safety check.');
      const mediaFiles = scanned.files.filter((file) => !file.endsWith('.part') && !file.endsWith('.tmp') && !file.endsWith('.ytdl'));
      if (mediaFiles.length !== 1 || !/^pinterest\.(?:jpe?g|png|mp4)$/i.test(basename(mediaFiles[0])) || resolve(mediaFiles[0]) !== join(resolve(jobDir), basename(mediaFiles[0]))) throw new Error('Pinterest download did not produce exactly one safe media artifact.');
      const safe = validateOutput(mediaFiles[0], jobDir);
      if (safe.kind !== expectedKind) throw new Error('Pinterest download media did not match its verified metadata.');
      // Successful media stays in its private managed provider job directory so
      // Resolve/history can continue to reference it after this worker returns.
      // Failed/cancelled jobs are removed in the finally block.
      cleanJobDirectory(this.jobDirectories.get(jobDir)!, [safe.path]);
      emit({jobId, state: 'downloading', percent: 100, message: 'Pinterest download complete.'});
      context.publish(jobDir);
      return {filePath: safe.path, fileName: basename(safe.path), kind: safe.kind};
    }, error => {
      const message = error instanceof Error ? error.message : '';
      const userMessage = message === PINTEREST_YTDLP_ERROR || message.startsWith('gallery-dl 1.28.0') ? message : message.includes('limit') || message.includes('safety') || message.includes('signature') || message.includes('output') || message.includes('exactly one') ? message : mapError(message || PINTEREST_DOWNLOAD_ERROR, true);
      return new Error(userMessage);
    });
  }
  cancel(jobId: string): Promise<void> | null {
    const pending = this.jobs.cancel(jobId);
    if (!pending) return null;
    const current = this.current;
    if (current?.kind === 'download' && current.jobId) current.emit?.({jobId: current.jobId, state: 'downloading', percent: null, message: 'Cancelling download…'});
    return pending;
  }

  async dispose(): Promise<void> { await this.jobs.dispose(); }
}

export const galleryDlLimits = {
  minVersion: '1.28.0',
  maxArtifacts: MAX_ARTIFACTS,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxVideoBytes: MAX_VIDEO_BYTES,
};
