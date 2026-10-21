import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {ProviderJobRunner, ProviderJobCancelledError, ProviderSession, abortableFetch} = createRequire(import.meta.url)('../dist/provider-job.js');

const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
// A hostile body: cancel is counted and never acknowledged.
const hostileResponse = () => { const response = {status: 200, cancels: 0, body: {cancel: () => { response.cancels++; return new Promise(() => {}); }}}; return response; };
const fetchContext = (controller, headers, terminations) => ({fetch: () => headers.promise, signal: controller.signal, cancelledMessage: 'Provider request cancelled.', terminations});

test('abortableFetch: user cancel before headers rejects at once and disposal owns the late body', async () => {
  const controller = new AbortController(), headers = deferred(), terminations = new Set();
  const pending = abortableFetch('https://example.test/a', {}, fetchContext(controller, headers, terminations));
  controller.abort(new ProviderJobCancelledError('Download cancelled.'));
  await assert.rejects(pending, {message: 'Provider request cancelled.'});
  assert.equal(terminations.size, 1);
  const late = hostileResponse();
  headers.resolve(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.cancels, 1);
  assert.equal(terminations.size, 1, 'the unacknowledged body cancel stays with disposal');
});

test('abortableFetch: a timeout abort cancels a late body in the background without tracking it', async () => {
  const controller = new AbortController(), headers = deferred(), terminations = new Set();
  const pending = abortableFetch('https://example.test/b', {}, fetchContext(controller, headers, terminations));
  controller.abort(new Error('Provider request timed out.'));
  await assert.rejects(pending, {message: 'Provider request cancelled.'});
  const late = hostileResponse();
  headers.resolve(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.cancels, 1);
  assert.equal(terminations.size, 0);
});

test('abortableFetch: headers before cancel hand the live body to the caller', async () => {
  const controller = new AbortController(), headers = deferred(), terminations = new Set(), seen = [];
  const response = hostileResponse();
  headers.resolve(response);
  const result = await abortableFetch('https://example.test/c', {redirect: 'manual'}, {...fetchContext(controller, headers, terminations), fetch: (url, init) => { seen.push([url, init.redirect]); return headers.promise; }});
  controller.abort(new ProviderJobCancelledError('Download cancelled.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result, response);
  assert.deepEqual(seen, [['https://example.test/c', 'manual']]);
  assert.equal(response.cancels, 0);
  assert.equal(terminations.size, 0);
});

const sessionFixture = name => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'clipdock-session-')));
  const path = join(parent, name);
  mkdirSync(path, {mode: 0o700});
  return {parent, path};
};
const jobs = () => new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'Worker shut down.'});

test('ProviderSession recreates a pruned provider directory through its parent before the job directory', async () => {
  const {parent, path} = sessionFixture('pinterest');
  let recreated = 0;
  const session = new ProviderSession(path, ['pinterest'], () => { recreated++; });
  rmSync(path, {recursive: true});
  const jobDir = join(path, 'download-1');
  const seen = await session.run(jobs(), 'job-1', jobDir, async context => {
    context.publish(jobDir);
    return [existsSync(jobDir), session.jobDirectories.has(jobDir)];
  }, {});
  assert.deepEqual(seen, [true, true]);
  assert.equal(recreated, 1);
  assert.equal(lstatSync(path).mode & 0o777, 0o700);
  assert.equal(session.jobDirectories.size, 0);
  rmSync(parent, {recursive: true});
});

test('ProviderSession rejects a replaced provider and never recreates an unnamed session root', async () => {
  const replaced = sessionFixture('pinterest');
  const session = new ProviderSession(replaced.path, ['pinterest']);
  rmSync(replaced.path, {recursive: true});
  symlinkSync(tmpdir(), replaced.path);
  let ran = 0;
  await assert.rejects(session.run(jobs(), 'job-2', join(replaced.path, 'download-2'), async () => { ran++; }, {}), {name: 'SafeFsError', code: 'symlink'});
  assert.equal(lstatSync(replaced.path).isSymbolicLink(), true);

  const unnamed = sessionFixture('selected-root');
  const fixed = new ProviderSession(unnamed.path, ['pinterest']);
  rmSync(unnamed.path, {recursive: true});
  await assert.rejects(fixed.run(jobs(), 'job-3', join(unnamed.path, 'download-3'), async () => { ran++; }, {}), {name: 'SafeFsError', code: 'replaced'});
  assert.equal(existsSync(unnamed.path), false);
  assert.equal(ran, 0);
  rmSync(replaced.parent, {recursive: true});
  rmSync(unnamed.parent, {recursive: true});
});
