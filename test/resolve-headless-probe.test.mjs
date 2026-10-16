import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runProbe } from '../scripts/resolve-smoke/lib/probe.mjs';

/**
 * Deterministic probe.py tests — never a real Resolve. A fake `pgrep` (shell
 * script on PATH) feeds scripted PID sets, a fake DaVinciResolveScript module
 * fakes the scripting API (or fails to import / misbehaves), and a quit log
 * proves whether Quit() was actually invoked.
 *
 * Covers the ownership gate plus the documented exit contract:
 *   2 probe-import-failed, 3 connect-timeout, 4 probe-failed, 5 checks-failed.
 */

const PROBE_PATH = fileURLToPath(new URL('../scripts/resolve-smoke/probe.py', import.meta.url));

/**
 * Guards every mutating API: writes a sentinel file AND raises if ever
 * invoked. The sentinel proves the probe never calls a mutating method; a
 * raise would crash the probe run (exit 4/1), so a green/red exit plus an
 * absent sentinel is deterministic proof.
 */
const MUTATE_GUARD = [
  'import os',
  '',
  'def _forbidden(name):',
  '    def _f(*a, **k):',
  '        with open(os.environ.get("FAKE_MUTATE_LOG", "/dev/null"), "a") as f:',
  '            f.write(name + "\\n")',
  '        raise AssertionError("mutating API invoked: " + name)',
  '    return _f',
  '',
].join('\n');

/** Default fixture: no project open (project-scoped APIs report unavailable). */
const FAKE_BMD = [
  MUTATE_GUARD,
  'class _Storage(object):',
  '    AddItemListToMediaPool = _forbidden("mediaStorage.AddItemListToMediaPool")',
  '',
  'class _PM(object):',
  '    def GetProjectListInCurrentFolder(self):',
  '        return []',
  '    def GetCurrentProject(self):',
  '        return None',
  '',
  'class _Resolve(object):',
  '    def GetVersionString(self):',
  '        return "18.6.4"',
  '    def GetMediaStorage(self):',
  '        return _Storage()',
  '    def GetProjectManager(self):',
  '        return _PM()',
  '    OpenPage = _forbidden("resolve.OpenPage")',
  '    def Quit(self):',
  '        with open(os.environ.get("FAKE_QUIT_LOG", "/dev/null"), "a") as f:',
  '            f.write("quit\\n")',
  '        return True',
  '',
  'def scriptapp(name):',
  '    return _Resolve()',
  '',
].join('\n');

/**
 * Complete fixture: project + timeline + media pool + folder + one clip, with
 * every mutating API sentinel-guarded. Mirrors the surface src/transfer.ts
 * depends on (src/transfer.ts ResolveLike/MediaStorageLike/ProjectManagerLike/
 * ProjectLike/TimelineLike/MediaPoolLike/FolderLike/ClipLike duck types).
 */
