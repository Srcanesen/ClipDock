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

test('shared initialization coalesces success and retries failure', async (t) => {
  const { createSharedWorkflowIntegration } = await import(path.join(dist, 'workflow-integration.js'));
  {
    let initCalls = 0;
    const shared = createSharedWorkflowIntegration({
      Initialize: async () => { initCalls += 1; return true; },
      GetInfo: () => ({ version: 'test' }),
      GetResolve: async () => ({ id: 'resolve' }),
    });
    await Promise.all([shared.Initialize('com.clipdock.app'), shared.Initialize('com.clipdock.app')]);
    await shared.Initialize('com.clipdock.app');
    expect('shared bridge initializes native module once', initCalls, 1);
  }
  {
    let initCalls = 0;
    const shared = createSharedWorkflowIntegration({
      Initialize: async () => { initCalls += 1; return initCalls > 1; },
      GetInfo: () => ({ version: 'test' }),
      GetResolve: async () => ({ id: 'resolve' }),
    });
    expect('shared bridge failed init remains false', await shared.Initialize('com.clipdock.app'), false);
    expect('shared bridge retries after failed init', await shared.Initialize('com.clipdock.app'), true);
    expect('shared bridge retry calls native twice', initCalls, 2);
  }

});
