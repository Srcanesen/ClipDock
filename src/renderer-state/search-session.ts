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

export type Orientation = 'all' | 'vertical' | 'horizontal' | 'square';
export type SearchOptions = { orientation?: Orientation };
export const ORIENTATION_SUPPORT = {
  youtube: ['all', 'vertical', 'horizontal'],
  pinterest: ['all', 'vertical', 'horizontal', 'square'],
  pexels: ['all', 'vertical', 'horizontal', 'square'],
  pixabay: ['all', 'vertical', 'horizontal', 'square'],
} as const satisfies Record<string, readonly Orientation[]>;

/** Untrusted IPC options default to All, including unsupported source options. */
export function searchOrientation(options: unknown, source: keyof typeof ORIENTATION_SUPPORT): Orientation {
  const value = options && typeof options === 'object' && !Array.isArray(options)
    ? (options as SearchOptions).orientation : undefined;
  return (ORIENTATION_SUPPORT[source] as readonly unknown[]).includes(value) ? value as Orientation : 'all';
}

export function classifyOrientation(width: unknown, height: unknown): Exclude<Orientation, 'all'> | null {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
  return height > width ? 'vertical' : width > height ? 'horizontal' : 'square';
}

export function matchesOrientation(item: {width: unknown; height: unknown}, orientation: Orientation): boolean {
  return orientation === 'all' || classifyOrientation(item.width, item.height) === orientation;
}

export function matchesYoutubeOrientation(item: {isShort: boolean | null}, orientation: Orientation): boolean {
  return orientation === 'all' || orientation === 'square' || (orientation === 'vertical' ? item.isShort === true : item.isShort === false);
}
