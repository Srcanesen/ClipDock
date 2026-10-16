import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';

test('media-prep POSIX fake children never send a real process-group signal', () => {
  const trap = `process.kill = (pid, signal) => {console.log('UNSAFE_FAKE_SIGNAL', pid, signal); throw Object.assign(new Error('intercepted'), {code: 'ESRCH'});};`;
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(trap)}`, '--test', 'test/media-prep.test.mjs', 'test/media-prep-checks.test.mjs'], {encoding: 'utf8', env});
  assert.doesNotMatch(result.stdout + result.stderr, /UNSAFE_FAKE_SIGNAL/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
