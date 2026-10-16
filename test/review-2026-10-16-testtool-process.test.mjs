import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guard = new URL('../scripts/test-process-safety.mjs', import.meta.url).href;

test('provider fake-child fixtures never signal an unowned process group', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', guard, '--test',
    'test/ytdlp.test.mjs', 'test/gallerydl.test.mjs',
    'test/provider-platform.test.mjs', 'test/ytdlp-checks.test.mjs',
    'test/media-prep.test.mjs', 'test/media-prep-checks.test.mjs',
  ], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /Blocked unowned process-group signal/);
});

test('signal trap blocks even a caught unowned signal and fails the worker', () => {
  const result = spawnSync(process.execPath, ['--import', guard, '-e',
    "const {kill} = await import('node:process'); try { kill(-4242, 'SIGKILL'); } catch (error) { console.log(error.code); }",
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'UNOWNED_PROCESS_GROUP\n');
  assert.match(result.stderr, /Blocked unowned process-group signal: -4242 SIGKILL/);
});
