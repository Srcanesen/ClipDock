// ClipDock — Resolve transfer logic with a
// destination bin (active | clipdock) and duplicate-safe import.
// The WorkflowIntegration native module is INJECTED (never required
// here), so this file runs in plain Node under scripts/verify-plugin.mjs with a
// fake adapter. It has no Electron imports and no runtime requires of local files.
//
// Fallback chain follows Blackmagic's official scripting API:
//   import to Media Pool: Initialize/GetResolve -> GetMediaStorage().AddItemListToMediaPool([path])
//   add to timeline:      verify current project + timeline -> project.GetMediaPool().AppendToTimeline([clip])
// Destination bin (official MediaPool/Folder APIs):
//   GetMediaPool/GetCurrentFolder/GetRootFolder, Folder.GetSubFolderList/GetName/GetClipList,
//   MediaPool.AddSubFolder/SetCurrentFolder, MediaPoolItem.GetClipProperty('File Path').
// Duplicate control scans ONLY the target bin by source path (normalized slash,
// Windows case folding, macOS file identity) and reuses the existing MediaPoolItem.

import { stat } from 'node:fs/promises';

/** Minimal surface of the WorkflowIntegration.node module the transfer logic needs. */
export interface TransferWorkflowIntegration {
  Initialize(pluginId: string): Promise<boolean> | boolean;
  GetResolve(): Promise<unknown> | unknown;
}

/** Destination bin for an import/append: the current Media Pool folder or the ClipDock bin. */
export type TargetBin = 'active' | 'clipdock';
/** Timeline insertion point: legacy end append or the current Edit-page playhead. */
export type TimelinePlacement = 'end' | 'playhead';

/** Discriminated transfer result: user-facing `message` on every branch. */
export type TransferResult =
  | { ok: true; kind: 'imported'; importedCount: number; message: string }
  | { ok: true; kind: 'already-imported'; message: string }
  | { ok: true; kind: 'timeline-appended'; message: string }
  | { ok: true; kind: 'timeline-inserted'; message: string }
  | { ok: false; kind: 'bridge-error'; message: string }
  | { ok: false; kind: 'no-project'; message: string }
  | { ok: false; kind: 'no-timeline'; message: string }
  | { ok: false; kind: 'destination-changed'; message: string }
  | { ok: false; kind: 'import-failed'; message: string }
  | { ok: false; kind: 'append-failed'; message: string }
  | { ok: false; kind: 'bin-error'; message: string }
  | { ok: false; kind: 'playhead-unsupported'; message: string };

export interface Transfer {
  noteResolveQuit(): void;
  importToMediaPool(filePath: string, targetBin: TargetBin): Promise<TransferResult>;
  addToTimeline(filePath: string, targetBin: TargetBin, placement: TimelinePlacement, automation?: TimelineAutomation): Promise<TransferResult>;
}
export type TimelineAutomation = { provider: 'youtube' | 'pexels' | 'pixabay' | 'social' | 'pinterest'; source: string; selection: { start: number; end: number; label: string } | null; chapters: Array<{ start: number; end: number; title: string }> };

// Duck-typed Resolve scripting surface (mirrors status-provider's approach: the
// native module returns plain objects; we cast narrowly where we call).
interface ResolveLike {
  OpenPage(page: string): Promise<unknown> | unknown;
  GetMediaStorage(): Promise<unknown> | unknown;
  GetProjectManager(): Promise<unknown> | unknown;
}
interface MediaStorageLike {
  AddItemListToMediaPool(paths: string[]): Promise<unknown> | unknown;
}
interface ProjectManagerLike {
  GetCurrentProject(): Promise<unknown> | unknown;
}
interface ProjectLike {
  GetCurrentTimeline(): Promise<unknown> | unknown;
  GetMediaPool(): Promise<unknown> | unknown;
  GetSetting(setting: string): Promise<unknown> | unknown;
}
interface TimelineLike {
  GetSetting(setting: string): Promise<unknown> | unknown;
  GetStartFrame(): Promise<unknown> | unknown;
  AddMarker?(frame: number, color: string, name: string, note: string, duration: number): Promise<unknown> | unknown;
  GetStartTimecode(): Promise<unknown> | unknown;
  GetCurrentTimecode(): Promise<unknown> | unknown;
}

type DestinationCheck = () => Promise<TransferResult | null>;
const destinationChanged = (): TransferResult => ({
  ok: false, kind: 'destination-changed',
  message: 'Resolve destination changed during transfer. Check the active project, timeline and bin, then retry. Earlier transfer steps may already have completed.',
});

