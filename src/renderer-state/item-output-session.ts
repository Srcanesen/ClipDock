import { cloneOutputDefaults, cloneOutputOverrides, createCommonDefaults, normalizeSourceOutput, outputOverridesFrom, resolvePexelsRendition, resolveQualityChoice, type OutputDefaults, type OutputOverrides, type Provider, type PexelsKind, type Rendition, type ResultSelection, type StagedSelection } from './output-model';

// Renderer callers read these helpers through the session module; output-model is
// an implementation detail shared with the range and rendition calculations.
export { cardOutputSummary, cardQualityLabel, resultOptionsId, profileLabel, intentLabel, cloneOutputDefaults, cloneOutputOverrides, normalizeSourceOutput, transitionSourceSelection, selectSourceSegments, resolveSourceSelection, selectionEnvelope, renditionHeight, resolveQualityChoice, resolvePexelsRendition, sourceQualityChoices } from './output-model';
export type { OutputDefaults, OutputOverrides, SourceSelection, ResultSelection, StagedSelection } from './output-model';

export type RawItemOutput = Partial<Record<'profile' | 'quality' | 'mediaMode' | 'audioFormat' | 'intent' | 'targetBin' | 'subtitleLanguage', string | null>> & {
  subtitles?: boolean;
  selection?: OutputDefaults['selection'];
  selectionPlan?: OutputDefaults['selectionPlan'];
};
export type SelectedResult = { key: string; resultId: string; thumbnailDataUrl: string | null };
type Selection = { provider: Provider; kind?: PexelsKind } | { clear: Provider } | { source: string } | SelectedResult | null;
type OutputContext = { photo?: boolean; choices?: string[]; files?: Rendition[]; kind?: PexelsKind };
type SavedOutput = { snapshot: OutputDefaults; overrides: OutputOverrides };

