import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransfer } from '../dist/transfer.js';

for (const platform of ['darwin', 'linux']) {
  for (const operation of ['import', 'append']) {
    test(`${platform} ${operation} keeps literal filename backslashes distinct from directories`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'resolve-backslash-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const literal = join(root, 'scene\\take.mp4');
      mkdirSync(join(root, 'scene'));
      const nested = join(root, 'scene', 'take.mp4');
      writeFileSync(literal, 'footage A');
      writeFileSync(nested, 'footage B');
      const existing = { GetClipProperty: () => literal };
      const imported = { GetClipProperty: () => nested };
      const imports = [], appends = [];
      const mediaPool = {
        GetCurrentFolder: () => ({ GetUniqueId: () => 'folder', GetClipList: () => [existing] }),
        AppendToTimeline: clips => { appends.push(clips); return [{ GetStart: () => 0 }]; },
      };
      const project = { GetMediaPool: () => mediaPool, GetCurrentTimeline: () => ({ GetUniqueId: () => 'timeline' }) };
      const resolve = {
        GetProjectManager: () => ({ GetCurrentProject: () => project }),
        GetMediaStorage: () => ({ AddItemListToMediaPool: paths => { imports.push(paths); return [imported]; } }),
      };
      const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'test', platform);
      const result = await (operation === 'import'
        ? transfer.importToMediaPool(nested, 'active')
        : transfer.addToTimeline(nested, 'active', 'end'));
      assert.equal(result.kind, operation === 'import' ? 'imported' : 'timeline-appended');
      assert.deepEqual(imports, [[nested]], 'distinct footage must be imported with its exact filename');
      if (operation === 'append') assert.deepEqual(appends, [[imported]], 'append must use footage B');
    });
  }
}
