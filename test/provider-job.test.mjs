import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {mkdtempSync, mkdirSync, lstatSync, renameSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {ProviderJobRunner, ProviderJobCancelledError, ProviderJobRejectedError, requireFfprobe} = createRequire(import.meta.url)('../dist/provider-job.js');
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const runner = (single = true) => new ProviderJobRunner({cancelledMessage: 'Download cancelled.', disposedMessage: 'Worker shut down.', ...(single ? {busyMessage: 'Worker busy.'} : {})});
const cancelled = pending => assert.rejects(pending, error => error instanceof ProviderJobCancelledError && error.message === 'Download cancelled.');

for (const boundary of ['before work', 'during body', 'after body resolves']) {
  test(`cancellation ${boundary} discards the result exactly once`, async () => {
    const jobs = runner(), gate = deferred(); let effects = 0, terminals = 0;
    const pending = jobs.run('job', async context => {
      await gate.promise;
      if (boundary === 'before work') context.check();
      effects++;
      if (boundary === 'after body resolves') queueMicrotask(() => jobs.cancel('job'));
      else if (boundary === 'during body') { await tick(); context.check(); }
      return 'late result';
    }, {terminal: outcome => {terminals++; assert.equal(outcome.state, 'cancelled'); assert.equal(outcome.error.message, 'Download cancelled.');}});
    const rejection = cancelled(pending);
    if (boundary === 'before work') jobs.cancel('job');
    gate.resolve();
    if (boundary === 'during body') { await Promise.resolve(); jobs.cancel('job'); }
    await rejection;
    assert.equal(effects, boundary === 'before work' ? 0 : 1);
    assert.equal(terminals, 1);
    assert.equal(jobs.cancel('job'), null);
    assert.equal(jobs.isActive(), false);
  });
}

test('cancel and repeated dispose await operation termination and body cleanup', async () => {
  const jobs = runner(), end = deferred(), cleanup = deferred(); let stopped = 0, cleaned = false;
  let registered;
  const cancelOperation = async () => {stopped++; await end.promise;};
  const pending = jobs.run('job', async context => {
    try { await context.perform(() => end.promise, cancelOperation, value => {registered = value;}); return 'unexpected'; }
    finally { await cleanup.promise; cleaned = true; }
  });
  const rejection = cancelled(pending);
  const cancelling = jobs.cancel('job');
  const disposals = [jobs.dispose(), jobs.dispose()]; let settled = 0;
  for (const done of [cancelling, ...disposals]) done.then(() => {settled++;});
  await tick(); assert.equal(stopped, 1); assert.equal(settled, 0);
  end.resolve('operation ended'); await tick(); assert.equal(settled, 0);
  cleanup.resolve(); await Promise.all([rejection, cancelling, ...disposals]);
  assert.equal(cleaned, true); assert.equal(settled, 3); assert.equal(registered, 'operation ended');
});

test('duplicate ids never overwrite a job; single-worker admission also rejects another id', async () => {
  for (const single of [true, false]) {
    const jobs = runner(single), gate = deferred(), events = []; let bodies = 0;
    const options = {terminal: outcome => events.push(outcome.state)};
    const pending = jobs.run('job', async () => {bodies++; await gate.promise; return 'original';}, options);
    await assert.rejects(jobs.run('job', async () => {bodies++; return 'duplicate';}, options), error => error instanceof ProviderJobRejectedError && error.kind === 'busy' && error.message === (single ? 'Worker busy.' : 'Provider job job is already active.'));
    if (single) await assert.rejects(jobs.run('other', async () => 'other', options), error => error instanceof ProviderJobRejectedError && error.kind === 'busy' && error.message === 'Worker busy.');
    assert.equal(bodies, 1); assert.deepEqual(events, []);
    gate.resolve(); assert.equal(await pending, 'original'); assert.deepEqual(events, ['completed']);
    assert.equal(await jobs.run('job', async () => 'retry'), 'retry');
  }
});

for (const outcome of ['completed', 'failed', 'cancelled', 'late cancel', 'cancel before publish']) {
  test(`registered files follow the ${outcome} outcome`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'provider-job-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const jobs = runner(), file = join(root, 'output'), partial = join(root, 'partial');
    let committed = 0;
    const pending = jobs.run('job', async context => {
      for (const target of [file, partial]) {context.register(target); writeFileSync(target, 'created');}
      if (outcome === 'failed') throw new Error('literal failure');
      if (outcome === 'cancelled' || outcome === 'cancel before publish') jobs.cancel('job');
      if (outcome !== 'cancelled') context.publish(file, () => {committed++;});
      if (outcome === 'late cancel') queueMicrotask(() => jobs.cancel('job'));
      return 'published';
    });
    if (outcome === 'completed') assert.equal(await pending, 'published');
    else if (outcome === 'failed') await assert.rejects(pending, {message: 'literal failure'});
    else await cancelled(pending);
    assert.equal(existsSync(file), outcome === 'completed');
    assert.equal(existsSync(partial), false);
    assert.equal(committed, outcome === 'completed' ? 1 : 0);
  });
}

