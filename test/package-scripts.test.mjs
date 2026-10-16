import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('validate combines deterministic tests and artifact verification without live Resolve', () => {
  assert.equal(packageJson.scripts.validate, 'npm test && npm run check');
  assert.doesNotMatch(packageJson.scripts.validate, /test:resolve:headless/);
});

test('local install and installed verification expose one canonical command each', () => {
  assert.equal(packageJson.scripts['install:plugin'], 'npm run build && node scripts/install-plugin.mjs');
  assert.equal(packageJson.scripts['verify:installed'], 'node scripts/verify-installed-plugin.mjs');
  for (const name of ['install:plugin:dev', 'install:plugin:production', 'verify:installed:dev', 'verify:installed:production', 'stage:production']) {
    assert.equal(packageJson.scripts[name], undefined, `${name} must not remain an active mode contract`);
  }
});
