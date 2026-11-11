// Adversarial contract tests derived from the task statement, independently of
// history-retry-preparation.test.mjs. Only process and fault boundaries are fake.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {createHistoryPreparationHandlers} from '../dist/main-process.js';
import {createMediaPrep} from '../dist/media-prep.js';
import {deferred, historyInput, mainFixture} from './helpers/files-main.mjs';
import {createHarness} from './helpers/renderer-harness.mjs';

const SOURCE = 'downloaded source: must survive';
const PREPARED = 'complete prepared media';
const RUNNING = 'Conversion is running for this item. Cancel it first.';
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 250 && !predicate(); i++) await turn();
  assert.equal(predicate(), true, 'the fake process must reach the requested boundary');
}

class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; }
  kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}

function probe({source = false, direct = false, profile = 'fast', invalid = false} = {}) {
  const editing = !source && profile === 'editing';
  return JSON.stringify({
    streams: [{codec_type: 'video', codec_name: editing ? 'prores' : 'h264', pix_fmt: editing ? 'yuv422p10le' : 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: invalid ? '1' : '10'}],
    format: {duration: invalid ? '1' : '10', format_name: source && !direct ? 'matroska,webm' : 'mov,mp4', tags: {major_brand: editing ? 'qt  ' : 'isom'}},
  });
}

// Run the real conversion/publication/cleanup code. Children have no PID and
// never start or signal an OS process. Each paused phase resumes explicitly.
function preparation(t, options = {}) {
  const children = [], outputs = [], entered = deferred();
  let probes = 0, resume;
  const prep = createMediaPrep({ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', platform: 'linux', killGraceMs: 5,
    spawn(binary, args) {
      const child = new Child(); children.push(child);
      const phase = binary === '/fake/ffmpeg' ? 'conversion' : ++probes === 1 ? 'source probe' : 'output probe';
      queueMicrotask(() => {
        if (phase === 'conversion') { outputs.push(args.at(-1)); fs.writeFileSync(args.at(-1), PREPARED); }
        const finish = () => {
          if (options.fail === phase) { child.stderr.emit('data', `injected ${phase} failure\n`); child.emit('close', 1); return; }
          if (phase === 'conversion') child.stderr.emit('data', 'out_time_us=5000000\nprogress=continue\nprogress=end\n');
          else child.stdout.emit('data', probe({source: phase === 'source probe', direct: options.direct, profile: options.profile, invalid: options.fail === 'validation' && phase === 'output probe'}));
          child.emit('close', 0);
        };
        if (options.pause === phase) { resume = finish; entered.resolve(); }
        else finish();
      });
      return child;
    },
  });
  t.after(() => prep.dispose());
  return {prep, children, outputs, entered: entered.promise, resume: () => resume()};
}

function fixture(t, {profile = 'fast', marker = true, thumbnails} = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'clipdock-retry-refute-')));
  const root = path.join(dir, 'downloads'); fs.mkdirSync(root);
  const input = path.join(root, 'clip.mkv'); fs.writeFileSync(input, SOURCE);
  const store = path.join(dir, 'data', 'history.json');
  const history = new DownloadHistory(store, root, () => 'Project', thumbnails);
  const record = history.add({...historyInput(input), ...(marker ? {preparationFailed: {profile}} : {})});
  const ledger = new DownloadLedger(history, () => false);
  const cardId = ledger.listHistory()[0].cardId;
  const before = {record: history.get(record.id), store: fs.readFileSync(store, 'utf8')};
  t.after(async () => {await history.dispose(); fs.rmSync(dir, {recursive: true, force: true});});
  return {dir, root, input, store, history, record, ledger, cardId, before};
}

function handlers(f, prep, overrides = {}) {
  return createHistoryPreparationHandlers({history: f.history, prepareMedia: request => prep.prepare(request), cancelMediaPreparation: id => prep.cancel(id), replaced: id => f.ledger.bindHistory(id), ...overrides});
}

function unchanged(f) {
  assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE, 'source bytes survive');
  assert.deepEqual(f.history.get(f.record.id), f.before.record, 'in-memory record is unchanged');
  assert.equal(fs.readFileSync(f.store, 'utf8'), f.before.store, 'persisted record is unchanged');
  assert.equal(f.history.resolve(f.record.id)?.path, f.input, 'record resolves to its surviving source');
  assert.equal(f.ledger.resolve(f.cardId)?.path, f.input, 'original History drag binding remains usable');
  assert.deepEqual(fs.readdirSync(f.root), ['clip.mkv'], 'no partial directory or orphan prepared file');
}

