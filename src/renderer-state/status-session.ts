// ClipDock renderer status sessions: host-status refresh flights and source
// metadata loading. Pure and DOM-free; the renderer keeps timers, DOM and IPC.
import { createGenerationGuard } from './search-session';

export interface StatusFlight { readonly generation: number; readonly epoch: number }

// Single-flight host status refresh. ResolveQuit bumps the generation and the
// bounded timeout bumps the epoch; neither lets an older response through.
export class StatusRefreshSession {
  #inFlight = false;
  #trailing = false;
  #generation = 0;
  #epoch = 0;

  get inFlight(): boolean { return this.#inFlight; }

  // Null while a flight is running: the request is folded into one trailing refresh.
  begin(): StatusFlight | null {
    if (this.#inFlight) { this.#trailing = true; return null; }
    this.#inFlight = true;
    return { generation: this.#generation, epoch: ++this.#epoch };
  }

  // The response may update visible state.
  accepts(flight: StatusFlight): boolean { return flight.epoch === this.#epoch && flight.generation === this.#generation; }
  // The flight still holds the single-flight slot (the timeout has not released it).
  holds(flight: StatusFlight): boolean { return flight.epoch === this.#epoch; }
  expire(): void { this.#epoch += 1; }
  invalidate(): void { this.#generation += 1; }

  // Frees the slot; true when a trailing refresh must run now.
  release(): boolean {
    this.#inFlight = false;
    if (!this.#trailing) return false;
    this.#trailing = false;
    return true;
  }
}

// Source metadata loading. Busy belongs to the newest request only, so an older
// request that settles late cannot clear it under a newer one.
export class MetadataSession {
  #guard = createGenerationGuard();
  #busy = false;

  get busy(): boolean { return this.#busy; }

  begin(): number {
    const request = this.#guard.next();
    this.#busy = true;
    return request;
  }

  isCurrent(request: number): boolean { return this.#guard.isCurrent(request); }
  isStale(request: number): boolean { return this.#guard.isStale(request); }

  // True when this request still owned busy and released it.
  finish(request: number): boolean {
    if (!this.#guard.isCurrent(request)) return false;
    this.#busy = false;
    return true;
  }

  // Abandon any in-flight request and drop busy (selection or provider change).
  reset(): void {
    this.#guard.invalidate();
    this.#busy = false;
  }
}
