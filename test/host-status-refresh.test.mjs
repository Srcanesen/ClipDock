// Phase 5 live Resolve status contract — deterministic fake DOM/timer/API checks
// against the BUILT renderer (dist/renderer.js). No Electron, no Resolve.
//
// Covered symptoms (each would be red against the pre-Phase-5 renderer):
//   - ResolveQuit is subscribed; quit synchronously renders a bridge-error snapshot
//     and host actions become unavailable immediately (no stale "Connected").
//   - Quit schedules a controlled refresh through the existing debounce.
//   - One bounded visible-only poll (3000ms) detects project/timeline changes.
//   - Hidden stops the poll entirely; becoming visible restarts ONE poll and
//     schedules an immediate refresh.
//   - Burst/poll/manual calls never exceed one in-flight getStatus and produce at
//     most one trailing request (single-flight guard preserved).
//   - beforeunload unsubscribes ResolveQuit, removes focus and
//     visibility listeners, and clears debounce + poll timers.
import { createFakeDom } from './helpers/fake-dom.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const renderer = readFileSync(path.join(root, 'dist', 'renderer.js'), 'utf8');

const HOST_POLL_MS = 3000;
const REFRESH_DEBOUNCE_MS = 120;
const HOST_STATUS_TIMEOUT_MS = 10_000;

function readySnapshot(project = 'Alpha', timeline = 'TL-1') {
  return {
    phase: 'ready',
    bridge: { connected: true, moduleVersion: '2.0.0', resolveVersion: '21.0.3', error: null },
    project: { loaded: true, name: project },
    timeline: { loaded: true, name: timeline },
    message: `Connected to project "${project}" — timeline "${timeline}".`,
    refreshHint: null,
  };
}

// Element ids the renderer touches on DOMContentLoaded / refresh / updateControls /
// renderQueue. Kept to the exact minimum so a missing element fails loudly.
const ELEMENT_IDS = [
  'refresh-btn', 'bridge-state', 'module-version', 'resolve-version', 'project-name',
  'timeline-name', 'message', 'refresh-hint', 'last-updated',
  'pin-on-top-btn', 'preview-selected-btn', 'source-monitor', 'preview-note',
  'youtube-search-form', 'youtube-search-input', 'youtube-search-btn',
  'youtube-search-prev', 'youtube-search-next', 'youtube-search-results',
  'youtube-search-status', 'load-youtube-btn', 'youtube-url', 'social-url',
  'pexels-api-key', 'download-youtube-btn', 'youtube-target-bin', 'youtube-placement',
  'youtube-quality', 'youtube-profile', 'youtube-media-mode', 'youtube-subtitles',
  'youtube-subtitle-language', 'video-controls', 'audio-controls', 'quality-chips',
  'profile-controls', 'prores-warning', 'youtube-download-queue', 'youtube-queue-status',
  'youtube-status', 'youtube-progress',
];

