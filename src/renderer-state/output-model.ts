// ClipDock renderer output model — pure state transitions for OutputDefaults.
// No DOM reads; output and source selection decisions are shared by all actions.
// Bug-hunt r1 stale-snapshot handling (overrides vs snapshot) is preserved here.

export type MediaProfile = 'original' | 'fast' | 'editing';
export type MediaMode = 'video' | 'audio';
export type AudioFormat = 'wav' | 'mp3' | 'm4a';
export type SubtitleLanguage = 'en' | 'es' | 'fr' | 'de' | 'tr';
export type DownloadIntent = 'download' | 'import' | 'playhead' | 'end';
export type TargetBin = 'active' | 'clipdock';
export type TimelinePlacement = 'end' | 'playhead';
export type YoutubeSelection = { start: number; end: number; label: string } | null;
export type OutputDefaults = {
  profile: MediaProfile;
  quality: string;
  mediaMode: MediaMode;
  audioFormat: AudioFormat;
  intent: DownloadIntent;
  targetBin: TargetBin;
  subtitles: boolean;
  subtitleLanguage: SubtitleLanguage;
  selection: YoutubeSelection;
  selectionPlan?: SourceSelection;
};
export type OutputOverrides = Partial<OutputDefaults>;

export type Provider = 'youtube' | 'pexels' | 'social' | 'pinterest';
export type PexelsKind = 'photo' | 'video';

export interface StagedSelection {
  key: string;
  provider: Provider;
  resultId: string;
  source: string;
  title: string;
  channel: string | null;
  thumbnailDataUrl: string | null;
  pexelsKind?: PexelsKind;
  snapshot: OutputDefaults;
  overrides: OutputOverrides;
}

export type ResultSelection = Omit<StagedSelection, 'key' | 'snapshot' | 'overrides'>;

export const commonDefaults: OutputDefaults = {
  profile: 'original',
  quality: 'best',
  mediaMode: 'video',
  audioFormat: 'mp3',
  intent: 'download',
  targetBin: 'active',
  subtitles: false,
  subtitleLanguage: 'en',
  selection: null,
};

export function createCommonDefaults(): OutputDefaults {
  return cloneOutputDefaults(commonDefaults);
}

export function cloneOutputDefaults(value: OutputDefaults = commonDefaults): OutputDefaults {
  return { ...value, selection: value.selection ? { ...value.selection } : null, ...(value.selectionPlan ? { selectionPlan: cloneSourceSelection(value.selectionPlan) } : {}) };
}

export function cloneOutputOverrides(value: OutputOverrides): OutputOverrides {
  return { ...value, ...('selection' in value ? { selection: value.selection ? { ...value.selection } : value.selection } : {}), ...(value.selectionPlan ? { selectionPlan: cloneSourceSelection(value.selectionPlan) } : {}) };
}

export function outputOverridesFrom(value: OutputDefaults, snapshot: OutputDefaults): OutputOverrides {
  const overrides: OutputOverrides = {};
  for (const key of [
    'profile',
    'quality',
    'mediaMode',
    'audioFormat',
    'intent',
    'targetBin',
    'subtitles',
    'subtitleLanguage',
    'selection',
    'selectionPlan',
  ] as const) {
    if (JSON.stringify(value[key]) !== JSON.stringify(snapshot[key])) overrides[key] = value[key] as never;
  }
  return overrides;
}

export function profileLabel(profile: MediaProfile): string {
  return profile === 'editing' ? 'Edit-ready' : profile === 'fast' ? 'Fast' : 'Best quality';
}

export function intentLabel(intent: DownloadIntent): string {
  return intent === 'import'
    ? 'Add to Media Pool'
    : intent === 'playhead'
      ? 'Add at playhead'
      : intent === 'end'
        ? 'Add to timeline end'
        : 'Download only';
}

export function cardQualityLabel(value: string): string {
  if (value === 'best') return 'Best available';
  if (value === 'original') return 'Original';
  return /^\d+p$/.test(value) ? value : 'Best available';
}

export function cardOutputSummary(value: OutputDefaults, photo = false): string {
  const quality = photo
    ? 'Original'
    : value.mediaMode === 'audio'
      ? `${value.audioFormat === 'm4a' ? 'AAC (M4A)' : value.audioFormat.toUpperCase()} audio`
      : cardQualityLabel(value.quality);
  const profile = photo ? null : value.mediaMode === 'audio' ? null : value.profile === 'original' ? 'Original' : profileLabel(value.profile);
  const destination = value.targetBin === 'active' ? 'Active bin' : 'ClipDock bin';
  return [quality, profile, value.intent === 'download' ? null : intentLabel(value.intent), destination].filter(Boolean).join(' · ');
}

