import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import ts from 'typescript';
import {runShippedSurfaceRules} from '../scripts/lib/shipped-surface-rules.mjs';

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const registrar = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerProviderHandlers');
const loop = registrar.body.statements.find(ts.isForOfStatement);
const remove = node => source.slice(0, node.getStart(parsed)) + source.slice(node.end);

function checkScratch(t, changed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-ipc-contract-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'src/main.ts'), changed);
  fs.writeFileSync(path.join(root, 'dist/main.js'), ts.transpileModule(fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText);
  fs.copyFileSync(new URL('../dist/preload.js', import.meta.url), path.join(root, 'dist/preload.js'));
  return runShippedSurfaceRules(root, {ruleIds: ['ipc-contract']})[0];
}

test('ipc-contract accepts the real provider registrations', () => {
  const [result] = runShippedSurfaceRules(process.cwd(), {ruleIds: ['ipc-contract']});
  assert.equal(result.ok, true, result.problems.join('; '));
  console.log('real tree: ipc-contract PASS');
});

const mutations = [
  ['registration loop removed', remove(loop)],
  ['route loop removed', remove(loop.statement.statements.find(ts.isForOfStatement))],
  ['cancel registration removed', remove(loop.statement.statements.find(ts.isExpressionStatement))],
  ['sensitive factory bypassed', source.replace('createSensitiveIpcHandler(requireTrustedSender, handler)', 'handler')],
  ['trusted sender bypassed', source.replace('createSensitiveIpcHandler(requireTrustedSender, handler)', 'createSensitiveIpcHandler(() => {}, handler)')],
  ['registrar invocation removed', source.replace('      registerProviderHandlers();', '')],
];
for (const [name, changed] of mutations) {
  test(`ipc-contract rejects scratch main.ts with ${name}`, t => {
    assert.notEqual(changed, source, 'mutation must change the source');
    const result = checkScratch(t, changed);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ['provider descriptors require an active sensitive IPC registration loop']);
    console.log(`scratch main.ts (${name}): ipc-contract FAIL — ${result.problems[0]}`);
  });
}
