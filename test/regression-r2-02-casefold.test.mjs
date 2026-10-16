import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransfer } from '../dist/transfer.js';

function makeTransferWithExisting(existingPath, platform) {
  let imports = 0;
  let importedPath = null;
  const folder = {
    GetClipList: async () => [
      { GetClipProperty: async (p) => (p === 'File Path' ? existingPath : null) },
    ],
  };
  const mediaPool = {
    GetCurrentFolder: async () => folder,
    GetRootFolder: async () => ({ GetSubFolderList: async () => [], GetClipList: async () => [] }),
    AddSubFolder: async () => folder,
    SetCurrentFolder: async () => true,
  };
  const project = {
    GetMediaPool: async () => mediaPool,
    GetCurrentTimeline: async () => null,
  };
  const resolveObj = {
    GetProjectManager: async () => ({ GetCurrentProject: async () => project }),
    GetMediaStorage: async () => ({
      AddItemListToMediaPool: async (paths) => {
        imports += 1;
        importedPath = paths[0];
        return [{ GetClipProperty: async () => paths[0] }];
      },
    }),
  };
  const workflow = { Initialize: async () => true, GetResolve: async () => resolveObj };
  // Try inject platform via third arg object, also fallback to string
  let transfer;
  try {
    transfer = createTransfer(workflow, 'com.clipdock.test', { platform });
  } catch {
    transfer = createTransfer(workflow, 'com.clipdock.test');
  }
  // If third arg didn't work, try as string
  if (platform && transfer && typeof transfer === 'object') {
    // second attempt if needed: create with string arg
    const alt = createTransfer(workflow, 'com.clipdock.test', platform);
    // Use alt if it differs; but we already have one. Keep first.
  }
  return { transfer, getImports: () => imports, getImportedPath: () => importedPath };
}

test('case-sensitive platform (linux) does NOT dedupe differing case', async () => {
  const existing = 'C:/media/clip.mp4';
  const wanted = 'C:/media/CLIP.MP4';
  const { transfer, getImports } = makeTransferWithExisting(existing, 'linux');
  // If platform seam not implemented, old code will dedupe (toLowerCase) and imports stays 0
  // Expected after fix: linux is case-sensitive, so NOT deduped => import happens
  const result = await transfer.importToMediaPool(wanted, 'active');
  assert.equal(result.kind, 'imported', 'linux platform must NOT dedupe case-only difference');
  assert.equal(getImports(), 1, 'linux must trigger import for case-different path');
});

test('macOS needs file identity for differing case; Windows preserves case folding', async () => {
  const existing = 'C:/media/clip.mp4';
  const wanted = 'C:/media/CLIP.MP4';
  // Test darwin
  const { transfer: tDarwin, getImports: getDarwin } = makeTransferWithExisting(existing, 'darwin');
  const rDarwin = await tDarwin.importToMediaPool(wanted, 'active');
  assert.equal(rDarwin.kind, 'imported', 'darwin must not assume filesystem case semantics');
  assert.equal(getDarwin(), 1);

  // Test win32
  const { transfer: tWin, getImports: getWin } = makeTransferWithExisting(existing, 'win32');
  const rWin = await tWin.importToMediaPool(wanted, 'active');
  assert.equal(rWin.kind, 'already-imported', 'win32 must dedupe case-only difference');
  assert.equal(getWin(), 0);
});

test('slash normalization still works on Windows', async () => {
  const existing = 'C:/media/clip.mp4';
  const wanted = 'C:\\media\\clip.mp4';
  const { transfer, getImports } = makeTransferWithExisting(existing, 'win32');
  const r = await transfer.importToMediaPool(wanted, 'active');
  assert.equal(r.kind, 'already-imported', 'backslash vs slash must normalize to same path');
  assert.equal(getImports(), 0);
});
