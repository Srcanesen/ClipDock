// ClipDock renderer status sessions: host-status refresh flights and source
// metadata loading. Pure and DOM-free; the renderer keeps timers, DOM and IPC.
import { createGenerationGuard } from './search-session';

export interface StatusFlight { readonly generation: number; readonly epoch: number }

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

  accepts(flight: StatusFlight): boolean { return flight.epoch === this.#epoch && flight.generation === this.#generation; }
  holds(flight: StatusFlight): boolean { return flight.epoch === this.#epoch; }
  expire(): void { this.#epoch += 1; }
  invalidate(): void { this.#generation += 1; }

  release(): boolean {
    this.#inFlight = false;
    if (!this.#trailing) return false;
    this.#trailing = false;
    return true;
  }
}

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
