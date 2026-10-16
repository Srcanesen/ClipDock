import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { inventory, verifyArtifact } from '../scripts/lib/release-artifact.mjs';
import { validatePluginArtifact } from '../scripts/lib/completed-build.mjs';
import { reconcileDirectoryContents } from '../scripts/lib/install-files.mjs';

function fixture(t) {
  fs.mkdirSync('output', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('output/testtool-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'installed');
  fs.mkdirSync(source); fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'main.js'), 'new');
  fs.writeFileSync(path.join(destination, 'old.js'), 'working');
  return { root, source, destination };
}

test('artifact inventory refuses symlink and non-directory roots without following them', t => {
  const { root, source } = fixture(t);
  const link = path.join(root, 'link'); fs.symlinkSync(source, link);
  for (const candidate of [link, path.join(source, 'main.js')]) {
    const result = inventory(candidate);
    assert.deepEqual(result.files, []);
    assert.match(result.problems.join('; '), /artifact root.*(?:symbolic link|directory)/);
    assert.equal(verifyArtifact(candidate).ok, false);
  }
  assert.equal(verifyArtifact(source, link).ok, false, 'reference roots must also be validated');
});

test('completed plugin validation refuses a symlink to otherwise valid build bytes', t => {
  const { root } = fixture(t);
  const dist = path.resolve('dist');
  assert.ok(validatePluginArtifact(dist).includes('main.js'));
  const link = path.join(root, 'dist'); fs.symlinkSync(dist, link);
  assert.throws(() => validatePluginArtifact(link), /artifact root.*symbolic link/);
});

test('reconciliation refuses linked source and destination roots before preparation', t => {
  const { root, source, destination } = fixture(t);
  const sourceLink = path.join(root, 'source-link'), destinationLink = path.join(root, 'installed-link');
  fs.symlinkSync(source, sourceLink); fs.symlinkSync(destination, destinationLink);
  for (const [from, to] of [[sourceLink, destination], [source, destinationLink]]) {
    let prepared = false;
    assert.throws(() => reconcileDirectoryContents(from, to, fs, () => { prepared = true; }), /directory.*symbolic link|symbolic link.*directory/);
    assert.equal(prepared, false);
    assert.equal(fs.readFileSync(path.join(destination, 'old.js'), 'utf8'), 'working');
    assert.deepEqual(fs.readdirSync(source), ['main.js']);
  }
});

test('staged root must be a real directory before native preparation can write', t => {
  const { source, destination } = fixture(t);
  let prepared = false;
  const fakeFs = { ...fs, cpSync(from, stage) { fs.symlinkSync(from, stage); } };
  assert.throws(() => reconcileDirectoryContents(source, destination, fakeFs, stage => {
    prepared = true;
    fs.writeFileSync(path.join(stage, 'WorkflowIntegration.node'), 'native');
  }), /directory.*symbolic link|symbolic link.*directory/);
  assert.equal(prepared, false);
  assert.deepEqual(fs.readdirSync(source), ['main.js']);
  assert.equal(fs.readFileSync(path.join(destination, 'old.js'), 'utf8'), 'working');
});
