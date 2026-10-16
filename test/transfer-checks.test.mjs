import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('bin import, duplicates, restoration, timeline and playhead frames', async (t) => {
  const { createTransfer, timecodeToFrames } = await import(path.join(dist, 'transfer.js'));

  // Phase 5 slice 2 TDD: playhead timecode conversion must exist before insertion.
  expect('transfer: exports timecodeToFrames', typeof timecodeToFrames, 'function');

  // Fake Resolve graph. Every call the transfer logic makes is recorded on o.calls so
  // the exact call-chain (docs chain, folder ops, restore) can be asserted.
  const makeClip = (o, entry) => (typeof entry === 'string'
    ? { GetClipProperty: async (property) => { o.calls.push(`GetClipProperty(${property})`); return property === 'File Path' ? entry : null; } }
    : entry);

  const makeFolder = (o, name, clips = []) => {
    const sub = [];
    return {
      name,
      GetName: async () => { o.calls.push(`GetName(${name})`); return name; },
      GetSubFolderList: async () => { o.calls.push('GetSubFolderList()'); return [...sub]; },
      GetClipList: async () => {
        o.calls.push('GetClipList()');
        if (o.scanThrows) throw new Error('scan boom');
        return clips.map((clip) => makeClip(o, clip));
      },
      addSub: (child) => sub.push(child),
    };
  };

  const makeTransferMediaPool = (o) => {
    const root = makeFolder(o, 'Root');
    for (const entry of o.existingFolders ?? []) {
      const [name, clips] = typeof entry === 'string' ? [entry, []] : [entry.name, entry.clips ?? []];
      root.addSub(makeFolder(o, name, clips));
    }
    const current = makeFolder(o, o.currentName ?? 'Current Folder', o.clips ?? []);
    let activeFolder = current;
    return {
      GetCurrentFolder: async () => { o.calls.push('GetCurrentFolder()'); return o.currentFolder === false ? null : activeFolder; },
      GetRootFolder: async () => { o.calls.push('GetRootFolder()'); return o.rootFolder === false ? null : root; },
      AddSubFolder: async (parent, name) => {
        o.calls.push(`AddSubFolder(${name})`);
        if (o.addSubFolderThrows) throw new Error('addsub boom');
        if (o.addSubFolderResult === false) return null;
        const created = makeFolder(o, name);
        if (parent && typeof parent.addSub === 'function') parent.addSub(created);
        return created;
      },
      SetCurrentFolder: async (target) => {
        o.calls.push(`SetCurrentFolder(${target.name})`);
        if (o.setCurrentFolderThrows) throw new Error('setfolder boom');
        if (o.setCurrentFolderNull) return null;
        if (o.setCurrentFolderResult === false) return false;
        activeFolder = target;
        return true;
      },
      AppendToTimeline: async (clips) => {
        o.appendArgs = clips;
        o.calls.push(`AppendToTimeline(${clips.length})`);
        if (o.appendThrows) throw new Error('append boom');
        if (o.appendResult !== undefined) return o.appendResult;
        return o.appendEmpty ? [] : [{ GetStart: async () => { o.calls.push('TimelineItem.GetStart()'); return clips[0]?.recordFrame ?? (o.endFrame ?? -1) + 1; } }];
      },
    };
  };

  const makeTransferResolve = (o = {}) => ({
    ...(o.noOpenPage ? {} : { OpenPage: async (page) => {
      o.calls.push(`OpenPage(${page})`);
      if (o.openPageThrows) throw new Error('open page boom');
      return o.openPageResult;
    } }),
    GetMediaStorage: async () => (o.storage === false ? null : {
      AddItemListToMediaPool: async (paths) => {
        o.calls.push(`AddItemListToMediaPool(${JSON.stringify(paths)})`);
        if (o.importThrows) throw new Error('import boom');
        if (o.importResult !== undefined) return o.importResult;
        return o.importEmpty ? [] : [{ MediaType: 'Video' }];
      },
    }),
    GetProjectManager: async () => {
      o.calls.push('GetProjectManager()');
      return {
        GetCurrentProject: async () => {
          o.calls.push('GetCurrentProject()');
          if (o.noProject) return null;
          return {
            GetUniqueId: () => 'project',
            GetCurrentTimeline: async () => {
              o.calls.push('GetCurrentTimeline()');
              return o.noTimeline ? null : {
                GetUniqueId: () => 'timeline',
                ...(o.noFrameRateApi ? {} : { GetSetting: async setting => { if (o.frameRateThrows) throw new Error('rate boom'); return setting === 'timelineFrameRate' ? (o.frameRate ?? '24') : '1'; } }),
                GetName: async () => 'TL-1',
                ...(o.noStartFrame ? {} : { GetStartFrame: async () => { o.calls.push('GetStartFrame()'); if (o.startFrameThrows) throw new Error('start frame boom'); return o.startFrame ?? 0; } }),
                ...(o.noStartTimecode ? {} : { GetStartTimecode: async () => { o.calls.push('GetStartTimecode()'); if (o.startTimecodeThrows) throw new Error('start tc boom'); return o.startTimecode ?? '00:00:00:00'; } }),
                ...(o.noCurrentTimecode ? {} : { GetCurrentTimecode: async () => { o.calls.push('GetCurrentTimecode()'); if (o.currentTimecodeThrows) throw new Error('current tc boom'); return o.currentTimecode ?? '00:00:01:00'; } }),
                ...(o.endFrame === undefined ? {} : { GetEndFrame: async () => { o.calls.push('GetEndFrame()'); return o.endFrame; } }),
                ...(o.markers === undefined ? {} : { AddMarker: async (...args) => { o.calls.push('AddMarker()'); o.markerArgs.push(args); return true; } }),
              };
            },
            ...(o.noFrameRateApi ? {} : { GetSetting: async (setting) => { o.calls.push(`GetSetting(${setting})`); if (o.frameRateThrows) throw new Error('rate boom'); return setting === 'timelineFrameRate' ? (o.frameRate ?? '24') : null; } }),
            GetMediaPool: async () => {
              o.calls.push('GetMediaPool()');
              return o.mediaPool === false ? null : makeTransferMediaPool(o);
            },
          };
        },
      };
    },
  });

  const makeTransferWI = (o = {}) => {
    const calls = o.calls ?? [];
    const state = { ...o, calls, markerArgs: o.markerArgs ?? [] };
    return {
      calls,
      state,
      Initialize: async () => {
        calls.push('Initialize()');
        return state.initResult ?? true;
      },
      GetResolve: async () => {
        calls.push('GetResolve()');
        if (state.resolveThrows) throw new Error('resolve boom');
        return state.resolve === false ? null : makeTransferResolve(state);
      },
    };
  };

  // 1. MEDIA POOL IMPORT SUCCESS (active bin) — docs chain plus a current-folder scan.
  {
    const wi = makeTransferWI({});
    const r = await createTransfer(wi, 'com.clipdock.app').importToMediaPool('/tmp/sample.mp4', 'active');
    expect('transfer: import success result', r,
      { ok: true, kind: 'imported', importedCount: 1, message: 'Imported 1 clip to the Media Pool.' });
    expect('transfer: import calls the docs chain (with current-folder scan)',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetMediaPool()|GetCurrentFolder()|GetClipList()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|AddItemListToMediaPool(["/tmp/sample.mp4"])|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()');
    expect('transfer: active bin never SetCurrentFolder/AddSubFolder',
      wi.calls.some((call) => call.startsWith('SetCurrentFolder') || call.startsWith('AddSubFolder')), false);
  }

  // 2. ACTIVE BIN DUPLICATE — exact source-path match in the current folder skips the import.
  {
    const wi = makeTransferWI({ clips: ['/tmp/sample.mp4'] });
    const r = await createTransfer(wi, 'com.clipdock.app').importToMediaPool('/tmp/sample.mp4', 'active');
    expect('transfer: active duplicate -> already-imported', r,
      { ok: true, kind: 'already-imported', message: 'Already imported to the Active bin — using the existing clip.' });
    expect('transfer: duplicate skips AddItemListToMediaPool',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetMediaPool()|GetCurrentFolder()|GetClipList()|GetClipProperty(File Path)|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()');
  }

  // 3. ACTIVE BIN SCAN FALLBACK — GetClipList throwing, missing GetClipProperty, or an
  //    unavailable current folder must never block the existing import.
  {
    const scanThrow = await createTransfer(makeTransferWI({ scanThrows: true }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: active GetClipList throw falls back to import', scanThrow.kind, 'imported');
    const noProp = await createTransfer(makeTransferWI({ clips: [{ MediaType: 'Video' }] }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: active missing GetClipProperty falls back to import', noProp.kind, 'imported');
    const noFolder = await createTransfer(makeTransferWI({ currentFolder: false }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: active no current folder falls back to import', noFolder.kind, 'imported');
    const noProjActive = await createTransfer(makeTransferWI({ noProject: true }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: active no project rejects an unbound import', noProjActive.kind, 'no-project');
  }

  // 4. CLIPDOCK BIN — existing folder reuse; import lands after SetCurrentFolder; restore runs.
  {
    const wi = makeTransferWI({ existingFolders: ['ClipDock'] });
    const r = await createTransfer(wi, 'com.clipdock.app').importToMediaPool('/tmp/sample.mp4', 'clipdock');
    expect('transfer: clipdock reuse import success result', r,
      { ok: true, kind: 'imported', importedCount: 1, message: 'Imported 1 clip to the Media Pool.' });
    expect('transfer: clipdock reuse chain (SetCurrentFolder then import, then restore)',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetMediaPool()|GetCurrentFolder()|GetRootFolder()|GetSubFolderList()|GetName(ClipDock)|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(ClipDock)|GetClipList()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|AddItemListToMediaPool(["/tmp/sample.mp4"])|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(Current Folder)');
  }

  // 5. CLIPDOCK BIN — absent folder is created exactly once.
  {
    const wi = makeTransferWI({});
    const r = await createTransfer(wi, 'com.clipdock.app').importToMediaPool('/tmp/sample.mp4', 'clipdock');
    expect('transfer: clipdock absent create result', r.kind, 'imported');
    expect('transfer: clipdock creates bin once then imports',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetMediaPool()|GetCurrentFolder()|GetRootFolder()|GetSubFolderList()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|AddSubFolder(ClipDock)|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(ClipDock)|GetClipList()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|AddItemListToMediaPool(["/tmp/sample.mp4"])|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(Current Folder)');
    expect('transfer: clipdock AddSubFolder called once', wi.calls.filter((call) => call.startsWith('AddSubFolder')).length, 1);
  }

  // 6. CLIPDOCK BIN DUPLICATE — Windows slash normalization in the ClipDock folder skips the import.
  {
    const wi = makeTransferWI({ existingFolders: [{ name: 'ClipDock', clips: ['C:\\Videos\\sample.mp4'] }] });
    const r = await createTransfer(wi, 'com.clipdock.app', 'win32').importToMediaPool('C:/Videos/sample.mp4', 'clipdock');
    expect('transfer: clipdock duplicate -> already-imported', r,
      { ok: true, kind: 'already-imported', message: 'Already imported to the ClipDock bin — using the existing clip.' });
    expect('transfer: clipdock duplicate scans only the target bin and skips import',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetMediaPool()|GetCurrentFolder()|GetRootFolder()|GetSubFolderList()|GetName(ClipDock)|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(ClipDock)|GetClipList()|GetClipProperty(File Path)|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetProjectManager()|GetCurrentProject()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|SetCurrentFolder(Current Folder)');
  }

  // 7. CLIPDOCK RESTORE — previous current folder is restored on success, on import throw, and on duplicate.
  {
    const miss = await createTransfer(makeTransferWI({ existingFolders: [{ name: 'ClipDock', clips: ['/tmp/other.mp4'] }] }), 'x').importToMediaPool('/tmp/sample.mp4', 'clipdock');
    expect('transfer: clipdock non-matching clip still imports', miss.kind, 'imported');
    const wiThrow = makeTransferWI({ existingFolders: ['ClipDock'], importThrows: true });
    const throwImport = await createTransfer(wiThrow, 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: clipdock import throw -> import-failed', throwImport.kind, 'import-failed');
    expect('transfer: clipdock restores folder after import throw',
      wiThrow.calls.filter(call => call.startsWith('GetCurrentFolder(') || call.startsWith('SetCurrentFolder(')).slice(-2).join('|'), 'GetCurrentFolder()|SetCurrentFolder(Current Folder)');
    const wiDup = makeTransferWI({ existingFolders: [{ name: 'ClipDock', clips: ['/tmp/a.mp4'] }] });
    const dup = await createTransfer(wiDup, 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: clipdock restores folder after duplicate hit', wiDup.calls.filter(call => call.startsWith('GetCurrentFolder(') || call.startsWith('SetCurrentFolder(')).slice(-2).join('|'), 'GetCurrentFolder()|SetCurrentFolder(Current Folder)');
  }

  // 8. CLIPDOCK CONTROLLED FAILURES — SetCurrentFolder / AddSubFolder / root failures are bin-error.
  {
    const setFail = await createTransfer(makeTransferWI({ existingFolders: ['ClipDock'], setCurrentFolderResult: false }), 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: SetCurrentFolder false -> bin-error', [setFail.ok, setFail.kind, setFail.message.includes('switch')], [false, 'bin-error', true]);
    const setNull = await createTransfer(makeTransferWI({ existingFolders: ['ClipDock'], setCurrentFolderNull: true }), 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: SetCurrentFolder null -> bin-error', [setNull.ok, setNull.kind], [false, 'bin-error']);
    const addFail = await createTransfer(makeTransferWI({ addSubFolderResult: false }), 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: AddSubFolder failure -> bin-error', [addFail.ok, addFail.kind, addFail.message.includes('create')], [false, 'bin-error', true]);
    const rootFail = await createTransfer(makeTransferWI({ rootFolder: false }), 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: no root folder -> bin-error', rootFail.kind, 'bin-error');
    const noProjClip = await createTransfer(makeTransferWI({ noProject: true }), 'x').importToMediaPool('/tmp/a.mp4', 'clipdock');
    expect('transfer: clipdock no project -> no-project', noProjClip.kind, 'no-project');
  }

  // 9. ADD TO TIMELINE SUCCESS (active bin) — verifies project + timeline, self-imports, appends.
  {
    const wi = makeTransferWI({});
    const r = await createTransfer(wi, 'com.clipdock.app').addToTimeline('/tmp/clip.mov', 'active');
    expect('transfer: timeline success result', r,
      { ok: true, kind: 'timeline-appended', message: 'Added to the active timeline.' });
    expect('transfer: timeline does its own import then appends',
      wi.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetMediaPool()|GetCurrentFolder()|GetClipList()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|AddItemListToMediaPool(["/tmp/clip.mov"])|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|AppendToTimeline(1)|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()');
    expect('transfer: end placement preserves raw clip append object', wi.state.appendArgs, [{ MediaType: 'Video' }]);
  }

  // 10. TIMELINE DUPLICATE — an existing clip in the target bin is appended without re-importing.
  {
    const wiClipdock = makeTransferWI({ existingFolders: [{ name: 'ClipDock', clips: ['/tmp/clip.mov'] }] });
    const clipdock = await createTransfer(wiClipdock, 'x').addToTimeline('/tmp/clip.mov', 'clipdock');
    expect('transfer: timeline duplicate still appends (clipdock)', [clipdock.ok, clipdock.kind], [true, 'timeline-appended']);
    expect('transfer: timeline duplicate skips import (clipdock)',
      wiClipdock.calls.join('|'),
      'Initialize()|GetResolve()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetMediaPool()|GetCurrentFolder()|GetRootFolder()|GetSubFolderList()|GetName(ClipDock)|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|SetCurrentFolder(ClipDock)|GetClipList()|GetClipProperty(File Path)|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|AppendToTimeline(1)|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|GetCurrentFolder()|GetProjectManager()|GetCurrentProject()|GetCurrentTimeline()|SetCurrentFolder(Current Folder)');
    const wiActive = makeTransferWI({ clips: ['/tmp/a.mp4'] });
    const active = await createTransfer(wiActive, 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: timeline duplicate still appends (active)', [active.ok, active.kind, wiActive.calls.includes('AddItemListToMediaPool(["/tmp/a.mp4"])')], [true, 'timeline-appended', false]);
  }

  // 11. NO PROJECT / NO TIMELINE / BRIDGE ERRORS.
  {
    const noProj = await createTransfer(makeTransferWI({ noProject: true }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: timeline no-project result', noProj,
      { ok: false, kind: 'no-project', message: 'No project is open in Resolve. Open a project, then retry.' });

    const noTl = await createTransfer(makeTransferWI({ noTimeline: true }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: timeline no-timeline result', noTl,
      { ok: false, kind: 'no-timeline', message: 'The current project has no active timeline. Open a timeline, then retry.' });

    const noResolve = await createTransfer(makeTransferWI({ resolve: false }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: GetResolve null -> bridge-error', noResolve,
      { ok: false, kind: 'bridge-error', message: 'GetResolve returned no Resolve object.' });

    const initFail = await createTransfer(makeTransferWI({ initResult: false }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: Initialize false -> bridge-error', initFail.kind, 'bridge-error');

    const resolveThrows = await createTransfer(makeTransferWI({ resolveThrows: true }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: GetResolve throw -> bridge-error', resolveThrows.kind, 'bridge-error');
  }

  // 12. IMPORT FAILED — AddItemListToMediaPool null / empty / throw all map to import-failed.
  {
    const nullRes = await createTransfer(makeTransferWI({ importResult: null }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: import null -> import-failed', nullRes.kind, 'import-failed');
    const emptyRes = await createTransfer(makeTransferWI({ importEmpty: true }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: import empty array -> import-failed', emptyRes.kind, 'import-failed');
    const throwRes = await createTransfer(makeTransferWI({ importThrows: true }), 'x').importToMediaPool('/tmp/a.mp4', 'active');
    expect('transfer: import throw -> import-failed', throwRes.kind, 'import-failed');
    expect('transfer: import-failed message hints at project', throwRes.message.includes('project'), true);

    const viaTimeline = await createTransfer(makeTransferWI({ importThrows: true }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: timeline self-import failure -> import-failed', viaTimeline.kind, 'import-failed');
  }

  // 13. APPEND FAILED — AppendToTimeline null / empty / throw all map to append-failed.
  {
    const nullRes = await createTransfer(makeTransferWI({ appendResult: null }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: append null -> append-failed', nullRes.kind, 'append-failed');
    const emptyRes = await createTransfer(makeTransferWI({ appendEmpty: true }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: append empty array -> append-failed', emptyRes.kind, 'append-failed');
    const throwRes = await createTransfer(makeTransferWI({ appendThrows: true }), 'x').addToTimeline('/tmp/a.mp4', 'active');
    expect('transfer: append throw -> append-failed', throwRes.kind, 'append-failed');
    expect('transfer: append-failed message carries the cause', throwRes.message.includes('append boom'), true);
  }

  // ---- 4c2. Phase 5 slice 2: playhead timecode and official clipInfo insertion ----
  {
    const frames = (tc, rate) => timecodeToFrames(tc, rate)?.frames;
    expect('transfer: 24fps timecode frames', frames('01:02:03:04', '24'), 89356);
    expect('transfer: 25fps timecode frames', frames('00:00:01:00', '25'), 25);
    expect('transfer: 29.97 DF timecode frames', frames('00:01:00;02', '29.97'), 1800);
    expect('transfer: 59.94 DF timecode frames', frames('00:01:00;04', '59.94DF'), 3600);
    expect('transfer: 10-minute DF boundary', [frames('00:10:00;00', '29.97'), frames('00:10:00;00', '59.94DF')], [17982, 35964]);
    expect('transfer: semicolon signals DF', frames('00:00:01;00', '29.97'), 30);
    expect('transfer: invalid timecode/rate rejected', [timecodeToFrames('00:00:00:24', '24'), timecodeToFrames('00:60:00:00', '24'), timecodeToFrames('00:00:00;00', '24')], [null, null, null]);
    expect('transfer: skipped DF labels rejected outside tenth minutes', [timecodeToFrames('00:01:00;00', '29.97'), timecodeToFrames('00:01:00;01', '29.97 DF'), timecodeToFrames('00:01:00;03', '59.94 DF')], [null, null, null]);
  }
  {
    const calls = [];
    const clip = { GetClipProperty: async (property) => { calls.push(`GetClipProperty(${property})`); return property === 'File Path' ? '/tmp/playhead.mov' : property === 'Frames' ? '48' : null; } };
    const wi = makeTransferWI({ calls, clips: [clip], startFrame: '1000', startTimecode: '01:00:00:00', currentTimecode: '01:00:02:00', frameRate: '24' });
    const r = await createTransfer(wi, 'x').addToTimeline('/tmp/playhead.mov', 'active', 'playhead');
    expect('transfer: playhead insertion result', r, { ok: true, kind: 'timeline-inserted', message: 'Added at the playhead.' });
    expect('transfer: playhead exact official clipInfo', wi.calls.includes('AppendToTimeline(1)') && wi.state.appendArgs, [{ mediaPoolItem: clip, startFrame: 0, endFrame: 47, recordFrame: 1048 }]);
    expect('transfer: playhead opens Edit before current timecode', calls.indexOf('GetClipProperty(Frames)') > -1 && wi.calls.indexOf('OpenPage(edit)') < wi.calls.indexOf('GetCurrentTimecode()'), true);
    expect('transfer: playhead duplicate skips import', wi.calls.includes('AddItemListToMediaPool(["/tmp/playhead.mov"])'), false);
  }
  {
    const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const automation = { provider: 'youtube', source, selection: { start: 10, end: 20, label: 'Chapter range' }, chapters: [{ start: 2, end: 5, title: 'Outside' }, { start: 12, end: 14, title: 'Inside' }] };
    const colors = [];
    const clip = { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/markers.mov' : property === 'Frames' ? '240' : null, SetClipColor: async (color) => { colors.push(color); return true; } };
    const playhead = makeTransferWI({ clips: [clip], startFrame: 1000, startTimecode: '00:00:00:00', currentTimecode: '00:00:02:00', frameRate: '24', markers: true });
    const playheadResult = await createTransfer(playhead, 'x').addToTimeline('/tmp/markers.mov', 'active', 'playhead', automation);
    expect('transfer: playhead marker uses appended base, FPS offset, source and original timestamp', [playheadResult.ok, playhead.state.markerArgs, colors], [true, [[96, 'Yellow', 'Inside', `${source} · original 12.000s`, 1]], ['Yellow']]);
    colors.length = 0;
    const end = makeTransferWI({ clips: [clip], frameRate: '24', markers: true, endFrame: 1099 });
    const endResult = await createTransfer(end, 'x').addToTimeline('/tmp/markers.mov', 'active', 'end', automation);
    expect('transfer: timeline-end marker uses returned item start', [endResult.ok, end.state.markerArgs, colors, end.calls.indexOf('TimelineItem.GetStart()') > end.calls.indexOf('AppendToTimeline(1)')], [true, [[1148, 'Yellow', 'Inside', `${source} · original 12.000s`, 1]], ['Yellow'], true]);
    colors.length = 0;
    const pexelsAutomation = { provider: 'pexels', source: 'https://www.pexels.com/video/1/', selection: null, chapters: [] };
    await createTransfer(makeTransferWI({ clips: [clip] }), 'x').addToTimeline('/tmp/markers.mov', 'active', 'end', pexelsAutomation);
    expect('transfer: deterministic provider/range colors distinguish Pexels', colors, ['Teal']);
    colors.length = 0;
    const socialAutomation = { provider: 'social', source: 'https://www.instagram.com/reel/ABC_def-123', selection: null, chapters: [{ start: 1, end: 2, title: 'Must not become a marker' }] };
    const socialTransfer = makeTransferWI({ clips: [clip], markers: true });
    await createTransfer(socialTransfer, 'x').addToTimeline('/tmp/markers.mov', 'active', 'end', socialAutomation);
    expect('transfer: Social automation never creates chapter markers', [colors, socialTransfer.state.markerArgs], [['Blue'], []]);
    // Resolve's AddMarker accepts only its marker palette (verified live with
    // `npm run test:resolve:e2e`: Orange/Teal are refused, Yellow/Blue accepted).
    const RESOLVE_MARKER_COLORS = ['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia', 'Rose', 'Lavender', 'Sky', 'Mint', 'Lemon', 'Sand', 'Cocoa', 'Cream'];
    colors.length = 0;
    const fullVideo = makeTransferWI({ clips: [clip], frameRate: '24', markers: true });
    await createTransfer(fullVideo, 'x').addToTimeline('/tmp/markers.mov', 'active', 'end', { ...automation, selection: null });
    expect('transfer: full-video YouTube chapters use Resolve marker colours', [colors, fullVideo.state.markerArgs.map((args) => RESOLVE_MARKER_COLORS.includes(args[1]))], [['Orange'], [true, true]]);
  }
  {
    const cases = [
      { label: 'missing OpenPage', noOpenPage: true },
      { label: 'missing start frame API', noStartFrame: true },
      { label: 'missing start timecode API', noStartTimecode: true },
      { label: 'missing current timecode API', noCurrentTimecode: true },
      { label: 'missing frame rate API', noFrameRateApi: true },
      { label: 'missing Frames', clip: { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : null } },
      { label: 'bad start frame', clip: { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : '24' }, startFrame: 'bad' },
      { label: 'bad current tc', clip: { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : '24' }, currentTimecode: '00:00:00:24' },
      { label: 'negative delta', clip: { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : '24' }, startTimecode: '01:00:01:00', currentTimecode: '01:00:00:00' },
      { label: 'mismatched DF', clip: { GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : '24' }, startTimecode: '00:00:00;00', currentTimecode: '00:00:01:00', frameRate: '29.97' },
    ];
    for (const testCase of cases) {
      const wi = makeTransferWI({ ...testCase, clips: testCase.clip ? [testCase.clip] : [] });
      const r = await createTransfer(wi, 'x').addToTimeline('/tmp/a.mov', 'active', 'playhead');
      expect(`transfer: playhead ${testCase.label} is controlled`, [r.ok, r.kind, wi.calls.includes('AppendToTimeline(1)')], [false, 'playhead-unsupported', false]);
    }
    const appendThrow = makeTransferWI({ existingFolders: [{ name: 'ClipDock', clips: [{ GetClipProperty: async (property) => property === 'File Path' ? '/tmp/a.mov' : '24' }] }], appendThrows: true });
    const failed = await createTransfer(appendThrow, 'x').addToTimeline('/tmp/a.mov', 'clipdock', 'playhead');
    expect('transfer: playhead append throw remains append-failed', failed.kind, 'append-failed');
    expect('transfer: playhead append throw restores ClipDock', appendThrow.calls.filter(call => call.startsWith('GetCurrentFolder(') || call.startsWith('SetCurrentFolder(')).slice(-2).join('|'), 'GetCurrentFolder()|SetCurrentFolder(Current Folder)');
  }
});
