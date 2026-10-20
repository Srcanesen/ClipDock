// Electron-free ownership of session artifacts, history bindings and deletion decisions.
import { randomUUID } from 'node:crypto';
import { canonicalMediaPath } from './path-boundary';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, captureFile, type OwnedFile } from './safe-fs';
import { DownloadHistory, recordHistory, type HistoryInput, type HistoryRecord } from './history';
import type { TimelineAutomation } from './transfer';
import type { HistoryDeleteResult } from './shared';

export type Card = Readonly<{ path: string; automation?: TimelineAutomation; historyId?: string; trustedRoot?: ManagedRoot; passive?: boolean; subtitlePath?: string; ownerPath?: string; ownedMedia?: OwnedFile; ownedSubtitle?: OwnedFile }>;
export class DownloadLedger {
  private readonly cards = new Map<string, Card>();
  private readonly historyCards = new Map<string, string>();
  private readonly subtitleCards = new Map<string, string>();
  private readonly sessionSubtitles = new Map<string, string>();
  constructor(private readonly history: DownloadHistory, private readonly mediaInUse: () => boolean) {}

  register(input: { path: string; automation?: TimelineAutomation; historyId?: string }, root: ManagedRoot): string {
    if (!root.resolve(input.path)) throw new Error('Could not safely register managed download.');
    return this.insert({ ...input, trustedRoot: root, subtitlePath: this.sessionSubtitles.get(input.path) });
  }
  registerExternal(path: string): string {
    const safe = canonicalMediaPath(path);
    if (!safe) throw new Error('Selected file is no longer available.');
    return this.insert({ path: safe });
  }
  private insert(card: Card): string {
    if (card.trustedRoot) {
      const dir = AnchoredDir.capture(card.trustedRoot.verify(), card.trustedRoot);
      const ownedMedia = captureFile(dir, card.path);
      let ownedSubtitle: OwnedFile | undefined;
      try { if (card.subtitlePath) ownedSubtitle = captureFile(dir, card.subtitlePath); } catch { /* Unavailable companions grant no deletion authority. */ }
      card = { ...card, ownedMedia, ownedSubtitle };
    }
    const id = randomUUID(); this.cards.set(id, Object.freeze(card)); return id;
  }
  registerSubtitle(path: string, root: ManagedRoot): string {
    const id = this.register({ path }, root);
    this.subtitleCards.set(path, id);
    return id;
  }
  record(input: HistoryInput): { record: HistoryRecord | null; warning?: string } {
    const result = recordHistory(this.history, input);
    if (input.subtitle?.filePath) {
      this.sessionSubtitles.set(input.filePath, input.subtitle.filePath);
      const id = this.subtitleCards.get(input.subtitle.filePath);
      const card = id ? this.cards.get(id) : undefined;
      if (id && card) this.cards.set(id, Object.freeze({ ...card, historyId: result.record?.id, ownerPath: input.filePath }));
    }
    return result;
  }
  resolve(cardId: unknown): Card | null {
    if (typeof cardId !== 'string' || !cardId) return null;
    const card = this.cards.get(cardId);
    return card && (card.trustedRoot ? card.trustedRoot.resolve(card.path) : canonicalMediaPath(card.path)) ? card : null;
  }
  /** All cleanup and deletion protection is computed here, including captured companions after eviction. */
  protectedPaths(...excludeCardIds: Array<string | null | undefined>): string[] {
    const excluded = new Set(excludeCardIds.filter((id): id is string => typeof id === 'string'));
    const excludedPaths = new Set([...excluded].flatMap(id => this.cards.get(id)?.path ?? []));
    const excludedHistoryIds = new Set([...excluded].flatMap(id => this.cards.get(id)?.historyId ?? []));
    return [...new Set([...this.cards.entries()]
      .filter(([id, card]) => !card.passive && !excluded.has(id) && (!card.ownerPath || !excludedPaths.has(card.ownerPath)) && (!card.historyId || !excludedHistoryIds.has(card.historyId)))
      .flatMap(([, card]) => {
        const subtitle = card.subtitlePath ?? (card.historyId ? this.history.resolveSubtitle(card.historyId)?.path : undefined);
        return subtitle ? [card.path, subtitle] : [card.path];
      }))];
  }
  private unbindDrag(recordId: string): void {
    const id = this.historyCards.get(recordId);
    if (id) this.cards.delete(id);
    this.historyCards.delete(recordId);
  }
  private unbind(recordId: string): string[] {
    const removedCardIds: string[] = [];
    for (const [id, card] of this.cards) if (card.historyId === recordId) {
      this.cards.delete(id);
      removedCardIds.push(id);
    }
    this.historyCards.delete(recordId);
    return removedCardIds;
  }
  bindHistory(recordId: unknown): string | null {
    const hit = this.history.resolve(recordId);
    if (!hit) return null;
    const existingId = this.historyCards.get(hit.record.id);
    if (existingId) {
      const existing = this.resolve(existingId);
      if (existing?.path === hit.path && existing.trustedRoot === hit.trustedRoot) return existingId;
      this.unbindDrag(hit.record.id);
    }
    const id = this.insert({ path: hit.path, automation: hit.record.automation, historyId: hit.record.id, trustedRoot: hit.trustedRoot, passive: true });
    this.historyCards.set(hit.record.id, id);
    return id;
  }
  listHistory(): Array<HistoryRecord & { cardId?: string }> {
    const records = this.history.list();
    const retained = new Set(records.map(record => record.id));
    for (const id of this.historyCards.keys()) if (!retained.has(id)) this.unbindDrag(id);
    return records.map(record => { const cardId = this.bindHistory(record.id); return cardId ? { ...record, cardId } : record; });
  }
  reuseHistory(id: unknown): { cardId: string; fileName: string } | null {
    const hit = this.history.reuse(id);
    if (!hit) return null;
    const cardId = this.insert({ path: hit.path, automation: hit.record.automation, historyId: hit.record.id, trustedRoot: hit.trustedRoot, subtitlePath: this.history.resolveSubtitle(hit.record.id)?.path });
    return { cardId, fileName: hit.record.fileName };
  }
  deleteHistory(id: unknown): HistoryDeleteResult {
    if (typeof id !== 'string') return { deleted: false, removed: false, removedCardIds: [] };
    const result = this.history.delete(id, this.protectedPaths(this.historyCards.get(id)), this.mediaInUse());
    const removedCardIds = result.removed ? this.unbind(id) : [];
    return { ...result, removedCardIds };
  }
  deleteCard(cardId: unknown): { deleted: boolean; message: string } {
    const card = this.resolve(cardId);
    if (typeof cardId !== 'string' || !card) return { deleted: false, message: 'File was not deleted safely because its ClipDock history record is unavailable. It remains in the queue.' };
    try {
      // A bound companion shares its media's history record: delete only its own file.
      const recorded = !card.ownerPath && card.historyId && this.history.get(card.historyId);
      const protectedPaths = this.protectedPaths(cardId, card.historyId ? this.historyCards.get(card.historyId) : undefined);
      const result = recorded && card.historyId
        ? this.history.delete(card.historyId, protectedPaths, this.mediaInUse(), true)
        : this.history.deleteUnrecorded(card.path, card.trustedRoot, protectedPaths, { media: card.ownedMedia ?? null, subtitle: card.ownedSubtitle ?? null }, this.mediaInUse(), card.subtitlePath);
      if (!result.deleted) return { deleted: false, message: result.warning ?? 'File was not deleted safely. It remains in the queue; retry after other references or active work are gone.' };
      this.cards.delete(cardId);
      if (card.historyId && !card.ownerPath) this.unbind(card.historyId);
      for (const [id, companion] of this.cards) if (companion.ownerPath === card.path) this.cards.delete(id);
      this.sessionSubtitles.delete(card.path);
      return { deleted: true, message: result.warning === 'Download history could not be updated.' ? 'File deleted, but download history could not be updated.' : result.warning ? `File deleted. ${result.warning}` : 'File deleted.' };
    } catch (error) {
      return { deleted: false, message: error instanceof Error ? error.message : 'File was not deleted safely. It remains in the queue.' };
    }
  }
}
