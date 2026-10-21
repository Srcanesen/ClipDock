// Pexels adapter for the stock-media client. Node-only: main owns this module and never exposes its key or paths.
import { StockClient, fileLabel, finite, positiveInteger, safeHostUrl, safeText, type StockAsset, type StockClientOptions, type StockConnectionStatus, type StockEvent, type StockFile, type StockKind, type StockPage, type StockSource } from './stock';

export type PexelsKind = StockKind;
export type PexelsFile = StockFile;
export type PexelsAsset = StockAsset;
export type PexelsPage = StockPage;
export type PexelsEvent = StockEvent;
export type PexelsConnectionStatus = StockConnectionStatus;

const API = 'api.pexels.com';
const API_HOSTS = new Set([API]);
const MAX_SEARCH_PAGE = 100;
const CDN_HOSTS = new Set(['images.pexels.com', 'videos.pexels.com']);

export function safePexelsUrl(value: unknown, api = false): URL | null {
  return safeHostUrl(value, api ? API_HOSTS : CDN_HOSTS);
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

const PEXELS: StockSource = {
  label: 'Pexels', prefix: 'pexels', mediaHosts: CDN_HOSTS, kinds: ['photo', 'video'], maxPage: MAX_SEARCH_PAGE,
  auth: 'header', cacheTtlMs: 60_000, resetIsRelative: false, rejectedStatuses: [401, 403],
  validateUrl: () => new URL('/v1/curated?per_page=1', `https://${API}`),
  searchUrl(kind, query, page) {
    const url = new URL(kind === 'photo' ? '/v1/search' : '/videos/search', `https://${API}`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '15');
    return url;
  },
  loadUrl: (kind, id) => new URL(kind === 'photo' ? `/v1/photos/${id}` : `/videos/videos/${id}`, `https://${API}`),
  parsePage: parsePexelsPage,
  parseAsset: (raw, kind) => normalize(raw, kind),
};

export class PexelsClient extends StockClient {
  constructor(root?: string, fetchFn?: typeof fetch, options?: StockClientOptions) { super(PEXELS, root, fetchFn, options); }
}
