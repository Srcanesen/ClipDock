// Main-only crash journal. Like History, metadata is replaced atomically through
// captured filesystem identities; invalid stores never block startup.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareDirectory, removeOwned, replaceOwned, writeExclusive, type AnchoredDir } from './safe-fs';
import { safeHistorySource, supportedHistoryMediaPath, type HistoryInput } from './history';
import { validatePinterestUrl } from './ytdlp-url';

export type PendingArtifact =
  | { id: string; kind: 'download'; path: string; trustedRoot: string; record: HistoryInput; requestedProfile?: 'fast' | 'editing' }
  | { id: string; kind: 'retry'; historyId: string; sourcePath: string; outputPath: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && value.length <= 4096;
function valid(value: unknown): value is PendingArtifact {
  if (!object(value) || typeof value.id !== 'string' || !value.id.length) return false;
  if (value.kind === 'retry') return typeof value.historyId === 'string' && !!value.historyId.length && path(value.sourcePath) && path(value.outputPath);
  if (value.kind !== 'download' || !path(value.path) || !path(value.trustedRoot) || !object(value.record)) return false;
  if (value.requestedProfile !== undefined && value.requestedProfile !== 'fast' && value.requestedProfile !== 'editing') return false;
  const r = value.record;
  if (!['youtube', 'social', 'pinterest', 'pexels', 'pixabay'].includes(String(r.provider))) return false;
  if (!(r.provider === 'pinterest' ? validatePinterestUrl(r.source)?.url : safeHistorySource(r.provider as HistoryInput['provider'], r.source))) return false;
  if (!path(r.filePath) || !supportedHistoryMediaPath(r.filePath) || typeof r.title !== 'string' || typeof r.profile !== 'string' || typeof r.mediaMode !== 'string') return false;
  if (![r.assetId, r.creator, r.quality].every(v => v === null || typeof v === 'string')) return false;
  if (r.selection !== null && (!object(r.selection) || typeof r.selection.start !== 'number' || typeof r.selection.end !== 'number' || typeof r.selection.label !== 'string' || !Number.isFinite(r.selection.start) || !Number.isFinite(r.selection.end) || r.selection.start < 0 || r.selection.end <= r.selection.start)) return false;
  if (!object(r.automation) || !Array.isArray(r.automation.chapters) || !r.automation.chapters.every(c => object(c) && typeof c.start === 'number' && Number.isFinite(c.start) && typeof c.end === 'number' && Number.isFinite(c.end) && typeof c.title === 'string')) return false;
  if (r.subtitle != null && (!object(r.subtitle) || !path(r.subtitle.filePath))) return false;
  return true;
}

export class PendingArtifacts {
  private entries: PendingArtifact[] = [];
  private readonly directory: AnchoredDir;
  private saveBlocked = false;
  constructor(private readonly file: string) {
    this.directory = prepareDirectory(dirname(file));
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown; entries?: unknown };
      if (raw?.schemaVersion !== 1 || !Array.isArray(raw.entries)) throw new Error('Unsupported pending artifact store.');
      for (const entry of raw.entries) if (valid(entry)) {
        this.entries = this.entries.filter(previous => previous.id !== entry.id);
        this.entries.push(entry);
      }
    } catch {
      if (existsSync(file)) { try { renameSync(file, `${file}.corrupt-${Date.now()}-${randomUUID()}`); } catch { this.saveBlocked = true; } }
    }
  }
  put(entry: PendingArtifact): void {
    if (!valid(entry)) throw new Error('Invalid pending artifact.');
    this.save([...this.entries.filter(previous => previous.id !== entry.id), entry]);
  }
  remove(id: string): void { if (this.entries.some(entry => entry.id === id)) this.save(this.entries.filter(entry => entry.id !== id)); }
  list(): PendingArtifact[] { return JSON.parse(JSON.stringify(this.entries)) as PendingArtifact[]; }
  private save(entries: PendingArtifact[]): void {
    if (this.saveBlocked) throw new Error('Pending artifacts could not be quarantined.');
    const temp = writeExclusive(this.directory, `${basename(this.file)}.${randomUUID()}.tmp`, JSON.stringify({ schemaVersion: 1, entries }, null, 2));
    try { replaceOwned(temp, this.directory, basename(this.file)); this.entries = JSON.parse(JSON.stringify(entries)) as PendingArtifact[]; }
    finally { if (removeOwned(temp) === 'replaced') throw new Error('Pending artifacts temporary file was replaced; preserved.'); }
  }
}