function createHarness({ visible = true } = {}) {
  const elements = new Map();
  const dom = createFakeDom();
  const makeElement = (id = '') => dom.makeElement('div', id);
  for (const id of ELEMENT_IDS) elements.set(id, makeElement(id));
  elements.get('profile-controls').parentElement = makeElement('profile-controls-parent');

  // Fake timers: deterministic manual clock over renderer window.setTimeout/setInterval.
  const timers = new Map();
  let nextTimerId = 0;
  let now = 0;
  const schedule = (kind, callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { id, kind, callback, delay, due: now + Math.max(0, delay) });
    return id;
  };
  const clear = (id) => timers.delete(id);
  const advance = (ms) => {
    const end = now + ms;
    let guard = 0;
    while (guard++ < 100_000) {
      const due = [...timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due);
      if (due.length === 0) break;
      const timer = due[0];
      now = Math.max(now, timer.due);
      if (timer.kind === 'timeout') timers.delete(timer.id);
      else timer.due += timer.delay;
      timer.callback();
    }
    now = end;
  };

  const windowListeners = {};
  const documentListeners = {};
  const fakeWindow = {
    innerWidth: 800, innerHeight: 600,
    localStorage: { getItem: () => null, setItem: () => {}, },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, callback) => { (windowListeners[type] ??= []).push(callback); },
    removeEventListener: (type, callback) => { if (windowListeners[type]) windowListeners[type] = windowListeners[type].filter((entry) => entry !== callback); },
    setTimeout: (cb, delay) => schedule('timeout', cb, delay),
    clearTimeout: clear,
    setInterval: (cb, delay) => schedule('interval', cb, delay),
    clearInterval: clear,
  };
  const documentObj = {
    visibilityState: visible ? 'visible' : 'hidden',
    body: { dataset: {} },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    addEventListener: (type, callback) => { (documentListeners[type] ??= []).push(callback); },
    removeEventListener: (type, callback) => { if (documentListeners[type]) documentListeners[type] = documentListeners[type].filter((entry) => entry !== callback); },
  };

  // Fake API: controllable pending getStatus promises; recorded subscriptions.
  const pendingStatus = [];
  let statusCalls = 0;
  let statusActive = 0;
  let statusPeak = 0;
  let currentSnapshot = readySnapshot();
  let resolveQuitCallback = null;
  const subscriptions = { resolveQuit: false };
  fakeWindow.clipdockAPI = {
    getStatus: () => {
      statusCalls += 1;
      statusActive += 1;
      statusPeak = Math.max(statusPeak, statusActive);
      return new Promise((resolve, reject) => pendingStatus.push({ resolve, reject }))
        .finally(() => { statusActive -= 1; });
    },
    onResolveQuit: (callback) => {
      subscriptions.resolveQuit = true;
      resolveQuitCallback = callback;
      // Real preload removes the ipcRenderer listener on unsubscribe, so the
      // callback can no longer fire afterwards — mirror that here.
      return () => { subscriptions.resolveQuit = false; resolveQuitCallback = null; };
    },
    onYoutubeEvent: () => () => undefined,
    onPexelsEvent: () => () => undefined,
    onSocialEvent: () => () => undefined,
  };

  const sandbox = {
    window: fakeWindow,
    document: documentObj,
    console, Date, Intl, Math, Number, Promise, URL, WeakMap, Set, Map, queueMicrotask,
    crypto: { randomUUID: () => `host-test-${statusCalls}`, getRandomValues: () => new Uint8Array(0) },
    setTimeout: (cb) => schedule('timeout', cb, 0),
    clearTimeout: clear,
  };
  let hostTest = null;
  // Missing Phase-5 functions degrade to no-ops so pre-implementation runs fail at
  // the precise behavior assertions below instead of at harness evaluation.
  runInNewContext(`${renderer}\nglobalThis.__hostTest = {
  refresh,
  scheduleHostRefresh,
  startHostPolling: typeof startHostPolling === 'function' ? startHostPolling : () => undefined,
  stopHostPolling: typeof stopHostPolling === 'function' ? stopHostPolling : () => undefined,
  hostActionReason,
  hostStatus: () => hostStatus,
  statusInFlight: () => statusSession.inFlight,
};`, sandbox);
  hostTest = sandbox.__hostTest;

  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

  return {
    el: (id) => elements.get(id),
    document: documentObj,
    windowListeners,
    documentListeners,
    subscriptions,
    advance,
    flush,
    // Settle the next pending getStatus with the current snapshot (or an override).
    settle: async (snapshot = currentSnapshot) => {
      const entry = pendingStatus.shift();
      if (!entry) throw new Error('no pending getStatus to settle');
      entry.resolve(snapshot);
      await flush();
      await flush();
    },
    // Settle the MOST RECENT pending call (e.g. a later success while an older
    // timed-out call is still pending), so a stale late response can be tested.
    settleLast: async (snapshot = currentSnapshot) => {
      const entry = pendingStatus.pop();
      if (!entry) throw new Error('no pending getStatus to settle');
      entry.resolve(snapshot);
      await flush();
      await flush();
    },
    fireDOMContentLoaded: () => { for (const cb of windowListeners.DOMContentLoaded ?? []) cb(); },
    emitResolveQuit: () => { resolveQuitCallback?.(); },
    emitWindowFocus: () => { for (const callback of [...(windowListeners.focus ?? [])]) callback(); },
    fireVisibilityChange: () => { for (const cb of documentListeners.visibilitychange ?? []) cb(); },
    fireBeforeUnload: () => { for (const cb of windowListeners.beforeunload ?? []) cb(); },
    refresh: () => hostTest.refresh(),
    hostStatus: () => hostTest.hostStatus(),
    hostActionReason: (action) => hostTest.hostActionReason(action),
    inFlight: () => hostTest.statusInFlight(),
    get statusCalls() { return statusCalls; },
    get statusPeak() { return statusPeak; },
    get statusActive() { return statusActive; },
    set snapshot(next) { currentSnapshot = next; },
    timeoutCount: () => [...timers.values()].filter((t) => t.kind === 'timeout').length,
    intervalCount: () => [...timers.values()].filter((t) => t.kind === 'interval').length,
  };
}

