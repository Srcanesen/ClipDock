// yt-dlp boundary: Node-only, Electron-free, and intentionally narrow.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, win32 } from 'node:path';
import { contains as pathContains } from './path-boundary';
import { absoluteForPlatform, discoverBinary, LruCache, spawnBounded, fetchBounded, cleanJobDirectory, SharedProviderOperation } from './provider-platform';
import { ProviderJobRunner, ProviderJobCancelledError, ProviderJobRejectedError, requireFfprobe, type ProviderJobContext } from './provider-job';
import { homedir, tmpdir } from 'node:os';
import { discoverFfprobe } from './media-prep';
import { VIDEO_EXTENSIONS } from './media-extensions';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, SafeFsError, appendOwned, captureFile, createDirectory, openExclusive, prepareDirectory, verifyFile, writeExclusive, writeOwned, type OwnedFile } from './safe-fs';
import { randomUUID } from 'node:crypto';
import { validateSocialUrl, validateYoutubeUrl, type SocialPlatform, type ValidSocialUrl, type ValidYoutubeUrl } from './ytdlp-url';

export type Quality = 'best' | `${number}p`;
export type MediaMode = 'video' | 'audio';
export type AudioFormat = 'wav' | 'mp3' | 'm4a';
export type SubtitleLanguage = 'en' | 'es' | 'fr' | 'de' | 'tr';
export type Chapter = { start: number; end: number; title: string };
export type RangeSelection = { start: number; end: number; label: string } | null;
export type SubtitleCue = { start: number; end: number; text: string };
export type DownloadOptions = { mediaMode: MediaMode; audioFormat: AudioFormat; subtitles: boolean; subtitleLanguage: SubtitleLanguage; selection?: RangeSelection; preferH264?: boolean };
export type YtdlpState = 'idle' | 'metadata' | 'downloading' | 'processing' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export type NarrowMetadata = { id: string; title: string; duration: number | null; channel: string | null; thumbnailUrl: string | null; heights: number[]; formatSummary: string[]; chapters: Chapter[] };
export type SocialMetadata = { id: string; platform: SocialPlatform; source: string; title: string; duration: number | null; channel: string | null; thumbnailDataUrl: string | null; heights: number[]; formatSummary: string[] };
export type ThumbnailDiagnostic = { failed: number; total: number; reason: string; node: string };
export type YoutubeSearchItem = { id: string; title: string; channel: string | null; duration: number | null; url: string; thumbnailUrl: string | null; viewCount: number | null; publishedAt: number | null; channelVerified: boolean };
export type YoutubeSearchPage = { query: string; page: number; pageSize: 10; results: YoutubeSearchItem[]; hasPrevious: boolean; hasNext: boolean; totalResults: number; pageCount: number; thumbnailDiagnostic?: ThumbnailDiagnostic };
export type DownloadEvent = { jobId: string; state: YtdlpState; percent: number | null; message: string; speedBytesPerSecond?: number | null; etaSeconds?: number | null; fileName?: string };