const FAKE_FULL_BMD = [
  MUTATE_GUARD,
  'class _Clip(object):',
  '    def GetClipProperty(self, prop):',
  '        return "/tmp/sample.mov" if prop == "File Path" else "1234"',
  '    SetClipColor = _forbidden("clip.SetClipColor")',
  '',
  'class _Folder(object):',
  '    def GetUniqueId(self):',
  '        return "folder-id"',
  '    def GetName(self):',
  '        return "ClipDock"',
  '    def GetSubFolderList(self):',
  '        return []',
  '    def GetClipList(self):',
  '        return [_Clip()]',
  '',
  'class _Timeline(object):',
  '    def GetSetting(self, setting):',
  '        return "24" if setting == "timelineFrameRate" else "0"',
  '    def GetUniqueId(self):',
  '        return "timeline-id"',
  '    def GetName(self):',
  '        return "Timeline 1"',
  '    def GetStartFrame(self):',
  '        return 1000',
  '    def GetStartTimecode(self):',
  '        return "01:00:00:00"',
  '    def GetCurrentTimecode(self):',
  '        return "01:00:05:00"',
  '    AddMarker = _forbidden("timeline.AddMarker")',
  '    def GetEndFrame(self):',
  '        return 1535',
  '',
  'class _MediaPool(object):',
  '    def GetCurrentFolder(self):',
  '        return _Folder()',
  '    def GetRootFolder(self):',
  '        return _Folder()',
  '    AddSubFolder = _forbidden("mediaPool.AddSubFolder")',
  '    SetCurrentFolder = _forbidden("mediaPool.SetCurrentFolder")',
  '    AppendToTimeline = _forbidden("mediaPool.AppendToTimeline")',
  '',
  'class _Project(object):',
  '    def GetUniqueId(self):',
  '        return "project-id"',
  '    def GetName(self):',
  '        return "Untitled Project"',
  '    def GetMediaPool(self):',
  '        return _MediaPool()',
  '    def GetCurrentTimeline(self):',
  '        return _Timeline()',
  '    def GetSetting(self, setting):',
  '        return "23.976"',
  '',
  'class _Storage(object):',
  '    AddItemListToMediaPool = _forbidden("mediaStorage.AddItemListToMediaPool")',
  '',
  'class _PM(object):',
  '    def GetProjectListInCurrentFolder(self):',
  '        return []',
  '    def GetCurrentProject(self):',
  '        return _Project()',
  '',
  'class _Resolve(object):',
  '    def GetVersionString(self):',
  '        return "18.6.4"',
  '    def GetMediaStorage(self):',
  '        return _Storage()',
  '    def GetProjectManager(self):',
  '        return _PM()',
  '    OpenPage = _forbidden("resolve.OpenPage")',
  '    def Quit(self):',
  '        with open(os.environ.get("FAKE_QUIT_LOG", "/dev/null"), "a") as f:',
  '            f.write("quit\\n")',
  '        return True',
  '',
  'def scriptapp(name):',
  '    return _Resolve()',
  '',
].join('\n');

/** The full transfer.ts dependency surface the probe must report (required). */
const EXPECTED_REQUIRED = [
  'clip.GetClipProperty',
  'folder.GetClipList',
  'folder.GetName',
  'folder.GetUniqueId',
  'folder.GetSubFolderList',
  'mediaPool.AddSubFolder',
  'mediaPool.AppendToTimeline',
  'mediaPool.GetCurrentFolder',
  'mediaPool.GetRootFolder',
  'mediaPool.SetCurrentFolder',
  'mediaStorage.AddItemListToMediaPool',
  'project.GetCurrentTimeline',
  'project.GetMediaPool',
  'project.GetSetting',
  'project.GetUniqueId',
  'projectManager.GetCurrentProject',
  'resolve.GetMediaStorage',
  'resolve.GetProjectManager',
  'resolve.OpenPage',
  'timeline.GetCurrentTimecode',
  'timeline.GetStartFrame',
  'timeline.GetUniqueId',
  'timeline.GetSetting',
  'timeline.GetStartTimecode',
].sort();
/** Feature-detected by transfer.ts (markers/color/end-frame): recorded, not red. */
const EXPECTED_OPTIONAL = ['clip.SetClipColor', 'timeline.AddMarker', 'timeline.GetEndFrame'];

