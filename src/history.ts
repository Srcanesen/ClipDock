// Persistent, main-process-only download history. Public records intentionally omit paths.
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute } from 'node:path';
import { canonicalRoot, regularFile } from './path-boundary';
import { ManagedRoot } from './managed-root';
import { MEDIA_EXTENSIONS } from './media-extensions';
import { AnchoredDir, captureEntry, captureFile, prepareDirectory, removeEntry, removeOwned, replaceOwned, verifyFile, writeExclusive, type OwnedFile } from './safe-fs';
import { randomUUID } from 'node:crypto';
import { tryAcquireFileLock } from './file-lock';
import { validatePinterestUrl, validateSocialUrl } from './ytdlp-url';
import { HistoryThumbnails, type HistoryThumbnailOptions } from './history-thumbnails';
import type { HistoryDeleteResult } from './shared';
import type { MediaProfile } from './media-prep';
import { admitDownloadRoot } from './settings';

export type HistoryProvider = 'youtube' | 'pexels' | 'pixabay' | 'social' | 'pinterest';
export type HistorySelection = { start: number; end: number; label: string } | null;
export type HistoryAutomation = { provider: HistoryProvider; source: string; selection: HistorySelection; chapters: Array<{ start: number; end: number; title: string }> };
/** Public, path-free subtitle companion metadata. */
export type HistorySubtitle = { fileName: string; bytes: number; available: boolean };
type ResolveUse = { at: number; via: 'import' | 'timeline' | 'drag' };
type StoredRecord = { resolveUse?: ResolveUse; id: string; provider: HistoryProvider; source: string; project: string | null; filePath: string; managed: boolean; /** Main-only registration-time boundary; absent for old/external records. */ trustedRoot?: string; fileName: string; bytes: number; assetId: string | null; title: string; creator: string | null; profile: string; preparationFailed?: { profile: MediaProfile }; quality: string | null; mediaMode: string; selection: HistorySelection; automation: HistoryAutomation; createdAt: number; lastUsedAt: number; subtitlePath: string | null };
type Store = { schemaVersion: 1; records: StoredRecord[] };
export type HistoryRecord = Omit<StoredRecord, 'filePath' | 'managed' | 'trustedRoot' | 'subtitlePath' | 'resolveUse'> & { sentToResolve: boolean; available: boolean; subtitle: HistorySubtitle | null };
export type HistoryInput = Omit<StoredRecord, 'id' | 'project' | 'managed' | 'trustedRoot' | 'fileName' | 'bytes' | 'createdAt' | 'lastUsedAt' | 'subtitlePath' | 'resolveUse'> & { /** Main-only companion input; the path is validated but never exposed publicly. */ subtitle?: { filePath: string } | null };
const MAX_RECORDS = 200;
const preparationFailure = (value: unknown): { profile: MediaProfile } | undefined => {
  const profile = (value as { profile?: unknown } | null)?.profile;
  return profile === 'fast' || profile === 'editing' ? { profile } : undefined;
};
const SUBTITLE_EXTENSIONS = new Set(['.srt']);
const inside = (root: ManagedRoot, target: string): boolean => { try { return root.contains(target); } catch { return false; } };
const regular = (file: string): string | null => regularFile(file);
const supportedSubtitlePath = (file: string): boolean => SUBTITLE_EXTENSIONS.has(extname(file).toLowerCase());
/** Validate a companion subtitle exactly like media: regular file, no symlink, supported extension. Missing/invalid input fails closed to null. */
const regularSubtitle = (file: unknown): string | null => (typeof file === 'string' && supportedSubtitlePath(file) ? regular(file) : null);
const finiteRange = (value: unknown): HistorySelection => { const x = value as Partial<NonNullable<HistorySelection>> | null; return typeof x?.start === 'number' && typeof x.end === 'number' && Number.isFinite(x.start) && Number.isFinite(x.end) && x.start >= 0 && x.end > x.start ? { start: x.start, end: x.end, label: typeof x.label === 'string' ? x.label.slice(0, 80) : 'Range' } : null; };
export const supportedHistoryMediaPath = (file: string): boolean => MEDIA_EXTENSIONS.has(extname(file).toLowerCase());
export function safeHistorySource(provider: HistoryProvider, source: unknown): string | null {
  if (typeof source !== 'string') return null;
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (provider === 'youtube' && !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return null;
    if (provider === 'pexels' && !['pexels.com', 'www.pexels.com'].includes(host)) return null;
    if (provider === 'pixabay' && host !== 'pixabay.com') return null;
    if (provider === 'social') return validateSocialUrl(source)?.url ?? null;
    if (provider === 'pinterest') {
      const valid = validatePinterestUrl(source);
      return valid && !valid.pinId.startsWith('e1_') ? valid.url : null;
    }
    return url.toString();
  } catch { return null; }
}

