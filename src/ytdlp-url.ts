// HTTPS URL validation for provider entry points. This module deliberately has no
// Electron or process APIs; main owns the authoritative validation call.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const SOCIAL_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SOCIAL_HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const SOCIAL_VIDEO_ID = /^[0-9]{1,40}$/;

export type ValidYoutubeUrl = { url: string; videoId: string };
export type ValidPinterestUrl = { url: string; pinId: string };
export type ValidPinterestShortUrl = { url: string; token: string };
export type SocialPlatform = 'instagram' | 'twitter' | 'facebook';
export type ValidSocialUrl = { url: string; platform: SocialPlatform };

export function validateYoutubeUrl(input: unknown): ValidYoutubeUrl | null {
  if (typeof input !== 'string' || input.length < 12 || input.length > 2_048) return null;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !YOUTUBE_HOSTS.has(host)) return null;
  if (parsed.searchParams.has('list') || parsed.pathname.startsWith('/playlist')) return null;
  let id: string | null = null;
  if (host === 'youtu.be') id = parsed.pathname.match(/^\/([^/]+)\/?$/)?.[1] ?? null;
  else if (parsed.pathname === '/watch' && !host.includes('nocookie')) id = parsed.searchParams.get('v');
  else {
    const match = parsed.pathname.match(/^\/(shorts|embed)\/([^/]+)\/?$/);
    if (match && (match[1] === 'embed' || !host.includes('nocookie'))) id = match[2];
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  return { url: `https://www.youtube.com/watch?v=${id}`, videoId: id };
}

const PIN_ID = /^\d{1,40}$/;
/** pinterest.com, www.pinterest.com, or a two-letter country subdomain such as tr.pinterest.com. */
export const pinterestPinHost = (host: string): boolean => /^(?:(?:www|[a-z]{2})\.)?pinterest\.com$/.test(host);
const PINTEREST_SHORT_TOKEN = /^[A-Za-z0-9_-]{1,80}$/;

/** Validate and normalize one anonymous Pinterest search query. */
export function validatePinterestSearchQuery(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const query = input.trim();
  return query.length >= 2 && query.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(query) ? query : null;
}

/** Accept only Pinterest's exact HTTPS short-link shape; resolution stays in main. */
export function validatePinterestShortUrl(input: unknown): ValidPinterestShortUrl | null {
  if (typeof input !== 'string' || input.length < 17 || input.length > 120 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(input)) return null;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{1,80})\/?$/);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'pin.it' || authority.toLowerCase() !== 'pin.it' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match || !PINTEREST_SHORT_TOKEN.test(match[1])) return null;
  return {url: `https://pin.it/${match[1]}`, token: match[1]};
}

/** Validate exactly one public Pinterest Pin URL (including its /sent/ share form) and canonicalize it to www + slash. */
export function validatePinterestUrl(input: unknown): ValidPinterestUrl | null {
  if (typeof input !== 'string' || input.length < 26 || input.length > 2_048 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(input)) return null;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (parsed.protocol !== 'https:' || !pinterestPinHost(host) || authority.toLowerCase() !== host || parsed.port || parsed.username || parsed.password || parsed.hash) return null;
  const match = parsed.pathname.match(/^\/pin\/(\d{1,40})(?:\/sent)?\/?$/);
  if (!match || !PIN_ID.test(match[1])) return null;
  return { url: `https://www.pinterest.com/pin/${match[1]}/`, pinId: match[1] };
}

function secureUrl(input: unknown): URL | null {
  if (typeof input !== 'string' || input.length < 8 || input.length > 2_048 || /[\u0000-\u0020\u005c\u007f-\u009f]/.test(input)) return null;
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (authority.includes(':') || authority.includes('@')) return null;
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' && !parsed.port ? parsed : null;
  } catch { return null; }
}

/** Validate one public video-page shape and strip tracking/fragments from its source. */
export function validateSocialUrl(input: unknown): ValidSocialUrl | null {
  if (typeof input === 'string') {
    const rawPath = input.split('?')[0].split('#')[0].replace(/^https:\/\/[^/]+/i, '');
    if (rawPath.split('/').some(seg => seg === '.' || seg === '..')) return null;
  }
  const parsed = secureUrl(input);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (host === 'instagram.com' || host === 'www.instagram.com') {
    const match = path.match(/^\/(reel|p|tv)\/([A-Za-z0-9_-]{1,80})\/?$/);
    if (!match || !SOCIAL_ID.test(match[2])) return null;
    return { url: `https://www.instagram.com/${match[1]}/${match[2]}`, platform: 'instagram' };
  }

  if (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') {
    const match = path.match(/^\/(?:([A-Za-z0-9_]{1,30})\/status|i\/(?:web\/)?status)\/([0-9]{1,40})\/?$/);
    if (!match || (match[1] !== undefined && !SOCIAL_HANDLE.test(match[1]))) return null;
    return { url: `https://x.com/${match[1] ?? 'i'}/status/${match[2]}`, platform: 'twitter' };
  }

  if (host === 'fb.watch') {
    const match = path.match(/^\/([A-Za-z0-9_-]{1,80})\/?$/);
    if (!match || !SOCIAL_ID.test(match[1])) return null;
    return { url: `https://fb.watch/${match[1]}`, platform: 'facebook' };
  }

  if (host !== 'facebook.com' && host !== 'www.facebook.com') return null;
  const watch = path.match(/^\/watch\/?$/);
  if (watch) {
    const values = parsed.searchParams.getAll('v');
    if (parsed.searchParams.has('list') || parsed.searchParams.has('playlist') || values.length !== 1 || !SOCIAL_VIDEO_ID.test(values[0])) return null;
    return { url: `https://www.facebook.com/watch?v=${values[0]}`, platform: 'facebook' };
  }
  const reel = path.match(/^\/reel\/([0-9]{1,40})\/?$/);
  if (reel && SOCIAL_VIDEO_ID.test(reel[1])) return { url: `https://www.facebook.com/reel/${reel[1]}`, platform: 'facebook' };
  const videos = path.match(/^\/(?:videos|[A-Za-z0-9._-]{1,80}\/videos)\/([0-9]{1,40})\/?$/);
  if (videos && SOCIAL_VIDEO_ID.test(videos[1])) return { url: `https://www.facebook.com/videos/${videos[1]}`, platform: 'facebook' };
  return null;
}
