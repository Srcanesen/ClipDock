import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('preview request callback refuses files and directories linked outside dist, including HTML', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clipdock-preview-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['scripts/preview.mjs', 'scripts/lib/preview-adapter.mjs', 'src/preview.ts', 'dist']) {
    fs.cpSync(entry, path.join(root, entry), { recursive: true });
  }
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'PRIVATE OUTSIDE CONTENT');
  fs.writeFileSync(path.join(outside, 'index.html'), '<p>PRIVATE OUTSIDE CONTENT</p><script src="./renderer.js"></script>');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'dist', 'leak.txt'));
  fs.symlinkSync(outside, path.join(root, 'dist', 'linked'));
  const preload = path.join(root, 'requests.cjs');
  fs.writeFileSync(preload, `const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
http.createServer = callback => ({ listen() {
  const request = url => { const response = {}; callback({url}, {writeHead(status) { response.status = status; }, end(body) {response.body = String(body);} }); return response; };
  const linked = ['/leak.txt', '/%6ceak.txt', '/linked/secret.txt'].map(request);
  const good = request('/renderer.js');
  const missing = request('/missing.js');
  const index = path.join(process.cwd(), 'dist/index.html');
  fs.renameSync(index, index + '.held');
  fs.symlinkSync(path.join(process.cwd(), 'outside/index.html'), index);
  const html = ['/', '/index.html'].map(request);
  fs.rmSync(index); fs.renameSync(index + '.held', index);
  const restored = request('/');
  process.stdout.write(JSON.stringify({linked, html, good, missing, restored}));
} }); require('node:module').syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'scripts', 'preview.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const responses = JSON.parse(result.stdout);
  for (const response of [...responses.linked, ...responses.html]) {
    assert.deepEqual(response, { status: 403, body: 'Forbidden' });
  }
  assert.equal(responses.good.status, 200);
  assert.equal(responses.good.body, fs.readFileSync(path.join(root, 'dist', 'renderer.js'), 'utf8'));
  assert.deepEqual(responses.missing, { status: 404, body: 'Not found' });
  assert.equal(responses.restored.status, 200);
  assert.match(responses.restored.body, /src="preview.js"/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'PRIVATE OUTSIDE CONTENT');
});
