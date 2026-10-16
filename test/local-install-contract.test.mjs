import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function artifactInventory() {
  const dist = path.join(root, 'dist');
  const result = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:js|html|css)$/.test(entry.name)) result[path.relative(dist, file)] = readFileSync(file, 'utf8');
    }
  };
  walk(dist);
  return result;
}

test('active ClipDock has one marker-free install contract and no runtime licensing surface', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['install:plugin'], 'npm run build && node scripts/install-plugin.mjs');
  assert.equal(pkg.scripts['verify:installed'], 'node scripts/verify-installed-plugin.mjs');
  for (const script of ['install:plugin:dev', 'install:plugin:production', 'verify:installed:dev', 'verify:installed:production']) {
    assert.equal(pkg.scripts[script], undefined);
  }

  const activeSources = ['src/main.ts', 'src/main-process.ts', 'src/preload.ts', 'src/shared.ts', 'src/renderer.ts', 'src/preview.ts', 'static/index.html'];
  for (const source of activeSources) assert.doesNotMatch(read(source), /licen(?:se|sing)|activation_required|clipdock-dev-mode/i, source);
  assert.equal(existsSync(path.join(root, 'src', 'licensing')), false);

  const artifact = artifactInventory();
  assert.equal(Object.keys(artifact).some((file) => file.startsWith('licensing/')), false);
  for (const [file, source] of Object.entries(artifact)) assert.doesNotMatch(source, /licen(?:se|sing)|activation_required|clipdock-dev-mode/i, file);
});