/** Prefer persistent Resolve IDs: native bridges may return fresh wrappers. */
async function destinationIdentity(handle: unknown): Promise<unknown> {
  if (handle == null) return null;
  const getId = (handle as { GetUniqueId?: () => unknown }).GetUniqueId;
  if (typeof getId !== 'function') return handle;
  const id = await getId.call(handle);
  if (typeof id !== 'string' || !id.trim()) throw new Error('Resolve returned no destination identity');
  return id;
}

async function captureDestination(resolve: unknown, project: unknown, timeline?: unknown): Promise<DestinationCheck> {
  const projectId = await destinationIdentity(project);
  const timelineId = timeline === undefined ? undefined : await destinationIdentity(timeline);
  return async () => {
    try {
      const now = await currentProject(resolve);
      if (await destinationIdentity(now) !== projectId) return destinationChanged();
      if (timelineId !== undefined && await destinationIdentity(await (now as ProjectLike).GetCurrentTimeline()) !== timelineId) return destinationChanged();
      return null;
    } catch { return destinationChanged(); }
  };
}
interface MediaPoolLike {
  AppendToTimeline(clips: unknown[]): Promise<unknown> | unknown;
  GetCurrentFolder(): Promise<unknown> | unknown;
  GetRootFolder(): Promise<unknown> | unknown;
  AddSubFolder(folder: unknown, name: string): Promise<unknown> | unknown;
  SetCurrentFolder(folder: unknown): Promise<unknown> | unknown;
}
interface FolderLike {
  GetName(): Promise<unknown> | unknown;
  GetSubFolderList(): Promise<unknown> | unknown;
  GetClipList(): Promise<unknown> | unknown;
}
interface ClipLike {
  GetClipProperty(property: string): Promise<unknown> | unknown;
  SetClipColor?(color: string): Promise<unknown> | unknown;
}
interface TimelineItemLike {
  GetStart(): Promise<unknown> | unknown;
}

function appendedItems(result: unknown): TimelineItemLike[] | null {
  if (!Array.isArray(result) || result.length === 0) return null;
  for (const item of result) {
    if (!item || typeof item !== 'object' || typeof item.GetStart !== 'function') return null;
  }
  return result;
}

function frameNumber(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
  const frame = Number(value);
  return Number.isSafeInteger(frame) ? frame : null;
}

/** A missing custom timeline rate is not evidence of project inheritance. */
async function timelineFrameRate(project: unknown, timeline: unknown): Promise<unknown> {
  const settings = timeline as TimelineLike;
  const rate = await settings.GetSetting('timelineFrameRate');
  const parsed = String(rate ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*DF)?$/i);
  if (parsed && Number(parsed[1]) >= 1 && Number(parsed[1]) <= 240) return rate;
  const custom = await settings.GetSetting('useCustomSettings');
  if (custom === '0' || custom === 0 || custom === false) return await (project as ProjectLike).GetSetting('timelineFrameRate');
  return null;
}

async function itemStart(item: TimelineItemLike): Promise<number | null> {
  try { return frameNumber(await item.GetStart()); } catch { return null; }
}

interface TimecodeFrames {
  frames: number;
  dropFrame: boolean;
}

/** Convert a Resolve HH:MM:SS:FF/;FF timecode to absolute nominal frames. */
export function timecodeToFrames(timecode: unknown, frameRate: unknown): TimecodeFrames | null {
  const rate = String(frameRate ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*DF)?$/i);
  const tc = typeof timecode === 'string' ? timecode.match(/^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/) : null;
  if (!rate || !tc) return null;
  const numericRate = Number(rate[1]);
  const nominal = Math.round(numericRate);
  if (!Number.isFinite(numericRate) || nominal < 1 || nominal > 240) return null;
  const [, hh, mm, ss, delimiter, ff] = tc;
  const h = Number(hh), m = Number(mm), s = Number(ss), f = Number(ff);
  if (h > 99 || m > 59 || s > 59 || f >= nominal) return null;
  const dropFrame = /DF$/i.test(String(frameRate).trim()) || delimiter === ';';
  const dropFrames = nominal === 30 && Math.abs(numericRate - 29.97) < 0.01 ? 2 : nominal === 60 && Math.abs(numericRate - 59.94) < 0.01 ? 4 : 0;
  if (dropFrame && (dropFrames === 0 || (m % 10 !== 0 && s === 0 && f < dropFrames))) return null;
  const totalMinutes = h * 60 + m;
  return { frames: nominal * (h * 3600 + m * 60 + s) + f - (dropFrame ? dropFrames * (totalMinutes - Math.floor(totalMinutes / 10)) : 0), dropFrame };
}