async function restartRecord(t, f) {
  const history = new DownloadHistory(f.store, f.root);
  t.after(() => history.dispose());
  return {record: history.get(f.record.id), resolved: history.resolve(f.record.id)?.path};
}

for (const profile of ['fast', 'editing']) {
  test(`retry commits ${profile} to the same record and refreshes History drag and thumbnail cache`, async t => {
    let frame = 1;
    const thumbnails = {tools: async () => ({ffmpegPath: '/fake/thumb', ffprobePath: '/fake/probe'}), spawn(_binary, args) {
      const child = new Child();
      queueMicrotask(() => {child.stdout.emit('data', args.includes('-show_entries') ? '{"format":{"duration":"10"}}' : Buffer.from([255, 216, frame, 0, 255, 217])); child.emit('close', 0);});
      return child;
    }};
    const f = fixture(t, {profile, thumbnails});
    const cached = await f.history.thumbnail(f.record.id);
    assert.equal(cached, 'data:image/jpeg;base64,/9gBAP/Z');
    const {prep} = preparation(t, {profile}); const h = handlers(f, prep); const progress = [];
    assert.deepEqual(await h.retryPreparation(f.record.id, update => progress.push(update)), {cancelled: false, profile});
    const next = f.history.get(f.record.id), hit = f.history.resolve(f.record.id);
    assert.equal(next.id, f.record.id); assert.equal(next.profile, profile); assert.equal('preparationFailed' in next, false);
    assert.equal(next.available, true); assert.equal(fs.readFileSync(hit.path, 'utf8'), PREPARED);
    assert.equal(path.extname(hit.path), profile === 'fast' ? '.mp4' : '.mov');
    assert.equal(f.history.list().length, 1); assert.deepEqual(fs.readdirSync(f.root), [path.basename(hit.path)]);
    assert.equal(f.ledger.resolve(f.cardId), null, 'old passive binding is retired');
    assert.equal(f.ledger.resolve(f.ledger.listHistory()[0].cardId)?.path, hit.path);
    assert.equal(progress[0].percent, 0); assert.equal(progress.at(-1).percent, 100);
    assert.equal(progress.every(update => update.id === f.record.id), true);
    frame = 2;
    assert.equal(await f.history.thumbnail(f.record.id), 'data:image/jpeg;base64,/9gCAP/Z', 'old artwork is invalidated');
    const restarted = await restartRecord(t, f);
    assert.deepEqual(restarted.record, next); assert.equal(restarted.resolved, hit.path);
    assert.equal(await h.cancelPreparation(f.record.id), false);
  });
}

test('a direct-compatible retry never deletes the file that remains in History', async t => {
  const f = fixture(t); const {prep, outputs} = preparation(t, {direct: true}); const h = handlers(f, prep);
  assert.deepEqual(await h.retryPreparation(f.record.id), {cancelled: false, profile: 'fast'});
  assert.equal(f.history.resolve(f.record.id)?.path, f.input); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
  assert.equal(f.history.get(f.record.id).profile, 'fast'); assert.equal('preparationFailed' in f.history.get(f.record.id), false);
  assert.deepEqual(outputs, []); assert.deepEqual(fs.readdirSync(f.root), ['clip.mkv']);
});

for (const phase of ['source probe', 'conversion', 'output probe', 'validation']) {
  test(`retry ${phase} failure keeps source and record and removes all prepared output`, async t => {
    const f = fixture(t); const {prep, outputs} = preparation(t, {fail: phase}); const h = handlers(f, prep);
    await assert.rejects(h.retryPreparation(f.record.id), phase === 'validation' ? /Prepared media failed validation/ : new RegExp(`injected ${phase} failure`));
    unchanged(f);
    assert.equal(outputs.every(file => !fs.existsSync(file)), true);
    if (phase !== 'source probe') assert.ok(outputs.length > 0, 'failure happens after output was written');
    assert.equal(await h.cancelPreparation(f.record.id), false);
    assert.deepEqual((await restartRecord(t, f)).record, f.before.record);
  });
}

