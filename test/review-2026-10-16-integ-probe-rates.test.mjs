import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runProbe} from '../scripts/resolve-smoke/lib/probe.mjs';
import {createTransfer} from '../dist/transfer.js';

const module = `import json, os

def forbidden(*args):
    with open(os.environ['MUTATE_LOG'], 'a') as f: f.write('mutation')
    raise RuntimeError('probe must remain read-only')

class Folder:
    def GetUniqueId(self): return 'folder'
    def GetName(self): return 'Master'
    def GetSubFolderList(self): return []
    def GetClipList(self): return []

class Timeline:
    def GetUniqueId(self): return 'timeline'
    def GetName(self): return 'Timeline'
    def GetSetting(self, key): return json.loads(os.environ['RATE' if key == 'timelineFrameRate' else 'CUSTOM'])
    def GetStartFrame(self): return 0
    def GetStartTimecode(self): return '00:00:00:00'
    def GetCurrentTimecode(self): return '00:00:00:00'

class Pool:
    def GetCurrentFolder(self): return Folder()
    def GetRootFolder(self): return Folder()
    AddSubFolder = SetCurrentFolder = AppendToTimeline = staticmethod(forbidden)

class Project:
    def GetUniqueId(self): return 'project'
    def GetName(self): return 'Project'
    def GetCurrentTimeline(self): return Timeline()
    def GetMediaPool(self): return Pool()
    def GetSetting(self, key): return json.loads(os.environ['PROJECT_RATE'])

class Manager:
    def GetProjectListInCurrentFolder(self): return []
    def GetCurrentProject(self): return Project()

class Storage:
    AddItemListToMediaPool = staticmethod(forbidden)

class Resolve:
    def GetVersionString(self): return 'fake'
    def GetProjectManager(self): return Manager()
    def GetMediaStorage(self): return Storage()
    OpenPage = staticmethod(forbidden)
    def Quit(self): return True

def scriptapp(name): return Resolve()
`;

async function transferOutcome(rate, custom, projectRate) {
  const clip = {GetClipProperty: key => key === 'Frames' ? '30' : '/clip.mp4'};
  const folder = {GetClipList: () => [clip]};
  const pool = {GetCurrentFolder: () => folder, AppendToTimeline: () => [{GetStart: () => 0}]};
  const timeline = {GetSetting: key => key === 'timelineFrameRate' ? rate : custom,
    GetStartFrame: () => 0, GetStartTimecode: () => '00:00:00:00', GetCurrentTimecode: () => '00:00:00:00'};
  const project = {GetMediaPool: () => pool, GetCurrentTimeline: () => timeline, GetSetting: () => projectRate};
  const resolve = {GetProjectManager: () => ({GetCurrentProject: () => project}), OpenPage: () => true};
  return createTransfer({Initialize: () => true, GetResolve: () => resolve}, 'integ', 'linux').addToTimeline('/clip.mp4', 'active', 'playhead');
}

for (const [rate, custom, accepted, projectRate = '24'] of [
  ['29.97 DF', '1', true], [' 59.94df ', '1', true],
  ['', '0', true], [null, 0, true], ['wrong', false, true], [999, 0, true], ['', false, true, '29.97 DF'],
  ['', null, false], ['', 'false', false], [999, '1', false], [0.5, '1', false],
  [1, '1', true], [240, '1', true], ['2.4e1', '1', false], ['+24', '1', false], ['24.', '1', false], ['1_0', '1', false],
]) {
  test(`probe rate matches transfer: ${JSON.stringify({rate, custom, projectRate})}`, async t => {
    const result = await transferOutcome(rate, custom, projectRate);
    assert.equal(result.kind, accepted ? 'timeline-inserted' : 'playhead-unsupported');
    const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-integ-probe-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\necho 4242\n', {mode: 0o755});
    fs.writeFileSync(path.join(root, 'DaVinciResolveScript.py'), module);
    const mutation = path.join(root, 'mutations');
    const probe = await runProbe({python: 'python3', probeScript: fileURLToPath(new URL('../scripts/resolve-smoke/probe.py', import.meta.url)),
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHONPATH: root, RESOLVE_SMOKE_CHILD_PID: '4242',
        RATE: JSON.stringify(rate), CUSTOM: JSON.stringify(custom), PROJECT_RATE: JSON.stringify(projectRate), MUTATE_LOG: mutation}, timeoutMs: 5000, mode: 'probe'});
    assert.equal(probe.exitCode, accepted ? 0 : 5, JSON.stringify(probe));
    assert.equal(probe.checks.transferApi.ok, accepted);
    assert.equal(fs.existsSync(mutation), false);
  });
}
