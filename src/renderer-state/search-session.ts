// ClipDock renderer search session — generation guard for stale-response suppression.
// Pure, DOM-free, testable without the fake-DOM VM harness.
// The renderer keeps three logical counters (search/metadata/preview) plus
// subtitle/history counters; all share the same increment/check pattern.

export interface GenerationGuard {
  next(): number;
  current(): number;
  isStale(id: number): boolean;
  isCurrent(id: number): boolean;
  invalidate(): void;
}

export function createGenerationGuard(initial = 0): GenerationGuard {
  let gen = initial;
  return {
    next(): number {
      gen += 1;
      return gen;
    },
    current(): number {
      return gen;
    },
    isStale(id: number): boolean {
      return id !== gen;
    },
    isCurrent(id: number): boolean {
      return id === gen;
    },
    invalidate(): void {
      gen += 1;
    },
  };
}
