import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, IPC_CHANNELS, DOWNLOAD_INTENTS, MEDIA_PROFILES, REQUIRED_HTML_IDS, REQUIRED_HTML_IDS_FLAT, DIST_REQUIRED_FILES } from '../scripts/lib/contracts.mjs';
import { runShippedSurfaceRules } from '../scripts/lib/shipped-surface-rules.mjs';
import runtime from '../dist/contracts.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('contracts: compiled runtime preserves the canonical values', () => {
  assert.equal(runtime.PLUGIN_ID, 'com.clipdock.app');
  assert.equal(runtime.PLUGIN_ID, PLUGIN_ID);
  assert.deepEqual(runtime.IPC_CHANNELS, IPC_CHANNELS);
  assert.deepEqual(runtime.DOWNLOAD_INTENTS, ['download', 'import', 'playhead', 'end']);
  assert.deepEqual(runtime.DOWNLOAD_INTENTS, DOWNLOAD_INTENTS);
  assert.deepEqual(runtime.MEDIA_PROFILES, ['original', 'fast', 'editing']);
  assert.deepEqual(runtime.MEDIA_PROFILES, MEDIA_PROFILES);
  assert.equal(Object.values(IPC_CHANNELS).length, new Set(Object.values(IPC_CHANNELS)).size);
  assert.equal(REQUIRED_HTML_IDS_FLAT.includes('youtube-intent'), true);
  assert.deepEqual(REQUIRED_HTML_IDS_FLAT, [...new Set(Object.values(REQUIRED_HTML_IDS).flat())]);
  assert.equal(DIST_REQUIRED_FILES.includes('preload.js'), true);
});

test('contracts: shipped rules accept the completed build, narrow preload, IPC and required HTML', () => {
  const results = runShippedSurfaceRules(root, { ruleIds: ['completed-build', 'preload-bridge', 'ipc-contract', 'html-contract'] });
  assert.deepEqual(results.map(({ id, ok }) => ({ id, ok })), [
    { id: 'completed-build', ok: true }, { id: 'preload-bridge', ok: true },
    { id: 'ipc-contract', ok: true }, { id: 'html-contract', ok: true },
  ]);
});
