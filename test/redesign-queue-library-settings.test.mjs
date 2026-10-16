import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'static/index.html'), 'utf8');
const css = readFileSync(path.join(root, 'static/css/styles.css'), 'utf8');

// Empty-state adjacency: queue has CSS-driven empty sibling immediately after list
test('Queue empty state is immediate CSS sibling after queue list and disappears when children exist', () => {
  assert.match(html, /id="youtube-download-queue"[^>]*>[\s\S]*?<\/div>\s*<div id="queue-empty-state" class="queue-empty-state"/);
  assert.match(css, /#youtube-download-queue:empty \+ \.queue-empty-state\s*\{[^}]*display:\s*grid/);
  assert.match(css, /#youtube-download-queue:not\(:empty\) \+ \.queue-empty-state\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.queue-empty-state[^{]*\{[^}]*min-height:\s*88px/);
  assert.match(html, /id="queue-empty-state"[^>]*role="status"/);
});

// Library completed empty adjacency
test('Library completed empty is CSS sibling after completed list with 88px compact', () => {
  assert.match(html, /id="completed-downloads"[^>]*>[\s\S]*?<\/div>\s*<div id="completed-empty-state" class="library-empty-state"/);
  assert.match(css, /#completed-downloads:empty \+ #completed-empty-state\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.library-empty-state[^{]*\{[^}]*min-height:\s*88px/);
});

// History empty truthful while loading: hidden during loading via data-loading or JS guard
test('History empty does not lie while loading: JS guards history empty hidden when loading and CSS suppresses during data-loading', () => {
  assert.ok(html.includes('id="history-empty-state"'), 'history empty exists');
  assert.ok(html.includes('id="history-list"'), 'history list exists');
  assert.match(css, /#history-list\[data-loading="true"\] \+ #history-empty-state|history-empty-state\[data-loading="true"\]/);
});

// Lab page heads: every page title uses the Fraunces display face from the shared class.
// (Replaces the Variant D 20px/44px, sage hairline, nowrap toolbar and disabled-token
// mirrors; those pinned the previous look, not behaviour.)
test('All surface pages share the Lab display page title', () => {
  assert.match(css, /\.page-title\s*\{[^}]*font-family:\s*var\(--f-display\)/);
  assert.match(css, /\.surface-page-head\s*\{[^}]*position:\s*sticky/, 'page heads stay visible while the list scrolls');
  assert.match(html, /id="queue-title"[^>]*class="page-title"/);
  assert.match(html, /id="library-title"[^>]*class="page-title"/);
  assert.match(html, /id="settings-title"[^>]*class="page-title"/);
});

// The Lab type system is vendored: nothing may load a remote font, and every face the
// stylesheet names must ship from static/fonts under the CSP's font-src 'self'.
test('Lab fonts are local, CSP-allowed and shipped', () => {
  assert.match(html, /font-src 'self'/);
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/, 'no remote url() in the stylesheet');
  const files = [...css.matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)].map((match) => match[1]);
  for (const family of ['Fraunces', 'Familjen Grotesk', 'DM Mono']) assert.match(css, new RegExp(`font-family: '${family}'`));
  assert.ok(files.length >= 8, 'every face has latin and latin-ext files');
  for (const file of files) assert.ok(existsSync(path.join(root, 'static/fonts', file)), `${file} ships`);
});

// History toolbar: the search field shrinks with long queries; chips mirror the native filters.
test('History toolbar contains long queries and its chips drive the native filters', () => {
  assert.match(css, /\.history-toolbar \.field\s*\{[^}]*flex:\s*1 1 200px/);
  assert.match(html, /id="history-provider-chips"[^>]*role="group"/);
  assert.match(html, /id="history-availability-chips"[^>]*role="group"/);
});
