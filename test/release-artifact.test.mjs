// Deterministic artifact checks for the single dist/ tree.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { inventory, requireGraphProblems, scanArtifactProblems, verifyArtifact } from '../scripts/lib/release-artifact.mjs';

const withTempDir = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipdock-artifact-test-'));
  try { return fn(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
};
const writeFiles = (root, files) => {
  for (const rel of files) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, `content:${rel}`);
  }
};

test('verifyArtifact accepts an exact artifact and reports source drift', () => {
  withTempDir((root) => {
    const source = path.join(root, 'source');
    const candidate = path.join(root, 'candidate');
    writeFiles(source, ['main.js', 'lib/util.js']);
    writeFiles(candidate, ['main.js', 'lib/util.js']);
    assert.equal(verifyArtifact(candidate, source).ok, true);
    writeFileSync(path.join(candidate, 'main.js'), 'changed');
    writeFileSync(path.join(candidate, 'extra.txt'), 'extra');
    const result = verifyArtifact(candidate, source);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('extra path') && problem.includes('extra.txt')));
    assert.ok(result.problems.some((problem) => problem.includes('content changed') && problem.includes('main.js')));
    rmSync(path.join(candidate, 'lib', 'util.js'));
    assert.ok(verifyArtifact(candidate, source).problems.some((problem) => problem.includes('missing path') && problem.includes('lib/util.js')));
  });
});

test('artifact inventory rejects symlinks and packaging hazards', () => {
  withTempDir((root) => {
    writeFiles(root, ['main.js', 'renderer.js', 'bin/native.node', 'output/debug.txt']);
    chmodSync(path.join(root, 'renderer.js'), 0o755);
    symlinkSync(path.join(root, 'main.js'), path.join(root, 'link.js'));
    const {files, problems} = inventory(root);
    assert.ok(problems.some((problem) => problem.includes('symbolic link') && problem.includes('link.js')));
    const artifactProblems = scanArtifactProblems(root, files);
    assert.ok(artifactProblems.some((problem) => problem.includes('native/binary') && problem.includes('native.node')));
    assert.ok(artifactProblems.some((problem) => problem.includes('packaging debris') && problem.includes('output/debug.txt')));
    assert.ok(artifactProblems.some((problem) => problem.includes('executable permission bits') && problem.includes('renderer.js')));
  });
});

test('relative require graph stays inside the artifact and allows the Resolve native sidecar', () => {
  withTempDir((root) => {
    writeFiles(root, ['main.js', 'preload.js', 'lib/util.js']);
    writeFileSync(path.join(root, 'main.js'), "require('./preload'); require('./WorkflowIntegration.node');");
    writeFileSync(path.join(root, 'preload.js'), "require('../outside'); require('./lib/missing');");
    assert.deepEqual(requireGraphProblems(root, inventory(root).files), [
      'require graph: preload.js references missing module ../outside',
      'require graph: preload.js references missing module ./lib/missing',
    ]);
  });
});