/** Builds a fixture dir with the fake pgrep + fake scripting module. */
function fixture({ pids, pgrepStatus = 0, quitLog, childPid, withChildPid = true, module = FAKE_BMD, mutateLog }) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  const bin = path.join(root, 'bin');
  const mods = path.join(root, 'mods');
  mkdirSync(bin, { recursive: true });
  mkdirSync(mods, { recursive: true });
  writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\necho "${pids}"\nexit ${pgrepStatus}\n`);
  chmodSync(path.join(bin, 'pgrep'), 0o755);
  writeFileSync(path.join(mods, 'DaVinciResolveScript.py'), module);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    PYTHONPATH: mods,
    FAKE_QUIT_LOG: quitLog,
    FAKE_MUTATE_LOG: mutateLog ?? path.join(root, 'mutate.log'),
  };
  if (withChildPid) {
    env.RESOLVE_SMOKE_CHILD_PID = String(childPid);
  }
  return { root, env };
}

async function run(python, env, mode, timeoutMs = 15000) {
  return runProbe({ python, probeScript: PROBE_PATH, env, timeoutMs, mode });
}

test('probe.py quits only when pgrep -x Resolve is exactly the harness child pid (quit-only)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 4242;
    const quitLog = path.join(root, 'quit.log');

    // Exact match: ownership proven, Quit() runs.
    let fx = fixture({ pids: String(childPid), quitLog, childPid });
    let result = await run('python3', fx.env, 'quit-only');
    assert.equal(result.ok, true);
    assert.equal(result.quitRequested, true);
    assert.equal(result.quitError, null);
    assert.equal(existsSync(quitLog), true);
    assert.match(readFileSync(quitLog, 'utf8'), /quit/);
    rmSync(fx.root, { recursive: true, force: true });

    // Foreign instance appeared (TOCTOU): Quit skipped, sanitized error.
    rmSync(quitLog, { force: true });
    fx = fixture({ pids: `${childPid} 9001`, quitLog, childPid });
    result = await run('python3', fx.env, 'quit-only');
    assert.equal(result.ok, true);
    assert.equal(result.quitRequested, false);
    assert.equal(result.quitError.code, 'quit-ownership-unproven');
    assert.equal(result.quitError.message.includes('9001'), true);
    assert.equal(result.quitError.message.includes(String(childPid)), true);
    assert.equal(existsSync(quitLog), false); // Quit() never called
    rmSync(fx.root, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py skips Quit when pgrep fails or the child pid env is missing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 5150;
    const quitLog = path.join(root, 'quit.log');

    // pgrep exits non-zero (other than 1): ownership unprovable.
    let fx = fixture({ pids: '', pgrepStatus: 2, quitLog, childPid });
    let result = await run('python3', fx.env, 'quit-only');
    assert.equal(result.quitRequested, false);
    assert.equal(result.quitError.code, 'quit-ownership-unproven');
    assert.equal(result.quitError.message.includes('pgrep'), true);
    assert.equal(existsSync(quitLog), false);
    rmSync(fx.root, { recursive: true, force: true });

    // Harness never passed the child pid: ownership unprovable, fail safe.
    fx = fixture({ pids: String(childPid), quitLog, childPid, withChildPid: false });
    result = await run('python3', fx.env, 'quit-only');
    assert.equal(result.quitRequested, false);
    assert.equal(result.quitError.code, 'quit-ownership-unproven');
    assert.equal(result.quitError.message.includes('RESOLVE_SMOKE_CHILD_PID'), true);
    assert.equal(existsSync(quitLog), false);
    rmSync(fx.root, { recursive: true, force: true });

    // No Resolve process at all: also unprovable (never quit blind).
    fx = fixture({ pids: '', pgrepStatus: 1, quitLog, childPid });
    result = await run('python3', fx.env, 'quit-only');
    assert.equal(result.quitRequested, false);
    assert.equal(result.quitError.code, 'quit-ownership-unproven');
    assert.equal(existsSync(quitLog), false);
    rmSync(fx.root, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py exits 2 with probe-import-failed when DaVinciResolveScript cannot be imported', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  let fx;
  try {
    // Module exists but raises at import time: deterministic regardless of
    // whether a real DaVinciResolveScript happens to be installed.
    fx = fixture({
      pids: '1',
      quitLog: path.join(root, 'quit.log'),
      childPid: 4242,
      module: 'raise RuntimeError("no DaVinciResolveScript here")\n',
    });
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'probe-import-failed');
    assert.match(result.error.message, /DaVinciResolveScript import failed/);
    assert.match(result.error.message, /no DaVinciResolveScript here/);
    assert.equal(result.error.message.includes('\n'), false); // sanitized single line
    assert.equal(result.quitRequested, false);
  } finally {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py exits 3 with connect-timeout when scriptapp never becomes reachable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  let fx;
  try {
    fx = fixture({
      pids: '1',
      quitLog: path.join(root, 'quit.log'),
      childPid: 4242,
      module: [
        'def scriptapp(name):',
        '    raise RuntimeError("app unreachable")',
        '',
      ].join('\n'),
    });
    const result = await run('python3', fx.env, 'probe', 1200);
    assert.equal(result.exitCode, 3);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'connect-timeout');
    assert.match(result.error.message, /did not become reachable/);
    assert.equal(result.quitRequested, false);
  } finally {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py exits 4 with probe-failed when a mid-check call raises', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  let fx;
  try {
    // Readiness gate is satisfied (PM list is a list) so polling breaks fast;
    // then GetCurrentProject() blows up mid-checks, which the gate never calls.
    fx = fixture({
      pids: '1',
      quitLog: path.join(root, 'quit.log'),
      childPid: 4242,
      module: [
        'class _PM(object):',
        '    def GetProjectListInCurrentFolder(self):',
        '        return []',
        '    def GetCurrentProject(self):',
        '        raise RuntimeError("current project exploded")',
        '',
        'class _Resolve(object):',
        '    def GetVersionString(self):',
        '        return "18.6.4"',
        '    def GetProjectManager(self):',
        '        return _PM()',
        '    def Quit(self):',
        '        return True',
        '',
        'def scriptapp(name):',
        '    return _Resolve()',
        '',
      ].join('\n'),
    });
    const result = await run('python3', fx.env, 'probe', 1200);
    assert.equal(result.exitCode, 4);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'probe-failed');
    assert.match(result.error.message, /current project exploded/);
    assert.equal(result.quitRequested, false); // mid-check failure never quits
    assert.equal(result.checks.projectManager, true);
    assert.equal(result.checks.projectList.ready, true);
    assert.equal(result.checks.currentProject, undefined); // failed before this check
    assert.equal(result.readiness.projectManagerReady, true);
  } finally {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py exits 5 with checks-failed when read-only checks run but fail', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  let fx;
  try {
    // PM answers but its project list is not a list: checks run, readiness
    // never proves, final ok is false.
    fx = fixture({
      pids: String(4242),
      quitLog: path.join(root, 'quit.log'),
      childPid: 4242,
      module: [
        'class _PM(object):',
        '    def GetProjectListInCurrentFolder(self):',
        '        return None',
        '    def GetCurrentProject(self):',
        '        return None',
        '',
        'class _Resolve(object):',
        '    def GetVersionString(self):',
        '        return "18.6.4"',
        '    def GetProjectManager(self):',
        '        return _PM()',
        '    def Quit(self):',
        '        return True',
        '',
        'def scriptapp(name):',
        '    return _Resolve()',
        '',
      ].join('\n'),
    });
    const result = await run('python3', fx.env, 'probe', 1200);
    assert.equal(result.exitCode, 5);
    assert.equal(result.ok, false);
    assert.equal(result.error, null); // contract: checks-failed carries no error payload
    assert.equal(result.checks.projectManager, true);
    assert.equal(result.checks.projectList.ready, false);
    assert.equal(result.checks.projectList.count, null);
    assert.equal(result.quitRequested, true); // ownership still proven, Quit requested
    assert.equal(result.quitError, null);
  } finally {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py applies the same ownership gate in normal mode (checks still run read-only)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 6060;

    // Owned: checks pass and Quit is requested.
    const quitLogOwned = path.join(root, 'owned.log');
    let fx = fixture({ pids: String(childPid), quitLog: quitLogOwned, childPid });
    let result = await run('python3', fx.env, 'probe');
    assert.equal(result.ok, true);
    assert.deepEqual(result.checks.projectManager, true);
    assert.equal(result.quitRequested, true);
    assert.equal(result.quitError, null);
    rmSync(fx.root, { recursive: true, force: true });

    // Unowned: read-only checks still pass, Quit is skipped with an error.
    const quitLogForeign = path.join(root, 'foreign.log');
    fx = fixture({ pids: `${childPid} 7777`, quitLog: quitLogForeign, childPid });
    result = await run('python3', fx.env, 'probe');
    assert.equal(result.ok, true); // checks themselves are unaffected
    assert.equal(result.quitRequested, false);
    assert.equal(result.quitError.code, 'quit-ownership-unproven');
    assert.equal(existsSync(quitLogForeign), false);
    rmSync(fx.root, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py reports a green transferApi covering the full transfer.ts surface without invoking mutating APIs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 7070;
    const quitLog = path.join(root, 'quit.log');
    const mutateLog = path.join(root, 'mutate.log');
    const fx = fixture({ pids: String(childPid), quitLog, childPid, module: FAKE_FULL_BMD, mutateLog });
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    const api = result.checks.transferApi;
    assert.equal(api.ok, true);
    // The shape covers every API transfer.ts depends on, and nothing else.
    assert.deepEqual(Object.keys(api.required).sort(), EXPECTED_REQUIRED);
    assert.deepEqual(Object.keys(api.optional).sort(), EXPECTED_OPTIONAL);
    for (const value of Object.values(api.required)) assert.equal(value, true);
    for (const value of Object.values(api.optional)) assert.equal(value, true);
    assert.deepEqual(api.unavailable, []);
    assert.deepEqual(api.callErrors, {});
    assert.deepEqual(api.observed, {
      'project.GetUniqueId': 'project-id', 'folder.GetUniqueId': 'folder-id', 'timeline.GetUniqueId': 'timeline-id',
      'timeline.GetSetting.timelineFrameRate': '24', 'timeline.GetSetting.useCustomSettings': '0',
    });
    // Presence-only mutating list is explicit and bounded.
    assert.deepEqual(api.mutating, [
      'clip.SetClipColor',
      'mediaPool.AddSubFolder',
      'mediaPool.AppendToTimeline',
      'mediaPool.SetCurrentFolder',
      'mediaStorage.AddItemListToMediaPool',
      'resolve.OpenPage',
      'timeline.AddMarker',
    ]);
    // The sentinel file never appears: every mutating API raises AND logs if
    // called, so a green run plus an absent sentinel is proof of no calls.
    assert.equal(existsSync(mutateLog), false);
    // Read-only getters answered on the full graph.
    assert.equal(result.checks.mediaPool.present, true);
    assert.equal(result.checks.currentTimeline.present, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py exits 5 (red) when any required transferApi callable is missing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 8080;
    const cases = [
      // Mutating callable missing (never callable anyway).
      { key: 'mediaPool.AppendToTimeline', remove: '    AppendToTimeline = _forbidden("mediaPool.AppendToTimeline")\n' },
      // Read-only callable missing.
      { key: 'timeline.GetStartTimecode', remove: '    def GetStartTimecode(self):\n        return "01:00:00:00"\n' },
      ...['project', 'folder', 'timeline'].map(scope => ({key: `${scope}.GetUniqueId`, remove: `    def GetUniqueId(self):\n        return "${scope}-id"\n`})),
      {key: 'timeline.GetSetting', remove: '    def GetSetting(self, setting):\n        return "24" if setting == "timelineFrameRate" else "0"\n'},
      // Resolve-level callable missing.
      { key: 'resolve.OpenPage', remove: '    OpenPage = _forbidden("resolve.OpenPage")\n' },
    ];
    for (const c of cases) {
      const module = FAKE_FULL_BMD.replace(c.remove, '');
      const quitLog = path.join(root, `quit-${c.key.replace(/\W+/g, '-')}.log`);
      const mutateLog = path.join(root, `mutate-${c.key.replace(/\W+/g, '-')}.log`);
      const fx = fixture({ pids: String(childPid), quitLog, childPid, module, mutateLog });
      const result = await run('python3', fx.env, 'probe');
      assert.equal(result.exitCode, 5, c.key);
      assert.equal(result.ok, false, c.key);
      assert.equal(result.error, null, c.key); // checks-failed carries no error payload
      assert.equal(result.checks.transferApi.ok, false, c.key);
      assert.equal(result.checks.transferApi.required[c.key], false, c.key);
      // Exactly one callable is missing; all others stay present.
      assert.equal(Object.values(result.checks.transferApi.required).filter((v) => v === true).length, EXPECTED_REQUIRED.length - 1, c.key);
      assert.equal(existsSync(mutateLog), false, c.key); // no mutating API invoked
      rmSync(fx.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py keeps no-project and no-timeline valid: object-scoped APIs report unavailable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 9090;
    const quitLog = path.join(root, 'quit.log');
    const mutateLog = path.join(root, 'mutate.log');

    // No project open: resolve/projectManager/mediaStorage stay checked; all
    // project-scoped groups report unavailable and the probe stays green.
    let fx = fixture({ pids: String(childPid), quitLog, childPid, mutateLog });
    let result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.checks.transferApi.ok, true);
    const api = result.checks.transferApi;
    assert.equal(api.required['resolve.GetMediaStorage'], true);
    assert.equal(api.required['resolve.OpenPage'], true);
    assert.equal(api.required['projectManager.GetCurrentProject'], true);
    assert.equal(api.required['mediaStorage.AddItemListToMediaPool'], true);
    assert.equal(api.required['project.GetSetting'], 'unavailable');
    assert.equal(api.required['timeline.GetStartFrame'], 'unavailable');
    assert.equal(api.required['mediaPool.GetRootFolder'], 'unavailable');
    assert.equal(api.required['folder.GetClipList'], 'unavailable');
    assert.equal(api.required['clip.GetClipProperty'], 'unavailable');
    assert.equal(api.optional['timeline.AddMarker'], 'unavailable');
    assert.equal(api.unavailable.includes('project.GetSetting'), true);
    assert.equal(existsSync(mutateLog), false);
    rmSync(fx.root, { recursive: true, force: true });

    // Project open but no timeline: timeline group unavailable, everything
    // else still verified (media pool folder + clip exist).
    const noTimeline = FAKE_FULL_BMD.replace('    def GetCurrentTimeline(self):\n        return _Timeline()\n', '    def GetCurrentTimeline(self):\n        return None\n');
    fx = fixture({ pids: String(childPid), quitLog, childPid, module: noTimeline, mutateLog });
    result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0);
    assert.equal(result.checks.currentTimeline.present, false);
    assert.equal(result.checks.transferApi.ok, true);
    assert.equal(result.checks.transferApi.required['timeline.GetStartFrame'], 'unavailable');
    assert.equal(result.checks.transferApi.required['timeline.GetStartTimecode'], 'unavailable');
    assert.equal(result.checks.transferApi.optional['timeline.AddMarker'], 'unavailable');
    assert.equal(result.checks.transferApi.required['project.GetMediaPool'], true);
    assert.equal(result.checks.transferApi.required['clip.GetClipProperty'], true);
    rmSync(fx.root, { recursive: true, force: true });

    // Folder with no clips: clip group unavailable, folder itself verified.
    const emptyFolder = FAKE_FULL_BMD.replace('        return [_Clip()]', '        return []');
    fx = fixture({ pids: String(childPid), quitLog, childPid, module: emptyFolder, mutateLog });
    result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0);
    assert.equal(result.checks.transferApi.ok, true);
    assert.equal(result.checks.transferApi.required['folder.GetClipList'], true);
    assert.equal(result.checks.transferApi.required['clip.GetClipProperty'], 'unavailable');
    assert.equal(result.checks.transferApi.optional['clip.SetClipColor'], 'unavailable');
    rmSync(fx.root, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.py records missing optional callables (markers/color/end-frame) without going red', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-probe-own-'));
  try {
    const childPid = 10101;
    const module = FAKE_FULL_BMD.replace('    AddMarker = _forbidden("timeline.AddMarker")\n', '');
    const quitLog = path.join(root, 'quit.log');
    const mutateLog = path.join(root, 'mutate.log');
    const fx = fixture({ pids: String(childPid), quitLog, childPid, module, mutateLog });
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0);
    assert.equal(result.checks.transferApi.ok, true);
    assert.equal(result.checks.transferApi.optional['timeline.AddMarker'], false);
    assert.equal(result.checks.transferApi.required['timeline.GetStartTimecode'], true);
    assert.equal(existsSync(mutateLog), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal probe clears an inherited quit-only flag and runs the checks', async (t) => {
  const fx = fixture({ pids: '4242', childPid: 4242, quitLog: '/dev/null', module: FAKE_FULL_BMD });
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const result = await run('python3', { ...fx.env, RESOLVE_SMOKE_QUIT_ONLY: '1' }, 'probe');
  assert.equal(result.ok, true);
  assert.equal(result.checks.transferApi.ok, true);
  assert.equal(result.checks.projectManager, true);
});

test('required getter exceptions and invalid answers fail the actual Python probe', async (t) => {
  for (const answer of ['raise RuntimeError("getter unavailable")', 'return None', 'return "wrong"']) {
    const module = FAKE_FULL_BMD.replace('    def GetStartFrame(self):\n        return 1000', `    def GetStartFrame(self):\n        ${answer}`);
    assert.notEqual(module, FAKE_FULL_BMD, 'fixture replacement must apply');
    const fx = fixture({ pids: '4242', childPid: 4242, quitLog: '/dev/null', module });
    t.after(() => rmSync(fx.root, { recursive: true, force: true }));
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 5);
    assert.equal(result.ok, false);
    assert.equal(result.checks.transferApi.ok, false);
    assert.equal(result.checks.transferApi.required['timeline.GetStartFrame'], true);
    assert.equal(result.checks.transferApi.callErrors['timeline.GetStartFrame'], answer.startsWith('raise') ? 'getter unavailable' : 'invalid required getter result');
  }
});

for (const scope of ['project', 'timeline', 'folder']) {
  test(`probe validates ${scope}.GetUniqueId answers and exceptions`, async t => {
    for (const answer of ['None', '""', '"   "', '123', 'False', 'RuntimeError("id unavailable")']) {
      const raises = answer.startsWith('RuntimeError');
      const module = FAKE_FULL_BMD.replace(`    def GetUniqueId(self):\n        return "${scope}-id"`, `    def GetUniqueId(self):\n        ${raises ? 'raise' : 'return'} ${answer}`);
      assert.notEqual(module, FAKE_FULL_BMD);
      const fx = fixture({pids: '4242', childPid: 4242, quitLog: '/dev/null', module});
      t.after(() => rmSync(fx.root, {recursive: true, force: true}));
      const result = await run('python3', fx.env, 'probe');
      assert.equal(result.exitCode, 5, answer);
      assert.equal(result.checks.transferApi.ok, false);
      assert.equal(result.checks.transferApi.callErrors[`${scope}.GetUniqueId`], raises ? 'id unavailable' : 'invalid required getter result');
    }
  });
}

test('probe validates timeline frame rate and observes custom settings without coercion', async t => {
  const original = '    def GetSetting(self, setting):\n        return "24" if setting == "timelineFrameRate" else "0"';
  for (const rate of ['None', 'True', '0', '-1', '"wrong"', 'float("nan")', 'float("inf")', '241', '"2.4e1"']) {
    const module = FAKE_FULL_BMD.replace(original, `    def GetSetting(self, setting):\n        return ${rate} if setting == "timelineFrameRate" else "1"`);
    assert.notEqual(module, FAKE_FULL_BMD);
    const fx = fixture({pids: '4242', childPid: 4242, quitLog: '/dev/null', module});
    t.after(() => rmSync(fx.root, {recursive: true, force: true}));
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 5, rate);
    assert.equal(result.checks.transferApi.callErrors['timeline.GetSetting.timelineFrameRate'], 'invalid required getter result');
  }
  for (const [answer, observed] of [['"1"', '1'], ['"0"', '0'], ['False', false], ['0', 0], ['None', null], ['"unknown"', 'unknown']]) {
    const module = FAKE_FULL_BMD.replace(original, `    def GetSetting(self, setting):\n        return "29.97" if setting == "timelineFrameRate" else ${answer}`);
    assert.notEqual(module, FAKE_FULL_BMD);
    const fx = fixture({pids: '4242', childPid: 4242, quitLog: '/dev/null', module});
    t.after(() => rmSync(fx.root, {recursive: true, force: true}));
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 0, answer);
    assert.equal(result.checks.transferApi.observed['timeline.GetSetting.timelineFrameRate'], '29.97');
    assert.equal(result.checks.transferApi.observed['timeline.GetSetting.useCustomSettings'], observed);
  }
});

test('probe reports timeline settings getter exceptions and invalid custom-setting shapes', async t => {
  const original = '    def GetSetting(self, setting):\n        return "24" if setting == "timelineFrameRate" else "0"';
  for (const [body, errors] of [
    ['raise RuntimeError("settings unavailable")', {'timeline.GetSetting.timelineFrameRate': 'settings unavailable', 'timeline.GetSetting.useCustomSettings': 'settings unavailable'}],
    ['return "24" if setting == "timelineFrameRate" else {}', {'timeline.GetSetting.useCustomSettings': 'invalid required getter result'}],
  ]) {
    const module = FAKE_FULL_BMD.replace(original, `    def GetSetting(self, setting):\n        ${body}`);
    assert.notEqual(module, FAKE_FULL_BMD);
    const fx = fixture({pids: '4242', childPid: 4242, quitLog: '/dev/null', module});
    t.after(() => rmSync(fx.root, {recursive: true, force: true}));
    const result = await run('python3', fx.env, 'probe');
    assert.equal(result.exitCode, 5);
    assert.deepEqual(result.checks.transferApi.callErrors, errors);
  }
});
