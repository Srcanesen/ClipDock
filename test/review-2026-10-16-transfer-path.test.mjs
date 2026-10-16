import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ManagedRoot } from '../dist/managed-root.js';
import { createTransfer } from '../dist/transfer.js';

for (const action of ['import', 'end', 'playhead']) {
  for (const revokeAt of ['scan', 'revoked-pristine-scan', 'playhead-read']) {
    if (revokeAt === 'playhead-read' && action !== 'playhead') continue;
    test(`trusted path: ${action} rejects root replacement during ${revokeAt}`, async t => {
      const dir = mkdtempSync(path.resolve('test/.transfer-path-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const root = path.join(dir, 'managed');
      mkdirSync(root);
      const file = path.join(root, 'clip.mp4');
      writeFileSync(file, 'original');
      const boundary = ManagedRoot.capture(root);
      assert.equal(boundary.resolve(file), file);
      let replaced = false;
      function revoke() {
        if (replaced) return;
        replaced = true;
        renameSync(root, path.join(dir, 'original'));
        mkdirSync(root);
        writeFileSync(file, 'replacement');
      }
      const calls = { imports: 0, appends: 0, validations: 0 };
      const clip = { GetClipProperty: key => key === 'Frames' ? '30' : file };
      const folder = { GetClipList() { if (revokeAt !== 'playhead-read') revoke(); return [clip]; } };
      const timeline = {
        GetStartFrame: () => 0, GetStartTimecode: () => '00:00:00:00',
        GetCurrentTimecode() { if (revokeAt === 'playhead-read') revoke(); return '00:00:10:00'; },
        GetSetting: key => key === 'useCustomSettings' ? '1' : '30',
      };
      const pool = { GetCurrentFolder: () => folder, AppendToTimeline() { calls.appends++; return [{ GetStart: () => 0 }]; } };
      const project = { GetMediaPool: () => pool, GetCurrentTimeline: () => timeline, GetSetting: () => '30' };
      let pristine = true;
      const resolve = {
        GetProjectManager: () => ({ GetCurrentProject: () => project }), OpenPage: () => true,
        GetMediaStorage() { pristine = false; return { AddItemListToMediaPool() { calls.imports++; return [clip]; } }; },
      };
      const transfer = createTransfer({ Initialize: () => true, GetResolve: () => resolve }, 'review', {
        platform: 'linux',
        takePristine: () => revokeAt === 'revoked-pristine-scan' ? () => pristine : null,
        validatePath(file) { calls.validations++; return boundary.resolve(file); },
      });
      const result = action === 'import' ? await transfer.importToMediaPool(file, 'active') : await transfer.addToTimeline(file, 'active', action);
      assert.deepEqual([result.ok, result.kind, calls.imports, calls.appends], [false, 'import-failed', 0, 0]);
      assert.match(result.message, /trusted path boundary/);
      assert.ok(calls.validations > 0);
      assert.equal(boundary.resolve(file), null);
    });
  }
}