for (const phase of ['source probe', 'conversion', 'output probe']) {
  test(`cancel during ${phase} keeps the exact source and record without partial output`, async t => {
    const f = fixture(t); const {prep, entered, children, outputs} = preparation(t, {pause: phase}); const h = handlers(f, prep);
    const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await entered;
    assert.equal(await h.cancelPreparation(f.record.id), true);
    assert.deepEqual(await pending, {cancelled: true}); unchanged(f);
    assert.deepEqual(children.at(-1).signals, ['SIGTERM']);
    assert.equal(outputs.every(file => !fs.existsSync(file)), true);
    assert.equal(await h.cancelPreparation(f.record.id), false);
  });
}

test('a throwing progress recipient cannot consume the source or mutate History', async t => {
  const f = fixture(t); const {prep} = preparation(t); const h = handlers(f, prep);
  await assert.rejects(h.retryPreparation(f.record.id, () => {throw new Error('progress recipient gone');}), /progress recipient gone/);
  unchanged(f);
});

test('cancel after publication but before History replacement removes the completed output', async t => {
  const f = fixture(t); const {prep} = preparation(t); const published = deferred(), release = deferred(); let output;
  const h = handlers(f, prep, {prepareMedia: async request => {const result = await prep.prepare(request); output = result.filePath; published.resolve(); await release.promise; return result;}});
  const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await published.promise;
  try {
    assert.equal(fs.readFileSync(output, 'utf8'), PREPARED); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
    assert.equal(await h.cancelPreparation(f.record.id), true);
  } finally {release.resolve();}
  assert.deepEqual(await pending, {cancelled: true}); unchanged(f); assert.equal(fs.existsSync(output), false);
});

test('History replacement refusal after publication rolls back the prepared file', async t => {
  const f = fixture(t); const {prep} = preparation(t); let output;
  t.mock.method(f.history, 'replacePreparedArtifact', (_id, next) => {output = next.filePath; assert.equal(fs.readFileSync(output, 'utf8'), PREPARED); return null;});
  await assert.rejects(handlers(f, prep).retryPreparation(f.record.id), /History item could not be updated/);
  unchanged(f); assert.equal(fs.existsSync(output), false);
});

test('a failed History save after in-memory replacement preserves the exact old record and source', async t => {
  const f = fixture(t); const {prep} = preparation(t); let saved = 0;
  t.mock.method(f.history, 'save', () => {saved++; throw Object.assign(new Error('injected history ENOSPC'), {code: 'ENOSPC'});});
  await assert.rejects(handlers(f, prep).retryPreparation(f.record.id), /injected history ENOSPC/);
  assert.equal(saved, 1); unchanged(f);
  assert.deepEqual((await restartRecord(t, f)).record, f.before.record);
});

test('a ledger refresh failure after the commit must not delete the prepared History file', async t => {
  const f = fixture(t); const {prep} = preparation(t);
  assert.deepEqual(await handlers(f, prep, {replaced: () => {throw new Error('ledger unavailable');}}).retryPreparation(f.record.id), {cancelled: false, profile: 'fast'});
  const hit = f.history.resolve(f.record.id); assert.equal(fs.readFileSync(hit.path, 'utf8'), PREPARED);
  assert.equal(f.ledger.resolve(f.ledger.listHistory()[0].cardId)?.path, hit.path);
  assert.equal((await restartRecord(t, f)).resolved, hit.path);
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(hit.path)]);
});

test('two racing retries admit exactly one preparation and a cancelled retry can run again', async t => {
  const f = fixture(t); const {prep, entered} = preparation(t, {pause: 'conversion'}); let starts = 0;
  const h = handlers(f, prep, {prepareMedia: request => {starts++; return prep.prepare(request);}});
  const first = h.retryPreparation(f.record.id); void first.catch(() => {});
  const second = assert.rejects(h.retryPreparation(f.record.id), error => {assert.equal(error.kind, 'busy'); assert.match(error.message, /already running/); return true;});
  await entered; await second; assert.equal(starts, 1);
  await h.cancelPreparation(f.record.id); assert.deepEqual(await first, {cancelled: true}); unchanged(f);
  const again = h.retryPreparation(f.record.id); void again.catch(() => {}); await until(() => starts === 2 && prep.isActive());
  await h.cancelPreparation(f.record.id); assert.deepEqual(await again, {cancelled: true}); unchanged(f);
});