test('ResolveQuit is subscribed; quit renders a bridge-error snapshot and disables host actions synchronously', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  assert.equal(h.subscriptions.resolveQuit, true);
  assert.equal(h.hostStatus().phase, 'ready');

  h.emitResolveQuit();
  // Synchronous: no timer flush, no settle needed.
  assert.equal(h.hostStatus().phase, 'bridge-error');
  assert.equal(h.hostStatus().bridge.connected, false);
  assert.equal(h.hostStatus().project.loaded, false);
  assert.equal(h.hostStatus().timeline.loaded, false);
  assert.equal(h.document.body.dataset.phase, 'bridge-error');
  assert.equal(h.el('bridge-state').textContent, 'Not connected');
  assert.equal(h.el('project-name').textContent, 'No project open');
  assert.equal(h.hostActionReason('import'), 'Host connection unavailable. Click Refresh to retry.');
  assert.equal(h.hostActionReason('timeline'), 'Host connection unavailable. Click Refresh to retry.');
  assert.equal(h.hostActionReason('drag'), 'Host connection unavailable. Click Refresh to retry.');
});

test('an older in-flight status response cannot restore Connected after ResolveQuit', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  assert.equal(h.statusCalls, 1);
  h.emitResolveQuit();
  assert.equal(h.hostStatus().phase, 'bridge-error');
  await h.settle(readySnapshot('Stale project', 'Stale timeline'));
  assert.equal(h.hostStatus().phase, 'bridge-error');
  assert.equal(h.el('bridge-state').textContent, 'Not connected');
  h.advance(REFRESH_DEBOUNCE_MS);
  assert.equal(h.statusCalls, 2);
  await h.settle(readySnapshot('Recovered project', 'Recovered timeline'));
  assert.equal(h.hostStatus().phase, 'ready');
  assert.equal(h.hostStatus().project.name, 'Recovered project');
});

test('ResolveQuit schedules a controlled refresh through the existing debounce', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  assert.equal(h.statusCalls, 1);
  h.emitResolveQuit();
  assert.equal(h.timeoutCount(), 1); // one 120ms debounce; no immediate duplicate call
  assert.equal(h.statusCalls, 1);
  h.advance(REFRESH_DEBOUNCE_MS);
  assert.equal(h.statusCalls, 2);
  await h.settle();
  assert.equal(h.statusActive, 0);
});