function storedHistorySource(provider: HistoryProvider, source: unknown): string | null {
  return provider === 'pinterest' ? validatePinterestUrl(source)?.url ?? null : safeHistorySource(provider, source);
}

export function historySourceUrl(provider: HistoryProvider, source: unknown): string | null {
  if (provider === 'pinterest' && validatePinterestUrl(source)?.pinId.startsWith('e1_')) throw new Error('This Pinterest item came from a temporary search selection. Search again to find its source.');
  return safeHistorySource(provider, source);
}

export function recordHistory(history: Pick<DownloadHistory, 'add'>, input: HistoryInput): { record: HistoryRecord | null; warning?: string } { try { return { record: history.add(input) }; } catch { return { record: null, warning: 'Download history could not be updated.' }; } }
export function recordHistoryWarning(history: Pick<DownloadHistory, 'add'>, input: HistoryInput): string | undefined { return recordHistory(history, input).warning; }

export class DownloadHistory {
  private records: StoredRecord[] = [];
  private saveBlocked = false;
  private revision = 0;
  private readonly preparations = new Set<string>();
  private assertNotPreparing(id: unknown): void {
    if (typeof id === 'string' && this.preparations.has(id)) throw new Error('Conversion is running for this item. Cancel it first.');
  }
  holdPreparation(id: string): () => void {
    this.assertNotPreparing(id);
    this.preparations.add(id);
    return () => { this.preparations.delete(id); };
  }
  private readonly storeDirectory: AnchoredDir;
  private readonly thumbnails: HistoryThumbnails;
  private readonly identities = new Map<string, {media: OwnedFile | null; subtitle: OwnedFile | null}>();
  private captureRecord(r: StoredRecord, refreshMedia = false): void {
    const previous = this.identities.get(r.id);
    if (previous && !refreshMedia) return;
    const root = r.managed ? this.recordRoot(r) : null;
    const capture = (path: string | null): OwnedFile | null => {
      try { return root && path ? captureFile(AnchoredDir.capture(root.verify(), root), path) : null; } catch { return null; }
    };
    this.identities.set(r.id, {media: capture(r.filePath), subtitle: previous ? previous.subtitle : capture(r.subtitlePath)});
  }
  private managedRoot: () => ManagedRoot | null;
  private readonly sessionRoots = new Map<string, ManagedRoot | null>();
  /** Legacy records lacking trustedRoot are bound once, to the root active at startup; undefined when it was unavailable. */
  private readonly legacyRoots = new Map<string, string | undefined>();
  private readonly externalProvenance = new Map<string, string>();
  constructor(private readonly file: string, managedRoot: ManagedRoot | string | (() => ManagedRoot | null), private readonly projectName: () => string | null = () => null, thumbnailOptions: HistoryThumbnailOptions = { tools: async () => ({ ffmpegPath: null, ffprobePath: null }) }, private readonly defaultFolder?: string) {
    this.storeDirectory = prepareDirectory(dirname(file));
    if (typeof managedRoot === 'function') this.managedRoot = managedRoot;
    else { const captured = this.captureRoot(managedRoot); this.managedRoot = () => captured; }
    this.load(true);
    this.thumbnails = new HistoryThumbnails(this.storeDirectory, thumbnailOptions);
    this.cleanupThumbnails();
  }
  private cleanupThumbnails(): void { try { this.thumbnails.cleanup(this.records.map(record => record.id)); } catch { /* Retry at the next reconciliation. */ } }
  thumbnail(id: unknown): Promise<string | null> {
    const record = typeof id === 'string' ? this.records.find(record => record.id === id) : null;
    if (!record || record.mediaMode === 'audio') return Promise.resolve(null);
    return this.thumbnails.load(record.id, () => {
      const hit = this.resolve(id);
      if (!hit) return null;
      try { const root = hit.trustedRoot ?? ManagedRoot.capture(dirname(hit.path)); return captureFile(AnchoredDir.capture(root.verify(), root), hit.path); } catch { return null; }
    }, () => this.records.some(record => record.id === id));
  }
  clear(busy = false): number {
    return this.transaction(() => {
      for (const id of this.preparations) this.assertNotPreparing(id);
      if (busy) throw new Error('Wait for active downloads or media preparation to finish.');
      const count = this.records.length;
      this.records = []; this.save(); this.cleanupThumbnails();
      return count;
    });
  }
  dispose(): Promise<void> { return this.thumbnails.dispose(); }
  /** Point the managed-root boundary at a new download folder; old records keep their absolute paths. */
  setManagedRoot(root: ManagedRoot | string): void {
    const captured = this.captureRoot(root);
    if (!captured) throw new Error('Managed root failed the safety check.');
    const path = captured.verify();
    if (!this.root()) for (const record of this.records) if (record.trustedRoot === path || this.externalProvenance.get(record.id) === path) this.identities.delete(record.id);
    this.managedRoot = () => captured;
  }
  private captureRoot(root: ManagedRoot | string): ManagedRoot | null {
    try { return typeof root === 'string' ? ManagedRoot.capture(root) : root; } catch { return null; }
  }
  private recordRoot(r: StoredRecord): ManagedRoot | null {
    try {
      if (!r.trustedRoot || canonicalRoot(r.trustedRoot) !== r.trustedRoot) return null;
      // A folder re-selection can refresh this root; an unrelated folder's failure cannot revoke it.
      try {
        const current = this.managedRoot();
        if (current?.verify() === r.trustedRoot) {
          const previous = this.sessionRoots.get(r.trustedRoot);
          if (this.sessionRoots.has(r.trustedRoot) && previous !== current) {
            let changed = !previous;
            try { previous?.verify(); } catch { changed = true; }
            if (changed) {
              // Only explicit root re-admission may admit files on a remounted
              // folder. Transaction reloads never refresh an existing inode.
              for (const record of this.records) if (record.trustedRoot === r.trustedRoot) this.identities.delete(record.id);
            }
          }
          this.sessionRoots.set(r.trustedRoot, current);
        }
      } catch { /* Validate the record's own captured root below. */ }
      if (!this.sessionRoots.has(r.trustedRoot)) this.sessionRoots.set(r.trustedRoot, admitDownloadRoot(r.trustedRoot, this.root(), this.defaultFolder));
      const root = this.sessionRoots.get(r.trustedRoot); root?.verify(); return root ?? null;
    } catch { return null; }
  }
  private load(initial = false): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Store;
      if (raw?.schemaVersion !== 1 || !Array.isArray(raw.records)) throw new Error('Unsupported history store.');
      this.records = raw.records.flatMap((value) => {
        const r = value as Partial<StoredRecord>;
        if (!r || typeof r.id !== 'string' || (r.provider !== 'youtube' && r.provider !== 'pexels' && r.provider !== 'pixabay' && r.provider !== 'social' && r.provider !== 'pinterest') || typeof r.filePath !== 'string' || typeof r.fileName !== 'string' || typeof r.source !== 'string') return [];
        const source = r.provider === 'social' || r.provider === 'pinterest' ? storedHistorySource(r.provider, r.source) : r.source.slice(0, 2048);
        if (!source) return [];
        const selection = r.provider === 'social' || r.provider === 'pinterest' ? null : finiteRange(r.selection);
        const chapters = r.provider === 'youtube' && Array.isArray(r.automation?.chapters) ? r.automation.chapters.flatMap((chapter) => { const range = finiteRange({ ...chapter, label: chapter?.title }); return range ? [{ start: range.start, end: range.end, title: range.label }] : []; }).slice(0, 100) : [];
        const resolveUse = r.resolveUse && typeof r.resolveUse.at === 'number' && Number.isFinite(r.resolveUse.at) && r.resolveUse.at >= 0 && ['import', 'timeline', 'drag'].includes(r.resolveUse.via)
          ? { at: r.resolveUse.at, via: r.resolveUse.via } : undefined;
        const createdAt = Number.isFinite(r.createdAt) ? Number(r.createdAt) : Date.now();
        const subtitlePath = typeof r.subtitlePath === 'string' && r.subtitlePath.length <= 2048 && isAbsolute(r.subtitlePath) && supportedSubtitlePath(r.subtitlePath) ? r.subtitlePath : null;
        // Preserve invalid provenance: undefined means explicitly external, never failed managed validation.
        // Transaction reloads reuse the startup binding instead of the folder active now.
        if (initial && typeof r.trustedRoot !== 'string') this.legacyRoots.set(r.id, this.root()?.verify());
        const trustedRoot = typeof r.trustedRoot === 'string' ? r.trustedRoot : this.legacyRoots.get(r.id);
        return [{ id: r.id, provider: r.provider, source, project: typeof r.project === 'string' ? r.project.slice(0, 200) : null, filePath: r.filePath, managed: r.managed === true, trustedRoot: r.managed === true ? trustedRoot : undefined, fileName: r.fileName.slice(0, 300), bytes: Number.isSafeInteger(r.bytes) && Number(r.bytes) >= 0 ? Number(r.bytes) : 0, assetId: typeof r.assetId === 'string' ? r.assetId.slice(0, 100) : null, title: typeof r.title === 'string' ? r.title.slice(0, 300) : r.fileName.slice(0, 300), creator: typeof r.creator === 'string' ? r.creator.slice(0, 200) : null, profile: typeof r.profile === 'string' ? r.profile.slice(0, 40) : 'original', ...(preparationFailure(r.preparationFailed) ? { preparationFailed: preparationFailure(r.preparationFailed) } : {}), quality: typeof r.quality === 'string' ? r.quality.slice(0, 80) : null, mediaMode: typeof r.mediaMode === 'string' ? r.mediaMode.slice(0, 20) : 'video', selection, automation: { provider: r.provider, source, selection, chapters }, ...(resolveUse ? { resolveUse } : {}), createdAt, lastUsedAt: Number.isFinite(r.lastUsedAt) ? Number(r.lastUsedAt) : createdAt, subtitlePath }];
      }).slice(0, MAX_RECORDS);
      this.externalProvenance.clear();
      for (const record of this.records) {
        if (record.managed && record.trustedRoot && !this.recordRoot(record)) {
          // This session cannot manage the file, but a later restart may admit
          // a temporarily unavailable root. Unrelated saves keep its provenance.
          this.externalProvenance.set(record.id, record.trustedRoot);
          record.managed = false; record.trustedRoot = undefined;
        }
        this.captureRecord(record);
      }
    } catch {
      this.records = [];
      if (existsSync(this.file)) { try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { this.saveBlocked = true; } }
    }
  }
  private save(): void {
    if (this.saveBlocked) throw new Error('Download history is corrupt and could not be quarantined.');
    const records = this.records.map(record => this.externalProvenance.has(record.id) ? { ...record, managed: true, trustedRoot: this.externalProvenance.get(record.id) } : record);
    const temp = writeExclusive(this.storeDirectory, `${basename(this.file)}.${randomUUID()}.tmp`, JSON.stringify({ schemaVersion: 1, records }, null, 2));
    try { replaceOwned(temp, this.storeDirectory, basename(this.file)); this.revision++; }
    finally { if (removeOwned(temp) === 'replaced') throw new Error('History temporary file was replaced; preserved.'); }
  }

  /** A competing/crashed writer fails closed rather than overwriting its store. Never wait on the main thread. */
  private transaction<T>(operation: () => T): T {
    this.storeDirectory.verify();
    const lock = tryAcquireFileLock(`${this.file}.lock`);
    if (!lock) throw new Error('Download history is locked by another writer. Retry after it finishes.');
    let before = this.records;
    const revision = this.revision;
    let identities = new Map(this.identities);
    try {
      if (existsSync(this.file) && statSync(this.file).isFile()) {
        this.load();
      }
      if (this.saveBlocked) throw new Error('Download history is corrupt and could not be quarantined.');
      const prefix = `${basename(this.file)}.`;
      const temps = readdirSync(this.storeDirectory.verify()).filter(name => name.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name.slice(prefix.length))).map(name => captureEntry(this.storeDirectory, name));
      for (const temp of temps) removeEntry(temp);
      before = JSON.parse(JSON.stringify(this.records)) as StoredRecord[];
      identities = new Map(this.identities);
      return operation();
    } catch (error) {
      if (this.revision !== revision) this.load();
      else { this.records = before; this.identities.clear(); for (const [id, files] of identities) this.identities.set(id, files); }
      throw error;
    }
    finally { lock.release(); }
  }
  private safePath(r: StoredRecord, file: string): string | null {
    const safe = regular(file);
    if (!safe) return null;
    if (this.externalProvenance.has(r.id) && safe !== file) return null;
    if (r.managed && this.recordRoot(r)?.resolve(file) !== file) return null;
    return safe;
  }
  private root(): ManagedRoot | null { try { const root = this.managedRoot(); root?.verify(); return root; } catch { return null; } }
  private moveToFront(record: StoredRecord): void { const index = this.records.indexOf(record); if (index > 0) this.records.unshift(...this.records.splice(index, 1)); }
  /** Live companion metadata: paths stay main-only; missing/symlink files surface as unavailable, never as a path. */
  private subtitle(r: StoredRecord): HistorySubtitle | null {
    if (!r.subtitlePath) return null;
    const resolved = this.safePath(r, r.subtitlePath);
    try { return { fileName: basename(r.subtitlePath), bytes: resolved ? statSync(resolved).size : 0, available: !!resolved }; }
    catch { return { fileName: basename(r.subtitlePath), bytes: 0, available: false }; }
  }
  private public(r: StoredRecord): HistoryRecord { return { sentToResolve: !!r.resolveUse, id: r.id, provider: r.provider, source: r.source, project: r.project, fileName: r.fileName, bytes: r.bytes, assetId: r.assetId, title: r.title, creator: r.creator, profile: r.profile, ...(r.preparationFailed ? { preparationFailed: { ...r.preparationFailed } } : {}), quality: r.quality, mediaMode: r.mediaMode, selection: r.selection, automation: r.automation, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, available: !!this.safePath(r, r.filePath), subtitle: this.subtitle(r) }; }
  noteResolveUse(filePath: string, via: ResolveUse['via']): void {
    this.transaction(() => {
      const safe = regular(filePath);
      if (!safe) return;
      let changed = false;
      for (const record of this.records) if (regular(record.filePath) === safe) {
        const previous = record.resolveUse;
        const nextVia = previous && previous.via !== 'drag' ? previous.via : via;
        if (previous?.via === nextVia) continue;
        record.resolveUse = { at: previous?.at ?? Date.now(), via: nextVia }; changed = true;
      }
      if (changed) this.save();
    });
  }
  resolveUsedPaths(): string[] {
    return this.records.filter(record => record.resolveUse).flatMap(record => record.subtitlePath ? [record.filePath, record.subtitlePath] : [record.filePath]);
  }
  private assertPathsNotInUse(paths: Array<string | null | undefined>, inUse: boolean | Iterable<string>): void {
    // Retain the legacy boolean adapter for callers outside the scoped ledger.
    if (typeof inUse === 'boolean') {
      if (inUse) throw new Error('Wait for active downloads or media preparation to finish.');
      return;
    }
    const used = new Set([...inUse].flatMap(path => regular(path) ?? []));
    if (paths.some(path => path && used.has(regular(path) ?? ''))) throw new Error('This file is being used by a transfer or conversion. Wait for it to finish.');
  }
  list(): HistoryRecord[] { return this.records.map((r) => this.public(r)); }
  get(id: unknown): HistoryRecord | null { const r = typeof id === 'string' ? this.records.find((x) => x.id === id) : null; return r ? this.public(r) : null; }
  add(input: HistoryInput): HistoryRecord { return this.transaction(() => this.addRecord(input)); }
  /** Main-only recovery uses the same admission and atomic History commit. */
  admitRoot(path: string): ManagedRoot | null { return this.recordRoot({ trustedRoot: path } as StoredRecord); }
  hasPath(path: string): boolean { return this.records.some(record => record.filePath === path); }
  recoveryArtifact(id: string): { path: string; trustedRoot: ManagedRoot | null } | null {
    const record = this.records.find(record => record.id === id);
    return record ? { path: record.filePath, trustedRoot: record.managed ? this.recordRoot(record) : null } : null;
  }
  addRecovered(input: HistoryInput, root: ManagedRoot): void {
    this.transaction(() => {
      if (this.admitRoot(root.verify()) !== root) throw new Error('Recovery root failed admission.');
      if (!this.hasPath(input.filePath)) this.addRecord(input, root);
    });
  }
  private addRecord(input: HistoryInput, root = this.root()): HistoryRecord {
    const filePath = regular(input.filePath); if (!filePath || !supportedHistoryMediaPath(filePath)) throw new Error('Downloaded file is no longer available.');
    const source = storedHistorySource(input.provider, input.source); if (!source) throw new Error('Invalid download source.');
    const selection = input.provider === 'social' ? null : finiteRange(input.selection);
    const chapters = input.provider === 'youtube' ? input.automation.chapters.slice(0, 100) : [];
    const now = Date.now();
    if (!root) throw new Error('Managed root failed the safety check.');
    const trustedRoot = inside(root, filePath) ? root : undefined;
    if (trustedRoot) this.recordRoot({trustedRoot: trustedRoot.verify()} as StoredRecord);
    const record: StoredRecord = { id: randomUUID(), provider: input.provider, source, project: this.projectName(), filePath, managed: !!trustedRoot, trustedRoot: trustedRoot?.verify(), fileName: basename(filePath), bytes: statSync(filePath).size, assetId: input.assetId?.slice(0, 100) ?? null, title: input.title.slice(0, 300), creator: input.creator?.slice(0, 200) ?? null, profile: input.profile.slice(0, 40), ...(preparationFailure(input.preparationFailed) ? { preparationFailed: preparationFailure(input.preparationFailed) } : {}), quality: input.quality?.slice(0, 80) ?? null, mediaMode: input.mediaMode.slice(0, 20), selection, automation: { provider: input.provider, source, selection, chapters }, createdAt: now, lastUsedAt: now, subtitlePath: regularSubtitle(input.subtitle?.filePath) };
    this.captureRecord(record);
    this.records = [record, ...this.records].slice(0, MAX_RECORDS); this.save(); this.cleanupThumbnails(); return this.public(record);
  }
  resolve(id: unknown): { path: string; trustedRoot?: ManagedRoot; record: HistoryRecord } | null {
    const r = typeof id === 'string' ? this.records.find((record) => record.id === id) : null;
    if (!r) return null;
    const root = r.managed ? this.recordRoot(r) : undefined;
    if (r.managed && !root) return null;
    const path = root ? (root.resolve(r.filePath) === r.filePath ? r.filePath : null) : this.safePath(r, r.filePath);
    return path ? { path, trustedRoot: root ?? undefined, record: this.public(r) } : null;
  }
  /** Main-only companion resolver: returns a validated subtitle path or null. Rejects missing, symlinked, and unsupported files; never crosses IPC. */
  resolveSubtitle(id: unknown): { path: string } | null { const r = typeof id === 'string' ? this.records.find((x) => x.id === id) : null; const path = r?.subtitlePath ? this.safePath(r, r.subtitlePath) : null; return path ? { path } : null; }
  reuse(id: unknown): { path: string; trustedRoot?: ManagedRoot; record: HistoryRecord } | null { return this.transaction(() => this.reuseRecord(id)); }
  private reuseRecord(id: unknown): { path: string; trustedRoot?: ManagedRoot; record: HistoryRecord } | null { const hit = this.resolve(id); if (!hit) return null; const r = this.records.find((x) => x.id === id)!; r.lastUsedAt = Date.now(); r.project = this.projectName(); this.moveToFront(r); this.save(); return { path: hit.path, trustedRoot: hit.trustedRoot, record: this.public(r) }; }
  relink(id: unknown, filePath: string): HistoryRecord | null { return this.transaction(() => this.relinkRecord(id, filePath)); }
  private relinkRecord(id: unknown, filePath: string): HistoryRecord | null {
    this.assertNotPreparing(id);
    const r = typeof id === 'string' ? this.records.find((x) => x.id === id) : null;
    const safe = regular(filePath);
    if (!r || !safe || !supportedHistoryMediaPath(safe)) return null;
    const retained = r.managed && r.filePath === safe && !!this.safePath(r, safe);
    r.filePath = safe; r.fileName = basename(safe); r.bytes = statSync(safe).size; r.managed = retained;
    if (!retained) { r.trustedRoot = undefined; this.externalProvenance.delete(r.id); }
    r.lastUsedAt = Date.now(); this.moveToFront(r); this.save();
    this.captureRecord(r, true);
    this.thumbnails.remove(r.id);
    return this.public(r);
  }

  replacePreparedArtifact(id: string, next: { filePath: string; profile: MediaProfile }, protectedPaths: Iterable<string> = []): (HistoryRecord & { originalKept?: true }) | null {
    return this.transaction(() => {
      const r = this.records.find(record => record.id === id);
      if (!r || (next.profile !== 'fast' && next.profile !== 'editing')) return null;
      const root = r.managed ? this.recordRoot(r) : null;
      if (!root) return null;
      const filePath = root.resolve(next.filePath);
      if (!filePath || !supportedHistoryMediaPath(filePath)) return null;
      const media = captureFile(AnchoredDir.capture(root.verify(), root), filePath);
      const safe = this.safePath(r, r.filePath);
      const protectedSet = new Set([...protectedPaths].flatMap(path => regular(path) ?? []));
      const owned = this.identities.get(r.id)?.media;
      let removable = this.canRemoveMedia(r, safe, protectedSet);
      try { removable = removable && !!owned && verifyFile(owned) === safe; } catch { removable = false; }
      if (filePath !== r.filePath && !removable) {
        delete r.preparationFailed; this.moveToFront(r);
        const added = this.addRecord({ ...r, filePath, profile: next.profile, preparationFailed: undefined }, root);
        return { ...added, originalKept: true };
      }
      r.filePath = filePath; r.fileName = basename(filePath); r.bytes = statSync(filePath).size;
      r.profile = next.profile; delete r.preparationFailed;
      this.identities.set(r.id, { media, subtitle: this.identities.get(r.id)?.subtitle ?? null });
      this.thumbnails.remove(r.id);
      this.save();
      return this.public(r);
    });
  }

  private canRemoveMedia(r: StoredRecord, safe: string | null, protectedPaths: Set<string>): boolean {
    const root = this.recordRoot(r);
    return !!(r.managed && safe && root && inside(root, safe) && !protectedPaths.has(safe) && this.records.filter(record => record.filePath === safe).length === 1);
  }

  /** Session ownership outlives the history cap and failed metadata writes. Never grant it from location alone. */
  deleteUnrecorded(filePath: string, trustedRoot: ManagedRoot | undefined, protectedPaths: Iterable<string>, files: { media: OwnedFile | null; subtitle: OwnedFile | null }, busy: boolean | Iterable<string> = false, subtitlePath?: string): HistoryDeleteResult {
    return this.transaction(() => {
      this.assertPathsNotInUse([filePath, subtitlePath], busy);
      const safe = regular(filePath);
      const { media, subtitle } = files;
      const protectedSet = new Set([...protectedPaths].flatMap((p) => { const resolved = regular(p); return resolved ? [resolved] : []; }));
      if (!trustedRoot || !trustedRoot.resolve(filePath) || !safe || !inside(trustedRoot, safe) || protectedSet.has(safe) || this.records.some((r) => regular(r.filePath) === safe)) return { deleted: false, removed: false };
      if (!media || media.path !== safe || removeOwned(media) !== 'removed') return {deleted: false, removed: false, warning: 'Media changed or was replaced; preserved.'};
      let warning: string | undefined;
      const companion = subtitlePath ? regularSubtitle(subtitlePath) : null;
      if (subtitle && !companion) warning = 'Media deleted, but its subtitle could not be deleted.';
      if (companion && inside(trustedRoot, companion) && !protectedSet.has(companion) && !this.records.some((r) => r.subtitlePath && regular(r.subtitlePath) === companion)) {
        try { if (!subtitle || subtitle.path !== companion || removeOwned(subtitle) !== 'removed') throw new Error('Subtitle replaced.'); } catch { warning = 'Media deleted, but its subtitle could not be deleted.'; }
      }
      return warning ? { deleted: true, removed: false, warning } : { deleted: true, removed: false };
    });
  }
  delete(id: unknown, protectedPaths: Iterable<string>, busy: boolean | Iterable<string> = false, preserveOnFailure = false): HistoryDeleteResult {
    return this.transaction(() => this.deleteRecord(id, protectedPaths, busy, preserveOnFailure));
  }
  private deleteRecord(id: unknown, protectedPaths: Iterable<string>, busy: boolean | Iterable<string>, preserveOnFailure: boolean): HistoryDeleteResult {
    if (typeof busy === 'boolean') this.assertNotPreparing(id);
    const target = this.records.find(record => record.id === id);
    this.assertPathsNotInUse([target?.filePath, target?.subtitlePath], busy);
    this.assertNotPreparing(id);
    const index = typeof id === 'string' ? this.records.findIndex((r) => r.id === id) : -1; if (index < 0) return { deleted: false, removed: false };
    const r = this.records[index]; const protectedSet = new Set([...protectedPaths].flatMap((p) => { const safe = regular(p); return safe ? [safe] : []; }));
    let deleted = false; let warning: string | undefined; const safe = this.safePath(r, r.filePath);
    const trustedRoot = this.recordRoot(r);
    if (this.canRemoveMedia(r, safe, protectedSet)) {
      const owned = this.identities.get(r.id)?.media;
      if (owned && owned.path === safe && removeOwned(owned) === 'removed') deleted = true;
      else warning = 'Media changed or was replaced; preserved.';
    }
    if (deleted && r.subtitlePath) {
      const companion = regular(r.subtitlePath);
      if (!companion && this.identities.get(r.id)?.subtitle) warning = 'Media deleted, but its subtitle could not be deleted.';
      const companionInside = companion && (trustedRoot && inside(trustedRoot, companion));
      if (companion && companionInside && !protectedSet.has(companion) && this.records.filter((x) => x.subtitlePath === r.subtitlePath).length === 1) { try { const owned = this.identities.get(r.id)?.subtitle; if (!owned || owned.path !== companion || removeOwned(owned) !== 'removed') throw new Error('Subtitle replaced.'); } catch { warning = 'Media deleted, but its subtitle could not be deleted.'; } }
    }
    if (r.managed && !safe && this.identities.get(r.id)?.media) warning = 'Media changed or was replaced; preserved.';
    if (preserveOnFailure && !deleted) return warning ? { deleted: false, removed: false, warning } : { deleted: false, removed: false };
    this.records.splice(index, 1);
    this.thumbnails.remove(r.id);
    try { this.save(); } catch (error) { if (deleted) return { deleted: true, removed: true, historyWriteFailed: true, ...(warning ? { warning } : {}) }; throw error; }
    return warning ? { deleted, removed: true, warning } : { deleted, removed: true };
  }
}