export function resultOptionsId(key: string): string {
  return `result-options-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

// Selection intent remains distinct from its validated queue ranges. Invalid input
// must survive staging rather than being converted into a full-source download.
export type SourceSelection = {
  source: string;
  mode: 'full' | 'manual' | 'chapters' | 'cues';
  start: string;
  end: string;
  indices: number[];
  ranges: NonNullable<YoutubeSelection>[];
};
export type SelectionResult = { status: 'full' | 'valid'; selections: YoutubeSelection[] }
  | { status: 'invalid'; message: string };
export type SelectionAction = { type: 'source'; source: string } | { type: 'full'; source: string }
  | { type: 'manual'; start: string; end: string }
  | { type: 'chapters' | 'cues'; indices: number[]; ranges: NonNullable<YoutubeSelection>[] };

export function cloneSourceSelection(value: SourceSelection): SourceSelection {
  return { ...value, indices: [...value.indices], ranges: value.ranges.map((range) => ({ ...range })) };
}
export function transitionSourceSelection(state: SourceSelection | null, action: SelectionAction): SourceSelection {
  if (action.type === 'source' || action.type === 'full') {
    return { source: action.source, mode: 'full', start: '', end: '', indices: [], ranges: [] };
  }
  const source = state?.source ?? '';
  if (action.type === 'manual') return { source, mode: 'manual', start: action.start, end: action.end, indices: [], ranges: [] };
  return { source, mode: action.indices.length ? action.type : 'full', start: '', end: '', indices: [...action.indices], ranges: action.ranges.map((range) => ({ ...range })) };
}
export function selectSourceSegments(state: SourceSelection, mode: 'chapters' | 'cues', segments: { start: number; end: number; title?: string }[], indices: number[]): SourceSelection {
  const selected = [...new Set(indices)].filter((index) => Number.isInteger(index) && !!segments[index]).sort((a, b) => a - b);
  return transitionSourceSelection(state, { type: mode, indices: selected, ranges: selected.map((index) => ({ start: segments[index].start, end: segments[index].end, label: mode === 'chapters' ? segments[index].title ?? 'Chapter' : 'Subtitle cue' })) });
}
export function selectionEnvelope(ranges: NonNullable<YoutubeSelection>[], label: string): YoutubeSelection {
  return ranges.length ? { start: Math.min(...ranges.map((range) => range.start)), end: Math.max(...ranges.map((range) => range.end)), label } : null;
}
export function resolveSourceSelection(state: SourceSelection, source: string, duration: number | null): SelectionResult {
  if (state.source !== source || state.mode === 'full') return { status: 'full', selections: [null] };
  let ranges = state.ranges;
  if (state.mode === 'manual') {
    if (!state.start.trim() && !state.end.trim()) return { status: 'full', selections: [null] };
    if (!state.start.trim() || !state.end.trim()) return { status: 'invalid', message: 'Enter both In and Out, or choose Full video.' };
    ranges = [{ start: Number(state.start), end: Number(state.end), label: 'Custom range' }];
  }
  if (!ranges.length || ranges.some(({ start, end }) => !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (duration !== null && end > duration))) {
    return { status: 'invalid', message: 'In/Out must be a valid range within the source duration.' };
  }
  return { status: 'valid', selections: state.mode === 'cues' ? [selectionEnvelope(ranges, ranges.length === 1 ? 'Subtitle cue' : `${ranges.length} subtitle cues`)] : ranges.map((range) => ({ ...range })) };
}

export interface Rendition { id: string; width: number | null; height: number | null; label: string; mime: string; size: number | null; }
export function renditionHeight(file: Rendition): number | null {
  if (file.height !== null && Number.isFinite(file.height) && file.height > 0) return file.height;
  const labelled = file.label.match(/(\d{3,4})p?/i)?.[1];
  return labelled ? Number(labelled) : null;
}
export function resolvePexelsRendition<T extends Rendition>(kind: PexelsKind, files: T[], desired: string): T | null {
  const ranked = files.filter((file) => kind === 'video' ? file.mime === 'video/mp4' : file.mime === 'image/jpeg' || file.mime === 'image/png')
    .sort((a, b) => (renditionHeight(b) ?? 0) - (renditionHeight(a) ?? 0) || (b.width ?? 0) - (a.width ?? 0) || (b.size ?? 0) - (a.size ?? 0) || a.id.localeCompare(b.id));
  const exact = ranked.find((file) => file.id === desired);
  if (exact) return exact;
  if (!ranked.length || kind === 'photo' || desired === 'best' || desired === 'original') return ranked[0] ?? null;
  const requested = Number(desired.match(/^(\d+)p$/)?.[1]);
  if (!Number.isFinite(requested)) return ranked[0];
  return ranked.find((file) => renditionHeight(file) === requested)
    ?? ranked.find((file) => (renditionHeight(file) ?? Number.POSITIVE_INFINITY) < requested)
    ?? ranked.at(-1) ?? null;
}
export function sourceQualityChoices(provider: Provider, heights: number[] = [], files: Rendition[] = []): string[] {
  if (provider === 'pinterest') return ['original'];
  if (provider === 'pexels') return files.map((file) => file.id);
  const actual = [...new Set(heights.filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))].sort((a, b) => b - a);
  return actual.length ? actual.map((height) => `${height}p`) : ['best'];
}
export function resolveQualityChoice(desired: string, choices: string[], fallback?: string | null): string {
  return choices.includes(desired) ? desired : fallback && choices.includes(fallback) ? fallback : choices.includes('2160p') ? '2160p' : choices[0] ?? '';
}
export function normalizeSourceOutput(value: OutputDefaults, provider: Provider, photo = false): OutputDefaults {
  const output = cloneOutputDefaults(value);
  if (provider !== 'youtube') {
    output.mediaMode = 'video'; output.audioFormat = 'm4a'; output.subtitles = false; output.subtitleLanguage = 'en'; output.selection = null; delete output.selectionPlan;
  } else if (output.mediaMode === 'audio') { output.profile = 'original'; output.quality = 'best'; }
  // Photo rendition IDs are opaque too; generic height/default choices mean Original.
  if (provider === 'pinterest' || (photo && (provider !== 'pexels' || output.quality === 'best' || /^\d+p$/.test(output.quality)))) output.quality = 'original';
  if (photo) output.profile = 'original';
  return output;
}
