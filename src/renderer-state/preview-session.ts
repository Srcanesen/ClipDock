// ClipDock renderer preview session: who owns the visible source preview.
// Pure and DOM-free. The renderer keeps timers, DOM and IPC calls; this module
// keeps the lifecycle so stale opens, bounds replies and close acknowledgements
// cannot act on a preview that has since stopped or been replaced.
import { createGenerationGuard } from './search-session';

export type PreviewSource = 'hover' | 'manual';
export type PreviewProvider = 'youtube' | 'pexels';
export interface YoutubePreviewSignal { state: string; reason?: string }
export type YoutubePreviewOutcome = 'acknowledged' | 'ignored' | 'ended';

export class PreviewSession<Target> {
  #guard = createGenerationGuard();
  #source: PreviewSource | null = null;
  #provider: PreviewProvider | null = null;
  #target: Target | null = null;
  #resultKey: string | null = null;
  #failure = false;
  // A close is sent only for a lifecycle that attempted to create the main-owned
  // view. This also covers failed open/bounds paths without double-close.
  #youtubeActive = false;
  #pendingCloses = new Set<object>();

  get source(): PreviewSource | null { return this.#source; }
  get provider(): PreviewProvider | null { return this.#provider; }
  get target(): Target | null { return this.#target; }
  get resultKey(): string | null { return this.#resultKey; }
  get failure(): boolean { return this.#failure; }
  get youtubeActive(): boolean { return this.#youtubeActive; }
  get pendingCloseCount(): number { return this.#pendingCloses.size; }

  isManualFor(key: string | null): boolean { return this.#source === 'manual' && this.#resultKey === key; }
  setFailure(value: boolean): void { this.#failure = value; }

  current(): number { return this.#guard.current(); }
  isCurrent(request: number): boolean { return this.#guard.isCurrent(request); }
  isStale(request: number): boolean { return this.#guard.isStale(request); }
  invalidate(): void { this.#guard.invalidate(); }

  beginYoutube(target: Target, resultKey: string | null): number {
    const request = this.#guard.next();
    this.#failure = false;
    this.#take('youtube', target, resultKey);
    this.#youtubeActive = true;
    return request;
  }

  beginPexels(target: Target, resultKey: string | null): number {
    const request = this.#guard.next();
    this.#take('pexels', target, resultKey);
    return request;
  }

  // Returns false when nothing is previewing; otherwise invalidates in-flight
  // replies and the caller clears the preview.
  stop(): boolean {
    if (this.#source === null) return false;
    this.#guard.invalidate();
    return true;
  }

  // Drops the lifecycle. `closeToken` is set when the caller must send a YouTube
  // close and report its result through closeSettled(). `provider` is the one
  // that was previewing, so the caller can tear down its own view.
  clear(): { provider: PreviewProvider | null; closeToken: object | null } {
    const provider = this.#provider;
    let closeToken: object | null = null;
    if (this.#youtubeActive) {
      this.#youtubeActive = false;
      closeToken = {};
      this.#pendingCloses.add(closeToken);
    }
    this.#source = null; this.#provider = null; this.#target = null; this.#resultKey = null;
    return { provider, closeToken };
  }

  // Main sends no acknowledgement for a close that did not succeed.
  closeSettled(token: object, closed: boolean): void {
    if (!closed) this.#pendingCloses.delete(token);
  }

  receiveYoutubeState(signal: YoutubePreviewSignal): YoutubePreviewOutcome {
    // Main acknowledges each successful renderer close in IPC order. That event
    // belongs to the stopped lifecycle, even if another preview is now active.
    if (signal.state === 'closed' && signal.reason === 'closed' && this.#pendingCloses.size) {
      this.#pendingCloses.delete(this.#pendingCloses.values().next().value!);
      return 'acknowledged';
    }
    if (this.#provider !== 'youtube' || !this.#youtubeActive) return 'ignored';
    this.#youtubeActive = false;
    this.#guard.invalidate();
    if (signal.state === 'failed') this.#failure = true;
    return 'ended';
  }

  #take(provider: PreviewProvider, target: Target, resultKey: string | null): void {
    this.#source = 'manual'; this.#provider = provider; this.#target = target; this.#resultKey = resultKey;
  }
}