type Spawn = (binary: string, args: string[], options: { shell: false }) => ChildProcess;
type Fetch = (url: string, init?: { redirect?: 'follow'; signal?: AbortSignal }) => Promise<{ ok: boolean; url?: string; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
type JobDetails = { jobDir: string; kind: 'metadata' | 'download' | 'search'; sharedMetadata?: boolean; cancelledLog?: string; emit?: (event: DownloadEvent) => void; jobId?: string };
type WorkerOptions = { sessionDir?: string; platform?: NodeJS.Platform; processSpawn?: Spawn; killGraceMs?: number; ffmpegPath?: string | null; ffprobePath?: string | null; jsRuntime?: string | null; metadataTimeoutMs?: number; downloadTimeoutMs?: number; thumbnailTimeoutMs?: number; now?: () => number };
type SearchCacheEntry = { query: string; createdAt: number; results: YoutubeSearchItem[] };
// Workers using the same extractor dependencies share replies and in-flight work.
// The spawn identity also keeps independent embedded/test extractors isolated.
type MetadataStore = {
  youtube: LruCache<string, NarrowMetadata>;
  raw: LruCache<string, string>;
  pending: Map<string, SharedProviderOperation<NarrowMetadata>>;
  social: LruCache<string, {metadata: SocialMetadata; thumbnail: string | null}>;
  socialPending: Map<string, SharedProviderOperation<SocialMetadata>>;
};
const metadataStores = new WeakMap<Spawn, Map<string, MetadataStore>>();
function metadataStore(spawn: Spawn, key: string, now: () => number): MetadataStore {
  let stores = metadataStores.get(spawn);
  if (!stores) { stores = new Map(); metadataStores.set(spawn, stores); }
  let store = stores.get(key);
  if (!store) {
    store = {youtube: new LruCache(30, 600_000, now), raw: new LruCache(10, 600_000, now), pending: new Map(), social: new LruCache(30, 120_000, now), socialPending: new Map()};
    stores.set(key, store);
  }
  return store;
}

const BASE = ['--ignore-config', '--no-warnings', '--no-colors', '--no-playlist', '--playlist-items', '1', '--socket-timeout', '15', '--max-filesize', '2147483648'];
const BEST_SELECTOR = 'bv*+ba/b';
const MAX_STDERR = 64 * 1024;
const MAX_STDOUT = 2 * 1024 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BYTES = 256 * 1024;
const MAX_LOG = 128 * 1024;
const MAX_THUMBNAIL = 5 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const SEARCH_PAGE_SIZE = 10;
const SEARCH_MAX_RESULTS = 30;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 10;
const THUMBNAIL_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com']);
const THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SOCIAL_ERRORS = new Set([
  'Live streams are not supported. Use a public video post.',
  'This video is still processing after the live stream. Try again later.',
  'This video is private or requires login. Only public videos are supported.',
  'This post does not contain a supported video. Image-only posts are not supported.',
]);

type VersionProbe = (candidate: string) => { code: number | null; text: string } | null;
function probeVersion(candidate: string): { code: number | null; text: string } | null {
  // retained for test seam compatibility; provider-platform owns the spawnSync probe
  try {
    const { spawnSync: sync } = require('node:child_process') as typeof import('node:child_process');
    const result = sync(candidate, ['-version'], { shell: false, timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: VERSION_PROBE_MAX_BYTES });
    return { code: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } catch { return null; }
}
export function discoverYtdlp(env = process.env, platform = process.platform, pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')): string | null {
  // Thin adapter: delegate candidate enumeration to provider-platform, preserving absolute+executable semantics
  const names = platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp.bat'] : ['yt-dlp'];
  const extra = [...(platform === 'darwin' ? ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'] : []), ...(platform === 'win32' ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'yt-dlp', 'yt-dlp.exe'), join(env.LOCALAPPDATA ?? '', 'yt-dlp', 'yt-dlp.exe')] : [])];
  // ytdlp's override allows any executable absolute path (no version check)
  const configured = env.CLIPDOCK_YTDLP_PATH;
  if (configured && isAbsolute(configured)) {
    try {
      const { accessSync: acc, constants: cons } = require('node:fs') as typeof import('node:fs');
      acc(configured, cons.X_OK);
      return configured;
    } catch { /* fall through to PATH discovery */ }
  }
  return discoverBinary(names, null, { env, platform, pathEntries, extraCandidates: extra, allowNoVersion: true });
}
export function discoverFfmpeg(env = process.env, platform = process.platform, pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':'), probe: VersionProbe = probeVersion): string | null {
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const extra = [...(platform === 'darwin' ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', join(env.HOME ?? homedir(), 'bin', 'ffmpeg')] : []), ...(platform === 'win32' ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'), join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'), join(env.USERPROFILE ?? '', 'bin', 'ffmpeg.exe')] : [])];
  return discoverBinary([name], ['-version'], { env, platform, pathEntries, envKey: 'CLIPDOCK_FFMPEG_PATH', extraCandidates: extra, versionIdentity: 'ffmpeg version', probe });
}
/**
 * yt-dlp needs an external JavaScript runtime to solve YouTube's player challenges;
 * without one YouTube rejects media requests with HTTP 403. Apps launched from
 * Resolve inherit a minimal PATH, so look in the usual install locations too.
 * Returns a `--js-runtimes` value, preferring Deno, then Node, Bun and QuickJS.
 */
export function discoverJsRuntime(env = process.env, platform = process.platform, pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':'), probe?: VersionProbe): string | null {
  const home = env.HOME ?? homedir();
  const deno = discoverBinary([platform === 'win32' ? 'deno.exe' : 'deno'], ['--version'], { env, platform, pathEntries, envKey: 'CLIPDOCK_DENO_PATH', extraCandidates: [...(platform === 'darwin' ? ['/opt/homebrew/bin/deno', '/usr/local/bin/deno'] : []), ...(platform === 'win32' ? [join(env.USERPROFILE ?? '', '.deno', 'bin', 'deno.exe')] : [join(home, '.deno', 'bin', 'deno')])], versionIdentity: 'deno ', versionCheck: ({ text }) => runtimeVersionSupported(text, /^deno (\S+)/, [2, 3, 0]), probe });
  if (deno) return `deno:${deno}`;
  const node = discoverBinary([platform === 'win32' ? 'node.exe' : 'node'], ['--version'], { env, platform, pathEntries, extraCandidates: platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : [], versionIdentity: 'v', versionCheck: ({ text }) => runtimeVersionSupported(text, /^v(\S+)/, [22, 0, 0]), probe });
  if (node) return `node:${node}`;
  const bun = discoverBinary([platform === 'win32' ? 'bun.exe' : 'bun'], ['--version'], { env, platform, pathEntries, extraCandidates: [...(platform === 'darwin' ? ['/opt/homebrew/bin/bun', '/usr/local/bin/bun'] : []), join(platform === 'win32' ? env.USERPROFILE ?? home : home, '.bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun')], versionCheck: ({ code, text }) => code === 0 && runtimeVersionSupported(text, /^(\S+)/, [1, 2, 11]), probe });
  if (bun) return `bun:${bun}`;
  const quickjs = discoverBinary([platform === 'win32' ? 'qjs.exe' : 'qjs'], ['--help'], { env, platform, pathEntries, extraCandidates: platform === 'darwin' ? ['/opt/homebrew/bin/qjs', '/usr/local/bin/qjs'] : [], versionCheck: ({ code, text }) => code !== null && runtimeVersionSupported(text, /^QuickJS(?:-ng)?\s+version\s+(\S+)/, text.includes('QuickJS-ng') ? [0] : [2023, 12, 9], text.includes('QuickJS-ng')), probe });
  if (quickjs) return `quickjs:${quickjs}`;
  console.warn('No supported JavaScript runtime found. yt-dlp requires Deno >=2.3.0, Node >=22.0.0, Bun >=1.2.11, QuickJS >=2023-12-09, or QuickJS-ng >0. YouTube challenge solving may be unavailable.');
  return null;
}

// Mirror yt-dlp 2026.8.19 utils/_jsruntime.py and its lenient version_tuple:
// split on dots/hyphens, use -1 for non-integer components, compare tuples.
// QuickJS-ng uses > (0,) instead of the date minimum of upstream QuickJS.
function runtimeVersionSupported(text: string, pattern: RegExp, minimum: number[], strict = false): boolean {
  const match = text.match(pattern);
  if (!match) return false;
  const version = match[1].split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : -1);
  for (let i = 0; i < Math.min(version.length, minimum.length); i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return version.length > minimum.length || (!strict && version.length === minimum.length);
}
const AUDIO_FORMATS = new Set<AudioFormat>(['wav', 'mp3', 'm4a']);
const SUBTITLE_LANGUAGES = new Set<SubtitleLanguage>(['en', 'es', 'fr', 'de', 'tr']);
function validOptions(options: unknown, duration: number | null = null): options is DownloadOptions {
  const x = options as Partial<DownloadOptions> | null;
  return !!x && (x.mediaMode === 'video' || x.mediaMode === 'audio') && AUDIO_FORMATS.has(x.audioFormat as AudioFormat) && typeof x.subtitles === 'boolean' && SUBTITLE_LANGUAGES.has(x.subtitleLanguage as SubtitleLanguage) && (x.selection === undefined || x.selection === null || validateRange(x.selection, duration) !== null);
}
export function parseSubtitleCues(text: string, max = 200): SubtitleCue[] {
  const time = (value: string): number | null => { const m = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : null; };
  return text.replace(/^WEBVTT[^\n]*\n/i, '').split(/\r?\n\r?\n/).flatMap((block) => { const lines = block.split(/\r?\n/).filter(Boolean); const at = lines.findIndex((line) => line.includes('-->')); if (at < 0) return []; const [a, b] = lines[at].split('-->').map((x) => time(x.trim().split(/\s+/)[0])); const cue = lines.slice(at + 1).join(' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300); return a !== null && b !== null && b > a && cue ? [{ start: a, end: b, text: cue }] : []; }).slice(0, max);
}
function selector(quality: unknown): string | null {
  if (quality === 'best') return BEST_SELECTOR;
  if (typeof quality !== 'string' || !/^[1-9]\d{2,3}p$/.test(quality)) return null;
  const height = Number(quality.slice(0, -1));
  return height >= 144 && height <= 4320
    ? `bv*[height<=${height}]+ba/b[height<=${height}]`
    : null;
}

function safeText(v: unknown, max = 300): string { return typeof v === 'string' ? v.replace(/[\r\n]/g, ' ').slice(0, max) : ''; }
export function validateYoutubeSearch(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const query = input.trim();
  return query.length >= 2 && query.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(query) ? query : null;
}
function narrowSearchEntry(raw: unknown): YoutubeSearchItem | null {
  const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(entry.id)) return null;
  const title = safeText(entry.title, 200).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  if (!title) return null;
  const channel = safeText(entry.channel ?? entry.uploader, 100).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() || null;
  const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0 && entry.duration <= 86400 ? entry.duration : null;
  const viewCount = typeof entry.view_count === 'number' && Number.isInteger(entry.view_count) && entry.view_count >= 0 && entry.view_count <= 1e15 ? entry.view_count : null;
  const publishedAt = typeof entry.timestamp === 'number' && Number.isInteger(entry.timestamp) && entry.timestamp >= 0 && entry.timestamp <= 4102444800 ? entry.timestamp : null;
  const channelVerified = entry.channel_is_verified === true;
  if (!((entry.live_status ?? null) === null || entry.live_status === 'not_live' || entry.live_status === 'was_live')) return null;
  if (!((entry.availability ?? null) === null || entry.availability === 'public' || entry.availability === 'unlisted')) return null;
  return { id: entry.id, title, channel, duration, url: `https://www.youtube.com/watch?v=${entry.id}`, thumbnailUrl: youtubeThumbnail(entry, entry.id), viewCount, publishedAt, channelVerified };
}
export function youtubeThumbnail(raw: Record<string, unknown>, id: string): string | null {
  const safe = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'i.ytimg.com' && !url.username && !url.password && !url.port && !url.hash ? url.href : null; } catch { return null; }
  };
  const thumbnails = (Array.isArray(raw.thumbnails) ? raw.thumbnails : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const candidates = thumbnails.filter(x => Number(x.width) >= 320 && Number(x.width) <= 480).sort((a, b) => Number(a.width) - Number(b.width));
  for (const candidate of candidates) { const url = safe(candidate.url); if (url) return url; }
  // An explicitly supplied untrusted image is rejected rather than propagated.
  if ((typeof raw.thumbnail === 'string' && !safe(raw.thumbnail)) || (thumbnails.length > 0 && !thumbnails.some(item => safe(item.url)))) return null;
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}
export function validateRange(value: unknown, duration: number | null): RangeSelection | null {
  const x = value as Partial<RangeSelection> | null;
  const start = x?.start, end = x?.end;
  return typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && (duration === null || end <= duration) ? { start, end, label: safeText(x?.label, 80) || `${start.toFixed(2)}-${end.toFixed(2)}` } : null;
}
function chapters(raw: unknown, duration: number | null): Chapter[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((item) => { const x = item && typeof item === 'object' ? item as Record<string, unknown> : {}; const range = validateRange({ start: x.start_time, end: x.end_time, label: x.title }, duration); return range ? [{ start: range.start, end: range.end, title: range.label }] : []; });
}
function narrowMetadata(raw: unknown, thumbnailUrl: string | null): NarrowMetadata {
  const x = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const formats = Array.isArray(x.formats) ? x.formats : [];
  const duration = typeof x.duration === 'number' && Number.isFinite(x.duration) && x.duration >= 0 ? x.duration : null;
  const heights = [...new Set(formats.map((f) => Number((f as Record<string, unknown>).height)).filter((h) => Number.isInteger(h) && h >= 144 && h <= 4320))].sort((a, b) => a - b);
  return { id: safeText(x.id, 64), title: safeText(x.title) || 'Untitled video', duration, channel: safeText(x.channel || x.uploader) || null, thumbnailUrl, heights, formatSummary: heights.map((h) => `${h}p`), chapters: chapters(x.chapters, duration) };
}
function socialEntries(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(raw.entries)) return [raw];
  return raw.entries.flatMap((entry) => entry && typeof entry === 'object' ? [entry as Record<string, unknown>] : []);
}
function socialAvailability(raw: Record<string, unknown>): 'live' | 'processing' | 'private' | null {
  const status = safeText(raw.live_status, 40).toLowerCase();
  if (raw.is_live === true || ['is_live', 'is_upcoming'].includes(status)) return 'live';
  if (status === 'post_live') return 'processing';
  const availability = safeText(raw.availability, 40).toLowerCase();
  if (raw.requires_login === true || raw.login_required === true || ['private', 'needs_auth', 'subscriber_only', 'premium_only', 'unavailable'].includes(availability)) return 'private';
  return null;
}
function socialHasVideo(raw: Record<string, unknown>): boolean {
  const rawExt = safeText(raw.ext, 10).toLowerCase();
  if (raw._type === 'photo' || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(rawExt)) return false;
  const codec = safeText(raw.vcodec, 40).toLowerCase();
  if (codec) return codec !== 'none';
  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  if (formats.some((format) => {
    if (!format || typeof format !== 'object') return false;
    const item = format as Record<string, unknown>;
    const itemCodec = safeText(item.vcodec, 40).toLowerCase();
    if (itemCodec) return itemCodec !== 'none';
    const itemExt = safeText(item.ext, 10).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(itemExt)) return false;
    const height = Number(item.height);
    return Number.isInteger(height) && height > 0;
  })) return true;
  const ext = safeText(raw.ext, 10).toLowerCase();
  return ['mp4', 'mov', 'webm', 'mkv'].includes(ext) && raw._type !== 'photo';
}
function socialVideoEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const entries = socialEntries(raw);
  for (const entry of entries) if (!socialAvailability(entry) && socialHasVideo(entry)) return entry;
  if (entries.some((entry) => socialAvailability(entry) === 'live')) throw new Error('Live streams are not supported. Use a public video post.');
  if (entries.some((entry) => socialAvailability(entry) === 'processing')) throw new Error('This video is still processing after the live stream. Try again later.');
  if (entries.some((entry) => socialAvailability(entry) === 'private')) throw new Error('This video is private or requires login. Only public videos are supported.');
  throw new Error('This post does not contain a supported video. Image-only posts are not supported.');
}
function narrowSocialMetadata(raw: Record<string, unknown>, entry: Record<string, unknown>, valid: ValidSocialUrl, thumbnailDataUrl: string | null): SocialMetadata {
  const formats = Array.isArray(entry.formats) ? entry.formats : [];
  const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0 && entry.duration <= 86_400 ? entry.duration : null;
  const heights = [...new Set(formats.map((format) => Number((format as Record<string, unknown>).height)).filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))].sort((a, b) => a - b);
  const id = safeText(entry.id, 80) || valid.url;
  return { id, platform: valid.platform, source: valid.url, title: safeText(entry.title || raw.title) || 'Untitled video', duration, channel: safeText(entry.channel || entry.uploader || entry.creator) || null, thumbnailDataUrl, heights, formatSummary: heights.map((height) => `${height}p`) };
}
function socialThumbnailHost(platform: SocialPlatform, host: string): boolean {
  const value = host.toLowerCase();
  if (platform === 'instagram') return value === 'cdninstagram.com' || value.endsWith('.cdninstagram.com') || value === 'fbcdn.net' || value.endsWith('.fbcdn.net');
  if (platform === 'twitter') return value === 'pbs.twimg.com';
  return value === 'fbcdn.net' || value.endsWith('.fbcdn.net') || value === 'fbsbx.com' || value.endsWith('.fbsbx.com');
}
// yt-dlp and gallery-dl pass path arguments through Python's os.path.expandvars.
// `${CLIPDOCK_LITERAL_DOLLAR}` expands to a literal `$` that is never re-expanded.
// On Windows, `%%` spells `%` outside yt-dlp templates (which already double it),
// and single quotes suspend expansion, so a quoted `$` or `%` cannot be spelled.
const LITERAL_DOLLAR = 'CLIPDOCK_LITERAL_DOLLAR';
const UNSPELLABLE_PATH = 'The download folder path cannot combine an apostrophe with $ or %. Choose another download folder.';
export function literalPath(path: string, platform: NodeJS.Platform, template = false): string {
  if (platform === 'win32' && path.includes('\'') && /[$%]/.test(path)) throw new Error(UNSPELLABLE_PATH);
  const literal = path.replace(/\$/g, `\${${LITERAL_DOLLAR}}`);
  return platform === 'win32' && !template ? literal.replace(/%/g, '%%') : literal;
}
export function literalPathEnv(args: string[]): NodeJS.ProcessEnv | undefined {
  return args.some(arg => arg.includes(`\${${LITERAL_DOLLAR}}`)) ? {...process.env, [LITERAL_DOLLAR]: '$'} : undefined;
}
// yt-dlp prefixes extractor errors with "[extractor] <id>:"; IDs are not diagnostics.
function withoutExtractorPrefix(text: string): string {
  return text.replace(/^(\s*ERROR:\s*)\[[^\]\r\n]*\]\s*[^\s:]*:\s*/gim, '$1');
}
function sanitized(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, '[url]').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim();
}