/** The bin ClipDock imports into when the user picks the ClipDock destination. */
const CLIPDOCK_BIN = 'ClipDock';

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Normalize path separators for duplicate comparison (Windows backslashes -> slashes). */
function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

let transferPlatformOverride: string | null = null;
export function __setTransferPlatform(platform: string | null): void {
  transferPlatformOverride = platform;
}

/** Read a clip's 'File Path' property; any missing/throw is a non-match, never a blocker. */
async function clipFilePath(clip: unknown): Promise<string | null> {
  try {
    const raw = await (clip as ClipLike).GetClipProperty('File Path');
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Exact-name subfolder lookup under the root folder (returns null when absent/API-error). */
async function findSubFolder(root: unknown, name: string): Promise<unknown | null> {
  if (!root) return null;
  try {
    const list = await (root as FolderLike).GetSubFolderList();
    if (!Array.isArray(list)) return null;
    for (const folder of list) {
      if (folder == null) continue;
      let folderName: unknown = null;
      try {
        folderName = await (folder as FolderLike).GetName();
      } catch {
        continue;
      }
      if (folderName === name) return folder;
    }
    return null;
  } catch {
    return null;
  }
}

/** Current project or null (never throws; callers decide the failure semantics). */
async function currentProject(resolve: unknown): Promise<unknown> {
  try {
    const pm = await (resolve as ResolveLike).GetProjectManager();
    return pm ? await (pm as ProjectManagerLike).GetCurrentProject() : null;
  } catch {
    return null;
  }
}

/** Resolved target bin context: the folder to scan/import into plus a best-effort restore. */
interface TargetContext {
  folder: unknown;
  binLabel: string;
  restore: () => Promise<void>;
  check: DestinationCheck;
}

/**
 * Open the destination bin on the given MediaPool.
 * - active: the current folder; NO SetCurrentFolder/AddSubFolder ever; a missing
 *   current folder means "no duplicate scan", provided it stays missing.
 * - clipdock: exact-name 'ClipDock' under the root, created once when absent, then
 *   SetCurrentFolder; restores the previous folder only while the captured
 *   destination is still active. SetCurrentFolder/AddSubFolder failures are
 *   controlled bin-error results.
 */
async function openTargetContext(mediaPool: unknown, targetBin: TargetBin, checkDestination: DestinationCheck): Promise<TargetContext | { error: TransferResult }> {
  let previous: unknown = null;
  try {
    previous = await (mediaPool as MediaPoolLike).GetCurrentFolder();
  } catch {
    /* best-effort */
  }
  const previousId = await destinationIdentity(previous);
  const checkFolder = (...ids: unknown[]): DestinationCheck => async () => {
    const changed = await checkDestination();
    if (changed) return changed;
    try {
      if (!ids.includes(await destinationIdentity(await (mediaPool as MediaPoolLike).GetCurrentFolder()))) return destinationChanged();
      // Folder lookup can itself wait on Resolve after the project check.
      return await checkDestination();
    } catch { return destinationChanged(); }
  };
  if (targetBin === 'active') return { folder: previous, binLabel: 'Active', restore: async () => undefined, check: checkFolder(previousId) };
  let check = checkFolder(previousId);
  const restore = async (): Promise<void> => {
    if (previous == null) return;
    try {
      if (await check() === null) await (mediaPool as MediaPoolLike).SetCurrentFolder(previous);
    } catch {
      /* best-effort */
    }
  };
  const fail = async (error: TransferResult): Promise<{ error: TransferResult }> => {
    await restore();
    return { error };
  };
  try {
    const root = await (mediaPool as MediaPoolLike).GetRootFolder();
    if (!root) {
      return await fail({ ok: false, kind: 'bin-error', message: 'Resolve returned no root Media Pool folder.' });
    }
    let folder = await findSubFolder(root, CLIPDOCK_BIN);
    if (!folder) {
      const changed = await check();
      if (changed) return { error: changed };
      const created = await (mediaPool as MediaPoolLike).AddSubFolder(root, CLIPDOCK_BIN);
      if (!created) {
        return await fail({
          ok: false,
          kind: 'bin-error',
          message: `Could not create the "${CLIPDOCK_BIN}" bin in the Media Pool.`,
        });
      }
      folder = created;
      // Resolve selects a newly created bin. Accept only this owned transition
      // (or bridges that leave the old folder selected), never an unrelated bin.
      check = checkFolder(previousId, await destinationIdentity(created));
    }
    const folderId = await destinationIdentity(folder);
    const changed = await check();
    if (changed) return { error: changed };
    const setOk = await (mediaPool as MediaPoolLike).SetCurrentFolder(folder);
    if (setOk === false || setOk === null) {
      return await fail({
        ok: false,
        kind: 'bin-error',
        message: `Could not switch to the "${CLIPDOCK_BIN}" bin.`,
      });
    }
    check = checkFolder(folderId);
    return { folder, binLabel: 'ClipDock', restore, check };
  } catch (err) {
    return await fail({ ok: false, kind: 'bin-error', message: `Resolve API call failed: ${msg(err)}.` });
  }
}

type AutomationWarning = 'unavailable' | 'destination-changed' | null;

/** The append is committed: checks can stop automation, never fail the handoff. */
async function applyAutomation(project: unknown, timeline: unknown, clip: unknown, recordFrame: number | null, check: DestinationCheck, automation?: TimelineAutomation): Promise<AutomationWarning> {
  const changed = await check();
  if (changed) return 'destination-changed';
  if (!automation) return null;
  let warning: AutomationWarning = null;
  const colorName = automation.provider === 'pexels' ? 'Teal' : automation.provider === 'pixabay' ? 'Green' : automation.provider === 'social' ? 'Blue' : automation.selection ? 'Yellow' : 'Orange';
  try { const color = (clip as ClipLike).SetClipColor; if (typeof color !== 'function' || await color.call(clip, colorName) === false) warning = 'unavailable'; } catch { warning = 'unavailable'; }
  if (automation.provider !== 'youtube' || automation.chapters.length === 0) return await check() ? 'destination-changed' : warning;
  // AddMarker takes Resolve's marker palette, which lacks clip colours such as Orange.
  const markerColor = automation.selection ? 'Yellow' : 'Sand';
  try {
    const rate = String(await timelineFrameRate(project, timeline) ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*DF)?$/i);
    const fps = rate ? Number(rate[1]) : NaN;
    const timelineStart = frameNumber(await (timeline as TimelineLike).GetStartFrame());
    const addMarker = (timeline as TimelineLike).AddMarker;
    if (!Number.isFinite(fps) || fps < 1 || fps > 240 || recordFrame === null || timelineStart === null || typeof addMarker !== 'function') return await check() ? 'destination-changed' : 'unavailable';
    const offset = automation.selection?.start ?? 0;
    for (const chapter of automation.chapters.slice(0, 100)) {
      if (automation.selection && (chapter.start < automation.selection.start || chapter.start >= automation.selection.end)) continue;
      const changed = await check();
      if (changed) return 'destination-changed';
      if (await addMarker.call(timeline, recordFrame - timelineStart + Math.round((chapter.start - offset) * fps), markerColor, chapter.title, `${automation.source} · original ${chapter.start.toFixed(3)}s`, 1) === false) warning = 'unavailable';
    }
  } catch { warning = 'unavailable'; }
  return await check() ? 'destination-changed' : warning;
}

function timelineSuccess(placement: TimelinePlacement, warning: AutomationWarning, automation?: TimelineAutomation): TransferResult {
  const kind = placement === 'playhead' ? 'timeline-inserted' : 'timeline-appended';
  if (warning === 'destination-changed') {
    const completed = placement === 'playhead' ? 'Added at the captured playhead.' : 'Added to the captured timeline.';
    return { ok: true, kind, message: `${completed} Resolve destination changed after the append.${automation ? ' ClipDock color/marker updates may be incomplete.' : ''}` };
  }
  const completed = placement === 'playhead' ? 'Added at the playhead.' : 'Added to the active timeline.';
  return { ok: true, kind, message: `${completed}${warning ? ' ClipDock color/markers unavailable.' : ''}` };
}

export function createTransfer(
  workflowIntegration: TransferWorkflowIntegration,
  pluginId: string,
  platformOrOptions?: string | { platform?: string; validatePath?: (filePath: string) => string | null; takePristine?: (filePath: string) => (() => boolean) | null },
): Transfer {
  const validatePath = typeof platformOrOptions === 'object' ? platformOrOptions.validatePath : undefined;
  const takePristine = typeof platformOrOptions === 'object' ? platformOrOptions.takePristine : undefined;
  const instancePlatform: string | undefined = typeof platformOrOptions === 'string' ? platformOrOptions : platformOrOptions?.platform;
  const trustedPathFailure = (): TransferResult => ({ ok: false, kind: 'import-failed', message: 'Media file no longer satisfies its trusted path boundary.' });
  function trustedPath(filePath: string): string | null {
    return validatePath ? validatePath(filePath) : filePath;
  }
  function instanceCurrentPlatform(): string {
    return instancePlatform ?? transferPlatformOverride ?? process.platform;
  }
  async function pathKey(filePath: string): Promise<string> {
    const plat = instanceCurrentPlatform();
    if (plat === 'win32') return normalizeSlash(filePath).toLowerCase();
    if (plat === 'darwin') {
      try {
        const identity = await stat(filePath, { bigint: true });
        return `file:${identity.dev}:${identity.ino}`;
      } catch { /* unavailable paths must retain their exact spelling */ }
    }
    return `path:${filePath}`;
  }
  // Positive identities survive idle periods. Never cache absence: an unknown
  // path may have been added or relinked outside ClipDock since the last visit.
  let binIndex: { project: unknown; folder: unknown; clips: Map<string, unknown> } | null = null;
  function indexFor(project: unknown, folder: unknown) {
    if (!binIndex || binIndex.project !== project || binIndex.folder !== folder) {
      binIndex = { project, folder, clips: new Map() };
    }
    return binIndex;
  }
  async function instanceFindExistingClip(project: unknown, folder: unknown, filePath: string): Promise<unknown | null> {
    if (!folder) { binIndex = null; return null; }
    try {
      const index = indexFor(project, folder);
      const list = await (folder as FolderLike).GetClipList();
      if (!Array.isArray(list)) { binIndex = null; return null; }
      const wanted = await pathKey(filePath);
      const existing = index.clips.get(wanted);
      if (existing) {
        // Resolve can remove, move or relink a remembered item between transfers.
        if (list.includes(existing)) {
          const candidate = await clipFilePath(existing);
          if (candidate !== null && await pathKey(candidate) === wanted) return existing;
        }
        binIndex = null;
      }
      // A miss or failed validation needs current properties for every member,
      // including previously indexed items that may now point at the wanted file.
      const refreshed = indexFor(project, folder);
      refreshed.clips.clear();
      for (const clip of list) {
        if (clip == null) continue;
        const candidate = await clipFilePath(clip);
        if (candidate !== null) refreshed.clips.set(await pathKey(candidate), clip);
      }
      return refreshed.clips.get(wanted) ?? null;
    } catch {
      binIndex = null;
      return null;
    }
  }
  async function rememberImportedClip(project: unknown, folder: unknown, filePath: string, clip: unknown): Promise<void> {
    if (folder) indexFor(project, folder).clips.set(await pathKey(filePath), clip);
  }
  function noteResolveQuit(): void { binIndex = null; }
  /** Initialize once, then GetResolve. Returns {resolve} or a controlled bridge-error result. */
  async function resolveResolve(): Promise<{ resolve: unknown } | { error: TransferResult }> {
    try {
      const initOk = await workflowIntegration.Initialize(pluginId);
      if (initOk !== true) {
        binIndex = null;
        return {
          error: {
            ok: false,
            kind: 'bridge-error',
            message: 'WorkflowIntegration.Initialize failed. Is the plugin installed for Resolve Studio?',
          },
        };
      }
      const resolve = await workflowIntegration.GetResolve();
      if (!resolve) {
        binIndex = null;
        return { error: { ok: false, kind: 'bridge-error', message: 'GetResolve returned no Resolve object.' } };
      }
      return { resolve };
    } catch (err) {
      binIndex = null;
      return { error: { ok: false, kind: 'bridge-error', message: `Resolve bridge call failed: ${msg(err)}.` } };
    }
  }

  /** AddItemListToMediaPool([filePath]); null / empty / throw -> controlled import-failed result. */
  async function importClip(resolve: unknown, filePath: string, context: { project: unknown; folder: unknown; pristine: (() => boolean) | null; check: DestinationCheck }): Promise<TransferResult | { clip: unknown; reused: boolean }> {
    try {
      const skippedScan = context.pristine?.() === true;
      indexFor(context.project, context.folder);
      if (!skippedScan) {
        const existing = await instanceFindExistingClip(context.project, context.folder, filePath);
        if (existing) {
          const changed = await context.check();
          if (changed) return changed;
          return trustedPath(filePath) ? { clip: existing, reused: true } : trustedPathFailure();
        }
      }
      const storage = await (resolve as ResolveLike).GetMediaStorage();
      if (!storage) {
        binIndex = null;
        return { ok: false, kind: 'bridge-error', message: 'Resolve returned no MediaStorage object.' };
      }
      let clips: unknown;
      try {
        // Drag may expose a fresh file while storage lookup awaits the host.
        // Recheck the revocable proof immediately before handing off the import.
        if (skippedScan && context.pristine?.() !== true) {
          const existing = await instanceFindExistingClip(context.project, context.folder, filePath);
          if (existing) {
            const changed = await context.check();
            if (changed) return changed;
            return trustedPath(filePath) ? { clip: existing, reused: true } : trustedPathFailure();
          }
        }
        // The host and FIFO waits above can outlive admission-time path validation.
        const changed = await context.check();
        if (changed) return changed;
        const canonical = trustedPath(filePath);
        if (!canonical) return trustedPathFailure();
        clips = await (storage as MediaStorageLike).AddItemListToMediaPool([canonical]);
      } catch (err) {
        return {
          ok: false,
          kind: 'import-failed',
          message: `Import failed: ${msg(err)}. Make sure a project is open in Resolve.`,
        };
      }
      const clip = Array.isArray(clips) && clips.length > 0 ? clips[0] : null;
      if (!clip) {
        return {
          ok: false,
          kind: 'import-failed',
          message: 'Import failed: Resolve added no clips. Make sure a project is open in Resolve.',
        };
      }
      return { clip, reused: false };
    } catch (err) {
      binIndex = null;
      return { ok: false, kind: 'bridge-error', message: `Resolve API call failed: ${msg(err)}.` };
    }
  }

  const importedOk = (): TransferResult => ({
    ok: true,
    kind: 'imported',
    importedCount: 1,
    message: 'Imported 1 clip to the Media Pool.',
  });

  async function importToMediaPoolTransaction(filePath: string, targetBin: TargetBin): Promise<TransferResult> {
    const pristine = takePristine?.(filePath) ?? null;
    const r = await resolveResolve();
    if ('error' in r) return r.error;
    try {
      const project = await currentProject(r.resolve);
      if (!project) {
        binIndex = null;
        return { ok: false, kind: 'no-project', message: 'No project is open in Resolve. Open a project, then retry.' };
      }
      const checkDestination = await captureDestination(r.resolve, project);
      const mediaPool = await (project as ProjectLike).GetMediaPool();
      if (!mediaPool) {
        binIndex = null;
        return { ok: false, kind: 'bridge-error', message: 'Resolve returned no MediaPool object.' };
      }
      const ctx = await openTargetContext(mediaPool, targetBin, checkDestination);
      if ('error' in ctx) { binIndex = null; return ctx.error; }
      try {
        const imported = await importClip(r.resolve, filePath, { project, folder: ctx.folder, pristine, check: ctx.check });
        if (!('clip' in imported)) return imported;
        await rememberImportedClip(project, ctx.folder, filePath, imported.clip);
        const changed = await ctx.check();
        // A successful native import cannot be undone by a later check. Only
        // reuse (which has not mutated Resolve) can still fail revalidation.
        if (!imported.reused) return changed ? {
          ...importedOk(), message: 'Imported 1 clip to the captured Media Pool bin. Resolve destination changed after the import.',
        } : importedOk();
        if (changed) return changed;
        if (!trustedPath(filePath)) return trustedPathFailure();
        return {
          ok: true,
          kind: 'already-imported',
          message: `Already imported to the ${ctx.binLabel} bin — using the existing clip.`,
        };
      } finally {
        await ctx.restore();
      }
    } catch (err) {
      binIndex = null;
      return { ok: false, kind: 'bridge-error', message: `Resolve API call failed: ${msg(err)}.` };
    }
  }

  async function addToTimelineTransaction(filePath: string, targetBin: TargetBin, placement: TimelinePlacement, automation?: TimelineAutomation): Promise<TransferResult> {
    const pristine = takePristine?.(filePath) ?? null;
    const r = await resolveResolve();
    if ('error' in r) return r.error;
    try {
      const resolve = r.resolve as ResolveLike;

      // Verify the current project and timeline exist before importing anything.
      const pm = await resolve.GetProjectManager();
      const project = pm ? await (pm as ProjectManagerLike).GetCurrentProject() : null;
      if (!project) {
        binIndex = null;
        return { ok: false, kind: 'no-project', message: 'No project is open in Resolve. Open a project, then retry.' };
      }
      const timeline = await (project as ProjectLike).GetCurrentTimeline();
      if (!timeline) {
        return {
          ok: false,
          kind: 'no-timeline',
          message: 'The current project has no active timeline. Open a timeline, then retry.',
        };
      }
      const checkDestination = await captureDestination(resolve, project, timeline);
      const mediaPool = await (project as ProjectLike).GetMediaPool();
      if (!mediaPool) {
        binIndex = null;
        return { ok: false, kind: 'bridge-error', message: 'Resolve returned no MediaPool object.' };
      }

      // Resolve the destination bin; reuse an existing clip there, otherwise self-import.
      const ctx = await openTargetContext(mediaPool, targetBin, checkDestination);
      if ('error' in ctx) { binIndex = null; return ctx.error; }
      try {
        const imported = await importClip(resolve, filePath, { project, folder: ctx.folder, pristine, check: ctx.check });
        if (!('clip' in imported)) return imported;
        const clip = imported.clip;
        await rememberImportedClip(project, ctx.folder, filePath, clip);

        if (placement === 'playhead') {
          const unsupported = (message: string): TransferResult => ({ ok: false, kind: 'playhead-unsupported', message });
          try {
            if (typeof resolve.OpenPage !== 'function' || typeof (clip as ClipLike).GetClipProperty !== 'function' ||
              typeof (timeline as TimelineLike).GetStartFrame !== 'function' || typeof (timeline as TimelineLike).GetStartTimecode !== 'function' ||
              typeof (timeline as TimelineLike).GetCurrentTimecode !== 'function' || typeof (timeline as TimelineLike).GetSetting !== 'function') {
              return unsupported('Playhead insertion is unsupported by this Resolve API version.');
            }
            const openResult = await resolve.OpenPage('edit');
            if (openResult === false || openResult === null) return unsupported('Could not open Resolve’s Edit page for playhead insertion.');
            const frames = Number(await (clip as ClipLike).GetClipProperty('Frames'));
            const rawTimelineStartFrame = await (timeline as TimelineLike).GetStartFrame();
            const timelineStartFrame = typeof rawTimelineStartFrame === 'number' || (typeof rawTimelineStartFrame === 'string' && rawTimelineStartFrame.trim() !== '') ? Number(rawTimelineStartFrame) : NaN;
            const startTimecode = await (timeline as TimelineLike).GetStartTimecode();
            const currentTimecode = await (timeline as TimelineLike).GetCurrentTimecode();
            const frameRate = await timelineFrameRate(project, timeline);
            if (!Number.isInteger(frames) || frames <= 0 || !Number.isInteger(timelineStartFrame)) {
              return unsupported('Resolve returned invalid clip or timeline frame data for playhead insertion.');
            }
            const start = timecodeToFrames(startTimecode, frameRate);
            const current = timecodeToFrames(currentTimecode, frameRate);
            if (!start || !current || start.dropFrame !== current.dropFrame || current.frames < start.frames) {
              return unsupported('Resolve returned unsupported or invalid timeline timecode for playhead insertion.');
            }
            const recordFrame = timelineStartFrame + current.frames - start.frames;
            if (!Number.isInteger(recordFrame) || !Number.isFinite(recordFrame) || recordFrame < timelineStartFrame) {
              return unsupported('Resolve returned an invalid playhead frame for insertion.');
            }
            let appended: unknown;
            try {
              const changed = await ctx.check();
              if (changed) return changed;
              if (!trustedPath(filePath)) return trustedPathFailure();
              appended = await (mediaPool as MediaPoolLike).AppendToTimeline([{ mediaPoolItem: clip, startFrame: 0, endFrame: frames - 1, recordFrame }]);
            } catch (err) {
              return { ok: false, kind: 'append-failed', message: `Append to timeline failed: ${msg(err)}.` };
            }
            const items = appendedItems(appended);
            if (!items) {
              return { ok: false, kind: 'append-failed', message: 'Append to timeline failed: Resolve returned no usable appended clips.' };
            }
            const warning = await applyAutomation(project, timeline, clip, automation ? await itemStart(items[0]) : null, ctx.check, automation);
            return timelineSuccess('playhead', warning, automation);
          } catch (err) {
            return unsupported(`Playhead insertion is unsupported: ${msg(err)}.`);
          }
        }

        let appended: unknown;
        try {
          const changed = await ctx.check();
          if (changed) return changed;
          if (!trustedPath(filePath)) return trustedPathFailure();
          appended = await (mediaPool as MediaPoolLike).AppendToTimeline([clip]);
        } catch (err) {
          return { ok: false, kind: 'append-failed', message: `Append to timeline failed: ${msg(err)}.` };
        }
        const items = appendedItems(appended);
        if (!items) {
          return { ok: false, kind: 'append-failed', message: 'Append to timeline failed: Resolve returned no usable appended clips.' };
        }
        const warning = await applyAutomation(project, timeline, clip, automation ? await itemStart(items[0]) : null, ctx.check, automation);
        return timelineSuccess('end', warning, automation);
      } finally {
        await ctx.restore();
      }
    } catch (err) {
      binIndex = null;
      return { ok: false, kind: 'bridge-error', message: `Resolve API call failed: ${msg(err)}.` };
    }
  }

  let transferTail: Promise<void> = Promise.resolve();
  function enqueueTransfer(transaction: () => Promise<TransferResult>): Promise<TransferResult> {
    const result = transferTail.then(transaction);
    transferTail = result.then(() => undefined, () => undefined);
    return result;
  }

  const MAX_OPERATION_CACHE = 128;
  const operationCache = new Map<string, Promise<TransferResult>>();
  const operationCacheSettled = new Set<string>();
  function operationCacheKey(operationId: string, filePath: string, targetBin: string, placement?: string): string {
    return `${operationId}\u0000${filePath}\u0000${targetBin}\u0000${placement ?? ''}`;
  }
  function evictOperationCacheIfNeeded(): void {
    while (operationCacheSettled.size > MAX_OPERATION_CACHE) {
      let toEvict: string | null = null;
      for (const k of operationCache.keys()) {
        if (operationCacheSettled.has(k)) { toEvict = k; break; }
      }
      if (!toEvict) break;
      operationCache.delete(toEvict);
      operationCacheSettled.delete(toEvict);
    }
  }
  function trackOperationCacheEntry(key: string, promise: Promise<TransferResult>): void {
    promise.then(
      (result) => {
        if (operationCache.get(key) !== promise) return;
        if (result && typeof result === 'object' && (result as TransferResult).ok === false) {
          operationCache.delete(key);
          operationCacheSettled.delete(key);
        } else {
          operationCacheSettled.add(key);
          evictOperationCacheIfNeeded();
        }
      },
      () => {
        if (operationCache.get(key) === promise) {
          operationCache.delete(key);
          operationCacheSettled.delete(key);
        }
      },
    );
  }

  function importToMediaPool(filePath: string, targetBin: TargetBin, operationId?: string): Promise<TransferResult> {
    if (typeof operationId === 'string' && operationId.length > 0) {
      const key = operationCacheKey(operationId, filePath, targetBin);
      if (operationCache.has(key)) {
        const cached = operationCache.get(key)!;
        operationCache.delete(key);
        operationCache.set(key, cached);
        return cached;
      }
      const promise = enqueueTransfer(() => importToMediaPoolTransaction(filePath, targetBin));
      operationCache.set(key, promise);
      trackOperationCacheEntry(key, promise);
      evictOperationCacheIfNeeded();
      return promise;
    }
    return enqueueTransfer(() => importToMediaPoolTransaction(filePath, targetBin));
  }

  function addToTimeline(filePath: string, targetBin: TargetBin, placement: TimelinePlacement, automation?: TimelineAutomation, operationId?: string): Promise<TransferResult> {
    let actualAutomation: TimelineAutomation | undefined = automation;
    let actualOpId: string | undefined = operationId;
    if (typeof automation === 'string' && operationId === undefined) {
      actualOpId = automation as unknown as string;
      actualAutomation = undefined;
    }
    if (typeof actualOpId === 'string' && actualOpId.length > 0) {
      const key = operationCacheKey(actualOpId, filePath, targetBin, placement);
      if (operationCache.has(key)) {
        const cached = operationCache.get(key)!;
        operationCache.delete(key);
        operationCache.set(key, cached);
        return cached;
      }
      const promise = enqueueTransfer(() => addToTimelineTransaction(filePath, targetBin, placement, actualAutomation));
      operationCache.set(key, promise);
      trackOperationCacheEntry(key, promise);
      evictOperationCacheIfNeeded();
      return promise;
    }
    return enqueueTransfer(() => addToTimelineTransaction(filePath, targetBin, placement, actualAutomation));
  }

  return { importToMediaPool, addToTimeline, noteResolveQuit };
}