// The only raw-control validation path, used for defaults, cards and inspector.
// Invalid fields leave their previous requested values unchanged. Rendition IDs
// are opaque; a range plan preserves even unfinished or invalid text as intent.
function validateOutput(raw: RawItemOutput, provider: Provider): OutputOverrides {
  const value: OutputOverrides = {};
  if (raw.profile === 'original' || raw.profile === 'fast' || raw.profile === 'editing') value.profile = raw.profile;
  if (raw.mediaMode === 'video' || raw.mediaMode === 'audio') value.mediaMode = raw.mediaMode;
  if (raw.audioFormat === 'wav' || raw.audioFormat === 'mp3' || raw.audioFormat === 'm4a') value.audioFormat = raw.audioFormat;
  if (raw.intent === 'download' || raw.intent === 'import' || raw.intent === 'playhead' || raw.intent === 'end') value.intent = raw.intent;
  if (raw.targetBin === 'active' || raw.targetBin === 'clipdock') value.targetBin = raw.targetBin;
  if (raw.subtitleLanguage === 'en' || raw.subtitleLanguage === 'es' || raw.subtitleLanguage === 'fr' || raw.subtitleLanguage === 'de' || raw.subtitleLanguage === 'tr') value.subtitleLanguage = raw.subtitleLanguage;
  if (typeof raw.quality === 'string' && raw.quality.trim() && (provider === 'pexels' || raw.quality === 'best' || raw.quality === 'original' || /^\d+p$/.test(raw.quality))) value.quality = raw.quality;
  if (typeof raw.subtitles === 'boolean') value.subtitles = raw.subtitles;
  if (raw.selection === null || (raw.selection && Number.isFinite(raw.selection.start) && Number.isFinite(raw.selection.end) && raw.selection.start >= 0 && raw.selection.end > raw.selection.start && typeof raw.selection.label === 'string')) value.selection = raw.selection;
  const plan = raw.selectionPlan;
  if ('selectionPlan' in raw && (plan === undefined || (plan && typeof plan.source === 'string' && ['full', 'manual', 'chapters', 'cues'].includes(plan.mode) && typeof plan.start === 'string' && typeof plan.end === 'string' && Array.isArray(plan.indices) && plan.indices.every((index) => Number.isInteger(index) && index >= 0) && Array.isArray(plan.ranges) && plan.ranges.every((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && typeof range.label === 'string')))) value.selectionPlan = plan;
  if (value.selectionPlan?.mode === 'full' || (value.selectionPlan?.mode === 'manual' && !value.selectionPlan.start.trim() && !value.selectionPlan.end.trim())) value.selectionPlan = undefined;
  return cloneOutputOverrides(value);
}
function providerForKey(key: string): Provider {
  return key.startsWith('pexels:') ? 'pexels' : key.startsWith('social:') ? 'social' : key.startsWith('pinterest:') ? 'pinterest' : 'youtube';
}
function copyStage(stage: StagedSelection): StagedSelection {
  return { ...stage, snapshot: cloneOutputDefaults(stage.snapshot), overrides: cloneOutputOverrides(stage.overrides) };
}

/** Owns all item output. Reads never write back, including capability resolution.
 * Staged outputs freeze their defaults; unstage remembers the requested output.
 * Selection identity and the source draft travel together across provider switches.
 */
export class ItemOutputSession {
  private common = createCommonDefaults();
  private stages = new Map<string, StagedSelection>();
  private cards = new Map<string, SavedOutput>();
  private identity: SelectedResult | null = null;
  // Detached inspector edits follow current defaults, independently of any card.
  private draft: OutputOverrides = {};
  private provider: Provider = 'youtube';
  private kind: PexelsKind = 'video';
  private qualityPreferences = new Map<Provider, string>();
  private sources = new Map<string, { selected: SelectedResult | null; draft: OutputOverrides }>();

  get defaults(): OutputDefaults { return cloneOutputDefaults(this.common); }
  get selected(): SelectedResult | null { return this.identity ? { ...this.identity } : null; }
  get staged(): ReadonlyMap<string, StagedSelection> { return new Map([...this.stages].map(([key, stage]) => [key, copyStage(stage)])); }

  select(next: Selection): OutputDefaults {
    if (next && 'source' in next) {
      // Range intent belongs to one video; the other detached edits survive loads.
      if (!this.identity && this.draft.selectionPlan?.source !== next.source) {
        delete this.draft.selection; delete this.draft.selectionPlan;
      }
    } else if (next && 'clear' in next) {
      for (const key of this.sources.keys()) if (key === next.clear || key.startsWith(`${next.clear}:`)) this.sources.delete(key);
      if (this.provider === next.clear) { this.identity = null; this.draft = {}; }
    } else if (next && 'provider' in next) {
      this.sources.set(this.sourceKey(), { selected: this.selected, draft: cloneOutputOverrides(this.draft) });
      this.provider = next.provider; this.kind = next.kind ?? 'video';
      const saved = this.sources.get(this.sourceKey());
      this.identity = saved?.selected ? { ...saved.selected } : null;
      this.draft = cloneOutputOverrides(saved?.draft ?? {});
    } else {
      this.identity = next ? { ...next } : null;
    }
    return this.output();
  }

  output(key?: string, context: OutputContext = {}): OutputDefaults {
    const target = key ?? this.identity?.key;
    const value = this.requested(target);
    const provider = target ? providerForKey(target) : this.provider;
    const photo = context.photo ?? (target ? target.startsWith('pexels:photo:') : provider === 'pexels' && this.kind === 'photo');
    const output = normalizeSourceOutput(value, provider, photo);
    if (provider === 'pexels' && context.files) output.quality = resolvePexelsRendition(context.kind ?? (photo ? 'photo' : 'video'), context.files, output.quality)?.id ?? '';
    else if (provider !== 'pexels' && output.mediaMode !== 'audio') output.quality = this.resolveQuality(provider, output.quality, context.choices);
    return output;
  }

  resolveQuality(provider: Provider, desired: string, choices?: string[]): string {
    const preference = this.qualityPreferences.get(provider);
    return choices ? resolveQualityChoice(desired, choices, preference) : desired === 'best' ? preference ?? desired : desired;
  }

  // Return only the accepted requested fields so persistence cannot capture a
  // capability fallback. Presentation is always a separate output() read.
  edit(target: 'defaults' | 'inspector' | string, raw: RawItemOutput): OutputOverrides {
    const key = target === 'defaults' ? undefined : target === 'inspector' ? this.identity?.key : target;
    const provider = key ? providerForKey(key) : this.provider;
    const patch = validateOutput(raw, provider);
    if ('quality' in patch) this.qualityPreferences.set(provider, patch.quality!);
    if (target === 'defaults') {
      this.common = cloneOutputDefaults({ ...this.common, ...patch });
      return cloneOutputOverrides(patch);
    }
    const stage = key ? this.stages.get(key) : undefined;
    const saved = stage ?? (key ? this.cards.get(key) : undefined);
    const base = saved && (stage || Object.keys(saved.overrides).length) ? saved.snapshot : this.common;
    const overrides = cloneOutputOverrides(key ? saved?.overrides ?? {} : this.draft);
    // Only validated, explicitly edited fields participate. Never diff presentation.
    for (const field of Object.keys(patch) as Array<keyof OutputDefaults>) {
      if (JSON.stringify(patch[field]) === JSON.stringify(base[field])) delete overrides[field];
      else Object.assign(overrides, { [field]: patch[field] });
    }
    if (key) {
      const state = { snapshot: cloneOutputDefaults(base), overrides };
      if (stage) stage.overrides = overrides;
      else if (Object.keys(patch).length) this.cards.set(key, state);
    } else this.draft = overrides;
    return cloneOutputOverrides(patch);
  }

  overrides(key?: string): OutputOverrides { return cloneOutputOverrides(key ? (this.stages.get(key) ?? this.cards.get(key))?.overrides ?? {} : this.draft); }

  stage(key: string, selection: ResultSelection, keep = true): StagedSelection {
    if (!this.stages.has(key)) {
      const snapshot = this.defaults;
      const stage = { ...selection, key, snapshot, overrides: outputOverridesFrom(this.requested(key), snapshot) };
      if (!keep) return copyStage(stage);
      this.stages.set(key, stage);
    }
    return copyStage(this.stages.get(key)!);
  }

  unstage(key?: string): void {
    for (const [id, stage] of this.stages) {
      if (key !== undefined && id !== key) continue;
      const snapshot = this.defaults;
      this.cards.set(id, { snapshot, overrides: outputOverridesFrom({ ...stage.snapshot, ...stage.overrides }, snapshot) });
      this.stages.delete(id);
    }
  }

  // The sole composition path for stored values, also used by staging. Provider
  // capabilities and fallbacks belong exclusively to output(), never here.
  private requested(key?: string): OutputDefaults {
    const saved = key ? this.stages.get(key) ?? this.cards.get(key) : undefined;
    return cloneOutputDefaults(saved && (this.stages.has(key!) || Object.keys(saved.overrides).length)
      ? { ...saved.snapshot, ...saved.overrides } : key ? this.common : { ...this.common, ...this.draft });
  }

  private sourceKey(): string { return this.provider === 'pexels' ? `pexels:${this.kind}` : this.provider; }
}