test('retry then delete then cancel refuses deletion and preserves the original until cancellation settles', async t => {
  const f = fixture(t); const {prep, entered} = preparation(t, {pause: 'conversion'}); const h = handlers(f, prep);
  const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await entered;
  assert.throws(() => f.ledger.deleteHistory(f.record.id), {message: RUNNING});
  assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE); assert.deepEqual(f.history.get(f.record.id), f.before.record);
  await h.cancelPreparation(f.record.id); assert.deepEqual(await pending, {cancelled: true}); unchanged(f);
  const deleted = f.ledger.deleteHistory(f.record.id); assert.equal(deleted.deleted, true); assert.equal(deleted.removed, true);
  assert.equal(fs.existsSync(f.input), false); assert.equal(f.history.get(f.record.id), null);
  assert.equal(await h.cancelPreparation(f.record.id), false);
});

test('cancel requested before delete still holds deletion protection until the retry drains', async t => {
  const f = fixture(t); const {prep} = preparation(t); const published = deferred(), release = deferred();
  const h = handlers(f, prep, {prepareMedia: async request => {const result = await prep.prepare(request); published.resolve(); await release.promise; return result;}});
  const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await published.promise;
  try {await h.cancelPreparation(f.record.id); assert.throws(() => f.ledger.deleteHistory(f.record.id), {message: RUNNING});}
  finally {release.resolve();}
  assert.deepEqual(await pending, {cancelled: true}); unchanged(f);
});