test('dispose awaits every concurrent job, including one already cancelling', async () => {
  const jobs = runner(false), gates = [deferred(), deferred()];
  const pending = gates.map((gate, i) => jobs.run(String(i), async () => {await gate.promise; return i;}));
  const rejections = pending.map(cancelled);
  jobs.cancel('0'); let disposed = false;
  const disposing = jobs.dispose().then(() => {disposed = true;});
  gates[0].resolve(); await tick(); assert.equal(disposed, false);
  gates[1].resolve(); await Promise.all([...rejections, disposing]);
  assert.equal(disposed, true); assert.equal(jobs.isActive(), false);
});

test('timeout is a failure, while an explicit cancellation preserves per-job message text', async () => {
  const jobs = runner(), gate = deferred();
  const timed = jobs.run('timed', async context => {await gate.promise; context.check(); return 'late';}, {timeoutMs: 1, timeoutMessage: 'Tool timed out.'});
  await new Promise(resolve => setTimeout(resolve, 10)); gate.resolve();
  await assert.rejects(timed, error => error.constructor === Error && error.message === 'Tool timed out.');
  const release = deferred();
  const pending = jobs.run('metadata', async () => {await release.promise; return 'late';}, {cancelledMessage: 'Pinterest request cancelled.'});
  jobs.cancel('metadata'); release.resolve();
  await assert.rejects(pending, error => error instanceof ProviderJobCancelledError && error.message === 'Pinterest request cancelled.');
  const child = runner(); let terminal;
  const nested = jobs.run('nested', context => context.perform(
    () => child.run('phase', async phase => {
      await new Promise(resolve => phase.signal.addEventListener('abort', resolve, {once: true}));
      phase.check();
    }, {cancelledMessage: 'Media preparation cancelled.'}),
    () => child.cancel('phase'),
  ), {terminal: outcome => {terminal = [outcome.state, outcome.error.terminalMessage];}});
  const rejected = cancelled(nested);
  await jobs.cancel('nested'); await rejected;
  assert.deepEqual(terminal, ['cancelled', 'Media preparation cancelled.']);
});

// Adapted from the reviewer's jobs-lifecycle-scenarios.cjs publication case.
test('gate: a later throwing publication cannot delete an earlier card-referenced file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-job-commit-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const jobs = runner(), first = join(root, 'first.mp4'), second = join(root, 'second.mp4');
  const cards = new Map();
  await assert.rejects(jobs.run('job', async context => {
    for (const file of [first, second]) {context.register(file); writeFileSync(file, 'media');}
    context.publish(first, () => cards.set('card', first));
    context.publish(second, () => {throw new Error('Second commit failed.');});
    return 'published';
  }), {message: 'Second commit failed.'});
  assert.equal(cards.get('card'), first);
  assert.equal(readFileSync(first, 'utf8'), 'media');
  assert.equal(existsSync(second), false, 'an uncommitted, unreferenced file is still removed');
  assert.equal(jobs.isActive(), false);
});

