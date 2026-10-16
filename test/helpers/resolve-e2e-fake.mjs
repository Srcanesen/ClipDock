import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPythonBridge } from '../../scripts/resolve-smoke/lib/bridge.mjs';

export const FAKE_MODULE = `import os, time, json

def log(name):
    if os.environ.get('FAKE_LOG'):
        with open(os.environ['FAKE_LOG'], 'a') as f: f.write(name + '\\n')

class Clip:
    def __init__(self, path): self.path = path
    def GetClipProperty(self, key): return self.path if key == 'File Path' else '75' if key == 'Frames' else None
    def SetClipColor(self, color): log('SetClipColor'); return True

class Folder:
    def __init__(self, name): self.name, self.clips, self.folders = name, [], []
    def GetName(self): return self.name
    def GetClipList(self): return self.clips
    def GetSubFolderList(self): return self.folders

class Item:
    def __init__(self, start): self.start = start
    def GetStart(self): return self.start

class Timeline:
    def __init__(self, name): self.name, self.items, self.markers = name, [], {}
    def GetName(self): return self.name
    def GetSetting(self, key): return '1' if key == 'useCustomSettings' else '25'
    def GetStartFrame(self): return 0
    def GetStartTimecode(self): return '00:00:00:00'
    def GetCurrentTimecode(self): return '00:00:01:00'
    def GetEndFrame(self): return len(self.items) * 75
    def GetItemListInTrack(self, kind, track): return self.items
    def GetMarkers(self): return self.markers

if os.environ.get('FAKE_MARKERS', '1') == '1':
    def add_marker(self, frame, color, name, note, duration):
        log('AddMarker')
        self.markers[frame] = {'color': color, 'name': name, 'note': note, 'duration': duration}
        return True
    Timeline.AddMarker = add_marker

class MediaPool:
    def __init__(self, project): self.project, self.root = project, Folder('Master'); self.folder = self.root
    def GetRootFolder(self): return self.root
    def GetCurrentFolder(self): return self.folder
    def SetCurrentFolder(self, folder):
        assert isinstance(folder, Folder), 'folder handle not decoded'
        log('SetCurrentFolder'); self.folder = folder; return True
    def AddSubFolder(self, folder, name):
        log('AddSubFolder'); child = Folder(name); folder.folders.append(child); self.folder = child; return child
    def CreateEmptyTimeline(self, name):
        log('CreateEmptyTimeline'); return Timeline(name)
    def AppendToTimeline(self, clips):
        log('AppendToTimeline')
        timeline = self.project.timeline
        start = timeline.GetEndFrame()
        if clips and isinstance(clips[0], dict):
            assert isinstance(clips[0]['mediaPoolItem'], Clip), 'nested clip handle not decoded'
            start = clips[0]['recordFrame']
        else: assert isinstance(clips[0], Clip), 'clip handle not decoded'
        item = Item(start); timeline.items.append(item); return [item]

class Project:
    def __init__(self, name): self.name, self.timeline = name, None; self.pool = MediaPool(self)
    def GetName(self): return self.name
    def GetMediaPool(self): return self.pool
    def GetCurrentTimeline(self): return self.timeline
    def SetCurrentTimeline(self, timeline): log('SetCurrentTimeline'); self.timeline = timeline; return True
    def GetSetting(self, name): return '25'

class ProjectManager:
    def __init__(self): self.project = None; self.projects = {}
    def GetCurrentProject(self): return self.project
    def GetProjectListInCurrentFolder(self): return list(self.projects.keys())
    def CreateProject(self, name):
        log('CreateProject')
        if os.environ.get('FAKE_CREATE_FAIL') == '1': return None
        self.project = Project(name); self.projects[name] = self.project; return self.project
    def CloseProject(self, project):
        assert project is self.project, 'project handle not decoded'
        log('CloseProject')
        if os.environ.get('FAKE_CLOSE_FAIL') == '1': return False
        self.project = None; return True
    def DeleteProject(self, name):
        assert name.startswith('ClipDock-E2E-'), 'unsafe delete'
        assert self.project is None, 'delete before close'
        log('DeleteProject'); del self.projects[name]; return True

class Storage:
    def __init__(self, pm): self.pm = pm
    def AddItemListToMediaPool(self, paths):
        log('AddItemListToMediaPool')
        if os.environ.get('FAKE_IMPORT_FAIL') == '1': raise RuntimeError('fake import failure')
        clips = [Clip(p) for p in paths]; self.pm.project.pool.folder.clips.extend(clips); return clips

class Resolve:
    def __init__(self): self.pm = ProjectManager(); self.storage = Storage(self.pm)
    def GetProjectManager(self): return self.pm
    def GetMediaStorage(self): return self.storage
    def GetVersionString(self): return 'fake-resolve-21'
    def OpenPage(self, name): log('OpenPage'); return True
    def Explode(self): raise RuntimeError('fake Python exception')
    def Hang(self): time.sleep(60)
    def Echo(self, value): return value

if os.environ.get('FAKE_EMPTY_DIR') == '1':
    for cls in [Clip, Folder, Item, Timeline, MediaPool, Project, ProjectManager, Storage, Resolve]:
        cls.__dir__ = lambda self: []

resolve = Resolve()
def scriptapp(name):
    assert name == 'Resolve'
    print('fake bootstrap diagnostic')
    return resolve
`;

export function fakeEnvironment(t, extra = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'clipdock-e2e-fake-')));
  writeFileSync(path.join(root, 'DaVinciResolveScript.py'), FAKE_MODULE);
  const env = { ...process.env, PYTHONPATH: root, ...extra };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env };
}
export function fakeBridge(t, extra = {}, timeoutMs = 3000) {
  const fixture = fakeEnvironment(t, extra);
  const bridge = createPythonBridge({ python: 'python3', env: fixture.env, script: fileURLToPath(new URL('../../scripts/resolve-smoke/bridge.py', import.meta.url)), timeoutMs });
  t.after(() => bridge.close());
  return { ...fixture, bridge };
}
