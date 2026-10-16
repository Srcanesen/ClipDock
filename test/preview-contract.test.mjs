import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { transpilePreviewAdapter } from '../scripts/lib/preview-adapter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('preview adapter stays out of dist and transpiles as a Node-free browser script', () => {
  assert.equal(existsSync(path.join(root, 'dist', 'preview.js')), false);
  const adapter = transpilePreviewAdapter(root);
  assert.doesNotMatch(adapter, /require\(/);
  assert.doesNotMatch(adapter, /\bexports\b/);
});

test('preview server serves the in-memory adapter and injects it into production HTML', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['scripts/preview.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => Promise.reject(new Error(`preview server exited (${code})`))),
  ]);
  const [html, adapter] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()),
    fetch(`http://127.0.0.1:${port}/preview.js`).then((response) => response.text()),
  ]);
  assert.match(html, /src="preview\.js"><\/script><script[^>]*src="\.\/renderer\.js"/);
  assert.match(adapter, /clipdockAPI/);
});
