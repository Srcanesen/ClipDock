import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-release-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['scripts', 'src', 'static', 'dist', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.cpSync(entry, path.join(root, entry), { recursive: true });
  }
  return root;
}

for (const kind of ['empty', 'partial', 'stale', 'modified']) {
  test(`release CLI rejects a ${kind} build instead of approving it for shipping`, (t) => {
    const root = fixture(t);
    const dist = path.join(root, 'dist');
    if (kind === 'empty') { fs.rmSync(dist, { recursive: true }); fs.mkdirSync(dist); }
    if (kind === 'partial') fs.rmSync(path.join(dist, 'renderer.js'));
    if (kind === 'stale') fs.appendFileSync(path.join(root, 'src', 'main.ts'), '\n// unbuilt change\n');
    if (kind === 'modified') fs.appendFileSync(path.join(dist, 'main.js'), '\n// changed after build\n');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'stage-release.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ARTIFACT CHECK FAILED/);
  });
}

test('release CLI accepts an unchanged completed build', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'stage-release.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARTIFACT CHECK PASSED: \d+ files/);
});
