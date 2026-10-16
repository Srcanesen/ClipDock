import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('status phases, root errors and trimmed project names', async (t) => {
  const { buildStatus } = await import(path.join(dist, 'status.js'));
  const facts = (over) => ({
    initialized: false, initError: null, resolveAvailable: false, resolveError: null,
    moduleVersion: '2.0.0', resolveVersion: null, projectName: null, timelineName: null, ...over,
  });
  expect('init failed -> bridge-error',
    buildStatus(facts({ initError: 'boom' })).phase, 'bridge-error');
  expect('init failed carries error + retry hint',
    [buildStatus(facts({ initError: 'boom' })).bridge.error,
     buildStatus(facts({ initError: 'boom' })).refreshHint],
    ['boom', 'Click Refresh to re-initialize the bridge.']);
  expect('GetResolve null -> bridge-error',
    buildStatus(facts({ initialized: true, resolveError: 'no resolve' })).phase, 'bridge-error');
  expect('connected, no project -> no-project',
    buildStatus(facts({ initialized: true, resolveAvailable: true })).phase, 'no-project');
  expect('no-project message',
    buildStatus(facts({ initialized: true, resolveAvailable: true })).message,
    'DaVinci Resolve is connected, but no project is currently open.');
  expect('project open, no timeline -> no-timeline',
    buildStatus(facts({ initialized: true, resolveAvailable: true, projectName: 'My Cut' })).phase,
    'no-timeline');
  expect('ready: names surfaced + trimmed',
    buildStatus(facts({ initialized: true, resolveAvailable: true, projectName: '  My Cut  ', timelineName: 'TL-1' })),
    {
      phase: 'ready',
      bridge: { connected: true, moduleVersion: '2.0.0', resolveVersion: null, error: null },
      project: { name: 'My Cut', loaded: true },
      timeline: { name: 'TL-1', loaded: true },
      message: 'Connected to project "My Cut" — timeline "TL-1".',
      refreshHint: null,
    });
  expect('whitespace-only project name -> no-project',
    buildStatus(facts({ initialized: true, resolveAvailable: true, projectName: '   ' })).phase,
    'no-project');
  expect('init error (root cause) wins over resolve error in message',
    buildStatus(facts({ initError: 'init', resolveError: 'resolve' })).bridge.error, 'init');
});
