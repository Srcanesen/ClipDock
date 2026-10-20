// Resolve compatibility preparation boundary: Node-only, Electron-free.
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { spawnBounded } from './provider-platform';
import { ProviderJobRunner, requireFfprobe, type ProviderJobContext } from './provider-job';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, SafeFsError, captureFile, createPrivateDir, publishNoReplace, removeOwned, removePrivateDir, verifyFile, type OwnedFile } from './safe-fs';

export type MediaProfile = 'fast' | 'editing';
export type MediaPrepEvent = { jobId: string; state: 'processing' | 'cancelled'; percent: number | null; message: string };
export type MediaPrepResult = { filePath: string; fileName: string; action: 'direct' | 'remux' | 'audio-remux' | 'transcode' };

type Spawn = (binary: string, args: string[], options: { shell: false }) => ChildProcess;
type Options = { ffmpegPath?: string | null; ffprobePath?: string | null; platform?: NodeJS.Platform; spawn?: Spawn; processSpawn?: Spawn; killGraceMs?: number; env?: NodeJS.ProcessEnv; probeTimeoutMs?: number; conversionTimeoutMs?: number };
type Stream = { codec_name?: unknown; codec_type?: unknown; pix_fmt?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown; duration?: unknown; tags?: unknown; side_data_list?: unknown };
type Probe = { video: { codec: string; pixFmt: string; width: number; height: number; fps: number | null; cfr: boolean; duration: number | null; rotation: number | null }; audio: { codec: string } | null; duration: number | null; container: 'mp4' | 'mov' | 'other' };

const MAX_PROBE = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BYTES = 256 * 1024;

function executable(p: string): boolean { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }
function absoluteForPlatform(p: string, platform: NodeJS.Platform): boolean { return platform === 'win32' ? win32.isAbsolute(p) : isAbsolute(p); }
type VersionProbe = (candidate: string) => { code: number | null; text: string } | null;
function probeVersion(candidate: string): { code: number | null; text: string } | null {
  try {
    const result = spawnSync(candidate, ['-version'], { shell: false, timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: VERSION_PROBE_MAX_BYTES });
    return { code: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } catch { return null; }
}
function versionMatches(candidate: string, identity: string, probe: VersionProbe): boolean {
  const result = probe(candidate);
  return result !== null && result.code === 0 && result.text.toLowerCase().includes(identity);
}

export function discoverFfprobe(ffmpegPath: string | null = null, env = process.env, platform = process.platform, pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':'), probe: VersionProbe = probeVersion): string | null {
  const configured = env.CLIPDOCK_FFPROBE_PATH;
  const name = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const candidates = [
    ...(configured && absoluteForPlatform(configured, platform) ? [configured] : []),
    ...(ffmpegPath && absoluteForPlatform(ffmpegPath, platform) ? [join(dirname(ffmpegPath), name)] : []),
    ...pathEntries.filter(Boolean).map((dir) => join(dir, name)),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', join(env.HOME || homedir(), 'bin', 'ffprobe')] : []),
    ...(platform === 'win32' ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffprobe.exe'), join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'), join(env.USERPROFILE ?? '', 'bin', 'ffprobe.exe')] : []),
  ];
  return candidates.find((candidate) => absoluteForPlatform(candidate, platform) && executable(candidate) && versionMatches(candidate, 'ffprobe version', probe)) ?? null;
}

