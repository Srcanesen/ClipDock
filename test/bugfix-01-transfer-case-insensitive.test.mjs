import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

// Windows keeps slash-normalized case-insensitive comparison. macOS identity
// behavior is covered in resolve-transfer-regressions.test.mjs.

test('duplicate scan is case-insensitive on slash-normalized path but keeps original for import', async () => {
  const events = [];
  const wantedPath = 'C:\\tmp\\Clip.MP4';
  const storedPath = 'c:/tmp/clip.mp4';

  let importedPath = null;
  const folder = {
    GetClipList: async () => {
      events.push('GetClipList');
      return [
        {
          GetClipProperty: async (prop) => {
            if (prop === 'File Path') return storedPath;
            return null;
          },
        },
      ];
    },
  };
  const mediaPool = {
    GetCurrentFolder: async () => folder,
    GetRootFolder: async () => ({ GetSubFolderList: async () => [], GetClipList: async () => [] }),
    AddSubFolder: async () => folder,
    SetCurrentFolder: async () => true,
  };
  const project = {
    GetCurrentTimeline: async () => null,
    GetMediaPool: async () => mediaPool,
    GetSetting: async () => '30',
  };
  const resolveObj = {
    GetProjectManager: async () => ({ GetCurrentProject: async () => project }),
    GetMediaStorage: async () => ({
      AddItemListToMediaPool: async (paths) => {
        importedPath = paths[0];
        return [{ GetClipProperty: async () => paths[0] }];
      },
    }),
  };
  const workflow = {
    Initialize: async () => true,
    GetResolve: async () => resolveObj,
  };
  const transfer = createTransfer(workflow, 'com.clipdock.test', { platform: 'win32' });

  // The file on disk uses Windows backslashes and different case; duplicate should be found
  const result = await transfer.importToMediaPool(wantedPath, 'active');

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'already-imported');
  assert.equal(importedPath, null, 'duplicate must not trigger import; original path must be preserved for non-duplicate case');

  // Non-duplicate case: ensure original path is used for import call
  const folderEmpty = {
    GetClipList: async () => [],
  };
  const mediaPool2 = {
    GetCurrentFolder: async () => folderEmpty,
    GetRootFolder: async () => ({ GetSubFolderList: async () => [], GetClipList: async () => [] }),
    AddSubFolder: async () => folderEmpty,
    SetCurrentFolder: async () => true,
  };
  const project2 = {
    GetCurrentTimeline: async () => null,
    GetMediaPool: async () => mediaPool2,
    GetSetting: async () => '30',
  };
  const resolveObj2 = {
    GetProjectManager: async () => ({ GetCurrentProject: async () => project2 }),
    GetMediaStorage: async () => ({
      AddItemListToMediaPool: async (paths) => {
        importedPath = paths[0];
        return [{ GetClipProperty: async () => paths[0] }];
      },
    }),
  };
  const workflow2 = {
    Initialize: async () => true,
    GetResolve: async () => resolveObj2,
  };
  const transfer2 = createTransfer(workflow2, 'com.clipdock.test', { platform: 'win32' });
  importedPath = null;
  const result2 = await transfer2.importToMediaPool(wantedPath, 'active');
  assert.equal(result2.ok, true);
  assert.equal(result2.kind, 'imported');
  assert.equal(importedPath, wantedPath, 'actual import must use original path, not lowercased');
});
