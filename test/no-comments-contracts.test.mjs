import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { PexelsClient } from '../dist/pexels.js';
import { PixabayClient } from '../dist/pixabay.js';
import { SharedProviderOperation } from '../dist/provider-platform.js';
import { DownloadHistory } from '../dist/history.js';
import { ManagedRoot } from '../dist/managed-root.js';
import { historyInput } from './helpers/files-main.mjs';
import { createHarness } from './helpers/renderer-harness.mjs';

function nodes(file) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) { result.push(node); ts.forEachChild(node, visit); }
  visit(tree);
  return result;
}

test('the final shared subscriber evicts its request synchronously before cancellation cleanup', async () => {
  const events = [];
  let finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const shared = new SharedProviderOperation({ result: new Promise(() => {}), cancel() { events.push('cancel'); return cleanup; } }, () => events.push('evict'));
  const controller = new AbortController();
  const result = shared.subscribe(controller.signal).catch(error => error.message);
  controller.abort(new Error('Cancelled.'));
  assert.deepEqual(events, ['evict', 'cancel']);
  finish();
  assert.equal(await result, 'Cancelled.');
});

for (const scenario of ['replacement', 'protected media']) {
  test(`History reload preserves ${scenario} and its subtitle companion`, async t => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-history-rule-')));
    const root = ManagedRoot.prepare(path.join(dir, 'managed'));
    const media = path.join(root.providerPath('youtube'), 'clip.mp4');
    const subtitle = path.join(root.providerPath('youtube'), 'clip.srt');
    fs.writeFileSync(media, 'original media'); fs.writeFileSync(subtitle, 'captions');
    const history = new DownloadHistory(path.join(dir, 'history.json'), root);
    t.after(async () => { await history.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
    const record = history.add({ ...historyInput(media), subtitle: { filePath: subtitle } });
    if (scenario === 'replacement') { fs.renameSync(media, `${media}.original`); fs.writeFileSync(media, 'replacement'); }
    const result = history.delete(record.id, scenario === 'protected media' ? [media] : []);
    assert.deepEqual(result, { deleted: false, removed: true, ...(scenario === 'replacement' ? { warning: 'Media changed or was replaced; preserved.' } : {}) });
    assert.equal(fs.readFileSync(media, 'utf8'), scenario === 'replacement' ? 'replacement' : 'original media');
    assert.equal(fs.readFileSync(subtitle, 'utf8'), 'captions');
  });
}

test('native drag stays synchronous through renderer, preload and main', () => {
  const renderer = nodes('src/renderer.ts');
  const start = renderer.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startCardDrag');
  const handlers = renderer.filter(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener' && node.arguments[0]?.text === 'dragstart').map(node => node.arguments[1]);
  for (const handler of [start, ...handlers]) {
    assert.ok(handler);
    assert.equal(handler.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
    const body = [];
    function visit(node) { body.push(node); ts.forEachChild(node, visit); }
    visit(handler.body);
    assert.equal(body.some(ts.isAwaitExpression), false);
  }
  const preload = nodes('src/preload.ts');
  const drag = preload.find(node => ts.isPropertyAssignment(node) && node.name.getText() === 'startNativeDrag');
  assert.equal(drag.initializer.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
  const call = drag.initializer.body.statements[0].expression;
  assert.equal(ts.isCallExpression(call), true);
  assert.equal(call.expression.getText(), 'ipcRenderer.send');
  const main = nodes('src/main.ts');
  const handler = main.find(node => ts.isCallExpression(node) && node.expression.getText() === 'ipcMain.on' && node.arguments[0].getText() === 'IPC_CHANNELS.nativeDragStart').arguments[1];
  assert.equal(handler.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
});

test('renderer URL pathname access uses brackets alongside the opaque-path boundary', () => {
  const renderer = nodes('src/renderer.ts');
  assert.deepEqual(renderer.filter(node => ts.isPropertyAccessExpression(node) && ['pathname', 'path', 'filePath', 'filePaths'].includes(node.name.text)).map(node => node.name.text), []);
});

test('native and browser imports stay inside their process boundaries', () => {
  for (const entry of fs.readdirSync('src', { recursive: true }).filter(file => file.endsWith('.ts') && file !== 'main.ts' && file !== 'preload.ts' && file !== 'electron.d.ts')) {
    const tree = nodes(`src/${entry}`);
    const dependencies = tree.filter(node => ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly).map(node => node.moduleSpecifier.text);
    dependencies.push(...tree.filter(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require').map(node => node.arguments[0]?.text));
    assert.deepEqual(dependencies.filter(name => /electron|\.node$/.test(name ?? '')), [], entry);
    if (entry.startsWith('renderer-state/')) assert.deepEqual(dependencies.filter(name => name?.startsWith('node:')), [], entry);
  }
  assert.equal(nodes('src/preview.ts').some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)), false);
  assert.deepEqual(nodes('src/preload.ts').filter(ts.isImportDeclaration).filter(node => !node.importClause?.isTypeOnly).map(node => node.moduleSpecifier.text), ['electron/renderer']);
});

test('pin UI waits for the returned native state even when it differs from the request', async () => {
  const h = createHarness();
  let respond;
  h.api.setAlwaysOnTop = () => new Promise(resolve => { respond = resolve; });
  await h.fireReady();
  const pin = h.elements.get('pin-on-top-btn');
  pin.click();
  assert.equal(pin.disabled, true);
  assert.equal(pin.getAttribute('aria-pressed'), 'false');
  respond(false); await h.flush();
  assert.equal(pin.disabled, false);
  assert.equal(pin.getAttribute('aria-pressed'), 'false');
});

test('explicit relink admits the selected media inode while preserving the original subtitle authority', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-relink-rule-')));
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const media = path.join(root.providerPath('youtube'), 'clip.mp4');
  const subtitle = path.join(root.providerPath('youtube'), 'clip.srt');
  fs.writeFileSync(media, 'old media'); fs.writeFileSync(subtitle, 'old captions');
  const history = new DownloadHistory(path.join(dir, 'history.json'), root);
  t.after(async () => { await history.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const record = history.add({ ...historyInput(media), subtitle: { filePath: subtitle } });
  for (const file of [media, subtitle]) { fs.renameSync(file, `${file}.original`); fs.writeFileSync(file, 'replacement'); }
  assert.equal(history.relink(record.id, media).available, true);
  assert.deepEqual(history.delete(record.id, []), { deleted: true, removed: true, warning: 'Media deleted, but its subtitle could not be deleted.' });
  assert.equal(fs.existsSync(media), false);
  assert.equal(fs.readFileSync(subtitle, 'utf8'), 'replacement');
});

for (const [label, Client, kind, key] of [['Pexels', PexelsClient, 'photo', 'A'.repeat(20)], ['Pixabay', PixabayClient, 'video', '12345678-0123456789abcdef0123456789ab']]) {
  for (const operation of ['search', 'load', 'validate']) {
    test(`${label} ${operation} scrubs even provider-prefixed transport errors containing credentials`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-secret-'));
      let requests = 0;
      const client = new Client(root, async url => { requests++; throw new Error(`${label} transport failed: ${url} Authorization=${key}`); });
      t.after(async () => { await client.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
      client.setKey(key, false);
      const pending = operation === 'search' ? client.search(kind, 'studio', 1) : operation === 'load' ? client.load(kind, 7) : client.validateKey(key);
      await assert.rejects(pending, error => {
        assert.equal(error.message, `${label} request failed.`);
        assert.equal(error.stack.includes(key), false);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(requests, 1);
    });
  }
}
