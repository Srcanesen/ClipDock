#!/usr/bin/env python3
"""NDJSON bridge to the official Resolve scripting API; stdout is protocol only."""
import contextlib
import json
import sys

# fusionscript (including native writes) can be chatty. Reserve the original
# stdout descriptor for protocol and redirect all other stdout to stderr.
import os
protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

FALLBACK_METHODS = (
    'GetProjectManager', 'GetMediaStorage', 'OpenPage', 'GetVersionString',
    'GetCurrentProject', 'GetName', 'GetCurrentTimeline', 'GetMediaPool',
    'GetSetting', 'GetStartFrame', 'GetStartTimecode', 'GetCurrentTimecode',
    'GetEndFrame', 'AddMarker', 'GetCurrentFolder', 'GetRootFolder',
    'AddSubFolder', 'SetCurrentFolder', 'AppendToTimeline', 'GetSubFolderList',
    'GetClipList', 'AddItemListToMediaPool', 'GetClipProperty', 'SetClipColor',
    'GetStart', 'GetProjectListInCurrentFolder', 'CreateProject', 'CloseProject',
    'DeleteProject', 'CreateEmptyTimeline', 'SetCurrentTimeline',
    'GetItemListInTrack', 'GetMarkers',
)
handles = {}
next_handle = 1


def methods(obj):
    def usable(name):
        try:
            return not name.startswith('_') and callable(getattr(obj, name, None))
        except Exception:
            return False
    try:
        names = [name for name in dir(obj) if usable(name)]
    except Exception:
        names = []
    return sorted(names or [name for name in FALLBACK_METHODS if usable(name)])


def encode(value):
    global next_handle
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    # Preserve object identity while held (ClipDock compares returned objects).
    for number, obj in handles.items():
        if obj is value:
            return {'$h': number, 'methods': methods(value)}
    number = next_handle
    next_handle += 1
    handles[number] = value
    return {'$h': number, 'methods': methods(value)}


def decode(value):
    if isinstance(value, dict):
        if '$h' in value:
            return handles[value['$h']]
        return {key: decode(item) for key, item in value.items()}
    if isinstance(value, list):
        return [decode(item) for item in value]
    return value


def main():
    with contextlib.redirect_stdout(sys.stderr):
        import DaVinciResolveScript as dvr
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                if request['op'] == 'root':
                    result = dvr.scriptapp('Resolve')
                elif request['op'] == 'call':
                    result = getattr(handles[request['handle']], request['method'])(*decode(request.get('args', [])))
                elif request['op'] == 'release':
                    for number in request['handles']:
                        handles.pop(number, None)
                    result = True
                else:
                    raise ValueError('unknown bridge operation')
                response = {'id': request['id'], 'result': encode(result)}
            protocol.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n')
        except Exception as exc:
            protocol.write(json.dumps({'id': request.get('id'), 'error': str(exc)}) + '\n')


if __name__ == '__main__':
    main()