test('delete then retry then cancel never resurrects the deleted record or starts preparation', async t => {
  const f = fixture(t); let starts = 0;
  const h = createHistoryPreparationHandlers({history: f.history, prepareMedia: async () => {starts++; throw new Error('unexpected preparation');}, cancelMediaPreparation: () => null, replaced() {}});
  assert.equal(f.ledger.deleteHistory(f.record.id).deleted, true);
  await assert.rejects(h.retryPreparation(f.record.id), /no failed conversion/);
  assert.equal(await h.cancelPreparation(f.record.id), false); assert.equal(starts, 0);
  assert.equal(f.history.get(f.record.id), null); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('successful retry then delete then cancel leaves neither a dangling record nor prepared output', async t => {
  const f = fixture(t); const {prep} = preparation(t); const h = handlers(f, prep);
  await h.retryPreparation(f.record.id); const prepared = f.history.resolve(f.record.id).path;
  assert.equal(f.ledger.deleteHistory(f.record.id).deleted, true);
  assert.equal(await h.cancelPreparation(f.record.id), false); assert.equal(f.history.get(f.record.id), null);
  assert.equal(fs.existsSync(prepared), false); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.deepEqual(f.ledger.listHistory(), []);
});

test('bulk History clear containing one running retry refuses the entire metadata removal', async t => {
  const f = fixture(t); const other = path.join(f.root, 'other.mp4'); fs.writeFileSync(other, 'other');
  const idle = f.history.add(historyInput(other)); const before = fs.readFileSync(f.store, 'utf8');
  const {prep, entered} = preparation(t, {pause: 'conversion'}); const h = handlers(f, prep);
  const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await entered;
  assert.throws(() => f.ledger.clearHistory(), {message: RUNNING});
  assert.equal(fs.readFileSync(f.store, 'utf8'), before); assert.equal(f.history.get(idle.id).available, true);
  assert.equal(f.history.get(f.record.id).available, true); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
  await h.cancelPreparation(f.record.id); assert.deepEqual(await pending, {cancelled: true});
  assert.equal(f.ledger.clearHistory(), 2); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
});

test('renderer bulk delete removes idle items but refuses its running item with the required message', async t => {
  const f = fixture(t); const other = path.join(f.root, 'other.mp4'); fs.writeFileSync(other, 'other');
  const idle = f.history.add(historyInput(other)); const {prep, entered} = preparation(t, {pause: 'conversion'}); const retry = handlers(f, prep);
  const pending = retry.retryPreparation(f.record.id); void pending.catch(() => {}); await entered;
  const h = createHarness(); h.api.historyList = async () => f.ledger.listHistory(); h.api.historyDelete = async id => f.ledger.deleteHistory(id);
  await h.fireReady(); h.test.setSurface('library'); await h.flush();
  const all = h.elements.get('history-select-all'); all.checked = true; all.listeners.change();
  h.elements.get('history-delete-selected-btn').click(); h.elements.get('history-delete-confirm').click(); await h.flush();
  assert.equal(h.elements.get('message').textContent, `1 deleted, 1 failed: ${RUNNING}`);
  assert.equal(f.history.get(idle.id), null); assert.equal(fs.existsSync(other), false);
  assert.deepEqual(f.history.get(f.record.id), f.before.record); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
  await retry.cancelPreparation(f.record.id); assert.deepEqual(await pending, {cancelled: true});
  assert.deepEqual(fs.readdirSync(f.root), ['clip.mkv']);
});

test('retry on an externally deleted source fails without rewriting or resurrecting History', async t => {
  const f = fixture(t); fs.unlinkSync(f.input); let starts = 0;
  const {prep} = preparation(t); const h = handlers(f, prep, {prepareMedia: () => {starts++; throw new Error('unexpected preparation');}});
  await assert.rejects(h.retryPreparation(f.record.id), /existing managed file/);
  assert.equal(starts, 0); assert.equal(fs.readFileSync(f.store, 'utf8'), f.before.store);
  assert.deepEqual(f.history.get(f.record.id), {...f.before.record, available: false});
  assert.equal(f.history.resolve(f.record.id), null); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(await h.cancelPreparation(f.record.id), false);
});

test('retry refuses an existing external relinked source even with a failure marker', async t => {
  const f = fixture(t); const outside = path.join(f.dir, 'external.mp4'); fs.writeFileSync(outside, SOURCE);
  f.history.relink(f.record.id, outside); const before = fs.readFileSync(f.store, 'utf8');
  const {prep} = preparation(t); await assert.rejects(handlers(f, prep).retryPreparation(f.record.id), /existing managed file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), SOURCE); assert.equal(fs.readFileSync(f.store, 'utf8'), before);
  assert.equal(f.history.resolve(f.record.id).path, outside); assert.equal(f.history.get(f.record.id).preparationFailed.profile, 'fast');
});

test('legacy records without preparationFailed load unchanged and cannot be retried', async t => {
  const f = fixture(t, {marker: false}); const {prep} = preparation(t); const h = handlers(f, prep);
  assert.deepEqual((await restartRecord(t, f)).record, f.before.record);
  await assert.rejects(h.retryPreparation(f.record.id), /no failed conversion/); unchanged(f);
});

test('malformed preparationFailed values are dropped without quarantining or losing valid records', async t => {
  const f = fixture(t); const original = JSON.parse(f.before.store).records[0];
  const malformed = [null, false, 17, 'fast', [], {}, {profile: null}, {profile: 1}, {profile: 'original'}, {profile: 'FAST'}, {profile: ['editing']}, {profile: {profile: 'fast'}}];
  const records = malformed.map((value, index) => ({...original, id: `bad-${index}`, preparationFailed: value}));
  records.push({...original, id: 'valid-fast', preparationFailed: {profile: 'fast'}}, {...original, id: 'valid-editing', preparationFailed: {profile: 'editing'}});
  fs.writeFileSync(f.store, JSON.stringify({schemaVersion: 1, records}));
  const history = new DownloadHistory(f.store, f.root); t.after(() => history.dispose());
  assert.equal(history.list().length, malformed.length + 2);
  for (let index = 0; index < malformed.length; index++) {
    const record = history.get(`bad-${index}`); assert.equal(record.available, true); assert.equal(record.profile, 'original');
    assert.equal('preparationFailed' in record, false, `reject ${JSON.stringify(malformed[index])}`);
    assert.equal(history.resolve(record.id).path, f.input);
  }
  assert.deepEqual(history.get('valid-fast').preparationFailed, {profile: 'fast'});
  assert.deepEqual(history.get('valid-editing').preparationFailed, {profile: 'editing'});
  assert.equal(fs.readdirSync(path.dirname(f.store)).some(name => name.includes('.corrupt-')), false);
  assert.equal(history.reuse('bad-0').record.id, 'bad-0', 'sanitized store remains writable');
  assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
});

test('non-string and malformed IDs cannot prepare, cancel another retry, or touch files', async t => {
  const f = fixture(t); const {prep, entered} = preparation(t, {pause: 'conversion'}); const h = handlers(f, prep);
  const pending = h.retryPreparation(f.record.id); void pending.catch(() => {}); await entered;
  for (const id of [undefined, null, 1, true, {}, [], [f.record.id], new String(f.record.id), '', '../clip', 'x'.repeat(201)]) {
    await assert.rejects(h.retryPreparation(id), /Invalid history record ID/);
    await assert.rejects(h.cancelPreparation(id), /Invalid history record ID/);
  }
  assert.equal(prep.isActive(), true); assert.equal(fs.readFileSync(f.input, 'utf8'), SOURCE);
  await h.cancelPreparation(f.record.id); assert.deepEqual(await pending, {cancelled: true}); unchanged(f);
});

test('unknown string IDs do not acquire a busy slot or affect a valid retry', async t => {
  const f = fixture(t); const {prep} = preparation(t); const h = handlers(f, prep);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(h.retryPreparation('unknown-id'), /no failed conversion/); assert.equal(await h.cancelPreparation('unknown-id'), false);
  }
  unchanged(f); assert.deepEqual(await h.retryPreparation(f.record.id), {cancelled: false, profile: 'fast'});
  assert.equal(fs.readFileSync(f.history.resolve(f.record.id).path, 'utf8'), PREPARED);
});