function rate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(value)) return null;
  const [n, d] = value.split('/').map(Number);
  const fps = n / d;
  return Number.isFinite(fps) && d > 0 && fps >= 1 && fps <= 240 ? fps : null;
}
function finite(value: unknown): number | null { const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; }
function signed(value: unknown): number | null { const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) ? n : null; }
export function parseFfprobe(text: string): Probe {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('ffprobe returned invalid media data.'); }
  const streams = Array.isArray(raw.streams) ? raw.streams as Stream[] : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('The downloaded file has no video stream.');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const avg = rate(video.avg_frame_rate), real = rate(video.r_frame_rate);
  // ponytail: avg/r agreement is a bounded VFR heuristic; upgrade to a full vfrdet pass when field footage proves it insufficient.
  const cfr = avg !== null && real !== null && Math.abs(avg - real) / Math.max(avg, real) <= 0.01;
  const format = raw.format && typeof raw.format === 'object' ? raw.format as Record<string, unknown> : {};
  const tags = format.tags && typeof format.tags === 'object' ? format.tags as Record<string, unknown> : {};
  const names = typeof format.format_name === 'string' ? format.format_name.split(',') : [];
  const brand = typeof tags.major_brand === 'string' ? tags.major_brand.trim().toLowerCase() : '';
  const mp4Brands = new Set(['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'm4v']);
  const container = names.some((name) => name === 'mov' || name === 'mp4') ? (brand === 'qt' ? 'mov' : mp4Brands.has(brand) ? 'mp4' : 'other') : 'other';
  const side = Array.isArray(video.side_data_list) ? video.side_data_list.find((item) => item && typeof item === 'object' && signed((item as Record<string, unknown>).rotation) !== null) as Record<string, unknown> | undefined : undefined;
  const videoTags = video.tags && typeof video.tags === 'object' ? video.tags as Record<string, unknown> : {};
  const rotation = signed(side?.rotation ?? videoTags.rotate);
  const duration = finite(video.duration) ?? finite(format.duration);
  return {
    video: { codec: typeof video.codec_name === 'string' ? video.codec_name : '', pixFmt: typeof video.pix_fmt === 'string' ? video.pix_fmt : '', width: finite(video.width) ?? 0, height: finite(video.height) ?? 0, fps: avg, cfr, duration, rotation },
    audio: audio ? { codec: typeof audio.codec_name === 'string' ? audio.codec_name : '' } : null,
    duration,
    container,
  };
}
function formatRate(fps: number): string { return Number(fps.toFixed(6)).toString(); }
function outputName(input: string, profile: MediaProfile, index: number): string {
  return `${basename(input, extname(input))}.resolve${index === 1 ? '' : `-${index}`}${profile === 'fast' ? '.mp4' : '.mov'}`;
}
function verifySource(source: OwnedFile): string {
  try { return verifyFile(source); }
  catch (error) { if (error instanceof SafeFsError) throw new Error('Media source was replaced or its directory changed; replacement preserved.'); throw error; }
}
function decision(probe: Probe, profile: MediaProfile): MediaPrepResult['action'] {
  if (profile === 'editing') return 'transcode';
  const safeVideo = probe.video.codec === 'h264' && probe.video.pixFmt === 'yuv420p' && probe.video.cfr;
  const safeAudio = !probe.audio || probe.audio.codec === 'aac';
  if (safeVideo && safeAudio && probe.container === 'mp4') return 'direct';
  if (safeVideo && safeAudio) return 'remux';
  if (safeVideo && probe.audio) return 'audio-remux';
  return 'transcode';
}
function ffmpegArgs(action: MediaPrepResult['action'], profile: MediaProfile, input: string, output: string, video: Probe['video']): string[] {
  const fps = video.fps;
  const head = ['-hide_banner', '-nostdin', '-n', '-i', input, '-map', '0:v:0', '-map', '0:a:0?'];
  const tail = ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output];
  if (action === 'remux') return [...head, '-c', 'copy', ...tail];
  if (action === 'audio-remux') return [...head, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...tail];
  if (profile === 'editing') return [...head, '-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le', ...(fps ? ['-r', formatRate(fps)] : []), '-fps_mode', 'cfr', '-c:a', 'pcm_s16le', ...tail];
  const padding = video.width % 2 || video.height % 2 ? ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'] : [];
  return [...head, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...padding, ...(fps ? ['-r', formatRate(fps)] : []), '-fps_mode', 'cfr', '-c:a', 'aac', '-b:a', '192k', ...tail];
}
function validated(input: Probe, output: Probe, profile: MediaProfile, action: MediaPrepResult['action']): boolean {
  const codec = profile === 'fast' ? 'h264' : 'prores';
  const pix = profile === 'fast' ? 'yuv420p' : 'yuv422p10le';
  const display = (video: Probe['video']) => {
    const angle = ((video.rotation ?? 0) % 360 + 360) % 360;
    return angle === 90 || angle === 270 ? [video.height, video.width] : [video.width, video.height];
  };
  const sourceDimensions = display(input.video);
  const [inputWidth, inputHeight] = profile === 'fast' && action === 'transcode' ? sourceDimensions.map(size => Math.ceil(size / 2) * 2) : sourceDimensions;
  const [outputWidth, outputHeight] = display(output.video);
  if (output.video.codec !== codec || output.video.pixFmt !== pix || !output.video.cfr || outputWidth !== inputWidth || outputHeight !== inputHeight || output.container !== (profile === 'fast' ? 'mp4' : 'mov')) return false;
  if (input.video.fps !== null && (output.video.fps === null || Math.abs(output.video.fps - input.video.fps) / input.video.fps > 0.01)) return false;
  if (input.duration !== null && (output.duration === null || Math.abs(output.duration - input.duration) > Math.max(0.5, input.duration * 0.015))) return false;
  if (input.audio && (!output.audio || output.audio.codec !== (profile === 'fast' ? 'aac' : 'pcm_s16le'))) return false;
  return true;
}

