import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('managed workspace containment and cleanup', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const { inspectWorkspace, cleanupWorkspace } = await import(path.join(dist, 'workspace.js'));
  {
    const workspaceExpect = expect;
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-workspace-'));
    const managed = path.join(temp, 'ClipDock');
    const outside = path.join(temp, 'outside.txt');
    mkdirSync(path.join(managed, 'youtube', 'old'), { recursive: true });
    mkdirSync(path.join(managed, 'unrelated', 'nested'), { recursive: true });
    writeFileSync(path.join(managed, '.clipdock-owned'), 'ClipDock managed download folder\n');
    writeFileSync(path.join(managed, 'top-level.txt'), 'top');
    writeFileSync(path.join(managed, 'unrelated', 'nested', 'keep.txt'), 'keep');
    writeFileSync(path.join(managed, 'youtube', 'old', 'old.mp4'), 'old');
    writeFileSync(path.join(managed, 'youtube', 'current.mp4'), 'current');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, path.join(managed, 'youtube', 'outside-link.mp4'));
    const before = inspectWorkspace(managed, [path.join(managed, 'youtube', 'current.mp4')]);
    workspaceExpect('workspace: only provider regular files are candidates', [before.fileCount, before.cleanupFileCount, before.cleanupBytes], [3, 2, 6]);
    const cleaned = cleanupWorkspace(managed, [path.join(managed, 'youtube', 'current.mp4')]);
    workspaceExpect('workspace: cleanup preserves current card and deletes only old provider file', [cleaned.deletedFileCount, cleaned.deletedBytes, cleaned.fileCount, cleaned.totalBytes], [2, 6, 1, 7]);
    workspaceExpect('workspace: symlink target is never deleted', existsSync(outside), true);
    workspaceExpect('workspace: marker, top-level files, and unrelated directories survive', [existsSync(path.join(managed, '.clipdock-owned')), existsSync(path.join(managed, 'top-level.txt')), existsSync(path.join(managed, 'unrelated', 'nested', 'keep.txt'))], [true, false, true]);
    workspaceExpect('workspace: empty managed directories are pruned', existsSync(path.join(managed, 'youtube', 'old')), false);
    rmSync(temp, { recursive: true, force: true });
  }
});