test('successful retry keeps existing queue card references consistent with the prepared History artifact', async t => {
  const f = fixture(t); const active = f.ledger.reuseHistory(f.record.id); const {prep} = preparation(t);
  await handlers(f, prep).retryPreparation(f.record.id);
  const prepared = f.history.resolve(f.record.id).path;
  assert.equal(fs.readFileSync(prepared, 'utf8'), PREPARED);
  const card = f.ledger.resolve(active.cardId);
  assert.ok(card, 'existing queue card must remain usable, by retaining its source or following the replacement');
  assert.equal(fs.existsSync(card.path), true);
  assert.equal(f.ledger.protectedPaths().every(file => fs.existsSync(file)), true, 'ledger must not retain deleted file paths');
});

test('app shutdown mid-retry cancels the real media worker and preserves source and persisted History', async t => {
  const {prep, entered, children, outputs} = preparation(t, {pause: 'conversion'});
  const f = await mainFixture(t, {modules: {'./media-prep': {createMediaPrep: () => prep, discoverFfprobe: () => '/fake/ffprobe'}}});
  const input = path.join(f.root, 'clip.mkv'); fs.writeFileSync(input, SOURCE);
  const record = f.controls.history.add({...historyInput(input), preparationFailed: {profile: 'fast'}});
  const store = path.join(f.userData, 'download-history.json'), before = fs.readFileSync(store, 'utf8');
  const pending = f.invoke('historyRetryPreparation', record.id); void pending.catch(() => {}); await entered;
  f.quit(); assert.deepEqual(await pending, {cancelled: true}); await until(() => f.lifecycle.completedQuits === 1);
  assert.equal(fs.readFileSync(input, 'utf8'), SOURCE); assert.deepEqual(f.controls.history.get(record.id), record);
  assert.equal(fs.readFileSync(store, 'utf8'), before); assert.equal(outputs.every(file => !fs.existsSync(file)), true);
  assert.deepEqual(children.at(-1).signals, ['SIGTERM']); assert.equal(prep.isActive(), false);
  assert.equal(await f.controls.history.dispose(), undefined); assert.equal(f.lifecycle.cleanups, 1);
});

test('app shutdown after publication cancels the still-running retry before its History commit', async t => {
  const {prep} = preparation(t); let f;
  // Inject quit at the exact handoff from the real worker to the real main
  // handler, without extending the worker's lifetime or mocking its cleanup.
  const wrapper = {...prep, prepare: async request => {const result = await prep.prepare(request); f.quit(); return result;}};
  f = await mainFixture(t, {modules: {'./media-prep': {createMediaPrep: () => wrapper, discoverFfprobe: () => '/fake/ffprobe'}}});
  const input = path.join(f.root, 'clip.mkv'); fs.writeFileSync(input, SOURCE);
  const record = f.controls.history.add({...historyInput(input), preparationFailed: {profile: 'fast'}});
  const store = path.join(f.userData, 'download-history.json'), before = fs.readFileSync(store, 'utf8');
  const result = await f.invoke('historyRetryPreparation', record.id); await until(() => f.lifecycle.completedQuits === 1);
  assert.deepEqual(result, {cancelled: true}, 'shutdown cancels the retry, including its post-conversion continuation');
  assert.equal(fs.readFileSync(input, 'utf8'), SOURCE); assert.deepEqual(f.controls.history.get(record.id), record);
  assert.equal(fs.readFileSync(store, 'utf8'), before); assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('clip.')), ['clip.mkv']);
});
