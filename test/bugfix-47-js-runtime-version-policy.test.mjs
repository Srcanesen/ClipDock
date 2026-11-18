import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { redirectFixtureProbes, writeNodeFixture } from './helpers/node-fixture.cjs';
import { discoverJsRuntime, YtdlpWorker } from '../dist/ytdlp.js';

const platform = process.platform === 'win32' ? 'win32' : 'linux';
const fixture = (dir, name, version, code = 0) => writeNodeFixture(dir, name,
  `console.log(${JSON.stringify(version)}); process.exitCode = ${code};`);

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-runtime-policy-'));
  redirectFixtureProbes(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  return { root, bin, env: { HOME: root, USERPROFILE: root, PATH: bin } };
}

test('old Deno does not mask usable Node 24 and yt-dlp receives the chosen runtime', async (t) => {
  const { root, bin, env } = workspace(t);
  fixture(bin, 'deno', 'deno 2.0.0 (stable)');
  const node = fixture(bin, 'node', 'v24.0.0');
  const runtime = discoverJsRuntime(env, platform);
  assert.equal(runtime, `node:${node}`);
  const calls = [];
  const worker = new YtdlpWorker('/fixture/yt-dlp', (_command, args) => { calls.push(args); throw new Error('offline spawn boundary'); }, undefined,
    { sessionDir: path.join(root, 'session'), ffmpegPath: null, ffprobePath: null, jsRuntime: runtime });
  await worker.search('runtime policy', 1).catch(() => {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['--ignore-config', '--js-runtimes', `node:${node}`]);
});

test('only Node 18 yields no runtime flag and explains the supported versions', async (t) => {
  const { root, bin, env } = workspace(t);
  fixture(bin, 'node', 'v18.20.8');
  const warnings = [];
  const warn = t.mock.method(console, 'warn', (message) => warnings.push(message));
  const runtime = discoverJsRuntime(env, platform);
  warn.mock.restore();
  assert.equal(runtime, null);
  assert.match(warnings.join('\n'), /No supported JavaScript runtime found/);
  assert.match(warnings.join('\n'), /Deno >=2\.3\.0.*Node >=22\.0\.0/);
  const calls = [];
  const worker = new YtdlpWorker('/fixture/yt-dlp', (_command, args) => { calls.push(args); throw new Error('offline spawn boundary'); }, undefined,
    { sessionDir: path.join(root, 'session'), ffmpegPath: null, ffprobePath: null, jsRuntime: runtime });
  await worker.search('runtime policy', 1).catch(() => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--js-runtimes'), false);
});

test('Deno 2.3.0 is usable and remains preferred to Node 24', (t) => {
  const { bin, env } = workspace(t);
  const deno = fixture(bin, 'deno', 'deno 2.3.0 (stable)\nv8 13.5.0');
  fixture(bin, 'node', 'v24.0.0');
  assert.equal(discoverJsRuntime(env, platform), `deno:${deno}`);
});

test('old configured and PATH candidates do not mask a later usable Deno', (t) => {
  const { root, env } = workspace(t);
  const configured = fixture(path.join(root, 'override'), 'deno', 'deno 2.0.0');
  const oldDir = path.join(root, 'old'), goodDir = path.join(root, 'good');
  fixture(oldDir, 'deno', 'deno 2.2.99');
  const deno = fixture(goodDir, 'deno', 'deno 2.3.0');
  assert.equal(discoverJsRuntime({ ...env, CLIPDOCK_DENO_PATH: configured }, platform, [oldDir, goodDir]), `deno:${deno}`);
});

// Policy source: yt-dlp 2026.8.19 utils/_jsruntime.py, including QuickJS-ng's
// special > (0,) rule and QuickJS's --help exit code of 1.
for (const [name, output, accepted, flag, code] of [
  ['deno', 'deno 2.2.99', false, 'deno', 0],
  ['deno', 'deno 3.0.0', true, 'deno', 0],
  ['node', 'v21.99.99', false, 'node', 0],
  ['node', 'v22.0.0', true, 'node', 0],
  ['node', 'not a runtime v24.0.0', false, 'node', 0],
  ['deno', 'deno unknown', false, 'deno', 0],
  ['bun', '1.2.10', false, 'bun', 0],
  ['bun', '1.2.11', true, 'bun', 0],
  ['qjs', 'QuickJS version 2023-12-08', false, 'quickjs', 1],
  ['qjs', 'QuickJS version 2023-12-09', true, 'quickjs', 1],
  ['qjs', 'QuickJS-ng version 0.0.0', true, 'quickjs', 1],
  ['qjs', 'QuickJS-ng version unknown', false, 'quickjs', 1],
  ['deno', 'deno 2.3.0', false, 'deno', 1],
]) {
  test(`${name} ${JSON.stringify(output)} exit ${code} is ${accepted ? 'accepted' : 'skipped'}`, (t) => {
    const { bin, env } = workspace(t);
    const binary = fixture(bin, name, output, code);
    t.mock.method(console, 'warn', () => {});
    assert.equal(discoverJsRuntime(env, platform), accepted ? `${flag}:${binary}` : null);
  });
}