const DOWNLOAD_FAILURE_MESSAGES = new Set([
  'This video is private or requires login. Only public videos are supported.',
  'This video was removed or is no longer available.',
  'This video exceeds ClipDock’s 2 GB download limit.',
  'There is not enough disk space to finish the download.',
  'Could not write the downloaded media. Check the download folder permissions and try again.',
  UNSPELLABLE_PATH,
  'The requested format is not available. Choose another quality or media mode.',
  'Download failed.',
]);
export function downloadFailureMessage(detail: unknown): string {
  const raw = typeof detail === 'string' ? detail : '';
  const errors = raw.split(/\r?\n/).filter(line => /^\s*ERROR:/i.test(line)).map(withoutExtractorPrefix);
  // Provider errors carry ERROR prefixes. Ignore warnings and strip paths/URLs
  // before matching access/availability words that may occur in a filename.
  const text = errors.join('\n')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(['"])(?:[a-z]:[\\/]|\/)[^\r\n]*?\1/gi, '[path]')
    .replace(/(?:[a-z]:)?[\\/][^\s'"]+/gi, '[path]').toLowerCase();
  // Size skips and OS write diagnostics can also be emitted without ERROR.
  const diagnostic = errors.length ? text : raw.toLowerCase();
  if (/enospc|no space left|not enough (?:free )?(?:disk )?space|disk (?:is )?full/.test(diagnostic)) return 'There is not enough disk space to finish the download.';
  if (/unable to (?:write|open for writing)|cannot write|could not write|write (?:failed|error)|read-only file system|permission denied/.test(diagnostic)) return 'Could not write the downloaded media. Check the download folder permissions and try again.';
  if (/max[- ]filesize|larger than.*(?:max|2\s*(?:gb|gib))|exceeds.*2\s*(?:gb|gib)|file size.*2\s*(?:gb|gib)/.test(diagnostic)) return 'This video exceeds ClipDock’s 2 GB download limit.';
  if (/requested formats? (?:is |are )?(?:not available|unavailable)|no video formats found/.test(text)) return 'The requested format is not available. Choose another quality or media mode.';
  if (/\bprivate\b|login|log in|sign in|authentication|authenticate|cookies?/.test(text)) return 'This video is private or requires login. Only public videos are supported.';
  if (/removed|deleted|no longer available|video unavailable|not available|copyright/.test(text)) return 'This video was removed or is no longer available.';
  return 'Download failed.';
}

// yt-dlp matches --sub-langs whole, so `en` misses `en-US`. Pick one available tag:
// human subtitles before automatic captions, the exact tag before a regional one.
function subtitleTag(rawInfo: string | null, language: SubtitleLanguage): string {
  let info: Record<string, unknown> = {};
  try { info = rawInfo ? JSON.parse(rawInfo) as Record<string, unknown> : {}; } catch { /* exact tag */ }
  for (const source of [info.subtitles, info.automatic_captions]) {
    const tags = source && typeof source === 'object' ? Object.keys(source) : [];
    const tag = tags.includes(language) ? language : tags.find(tag => tag.startsWith(`${language}-`) && /^[A-Za-z0-9-]{1,32}$/.test(tag));
    if (tag) return tag;
  }
  return language;
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export class YtdlpWorker {
  private readonly jobs = new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'yt-dlp worker is shut down.'});
  private current: (JobDetails & {context: ProviderJobContext}) | null = null;
  private readonly activeJobs = new Map<string, JobDetails>();
  private readonly metadataTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly thumbnailTimeoutMs: number;
  private readonly ffprobePath: string | null;
  private sessionDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly processSpawn: Spawn;
  private readonly killGraceMs: number;
  private readonly ffmpegPath: string | null;
  private readonly jsRuntime: string | null;
  private readonly now: () => number;
  readonly searchCache: LruCache<string, SearchCacheEntry>;
  private readonly metadataStore: MetadataStore;
  private readonly thumbnailAbort = new AbortController();
  private prefetchWorker: YtdlpWorker | null = null;
  private prefetchPending = false;
  private disposed = false;
  constructor(private readonly binary = discoverYtdlp(), private readonly spawn: Spawn = nodeSpawn as Spawn, private readonly fetcher: Fetch = globalThis.fetch as unknown as Fetch, private readonly options: WorkerOptions = {}) {
    this.sessionDir = options.sessionDir ?? join(tmpdir(), 'clipdock', randomUUID());
    this.platform = options.platform ?? process.platform;
    this.processSpawn = options.processSpawn ?? nodeSpawn as Spawn;
    this.killGraceMs = options.killGraceMs ?? 3_000;
    this.ffmpegPath = options.ffmpegPath === undefined ? discoverFfmpeg(process.env, this.platform) : options.ffmpegPath;
    this.ffprobePath = options.ffprobePath === undefined ? discoverFfprobe(this.ffmpegPath) : options.ffprobePath;
    this.jsRuntime = options.jsRuntime ?? null;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 30000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 30 * 60 * 1000;
    this.thumbnailTimeoutMs = options.thumbnailTimeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.searchCache = new LruCache<string, SearchCacheEntry>(SEARCH_CACHE_MAX, SEARCH_CACHE_TTL, this.now);
    this.metadataStore = metadataStore(this.spawn, JSON.stringify([this.binary, this.jsRuntime]), this.now);
    this.captureLogDirectory();
  }
  /**
   * Move future jobs to a new session directory (download folder change). The
   * currently active job keeps its already-resolved job directory; only jobs
   * started afterwards use the new root.
   */
  setSessionDir(dir: string): void {
    this.sessionDir = dir;
    this.prefetchWorker?.setSessionDir(dir);
    this.captureLogDirectory();
  }
  private assertAvailable(): string { if (!this.binary) throw new Error('yt-dlp was not found. Install yt-dlp or set CLIPDOCK_YTDLP_PATH to an absolute executable path.'); return this.binary; }
  private logDirectory!: AnchoredDir;
  private logParent!: AnchoredDir;
  private stopObservingLogDirectory?: () => void;
  private captureLogDirectory(): void {
    this.stopObservingLogDirectory?.();
    const path = prepareDirectory(this.sessionDir).verify();
    this.sessionDir = path;
    const root = ManagedRoot.capture(dirname(path));
    const parent = AnchoredDir.capture(root.verify(), root);
    this.logParent = parent;
    this.logDirectory = AnchoredDir.capture(path, root); this.logFile = null;
    this.stopObservingLogDirectory = this.jobs.observeDirectories(created => {
      try {
        // Only a newly admitted job supplies fresh provider authority. Its own
        // captured chain and the original managed parent must both still match.
        if (dirname(created.verify()) !== path) return;
        parent.verify();
        try { this.logDirectory.verify(); }
        catch { this.logFile = null; }
        this.logDirectory = AnchoredDir.capture(path, root);
        if (this.logFile) {
          try { verifyFile(this.logFile); }
          catch {
            // Cleanup can remove the log while protected media keeps its parent.
            // An existing replacement keeps the old, refusing file identity.
            try { lstatSync(this.logDirectory.child('clipdock.log'), {bigint: true}); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.logFile = null; }
          }
        }
      } catch { /* diagnostics never refresh authority after an unsafe admission */ }
    });
  }
  private admitProviderDirectory(): void {
    try { this.logDirectory.verify(); }
    catch (error) {
      // Only named providers are pruned by workspace cleanup. An arbitrary
      // caller-selected session directory remains an immutable boundary.
      if (!['youtube', 'social'].includes(basename(this.sessionDir))) throw error;
      // Cleanup may prune this provider. Only absence permits recreation, and
      // only through the original parent; an existing replacement stays rejected.
      const path = this.logParent.child(basename(this.sessionDir));
      try { lstatSync(path); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        this.logDirectory = createDirectory(this.logParent, basename(path));
        this.logFile = null;
        return;
      }
      throw error;
    }
  }
  private readonly jobDirectories = new Map<string, AnchoredDir>();
  private logFile: OwnedFile | null = null;
  private log(message: string): void {
    try {
      const line = `${new Date().toISOString()} ${sanitized(message).slice(0, MAX_STDERR)}\n`;
      const directory = this.logDirectory;
      if (!this.logFile) {
        try {
          const opened = openExclusive(directory, 'clipdock.log');
          closeSync(opened.fd); this.logFile = opened.file;
        } catch (error) {
          if (!(error instanceof SafeFsError && error.code === 'exists')) throw error;
          this.logFile = captureFile(directory, directory.child('clipdock.log'));
        }
      }
      appendOwned(this.logFile, line, MAX_LOG);
    } catch { /* diagnostics must never prevent reporting or cleanup */ }
  }
  private async runJob<T>(details: JobDetails, body: (context: ProviderJobContext) => Promise<T>, cancelledMessage = 'Download cancelled.', mapError?: (error: Error) => Error): Promise<T> {
    let current: typeof this.current = null;
    const jobId = details.jobId ?? randomUUID();
    try {
      return await this.jobs.run(jobId, context => {
        current = {...details, context};
        this.activeJobs.set(jobId, current);
        // A shared wait owns no child and must not replace a running extractor's
        // context, or prevent explicit work alongside speculative prefetch.
        if (!details.sharedMetadata) this.current = current;
        if (details.jobDir) {
          this.admitProviderDirectory();
          context.createDirectory(details.jobDir);
          this.jobDirectories.set(details.jobDir, AnchoredDir.capture(details.jobDir, this.logDirectory.root));
        }
        return body(context);
      }, {cancelledMessage, mapError, notifyFailure: details.kind === 'download', busyMessage: 'Another ClipDock URL job is already active.', invalidMessage: details.kind === 'metadata' ? 'Invalid social download request.' : 'Invalid download request.', prerequisites: () => {
        if (!details.sharedMetadata && this.current) throw new ProviderJobRejectedError('busy', 'Another ClipDock URL job is already active.');
        if (details.kind === 'download') {
          if (!this.ffmpegPath || !absoluteForPlatform(this.ffmpegPath, this.platform)) throw new Error('ffmpeg was not found. Install ffmpeg or set CLIPDOCK_FFMPEG_PATH to an absolute executable path.');
        }
      }, terminal: outcome => {
        if (outcome.state === 'cancelled') {
          const message = details.kind === 'download' ? 'download cancelled' : details.cancelledLog;
          if (message) this.log(message);
        }
      }});
    } finally {
      this.jobDirectories.delete(details.jobDir);
      if (this.current === current) this.current = null;
      if (current && this.activeJobs.get(jobId) === current) this.activeJobs.delete(jobId);
    }
  }
  private begin(args: string[], details: JobDetails, onLine?: (line: string) => void, onStderrLine?: (line: string) => void): Promise<import('./provider-platform').SpawnBoundedResult> {
    const context = this.current!.context;
    context.check();
    const bounded = spawnBounded(this.assertAvailable(), this.jsRuntime ? [...args.slice(0, 1), '--js-runtimes', this.jsRuntime, ...args.slice(1)] : args, this.spawn, {
      env: literalPathEnv(args), maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR, onLine, onStderrLine,
      timeoutMs: details.kind === 'download' ? this.downloadTimeoutMs : this.metadataTimeoutMs,
      killGraceMs: this.killGraceMs, platform: this.platform, processSpawn: this.processSpawn,
    });
    return context.wait(bounded).then(result => {
      if (result.timedOut) throw new Error('yt-dlp request timed out.');
      return result;
    });
  }
  private async thumbnail(raw: Record<string, unknown>, allowed: Set<string> | ((host: string) => boolean) = THUMBNAIL_HOSTS): Promise<string | null> {
    const source = typeof raw.thumbnail === 'string' ? raw.thumbnail : '';
    let url: URL; try { url = new URL(source); } catch { return null; }
    const hostAllowed = (host: string): boolean => allowed instanceof Set ? allowed.has(host.toLowerCase()) : allowed(host.toLowerCase());
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname)) return null;
    try {
      const {response, bytes} = await fetchBounded(this.fetcher, url.toString(), MAX_THUMBNAIL, this.thumbnailAbort.signal, this.thumbnailTimeoutMs, response => {
        const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        let final: URL; try { final = new URL(response.url || url.toString()); } catch { return 'redirect-host'; }
        return !response.ok ? 'status' : !THUMBNAIL_TYPES.has(type) ? 'mime' : final.protocol !== 'https:' || !hostAllowed(final.hostname) ? 'redirect-host' : null;
      });
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const length = Number(response.headers.get('content-length'));
      const final = new URL(response.url || url.toString());
      if (!response.ok || !THUMBNAIL_TYPES.has(type) || final.protocol !== 'https:' || !hostAllowed(final.hostname) || (Number.isFinite(length) && length > MAX_THUMBNAIL)) return null;
      if (bytes.length > MAX_THUMBNAIL) return null;
      return `data:${type};base64,${bytes.toString('base64')}`;
    } catch { return null; }
  }
  private async searchPage(query: string, page: number, results: YoutubeSearchItem[]): Promise<YoutubeSearchPage> {
    const start = (page - 1) * SEARCH_PAGE_SIZE;
    const totalResults = results.length;
    return { query, page, pageSize: SEARCH_PAGE_SIZE, results: results.slice(start, start + SEARCH_PAGE_SIZE).map(item => ({ ...item })), hasPrevious: page > 1, hasNext: start + SEARCH_PAGE_SIZE < totalResults, totalResults, pageCount: Math.min(3, Math.max(1, Math.ceil(totalResults / SEARCH_PAGE_SIZE))) };
  }
  async search(input: unknown, page: unknown): Promise<YoutubeSearchPage> {
    const query = validateYoutubeSearch(input);
    if (!query) throw new Error('Enter 2–100 characters to search YouTube.');
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 3) throw new Error('Invalid search request.');
    const key = query.toLocaleLowerCase('en-US');
    const cached = this.searchCache.get(key);
    if (cached) {
      return this.runJob({jobDir: '', kind: 'search'}, () => this.searchPage(cached.query, page, cached.results));
    }
    const jobDir = join(this.sessionDir, `search-${randomUUID()}`);
    return await this.runJob({jobDir, kind: 'search'}, async context => {
      const pending = this.begin(['--ignore-config', '--no-warnings', '--no-colors', '--socket-timeout', '15', '--flat-playlist', '--dump-single-json', '--skip-download', '--playlist-end', '30', `ytsearch30:${query}`], { jobDir, kind: 'search' });
      const result = await pending;
      context.check();
      if (result.code !== 0) { this.log(`search failed code=${result.code}`); throw new Error('Could not search YouTube.'); }
      if (result.stdoutTruncated) { this.log('search results exceeded stdout limit'); throw new Error('Search results were too large.'); }
      let raw: Record<string, unknown>; try { raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>; } catch { this.log('search returned invalid JSON'); throw new Error('Could not search YouTube.'); }
      if (!Array.isArray(raw.entries) || raw.entries.length > SEARCH_MAX_RESULTS) throw new Error('Could not search YouTube.');
      const seen = new Set<string>();
      const results = raw.entries.flatMap((entry) => { const item = narrowSearchEntry(entry); return item && !seen.has(item.id) ? (seen.add(item.id), [item]) : []; });
      this.searchCache.set(key, { query, createdAt: this.now(), results });
      return await this.searchPage(query, page, results);
    }, 'Could not search YouTube.', error => {
      const message = (error as Error).message;
      if (['Could not search YouTube.', 'Search results were too large.'].includes(message)) return error;
      this.log('search error');
      return new Error('Could not search YouTube.');
    });
  }
  async prefetchMetadata(input: unknown): Promise<void> {
    const valid = validateYoutubeUrl(input);
    if (this.disposed || !valid || this.prefetchPending || this.metadataStore.youtube.get(valid.videoId) || this.metadataStore.pending.has(valid.videoId) || this.jobs.isActive()) return;
    this.prefetchPending = true;
    this.prefetchWorker ??= new YtdlpWorker(this.binary, this.spawn, this.fetcher, { ...this.options, sessionDir: this.sessionDir });
    const pending = this.prefetchWorker.metadata(valid.url);
    try { await pending; } catch { /* Speculative failures are silent and never cached. */ }
    finally { this.prefetchPending = false; }
  }
  async metadata(input: unknown, context?: {jobId: string; emit: (event: DownloadEvent) => void}): Promise<NarrowMetadata> {
    const valid = validateYoutubeUrl(input); if (!valid) throw new Error('Enter a valid single YouTube video URL.');
    if (this.disposed) throw new ProviderJobRejectedError('disposed', 'yt-dlp worker is shut down.');
    const sharedMetadata = !this.metadataStore.youtube.has(valid.videoId) && this.metadataStore.pending.has(valid.videoId);
    return this.runJob({jobDir: '', kind: 'metadata', sharedMetadata, jobId: context?.jobId, emit: context?.emit}, async job => {
      const cached = this.metadataStore.youtube.get(valid.videoId); if (cached) return structuredClone(cached);
      return this.subscribeMetadata(this.metadataStore.pending, valid.videoId, job.signal, worker => worker.loadMetadata(valid.url).then(value => {
        this.metadataStore.youtube.set(valid.videoId, value); return value;
      }));
    }, context ? 'Download cancelled.' : 'Could not load video metadata.');
  }
  private async subscribeMetadata<T>(pending: Map<string, SharedProviderOperation<T>>, key: string, signal: AbortSignal, load: (worker: YtdlpWorker) => Promise<T>): Promise<T> {
    let shared = pending.get(key);
    if (!shared) {
      // Extraction has its own lifetime: even the first caller is a subscriber,
      // so its disposal cannot kill work another role still needs.
      const extractor = new YtdlpWorker(this.binary, this.spawn, this.fetcher, {...this.options, sessionDir: this.sessionDir});
      const operation = new SharedProviderOperation({result: load(extractor).finally(() => extractor.dispose()), cancel: () => extractor.dispose()}, () => {
        if (pending.get(key) === operation) pending.delete(key);
      });
      pending.set(key, operation);
      shared = operation;
    }
    return structuredClone(await shared.subscribe(signal));
  }
  private async loadMetadata(input: unknown, context?: {jobId: string; emit: (event: DownloadEvent) => void}): Promise<NarrowMetadata> {
    const valid = validateYoutubeUrl(input); if (!valid) throw new Error('Enter a valid single YouTube video URL.');
    const jobDir = join(this.sessionDir, `metadata-${randomUUID()}`);
    return await this.runJob({jobDir, kind: 'metadata', jobId: context?.jobId, emit: context?.emit}, async job => {
      const pending = this.begin([...BASE, '--dump-single-json', valid.url], { jobDir, kind: 'metadata', jobId: context?.jobId, emit: context?.emit });
      const result = await pending;
      job.check();
      if (result.code !== 0) { this.log(`metadata failed code=${result.code}: ${result.stderr || 'no stderr'}`); throw new Error('Could not load video metadata.'); }
      let raw: Record<string, unknown>; try { raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>; } catch { this.log('metadata returned invalid JSON'); throw new Error('yt-dlp returned invalid metadata.'); }
      if (safeText(raw.id, 64) !== valid.videoId) { this.log('metadata video ID mismatch'); throw new Error('Metadata did not match the requested video.'); }
      // yt-dlp's load-info entry point otherwise retries webpage_url internally.
      // ClipDock owns the single URL retry, including cancellation and cleanup.
      const reusable = {...raw}; delete reusable.webpage_url;
      this.metadataStore.raw.set(valid.videoId, JSON.stringify(reusable));
      const thumbnail = youtubeThumbnail(raw, valid.videoId);
      job.check();
      return narrowMetadata(raw, thumbnail);
    }, context ? 'Download cancelled.' : 'Could not load video metadata.', error => {
      const message = (error as Error).message;
      if (['Could not load video metadata.', 'yt-dlp returned invalid metadata.', 'Metadata did not match the requested video.'].includes(message)) return error;
      this.log(`metadata error: ${message}`);
      return new Error('Could not load video metadata.');
    });
  }
  async metadataSocial(input: unknown, context?: { jobId: string; emit: (event: DownloadEvent) => void }): Promise<SocialMetadata> {
    const valid = validateSocialUrl(input); if (!valid) throw new Error('Enter a valid public Instagram, X, or Facebook video URL.');
    if (this.disposed) throw new ProviderJobRejectedError('disposed', 'yt-dlp worker is shut down.');
    const sharedMetadata = !this.metadataStore.social.has(valid.url) && this.metadataStore.socialPending.has(valid.url);
    return this.runJob({jobDir: '', kind: 'metadata', sharedMetadata, jobId: context?.jobId, emit: context?.emit, cancelledLog: context ? 'social metadata cancelled' : undefined}, async job => {
      const cached = this.metadataStore.social.get(valid.url); if (cached) return structuredClone(cached.metadata);
      return this.subscribeMetadata(this.metadataStore.socialPending, valid.url, job.signal, worker => worker.loadSocialMetadata(valid.url));
    }, context ? 'Download cancelled.' : 'Could not load public social video metadata.');
  }
  // Thumbnail I/O is requested separately after the renderer has painted metadata.
  async thumbnailSocial(input: unknown): Promise<string | null> {
    const valid = validateSocialUrl(input); if (!valid || this.disposed) return null;
    const cached = this.metadataStore.social.get(valid.url); if (!cached?.thumbnail) return null;
    return this.thumbnail({thumbnail: cached.thumbnail}, host => socialThumbnailHost(valid.platform, host));
  }
  private async loadSocialMetadata(input: string, context?: {jobId: string; emit: (event: DownloadEvent) => void}): Promise<SocialMetadata> {
    const valid = validateSocialUrl(input)!;
    const jobDir = join(this.sessionDir, `metadata-${randomUUID()}`);
    return await this.runJob({jobDir, kind: 'metadata', jobId: context?.jobId, emit: context?.emit, cancelledLog: context ? 'social metadata cancelled' : undefined}, async job => {
      const pending = this.begin([...BASE, '--dump-single-json', valid.url], { jobDir, kind: 'metadata', jobId: context?.jobId, emit: context?.emit });
      const result = await pending;
      job.check();
      if (result.code !== 0) {
        this.log(`social metadata failed code=${result.code}: ${result.stderr || 'no stderr'}`);
        const detail = withoutExtractorPrefix(result.stderr).toLowerCase();
        if (/\blive\b|upcoming/.test(detail)) throw new Error('Live streams are not supported. Use a public video post.');
        if (/private|login|log in|sign in|authentication|authenticate/.test(detail)) throw new Error('This video is private or requires login. Only public videos are supported.');
        throw new Error('Could not load public social video metadata. Only permitted public video posts are supported.');
      }
      let raw: Record<string, unknown>; try { raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>; } catch { this.log('social metadata returned invalid JSON'); throw new Error('Could not load public social video metadata.'); }
      const entry = socialVideoEntry(raw);
      const metadata = narrowSocialMetadata(raw, entry, valid, null);
      this.metadataStore.social.set(valid.url, {metadata, thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : null});
      return metadata;
    }, context ? 'Download cancelled.' : 'Could not load public social video metadata.', error => {
      const message = (error as Error).message;
      if (SOCIAL_ERRORS.has(message) || message === 'Could not load public social video metadata. Only permitted public video posts are supported.' || message === 'Could not load public social video metadata.') return error;
      this.log(`social metadata error: ${message}`);
      return new Error('Could not load public social video metadata.');
    });
  }
  private async downloadValidated(valid: ValidYoutubeUrl | ValidSocialUrl, quality: Quality, jobId: string, emit: (event: DownloadEvent) => void, options: DownloadOptions): Promise<{ filePath: string; fileName: string; subtitlePath?: string; subtitleFileName?: string; warning?: string }> {
    const format = options.mediaMode === 'video' ? selector(quality) : 'ba/b';
    const selection = options.selection === undefined || options.selection === null ? null : validateRange(options.selection, null);
    if (!validOptions(options) || (options.selection && !selection) || !format) throw new Error('Invalid download request.');
    const selectedFormat = format;
    // Fast output: at 1080p and below prefer YouTube's H.264/AAC rendition at the best
    // available height, so media prep can keep the file as-is instead of transcoding.
    const fastHeight = options.mediaMode === 'video' && options.preferH264 === true && typeof quality === 'string' && /^\d+p$/.test(quality) ? Number(quality.slice(0, -1)) : null;
    const formatSort = fastHeight !== null && fastHeight <= 1080 ? ['-S', `res:${fastHeight},vcodec:h264,acodec:aac`] : [];
    const ffmpegPath = this.ffmpegPath!;
    const jobDir = join(this.sessionDir, `download-${randomUUID()}`);
    let output: string | null = null;
    let failureDetail = '';
    return await this.runJob({jobDir, kind: 'download', emit, jobId}, async context => {
      emit({jobId, state: 'downloading', percent: null, message: 'Starting download…'});
      const conversion = options.mediaMode === 'audio' ? ['-x', '--audio-format', options.audioFormat === 'm4a' ? 'm4a' : options.audioFormat] : ['--merge-output-format', 'mp4'];
      // yt-dlp fetches a merged format's streams one after another, each from 0%.
      // before_dl names them ("137+140") with sizes, so progress can be one rising total.
      let streams: string[] = []; let weights: number[] = []; let overall = 0;
      const overallPercent = (formatId: string, streamPercent: number): number | null => {
        const index = streams.indexOf(formatId);
        if (index < 0) return null;
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const done = weights.slice(0, index).reduce((sum, weight) => sum + weight, 0);
        overall = Math.max(overall, Math.min(100, ((done + weights[index] * streamPercent / 100) / total) * 100));
        return overall;
      };
      const cachedInfo = 'videoId' in valid && !selection ? this.metadataStore.raw.get(valid.videoId) : null;
      const subtitleLanguage = subtitleTag('videoId' in valid ? this.metadataStore.raw.get(valid.videoId) : null, options.subtitleLanguage);
      const infoPath = join(jobDir, 'source.info.json');
      if (cachedInfo) writeExclusive(this.jobDirectories.get(jobDir)!, basename(infoPath), cachedInfo);
      let bytesWritten = false;
      const combinedSubtitles = options.subtitles && !selection;
      const runDownload = (loaded: boolean) => this.begin([...BASE, '--quiet', '--progress', '--progress-delta', '0.25', '--newline', '--progress-template', 'download:C|%(progress.status)s|%(progress._percent).1f|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s', '--progress-template', 'postprocess:Q|%(progress.status)s', '--print', 'before_dl:S|%(format_id)s|%(requested_formats.:.filesize)l|%(filesize,filesize_approx)s', '--print', 'after_move:P|%(filepath)s', '--no-overwrites', '--windows-filenames', '--ffmpeg-location', literalPath(ffmpegPath, this.platform), ...(selection ? ['--download-sections', `*${selection.start.toFixed(3)}-${selection.end.toFixed(3)}`, '--force-keyframes-at-cuts'] : []), ...(combinedSubtitles ? ['--write-subs', '--write-auto-subs', '--sub-langs', subtitleLanguage, '--sub-format', 'srt/vtt', '--ignore-errors'] : []), ...conversion, '-f', selectedFormat, ...formatSort, '-o', literalPath(join(jobDir.replace(/%/g, '%%'), selection ? `%(title).120B [%(id)s] [${selection.label.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 50)}].%(ext)s` : '%(title).150B [%(id)s].%(ext)s'), this.platform, true), ...(loaded ? ['--load-info-json', literalPath(infoPath, this.platform)] : [valid.url])], { jobDir, kind: 'download', emit, jobId }, (line) => {
        if (line.startsWith('Q|')) { emit({jobId, state: 'processing', percent: null, message: 'Processing media…'}); return; }
        if (line.startsWith('P|')) { output = line.slice(2); return; }
        const fields = line.split('|');
        if (fields[0] === 'S' && fields.length >= 4) {
          streams = fields[1].trim().split('+').filter(Boolean);
          const sizes = (streams.length > 1 ? fields[2].split(',') : [fields[3]]).map(size => Number(size.trim()));
          weights = sizes.length === streams.length && sizes.every(size => Number.isFinite(size) && size > 0) ? sizes : streams.map(() => 1);
          return;
        }
        if (fields[0] !== 'C' || fields.length < 7) return;
        bytesWritten ||= Number(fields[3]) > 0;
        const percent = Number(fields[2]);
        if (Number.isFinite(percent)) {
          const speedRaw = fields[5].trim(); const speed = Number(speedRaw);
          const etaRaw = fields[6].trim(); const eta = Number(etaRaw);
          const streamPercent = Math.max(0, Math.min(100, percent));
          const total = overallPercent((fields[7] ?? '').trim(), streamPercent);
          const message = fields[1] === 'finished' ? 'Downloaded stream; processing media…' : total === null ? `Downloading stream (${streamPercent.toFixed(1)}%)…` : streams.length > 1 ? `Downloading stream ${streams.indexOf((fields[7] ?? '').trim()) + 1} of ${streams.length}…` : 'Downloading…';
          emit({ jobId, state: 'downloading', percent: total, message, speedBytesPerSecond: speedRaw !== '' && Number.isFinite(speed) && speed >= 0 ? speed : null, etaSeconds: etaRaw !== '' && Number.isFinite(eta) && eta >= 0 ? Math.min(604800, eta) : null });
        }
      }, line => {
        // yt-dlp emits postprocessor templates on stderr; keep stdout path
        // handling separate and retain stderr in the bounded diagnostic log.
        if (line.startsWith('Q|')) emit({jobId, state: 'processing', percent: null, message: 'Processing media…'});
      });
      let result = await runDownload(!!cachedInfo);
      context.check();
      const wroteMedia = () => readdirSync(jobDir).some(name => {
        if (name === 'source.info.json' || /\.(?:srt|vtt|ass|lrc|ttml|srv[123]|json3)(?:\.part)?$/i.test(name)) return false;
        const file = statSync(join(jobDir, name));
        return file.isFile() && file.size > 0;
      });
      if (cachedInfo && result.code !== 0 && (/HTTP.*(?:403|410)|expired|Requested format is not available/i.test(result.stderr) || (!bytesWritten && !wroteMedia()))) {
        if ('videoId' in valid) this.metadataStore.raw.delete(valid.videoId);
        cleanJobDirectory(this.jobDirectories.get(jobDir)!, [infoPath]);
        output = null; streams = []; weights = []; overall = 0;
        result = await runDownload(false);
        context.check();
      }
      // With --quiet, yt-dlp's max-filesize skip exits successfully without
      // a final path or any diagnostic. Nonzero exits remain ordinary failures.
      if (result.code === 0 && !output && !result.stdout.trim() && !result.stderr.trim()) throw new Error('This video exceeds ClipDock’s 2 GB download limit.');
      if (result.code !== 0 || !output) { failureDetail = result.stderr || 'missing final path'; this.log(`download failed code=${result.code}: ${failureDetail}`); throw new Error(downloadFailureMessage(failureDetail)); }
      if (!isAbsolute(output) || !existsSync(output) || !statSync(output).isFile()) throw new Error('Downloaded file failed the safety check.');
      const filePath = realpathSync(output);
      if (!pathContains(realpathSync(jobDir), filePath)) throw new Error('Downloaded file failed the safety check.');
      if (options.mediaMode === 'video' && !VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase())) throw new Error('Downloaded media failed validation.');
      if (options.mediaMode === 'audio' && !filePath.toLowerCase().endsWith(`.${options.audioFormat}`)) throw new Error('Downloaded file failed the safety check.');
      const size = statSync(filePath).size;
      if (size === 0 || size > 2147483648) throw new Error('Downloaded media exceeded the size limit or was empty.');
      requireFfprobe(this.ffprobePath, 'ffprobe was not found. Install ffprobe to validate downloaded media.');
      const checked = spawnBounded(this.ffprobePath!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], this.spawn, {maxStdout: MAX_STDOUT, timeoutMs: this.metadataTimeoutMs, killGraceMs: this.killGraceMs, platform: this.platform, processSpawn: this.processSpawn});
      const probe = await context.wait(checked);
      context.check();
      if (probe.timedOut) throw new Error('Downloaded media validation timed out.');
      let media: {streams?: {codec_type?: string; avg_frame_rate?: string; start_time?: string; width?: number; height?: number}[]; format?: {duration?: string; format_name?: string}};
      try { media = JSON.parse(probe.stdout); } catch { throw new Error('Downloaded media failed validation.'); }
      if (probe.code !== 0 || probe.stdoutTruncated || !media.streams?.some(stream => stream.codec_type === options.mediaMode)) throw new Error('Downloaded media failed validation.');
      const mediaDuration = Number(media.format?.duration);
      const videoFormats = new Set(['mov', 'mp4', 'matroska', 'webm', 'avi', 'mpeg', 'mpegts', 'flv', 'ogg', 'asf', 'nut']);
      const videoStream = media.streams.find(stream => stream.codec_type === 'video');
      if (!Number.isFinite(mediaDuration) || !(mediaDuration > 0) || (options.mediaMode === 'video' && (!videoStream || !(Number(videoStream.width) > 0) || !(Number(videoStream.height) > 0) || !media.format?.format_name?.split(',').some(name => videoFormats.has(name))))) throw new Error('Downloaded media failed validation.');
      if (selection) {
        const video = media.streams.find(stream => stream.codec_type === 'video');
        const [numerator, denominator] = (video?.avg_frame_rate ?? '').split('/').map(Number);
        const fps = numerator / denominator;
        const tolerance = Number.isFinite(fps) && fps > 0 ? Math.max(0.02, 2 / fps) : 0.05;
        const duration = Number(media.format?.duration);
        if (!Number.isFinite(duration) || Math.abs(duration - (selection.end - selection.start)) > tolerance || (video?.start_time !== undefined && Math.abs(Number(video.start_time)) > tolerance)) throw new Error('Downloaded media did not match the requested In/Out range.');
      }
      let subtitlePath: string | undefined;
      const subtitlePreserved: string[] = [];
      let warning: string | undefined;
      if (options.subtitles) {
        emit({ jobId, state: 'processing', percent: null, message: 'Retrieving subtitles…' });
        try {
          const pendingSubtitle = selection ? this.begin([...BASE, '--quiet', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', subtitleLanguage, '--convert-subs', 'srt', '--no-overwrites', '--windows-filenames', '--ffmpeg-location', literalPath(ffmpegPath, this.platform), '-o', literalPath(join(jobDir.replace(/%/g, '%%'), '%(title).150B [%(id)s].%(ext)s'), this.platform, true), valid.url], { jobDir, kind: 'download', emit, jobId }) : Promise.resolve({code: 0});
          const subtitle = await pendingSubtitle;
          context.check();
          // Full clips use the existing cue normalizer to write SRT directly.
          // This avoids a failing subtitle converter poisoning the media exit code.
          const directory = this.jobDirectories.get(jobDir)!;
          const candidates = readdirSync(directory.verify()).filter(name => /\.srt$/i.test(name) || (!selection && /\.vtt$/i.test(name))).filter(name => {
            const path = directory.child(name);
            if (!lstatSync(path).isSymbolicLink()) return true;
            subtitlePreserved.push(path); return false;
          });
          if (subtitle.code === 0 && candidates.length === 1) {
            subtitlePreserved.push(directory.child(candidates[0]));
            const source = captureFile(directory, directory.child(candidates[0]));
            const candidate = source.path;
            if (pathContains(realpathSync(jobDir), candidate) && statSync(candidate).isFile() && statSync(candidate).size <= MAX_SUBTITLE_BYTES) {
              const cues = parseSubtitleCues(readFileSync(candidate, 'utf8'), Infinity);
              const selected = selection ? cues.filter(cue => cue.end > selection.start && cue.start < selection.end).map(cue => ({...cue, start: Math.max(cue.start, selection.start) - selection.start, end: Math.min(cue.end, selection.end) - selection.start})) : cues;
              if (selected.length) {
                const target = selection ? join(jobDir, 'captions.segment.srt') : candidate.replace(/\.vtt$/i, '.srt');
                subtitlePreserved.push(target);
                const content = selected.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
                if (target === candidate) writeOwned(source, content);
                else writeExclusive(directory, basename(target), content);
                subtitlePath = target;
                subtitlePreserved.length = 0;
              } else warning = 'Subtitles were unavailable; the media download is ready.';
            }
            else warning = 'Subtitle file failed the safety check.';
          } else warning = 'Subtitles were unavailable; the media download is ready.';
        } catch (subtitleError) {
          context.check();
          if (subtitleError instanceof ProviderJobCancelledError) {
            throw subtitleError;
          } else {
            warning = 'Subtitles were unavailable; the media download is ready.';
          }
        }
      }
      cleanJobDirectory(this.jobDirectories.get(jobDir)!, [filePath, ...(subtitlePath ? [subtitlePath] : []), ...subtitlePreserved]);
      context.publish(jobDir);
      return { filePath, fileName: basename(filePath), subtitlePath, subtitleFileName: subtitlePath ? basename(subtitlePath) : undefined, warning };
    }, 'Download cancelled.', error => {
      const message = (error as Error).message;
      const userMessage = message.startsWith('Downloaded ') || message.startsWith('ffprobe ') || message.includes('timed out') ? message : DOWNLOAD_FAILURE_MESSAGES.has(message) ? message : downloadFailureMessage(failureDetail || message);
      this.log(`download error: ${message}`);
      return new Error(userMessage);
    });
  }
  async download(input: unknown, quality: Quality, jobId: string, emit: (event: DownloadEvent) => void, options: DownloadOptions = { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' }): Promise<{ filePath: string; fileName: string; subtitlePath?: string; subtitleFileName?: string; warning?: string }> {
    const valid = validateYoutubeUrl(input); if (!valid) throw new Error('Enter a valid single YouTube video URL.');
    return this.downloadValidated(valid, quality, jobId, emit, options);
  }
  async downloadSocial(input: unknown, quality: Quality, jobId: string, emit: (event: DownloadEvent) => void): Promise<{ filePath: string; fileName: string; warning?: string }> {
    const valid = validateSocialUrl(input); if (!valid) throw new Error('Enter a valid public Instagram, X, or Facebook video URL.');
    const result = await this.downloadValidated(valid, quality, jobId, emit, { mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en' });
    return { filePath: result.filePath, fileName: result.fileName, warning: result.warning };
  }
  async subtitles(input: unknown, language: unknown): Promise<SubtitleCue[]> {
    const valid = validateYoutubeUrl(input); if (!valid || !SUBTITLE_LANGUAGES.has(language as SubtitleLanguage)) throw new Error('Invalid subtitle request.');
    const jobDir = join(this.sessionDir, `subtitles-${randomUUID()}`);
    return this.runJob({jobDir, kind: 'metadata'}, async context => {
      const raw = this.metadataStore.raw.get(valid.videoId);
      const infoPath = join(jobDir, 'source.info.json');
      if (raw) writeExclusive(this.jobDirectories.get(jobDir)!, basename(infoPath), raw);
      const runSubtitles = (loaded: boolean) => this.begin([...BASE, '--quiet', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', subtitleTag(raw, language as SubtitleLanguage), '--convert-subs', 'vtt', '-o', literalPath(join(jobDir.replace(/%/g, '%%'), 'captions.%(ext)s'), this.platform, true), ...(loaded ? ['--load-info-json', literalPath(infoPath, this.platform)] : [valid.url])], {jobDir, kind: 'metadata'});
      let result = await runSubtitles(!!raw);
      context.check();
      if (raw && result.code !== 0) {
        this.metadataStore.raw.delete(valid.videoId);
        cleanJobDirectory(this.jobDirectories.get(jobDir)!, [infoPath]);
        result = await runSubtitles(false);
      }
      context.check();
      if (result.code !== 0) throw new Error('Subtitles were unavailable.');
      const file = readdirSync(jobDir).find(name => name.endsWith('.vtt'));
      if (!file) throw new Error('Subtitles were unavailable.');
      const subtitleFile = join(jobDir, file);
      if (statSync(subtitleFile).size > MAX_SUBTITLE_BYTES) throw new Error('Subtitle text was too large.');
      return parseSubtitleCues(readFileSync(subtitleFile, 'utf8'));
    }, 'Subtitles were unavailable.');
  }
  isActive(): boolean { return this.jobs.isActive(); }
  isDownloadActive(): boolean { return this.jobs.isActive() && this.current?.kind === 'download'; }
  cancel(jobId: string): Promise<void> | null {
    const pending = this.jobs.cancel(jobId);
    if (!pending) return null;
    this.activeJobs.get(jobId)?.emit?.({jobId, state: 'cancelling', percent: null, message: 'Cancelling download…'});
    return pending;
  }
  async dispose(): Promise<void> { this.disposed = true; this.thumbnailAbort.abort(); await Promise.all([this.jobs.dispose(), this.prefetchWorker?.dispose()]); }
}