export function createMediaPrep(options: Options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const ffmpeg = options.ffmpegPath === undefined ? null : options.ffmpegPath;
  const ffprobe = options.ffprobePath === undefined ? discoverFfprobe(ffmpeg, env, platform) : options.ffprobePath;
  const spawn = options.spawn ?? nodeSpawn as Spawn;
  const processSpawn = options.processSpawn ?? nodeSpawn as Spawn;
  const killGraceMs = options.killGraceMs ?? 3_000;
  const jobs = new ProviderJobRunner({cancelledMessage: 'Media preparation cancelled.', busyMessage: 'Another media preparation job is already active.', disposedMessage: 'Media preparation is shut down.'});

  async function run(context: ProviderJobContext, binary: string, args: string[], progress?: (chunk: string) => void): Promise<{ stdout: string; stderr: string; overflow: boolean }> {
    context.check();
    const bounded = spawnBounded(binary, args, spawn, {
      maxStdout: progress ? 16 * 1024 * 1024 : MAX_PROBE, maxStderr: MAX_STDERR,
      onLine: progress ? line => progress(`${line}\n`) : undefined,
      timeoutMs: progress ? options.conversionTimeoutMs ?? 30 * 60 * 1000 : options.probeTimeoutMs ?? 30000,
      killGraceMs, platform, processSpawn,
    });
    const result = await context.wait(bounded);
    if (result.timedOut) throw new Error('Media tool timed out.');
    if (result.stdoutTruncated && !progress) throw new Error('ffprobe output exceeded the 2 MB limit.');
    if (result.stdoutTruncated || result.code !== 0) throw new Error(result.stderr || 'Media tool failed.');
    return {stdout: result.stdout, stderr: result.stderr, overflow: result.stdoutTruncated};
  }
  async function probe(context: ProviderJobContext, file: string): Promise<Probe> {
    const result = await run(context, ffprobe!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (result.overflow) throw new Error('ffprobe output exceeded the 2 MB limit.');
    return parseFfprobe(result.stdout);
  }
  async function prepare(request: { jobId: string; inputPath: string; allowedRoot: string | ManagedRoot; source?: OwnedFile; profile: MediaProfile; emit: (event: MediaPrepEvent) => void }): Promise<MediaPrepResult> {
    if ((request.profile !== 'fast' && request.profile !== 'editing')) throw new Error('Invalid media preparation request.');
    let input: string, ownedSource: OwnedFile;
    const preparing = 'Preparing for Resolve…';
    return await jobs.run<MediaPrepResult>(request.jobId, async context => {
      request.emit({ jobId: request.jobId, state: 'processing', percent: 0, message: preparing });
      const source = await probe(context, verifySource(ownedSource));
      verifySource(ownedSource);
      const action = decision(source, request.profile);
      if (action === 'direct') return { filePath: input, fileName: basename(input), action };

      const parent = AnchoredDir.capture(dirname(input), ownedSource.dir.root);
      const privateDir = createPrivateDir(parent, '.clipdock-prep-');
      try {
        const convert = async (attempt: MediaPrepResult['action']): Promise<OwnedFile | null> => {
          const temporary = privateDir.child(`${attempt}${request.profile === 'fast' ? '.mp4' : '.mov'}`);
          let pending = '';
          const progressLine = (line: string) => {
            const [key, value] = line.split('=', 2);
            if (key === 'progress' && value === 'end') request.emit({ jobId: request.jobId, state: 'processing', percent: 100, message: preparing });
            else if ((key === 'out_time_ms' || key === 'out_time_us') && source.duration && Number.isFinite(Number(value))) request.emit({ jobId: request.jobId, state: 'processing', percent: Math.max(0, Math.min(99.9, Number(value) / 1_000_000 / source.duration * 100)), message: preparing });
        };
        const progress = (chunk: string) => { pending += chunk; const lines = pending.split(/[\r\n]+/); pending = lines.pop() ?? ''; lines.forEach(progressLine); };
        verifySource(ownedSource); privateDir.verify();
        await run(context, ffmpeg!, ffmpegArgs(attempt, request.profile, input, temporary, source.video), progress);
        if (pending) progressLine(pending);
        const prepared = captureFile(privateDir, temporary);
        if (statSync(verifyFile(prepared)).size === 0) throw new Error('Media file failed the safety check.');
        const output = await probe(context, verifyFile(prepared));
        verifyFile(prepared); verifySource(ownedSource);
        return validated(source, output, request.profile, attempt) ? prepared : null;
        };
        // A copy can expose timing its container hid (Matroska reports timebase rates for VFR): re-encode once.
        let final = action;
        let prepared = await convert(action);
        if (!prepared && action !== 'transcode') prepared = await convert(final = 'transcode');
        if (!prepared) throw new Error('Prepared media failed validation.');
        let published: OwnedFile;
        for (let index = 1;; index++) {
          try { published = publishNoReplace(prepared, parent, outputName(input, request.profile, index)); break; }
          catch (error) { if (!(error instanceof SafeFsError && error.code === 'exists')) throw error; }
        }
        context.register(published);
        context.publish(published.path, () => {
          verifySource(ownedSource);
          if (removeOwned(ownedSource) !== 'removed') throw new Error('Media source was replaced; replacement preserved.');
        });
        return { filePath: published.path, fileName: basename(published.path), action: final };
      } finally { removePrivateDir(privateDir); }
    }, {
      invalidMessage: 'Invalid media preparation request.',
      prerequisites: () => {
        if (!ffmpeg || !absoluteForPlatform(ffmpeg, platform)) throw new Error('ffmpeg was not found. Install ffmpeg or set CLIPDOCK_FFMPEG_PATH to an absolute executable path.');
        requireFfprobe(ffprobe && absoluteForPlatform(ffprobe, platform));
        try {
          if (request.source) ownedSource = request.source;
          else {
            // Compatibility ingress only: capture once, before the first await.
            const root = typeof request.allowedRoot === 'string' ? ManagedRoot.capture(request.allowedRoot) : request.allowedRoot;
            const inputPath = typeof request.allowedRoot === 'string'
              ? join(root.verify(), relative(resolve(request.allowedRoot), resolve(request.inputPath))) : request.inputPath;
            ownedSource = captureFile(AnchoredDir.capture(root.verify(), root), inputPath);
          }
          input = verifyFile(ownedSource);
          if (statSync(input).size === 0) throw new Error('Empty source.');
        } catch { throw new Error('Media file failed the safety check.'); }
      },
      mapError: error => error.message === 'Prepared media failed validation.' ? error : new Error(`Media preparation failed: ${error.message}`),
    });
  }
  function isActive(): boolean { return jobs.isActive(); }
  function cancel(jobId: string): Promise<void> | null { return jobs.cancel(jobId); }
  async function dispose(): Promise<void> { await jobs.dispose(); }
  return { prepare, cancel, dispose, isActive };
}