test('visible poll detects project/timeline snapshot changes at the fixed low frequency', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  assert.equal(h.hostStatus().project.name, 'Alpha');
  assert.equal(h.el('project-name').textContent, 'Alpha');
  assert.equal(h.intervalCount(), 1);

  h.snapshot = readySnapshot('Beta', 'TL-2');
  h.advance(HOST_POLL_MS); // poll tick
  await h.settle();
  assert.equal(h.hostStatus().project.name, 'Beta');
  assert.equal(h.hostStatus().timeline.name, 'TL-2');
  assert.equal(h.el('project-name').textContent, 'Beta');
  assert.equal(h.el('timeline-name').textContent, 'TL-2');
  assert.equal(h.statusCalls, 2);
  assert.equal(h.intervalCount(), 1); // still exactly one interval
});

test('hidden state stops the poll; becoming visible restarts one poll and refreshes immediately', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  assert.equal(h.intervalCount(), 1);

  h.document.visibilityState = 'hidden';
  h.fireVisibilityChange();
  assert.equal(h.intervalCount(), 0); // hidden: no poll at all
  assert.equal(h.timeoutCount(), 0);  // hiding schedules nothing
  assert.equal(h.statusCalls, 1);
  h.advance(HOST_POLL_MS * 3);
  assert.equal(h.statusCalls, 1);     // no polling while hidden

  h.document.visibilityState = 'visible';
  h.fireVisibilityChange();
  assert.equal(h.intervalCount(), 1); // exactly one poll restarted
  assert.equal(h.timeoutCount(), 1);  // immediate refresh debounce
  h.advance(REFRESH_DEBOUNCE_MS);
  assert.equal(h.statusCalls, 2);
  await h.settle();
  h.advance(HOST_POLL_MS);
  assert.equal(h.statusCalls, 3);     // poll resumes
  await h.settle();
  assert.equal(h.statusActive, 0);
});

test('burst/poll/manual calls never exceed one in-flight getStatus and produce at most one trailing request', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  assert.equal(h.statusCalls, 1); // initial refresh held in flight

  for (let event = 0; event < 20; event += 1) h.emitWindowFocus();
  h.advance(HOST_POLL_MS); // poll tick lands while in flight
  h.refresh();             // manual refresh while in flight
  assert.equal(h.statusCalls, 1);
  assert.equal(h.statusPeak, 1);
  assert.equal(h.statusActive, 1);

  await h.settle();        // initial resolves -> trailing fires
  assert.equal(h.statusCalls, 2); // exactly ONE trailing request
  assert.equal(h.statusPeak, 1);
  assert.equal(h.statusActive, 1);
  await h.settle();
  assert.equal(h.statusCalls, 2);
  assert.equal(h.statusActive, 0);
});

test('a hung getStatus releases the single-flight guard and Refresh button after the bounded timeout; a later call recovers', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle(); // initial refresh completes: ready (Alpha)
  assert.equal(h.hostStatus().phase, 'ready');
  h.document.visibilityState = 'hidden'; // stop the poll so no tick can trail the hang
  h.fireVisibilityChange();
  h.refresh(); // this call never settles
  assert.equal(h.statusCalls, 2);
  assert.equal(h.statusActive, 1);
  assert.equal(h.el('refresh-btn').disabled, true);
  h.advance(HOST_STATUS_TIMEOUT_MS - 1);
  assert.equal(h.inFlight(), true); // still bounded before the deadline
  assert.equal(h.el('refresh-btn').disabled, true);
  h.advance(1); // deadline: single-flight guard released
  assert.equal(h.inFlight(), false);
  assert.equal(h.el('refresh-btn').disabled, false);
  assert.equal(h.hostStatus().phase, 'ready'); // snapshot untouched by the timeout
  assert.equal(h.statusCalls, 2); // the timeout itself never re-requests
  h.snapshot = readySnapshot('Recovered', 'TL-2');
  h.refresh(); // manual recovery
  assert.equal(h.statusCalls, 3);
  await h.settleLast(); // resolves the recovery call (the hung call is still pending)
  assert.equal(h.hostStatus().phase, 'ready');
  assert.equal(h.hostStatus().project.name, 'Recovered');
  assert.equal(h.el('project-name').textContent, 'Recovered');
  assert.equal(h.el('refresh-btn').disabled, false);
  assert.equal(h.inFlight(), false);
});

