// Downloaded containers accepted at the yt-dlp boundary must survive history reloads.
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mpeg', '.mpg',
  '.ts', '.m2ts', '.flv', '.ogg', '.ogv',
]);
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...VIDEO_EXTENSIONS, '.m4a', '.mp3', '.wav', '.jpg', '.jpeg', '.png',
]);
