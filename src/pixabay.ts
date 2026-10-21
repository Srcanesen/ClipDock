// Pixabay adapter for the stock-media client: videos only. Node-only: main owns
// this module. The key travels in the query string, so URLs built here never carry
// it; the client adds it at fetch time and never surfaces a request URL or error.
import { StockClient, fileLabel, finite, positiveInteger, safeHostUrl, safeText, type StockAsset, type StockClientOptions, type StockFile, type StockPage, type StockSource } from './stock';

const API = 'pixabay.com';
const PAGE_SIZE = 15;
// Pixabay exposes at most 500 hits per query.
const MAX_SEARCH_PAGE = Math.ceil(500 / PAGE_SIZE);
const CDN_HOSTS = new Set(['cdn.pixabay.com']);
const PAGE_HOSTS = new Set(['pixabay.com']);
const RENDITIONS: Array<[string, string]> = [['large', 'Large'], ['medium', 'Medium'], ['small', 'Small'], ['tiny', 'Tiny']];

export const safePixabayUrl = (value: unknown): URL | null => safeHostUrl(value, CDN_HOSTS);

export function safePixabayExternal(value: unknown): string | null {
  return safeHostUrl(value, PAGE_HOSTS)?.toString() ?? null;
}

const apiUrl = (params: Record<string, string>): URL => {
  const url = new URL('/api/videos/', `https://${API}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
};

function normalize(raw: unknown): StockAsset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = positiveInteger(source.id);
  if (id === null) return null;
  const videos = source.videos && typeof source.videos === 'object' ? source.videos as Record<string, unknown> : {};
  const files: StockFile[] = [];
  const rendition = (name: string): Record<string, unknown> => videos[name] && typeof videos[name] === 'object' ? videos[name] as Record<string, unknown> : {};
  for (const [name, displayName] of RENDITIONS) {
    // `large` is listed with an empty URL and size 0 when no such rendition exists.
    const url = safePixabayUrl(rendition(name).url);
    const size = positiveInteger(rendition(name).size);
    if (!url || size === null || files.some(file => file.url === url.href)) continue;
    const width = positiveInteger(rendition(name).width), height = positiveInteger(rendition(name).height);
    files.push({id: name, url: url.href, width, height, label: fileLabel(width, height, displayName), mime: 'video/mp4', size});
  }
  // A list-sized poster; `large` posters are full-frame.
  const thumbnailUrl = ['small', 'medium', 'tiny', 'large'].map(name => safePixabayUrl(rendition(name).thumbnail)?.href).find(Boolean) ?? null;
  const tags = safeText(source.tags, 120);
  return {
    id,
    kind: 'video',
    title: tags ? tags[0].toUpperCase() + tags.slice(1) : `Pixabay video ${id}`,
    creator: safeText(source.user, 80),
    creatorUrl: null,
    sourceUrl: safePixabayExternal(source.pageURL) ?? `https://pixabay.com/videos/id-${id}/`,
    duration: finite(source.duration),
    width: files[0]?.width ?? null,
    height: files[0]?.height ?? null,
    thumbnailUrl,
    files,
    previewUrl: files.find(file => (file.height ?? Infinity) <= 540)?.url ?? files.at(-1)?.url ?? null,
  };
}

export function parsePixabayPage(raw: unknown, query: string, page: number): StockPage {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const hits = Array.isArray(value.hits) ? value.hits : [];
  const seen = new Set<number>();
  const results = hits.flatMap((item): StockAsset[] => {
    const asset = normalize(item);
    if (!asset || !asset.files.length || seen.has(asset.id)) return [];
    seen.add(asset.id);
    return [asset];
  });
  const totalResults = finite(value.totalHits);
  return {
    query, page, pageSize: PAGE_SIZE, results,
    hasPrevious: page > 1,
    hasNext: page < MAX_SEARCH_PAGE && totalResults !== null && page * PAGE_SIZE < totalResults,
    totalResults,
  };
}

const PIXABAY: StockSource = {
  label: 'Pixabay', prefix: 'pixabay', mediaHosts: CDN_HOSTS, kinds: ['video'], maxPage: MAX_SEARCH_PAGE,
  // Terms: cache requests for 24 hours. A 400 while validating is Pixabay's answer to an invalid key.
  auth: 'query', cacheTtlMs: 24 * 60 * 60 * 1000, resetIsRelative: true, rejectedStatuses: [401, 403], validationRejectedStatuses: [400],
  validateUrl: () => apiUrl({per_page: '3'}),
  searchUrl: (_kind, query, page) => apiUrl({q: query, page: String(page), per_page: String(PAGE_SIZE)}),
  loadUrl: (_kind, id) => apiUrl({id: String(id)}),
  parsePage: (raw, _kind, query, page) => parsePixabayPage(raw, query, page),
  parseAsset(raw, _kind, id) {
    const hit = Array.isArray(raw.hits) ? normalize(raw.hits[0]) : null;
    return hit && hit.id === id && hit.files.length ? hit : null;
  },
};

export class PixabayClient extends StockClient {
  constructor(root?: string, fetchFn?: typeof fetch, options?: StockClientOptions) { super(PIXABAY, root, fetchFn, options); }
}