test('a timed-out status response cannot overwrite a later success', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle(); // initial: Alpha
  h.document.visibilityState = 'hidden';
  h.fireVisibilityChange();
  h.refresh(); // call 2 hangs
  h.advance(HOST_STATUS_TIMEOUT_MS); // times out; guard released
  assert.equal(h.inFlight(), false);
  assert.equal(h.el('refresh-btn').disabled, false);
  h.snapshot = readySnapshot('Newer', 'TL-2');
  h.refresh(); // call 3 succeeds
  assert.equal(h.statusCalls, 3);
  await h.settleLast(); // resolve call 3 first: the newer success wins
  assert.equal(h.hostStatus().project.name, 'Newer');
  assert.equal(h.el('project-name').textContent, 'Newer');
  // The timed-out call 2 finally answers with stale data: it must be dropped.
  h.snapshot = readySnapshot('Stale', 'TL-1');
  await h.settle(); // resolves the remaining pending call (the timed-out one)
  assert.equal(h.hostStatus().project.name, 'Newer');
  assert.equal(h.el('project-name').textContent, 'Newer');
  assert.equal(h.el('refresh-btn').disabled, false);
  assert.equal(h.inFlight(), false);
  assert.equal(h.statusActive, 0); // both calls have now settled; only the newer one landed
});

test('the visible poll recovers automatically after a hung status call times out', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  h.refresh(); // hangs; every poll tick folds into the trailing request
  assert.equal(h.statusCalls, 2);
  h.advance(HOST_STATUS_TIMEOUT_MS); // timeout releases the guard; trailing fires a fresh call
  assert.equal(h.statusCalls, 3);
  assert.equal(h.inFlight(), true); // recovery call is in flight
  assert.equal(h.el('refresh-btn').disabled, true);
  await h.settle(); // stale timed-out response — dropped
  assert.equal(h.hostStatus().project.name, 'Alpha');
  h.snapshot = readySnapshot('Recovered', 'TL-2');
  await h.settle(); // recovery call succeeds
  assert.equal(h.hostStatus().project.name, 'Recovered');
  assert.equal(h.el('project-name').textContent, 'Recovered');
  assert.equal(h.inFlight(), false);
  assert.equal(h.statusActive, 0);
});

test('beforeunload unsubscribes quit, removes focus+visibility listeners, and clears debounce and poll timers', async () => {
  const h = createHarness({ visible: true });
  h.fireDOMContentLoaded();
  await h.settle();
  h.emitWindowFocus();
  assert.equal(h.timeoutCount(), 1); // debounce pending
  assert.equal(h.intervalCount(), 1); // poll pending
  assert.ok(h.windowListeners.focus?.length);
  assert.ok(h.documentListeners.visibilitychange?.length);
  assert.equal(h.subscriptions.resolveQuit, true);

  h.fireBeforeUnload();
  assert.equal(h.subscriptions.resolveQuit, false);
  assert.equal(h.windowListeners.focus.length, 0);
  assert.equal(h.documentListeners.visibilitychange.length, 0);
  assert.equal(h.timeoutCount(), 0);
  assert.equal(h.intervalCount(), 0);

  h.advance(HOST_POLL_MS * 3);
  assert.equal(h.statusCalls, 1); // nothing fires after unload
  h.emitResolveQuit();            // unsubscribed: callback is a no-op
  h.emitWindowFocus();
  h.advance(HOST_POLL_MS * 3);
  assert.equal(h.statusCalls, 1);
  assert.equal(h.hostStatus().phase, 'ready'); // snapshot untouched after unload
});