for (const outcome of ['cancel', 'failure']) {
  test(`owned temporary directory replaced by another directory survives ${outcome}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'provider-job-directory-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const jobs = runner(), directory = join(root, 'job'), moved = join(root, 'moved-job');
    const pending = jobs.run('job', async context => {
      context.createDirectory(directory);
      const owned = lstatSync(directory);
      writeFileSync(join(directory, 'partial'), 'job output');
      renameSync(directory, moved);
      mkdirSync(directory);
      assert.notEqual(lstatSync(directory).ino, owned.ino);
      writeFileSync(join(directory, 'user-media.mov'), 'irreplaceable user media');
      if (outcome === 'cancel') {jobs.cancel('job'); return 'late result';}
      throw new Error('Tool failed.');
    });
    if (outcome === 'cancel') await cancelled(pending);
    else await assert.rejects(pending, {message: 'Tool failed.'});
    assert.equal(readFileSync(join(directory, 'user-media.mov'), 'utf8'), 'irreplaceable user media');
    assert.equal(readFileSync(join(moved, 'partial'), 'utf8'), 'job output');
    assert.equal(jobs.isActive(), false);
  });
}

test('temporary-directory ownership refuses an existing directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-job-existing-directory-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const jobs = runner();
  writeFileSync(join(root, 'user-media.mov'), 'keep');
  await assert.rejects(jobs.run('job', async context => {
    context.createDirectory(root);
    return 'unexpected';
  }), {code: 'EEXIST'});
  assert.equal(readFileSync(join(root, 'user-media.mov'), 'utf8'), 'keep');
});

test('temporary-directory ownership preserves a symlink replacing the created directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-job-directory-link-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const jobs = runner(), directory = join(root, 'job'), moved = join(root, 'moved-job');
  await assert.rejects(jobs.run('job', async context => {
    context.createDirectory(directory);
    writeFileSync(join(directory, 'media'), 'keep');
    renameSync(directory, moved);
    symlinkSync(moved, directory);
    throw new Error('Tool failed.');
  }), {message: 'Tool failed.'});
  assert.equal(lstatSync(directory).isSymbolicLink(), true);
  assert.equal(readFileSync(join(moved, 'media'), 'utf8'), 'keep');
});

for (const publication of ['file', 'directory']) {
  test(`later failure preserves a published ${publication} inside temporary-directory ownership`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'provider-job-nested-publication-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const jobs = runner(), directory = join(root, 'job'), file = join(directory, 'media.mp4'), next = join(root, 'next.mp4');
    const cards = new Map();
    await assert.rejects(jobs.run('job', async context => {
      context.createDirectory(directory);
      for (const output of [file, next]) {context.register(output); writeFileSync(output, 'media');}
      context.publish(publication === 'file' ? file : directory, () => cards.set('card', file));
      context.publish(next, () => {throw new Error('Second commit failed.');});
      return 'published';
    }), {message: 'Second commit failed.'});
    assert.equal(cards.get('card'), file);
    assert.equal(readFileSync(file, 'utf8'), 'media');
    assert.equal(existsSync(next), false);
  });
}


test('admission validates ids and prerequisites before work; rejected work has no terminal event', async () => {
  const jobs = runner(), events = []; let bodies = 0, prerequisites = 0, mapped = 0;
  const options = {
    invalidMessage: 'Invalid download request.',
    prerequisites: () => { prerequisites++; requireFfprobe(false); },
    mapError: error => {mapped++; return error;},
    terminal: outcome => events.push(outcome.state),
  };
  for (const id of ['', '../escape', 'x'.repeat(81), null]) {
    await assert.rejects(jobs.run(id, async () => {bodies++;}, options), {message: 'Invalid download request.'});
  }
  await assert.rejects(jobs.run('valid_Job-7', async () => {bodies++;}, options), {message: 'ffprobe was not found. Install ffprobe or set CLIPDOCK_FFPROBE_PATH to an absolute executable path.'});
  assert.deepEqual([bodies, prerequisites, mapped, events, jobs.isActive()], [0, 1, 0, [], false]);
  assert.equal(await jobs.run('valid_Job-7', async () => 'admitted', {...options, prerequisites: () => {prerequisites++; requireFfprobe(true);}}), 'admitted');
  assert.deepEqual([prerequisites, events], [2, ['completed']]);
  await jobs.dispose();
  await assert.rejects(jobs.run('disposed', async () => {bodies++;}, options), error => error instanceof ProviderJobRejectedError && error.kind === 'disposed' && error.message === 'Worker shut down.');
  assert.deepEqual([bodies, prerequisites, mapped, events], [0, 2, 0, ['completed']]);
});

test('one terminal notification owns success, mapped failure, thrown values, deadlines and publication failures', async t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-job-outcome-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [kind, expected] of [
    ['completed', ['completed', 'literal result']],
    ['failed', ['failed', 'mapped: literal failure']],
    ['thrown value', ['failed', 'mapped: literal failure']],
    ['timeout', ['failed', 'mapped: deadline expired']],
    ['publication', ['failed', 'mapped: commit failed']],
    ['mapping', ['failed', 'mapping failed']],
    ['cleanup', ['failed', 'mapped: cleanup failed']],
  ]) {
    const jobs = runner(), events = [], file = join(root, kind); let mapped = 0;
    const pending = jobs.run('job', async context => {
      context.register(file); writeFileSync(file, 'unpublished');
      if (kind === 'completed') {context.publish(file); return 'literal result';}
      if (kind === 'publication') {context.publish(file, () => {throw new Error('commit failed');}); return 'uncommitted';}
      if (kind === 'cleanup') {t.mock.method(fs, 'unlinkSync', () => {throw new Error('cleanup failed');}); return 'unpublished';}
      if (kind === 'timeout') await new Promise(resolve => setTimeout(resolve, 10));
      throw kind === 'thrown value' ? 'literal failure' : new Error('literal failure');
    }, {
      ...(kind === 'timeout' ? {timeoutMs: 1, timeoutMessage: 'deadline expired'} : {}),
      mapError: error => { mapped++; if (kind === 'mapping') throw new Error('mapping failed'); return new Error(`mapped: ${error.message}`); },
      terminal: outcome => {
        assert.equal(jobs.isActive(), false);
        assert.equal(jobs.cancel('job'), null);
        if (kind !== 'completed' && kind !== 'cleanup') assert.equal(existsSync(file), false);
        events.push(outcome.state === 'completed' ? [outcome.state, outcome.result] : [outcome.state, outcome.error.message]);
      },
    });
    if (kind === 'completed') assert.equal(await pending, 'literal result');
    else await assert.rejects(pending, {message: expected[1]});
    assert.deepEqual(events, [expected]);
    assert.equal(mapped, kind === 'completed' ? 0 : 1);
    t.mock.restoreAll();
  }
});
