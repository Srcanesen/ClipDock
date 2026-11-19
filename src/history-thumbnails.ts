// Main-only, disposable History artwork. Renderer input is an opaque record id.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnBounded, type Spawn } from './provider-platform';
import { AnchoredDir, captureEntry, captureFile, ensureDirectory, openExclusive, publishNoReplace, removeEntry, removeOwned, verifyFile, verifyFileDescriptor, type OwnedFile } from './safe-fs';

export type HistoryThumbnailOptions = {
  tools: () => Promise<{ ffmpegPath: string | null; ffprobePath: string | null }>;
  spawn?: Spawn;
};
const MAX_BYTES = 32 * 1024;
const PREFIX = 'clipdock-history-';
const OWN_NAME = /^clipdock-history-[a-f0-9]{64}(?:\.jpg|\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp)$/;
const nameFor = (id: string) => `${PREFIX}${createHash('sha256').update(id).digest('hex')}.jpg`;
const isJpeg = (bytes: Buffer) => bytes.length > 4 && bytes.length <= MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;

export class HistoryThumbnails {
  private directory: AnchoredDir | null = null;
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private active: ReturnType<typeof spawnBounded> | null = null;
  private disposed = false;
  constructor(private readonly store: AnchoredDir, private readonly options: HistoryThumbnailOptions) {}
  private existingDirectory(): AnchoredDir | null {
    if (!this.directory) {
      try { this.directory = AnchoredDir.capture(this.store.child('history-thumbnails'), this.store.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.directory;
  }
  /** Reconcile only our direct, namespaced files; never descend or follow links. */
  cleanup(ids: string[]): void {
    const retained = new Set(ids);
    for (const id of this.failed.keys()) if (!retained.has(id)) this.failed.delete(id);
    const keep = new Set(ids.map(nameFor));
    const directory = this.existingDirectory();
    if (!directory) return;
    for (const name of readdirSync(directory.verify())) {
      if (OWN_NAME.test(name) && !keep.has(name)) {
        try { removeEntry(captureEntry(directory, name)); } catch { /* A swapped entry is preserved. */ }
      }
    }
  }
  remove(id: string): void {
    this.failed.delete(id);
    try { const directory = this.existingDirectory(); if (directory) removeEntry(captureEntry(directory, nameFor(id))); } catch { /* Missing or replaced artwork is harmless. */ }
  }
  private read(name: string): string | null {
    try {
      const directory = this.existingDirectory();
      if (!directory) return null;
      const file = captureFile(directory, directory.child(name));
      const fd = openSync(verifyFile(file), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = verifyFileDescriptor(file, fd);
        if (stat.size > BigInt(MAX_BYTES)) { removeOwned(file); return null; }
        const bytes = readFileSync(fd);
        verifyFile(file);
        if (!isJpeg(bytes)) { removeOwned(file); return null; }
        return `data:image/jpeg;base64,${bytes.toString('base64')}`;
      } finally { closeSync(fd); }
    } catch { return null; }
  }
  load(id: string, source: () => OwnedFile | null, retained: () => boolean): Promise<string | null> {
    if (this.disposed || !retained()) return Promise.resolve(null);
    const name = nameFor(id);
    const cached = this.read(name);
    if (cached) return Promise.resolve(cached);
    const previous = this.pending.get(id);
    if (previous) return previous;
    let failureKey: string | null = null;
    const pending = this.tail.then(async () => {
      if (this.disposed || !retained()) return null;
      const input = source();
      if (!input) return null;
      const stat = statSync(verifyFile(input), { bigint: true });
      failureKey = `${input.path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (this.failed.get(id) === failureKey) return null;
      const { ffmpegPath, ffprobePath } = await this.options.tools();
      if (this.disposed || !retained() || !ffmpegPath || !ffprobePath) return null;
      const probe = await this.run(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'json', verifyFile(input)], 16 * 1024);
      const duration = Number((JSON.parse(probe.toString('utf8')) as { format?: { duration?: string } }).format?.duration);
      const image = ['.jpg', '.jpeg', '.png'].includes(extname(input.path).toLowerCase());
      const seek = !image && Number.isFinite(duration) && duration > 0 ? ['-ss', String(Math.min(30, duration * 0.1))] : [];
      // Decode one frame only, with input seeking for videos; output and stderr are bounded.
      const bytes = await this.run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', ...seek, '-i', verifyFile(input), '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=224:126:force_original_aspect_ratio=increase,crop=224:126,setsar=1', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], MAX_BYTES);
      if (!isJpeg(bytes)) throw new Error('History thumbnail generation failed.');
      if (this.disposed || !retained() || source()?.path !== input.path) return null;
      verifyFile(input);
      const directory = this.directory ??= ensureDirectory(this.store, 'history-thumbnails');
      const opened = openExclusive(directory, `${name.slice(0, -4)}.${randomUUID()}.tmp`);
      try {
        writeFileSync(opened.fd, bytes); fsyncSync(opened.fd); verifyFile(opened.file);
        publishNoReplace(opened.file, directory, name);
      } finally { closeSync(opened.fd); removeOwned(opened.file); }
      return this.read(name);
    }).catch(() => {
      if (failureKey && !this.disposed && retained()) this.failed.set(id, failureKey);
      return null;
    }).finally(() => { this.pending.delete(id); });
    this.pending.set(id, pending); this.tail = pending;
    return pending;
  }
  private async run(binary: string, args: string[], maxBytes: number): Promise<Buffer> {
    if (this.disposed) throw new Error('History thumbnails are closed.');
    const process = spawnBounded(binary, args, this.options.spawn ?? nodeSpawn, { maxStdout: maxBytes, maxStderr: 8 * 1024, idleTimeoutMs: 15_000 });
    this.active = process;
    const chunks: Buffer[] = []; let size = 0;
    process.child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size <= maxBytes) chunks.push(bytes);
    });
    try {
      const result = await process;
      if (result.code !== 0 || result.timedOut || result.stdoutTruncated || size > maxBytes) throw new Error('History thumbnail generation failed.');
      return Buffer.concat(chunks);
    } finally { this.active = null; }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.active?.cancel();
    await this.tail;
  }
}
