#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ArgError, parseArgs } from './lib/args.mjs';
import { resolveBinary, scriptEnv, scriptLibForBinary, validatePaths } from './lib/locate.mjs';
import { BoundedBuffer, activeProcessMessage, assertNoResolveRunning, collectProcesses, collectResidue, shutdown, spawnResolve } from './lib/spawn.mjs';
import { checkPython, runProbe } from './lib/probe.mjs';
import { EXIT, renderReport, sanitizeError, sanitizeMessage } from './lib/report.mjs';
import { createPythonBridge } from './lib/bridge.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');
const require = createRequire(import.meta.url);
const PREFIX = 'ClipDock-E2E-';
const PLUGIN_ID = 'com.clipdock.app';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const USAGE = `ClipDock Resolve headless end-to-end gate (opt-in).
Usage: node scripts/resolve-smoke/e2e.mjs [options]
Run npm run build first. Refuses when Resolve or fuscript is running. Creates and deletes
only its own ClipDock-E2E- project; exercises real transfer/status/media prep.
Options (same defaults as run.mjs):
  --bundle <path>       Resolve bundle or binary
  --script-api <path>   official Developer/Scripting folder
  --python <path>       Python executable (default: python3)
  --timeout-ms <n>      readiness deadline (default: 120000)
  --quit-grace-ms <n>   graceful shutdown wait (default: 15000)
  --term-wait-ms <n>    TERM wait (default: 10000)
  --kill-wait-ms <n>    KILL wait (default: 5000)
  --download-url=<url>  optional yt-dlp download (YouTube or supported social URL)
  --pretty              pretty JSON
  --help                show usage
Exit codes: 0 passed/unavailable; 2 usage; 3 setup failure;
4 Resolve/fuscript already running; 5 failed check; 6 cleanup failure.`;

export function parseE2eArgs(argv) {
  if (argv.includes('--help')) return { ...parseArgs(['--help']), downloadUrl: null };
  const smokeArgs = [];
  let downloadUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--download-url' || arg.startsWith('--download-url=')) {
      downloadUrl = arg === '--download-url' ? argv[++i] : arg.slice('--download-url='.length);
      if (!downloadUrl || downloadUrl.startsWith('--')) throw new ArgError('--download-url requires a URL');
      let url;
      try { url = new URL(downloadUrl); } catch { throw new ArgError('--download-url requires an http(s) URL'); }
      if (!['https:', 'http:'].includes(url.protocol)) throw new ArgError('--download-url requires an http(s) URL');
    } else {
      if (arg === '--probe' || arg.startsWith('--probe=')) throw new ArgError('--probe is only supported by the read-only smoke harness');
      smokeArgs.push(arg);
    }
  }
  return { ...parseArgs(smokeArgs), downloadUrl };
}

export function loadClipDock() {
  if (!existsSync(path.join(ROOT, 'dist/transfer.js'))) throw new Error('dist/transfer.js is missing; run npm run build first');
  return Object.assign({}, ...['transfer', 'status-provider', 'media-prep', 'path-boundary', 'ytdlp', 'ytdlp-url'].map(name => require(path.join(ROOT, `dist/${name}.js`))));
}

export function generateFixtures(root, ffmpeg) {
  if (!ffmpeg) throw new Error('ffmpeg was not found (ClipDock discoverFfmpeg)');
  const fixture = path.join(root, 'clip één.mp4');
  const oddFixture = path.join(root, 'odd 161x97.mkv');
  function generate(args) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Fixture generation failed: ${sanitizeMessage(result.error?.message ?? result.stderr)}`);
  }
  generate(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', fixture]);
  // FFV1 preserves odd dimensions and forces the real fast-profile transcode.
  generate(['-f', 'lavfi', '-i', 'testsrc=size=161x97:rate=25', '-t', '2', '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', oddFixture]);
  return { fixture, oddFixture };
}

export async function assertTestProject(pm, name) {
  if (!name.startsWith(PREFIX)) throw new Error('Unsafe test project name');
  const project = await pm.GetCurrentProject();
  const actual = project ? await project.GetName() : null;
  if (actual !== name) throw new Error(`Refusing mutation: current project ${JSON.stringify(actual)} does not equal ${JSON.stringify(name)}`);
}

const MUTATING = new Set(['OpenPage', 'AddItemListToMediaPool', 'AppendToTimeline', 'AddSubFolder', 'SetCurrentFolder', 'AddMarker', 'SetClipColor', 'CreateEmptyTimeline', 'SetCurrentTimeline']);
/** Wrap only the harness adapter; src behavior and optional method presence stay intact. */
export function guardWorkflowIntegration(workflowIntegration, assertSafe) {
  const wrapped = new WeakMap();
  const originals = new WeakMap();
  const unwrap = value => {
    if (value && originals.has(value)) return originals.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
    return value;
  };
  function wrap(value) {
    if (Array.isArray(value)) return value.map(wrap);
    if (!value || typeof value !== 'object') return value;
    if (wrapped.has(value)) return wrapped.get(value);
    const object = {};
    wrapped.set(value, object);
    originals.set(object, value);
    for (const [name, member] of Object.entries(value)) {
      object[name] = typeof member === 'function' ? async (...args) => {
        if (MUTATING.has(name)) await assertSafe();
        return wrap(await member(...args.map(unwrap)));
      } : wrap(member);
    }
    return object;
  }
  return { Initialize: (...args) => workflowIntegration.Initialize(...args), GetResolve: async () => wrap(await workflowIntegration.GetResolve()) };
}

function check(expected, actual, ok) { return { status: ok ? 'pass' : 'fail', expected, actual }; }
async function clipCount(folder, fixture) {
  const clips = await folder.GetClipList();
  if (!Array.isArray(clips)) throw new Error('GetClipList did not return a list');
  const paths = await Promise.all(clips.map(clip => clip.GetClipProperty('File Path')));
  return paths.filter(file => file === fixture).length;
}
export async function importActiveScenario({ transfer, mediaPool, fixture }, duplicate = false) {
  const result = await transfer.importToMediaPool(fixture, 'active');
  const count = await clipCount(await mediaPool.GetCurrentFolder(), fixture);
  const kind = duplicate ? 'already-imported' : 'imported';
  return check({ kind, count: 1 }, { kind: result.kind, count, message: result.message }, result.ok === true && result.kind === kind && count === 1);
}
export const importDuplicateScenario = context => importActiveScenario(context, true);

function frameNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const frame = Number(value);
  return Number.isSafeInteger(frame) ? frame : null;
}

async function timelineFrames(timeline) {
  const items = await timeline.GetItemListInTrack('video', 1);
  if (!Array.isArray(items)) throw new Error('GetItemListInTrack did not return a list');
  const frames = await Promise.all(items.map(async item => frameNumber(await item.GetStart())));
  if (frames.includes(null)) throw new Error('Timeline item GetStart did not return a frame');
  return frames;
}

async function playheadFrame({api, workflowIntegration, timeline}) {
  if (typeof timeline.GetStartFrame !== 'function' || typeof timeline.GetStartTimecode !== 'function' || typeof timeline.GetCurrentTimecode !== 'function') return null;
  const project = await (await (await workflowIntegration.GetResolve()).GetProjectManager()).GetCurrentProject();
  const rate = await project.GetSetting('timelineFrameRate');
  const startFrame = frameNumber(await timeline.GetStartFrame());
  const start = api.timecodeToFrames(await timeline.GetStartTimecode(), rate);
  const current = api.timecodeToFrames(await timeline.GetCurrentTimecode(), rate);
  if (startFrame === null || !start || !current || start.dropFrame !== current.dropFrame || current.frames < start.frames) return null;
  return startFrame + current.frames - start.frames;
}

async function timelinePlacementScenario(context, placement, automation) {
  const {timeline, transfer, fixture} = context;
  const before = await timelineFrames(timeline);
  const expectedFrame = placement === 'end' ? frameNumber(await timeline.GetEndFrame()) : await playheadFrame(context);
  const result = await transfer.addToTimeline(fixture, 'active', placement, automation);
  if (placement === 'playhead' && result.kind === 'playhead-unsupported') return {status: 'unavailable', expected: 'timeline-inserted', actual: result.kind};
  const after = await timelineFrames(timeline);
  // Compare multisets of starts rather than array order or proxy identity.
  // Resolve may return the existing items in a different order on read-back.
  const remaining = [...after];
  for (const frame of before) {
    const index = remaining.indexOf(frame);
    if (index === -1) return check('existing timeline items preserved', {before, after}, false);
    remaining.splice(index, 1);
  }
  const kind = placement === 'end' ? 'timeline-appended' : 'timeline-inserted';
  const expected = {kind, count: before.length + 1, recordFrame: expectedFrame};
  const actual = {kind: result.kind, count: after.length, recordFrame: remaining.length === 1 ? remaining[0] : null};
  return check(expected, actual, result.ok === true && actual.kind === kind && actual.count === expected.count && expectedFrame !== null && actual.recordFrame === expectedFrame);
}

export async function runScenarios(context) {
  const { api, workflowIntegration, transfer, mediaPool, timeline, fixture, oddFixture, fixtureRoot, projectName, ffmpeg, downloadUrl } = context;
  const checks = {};
  async function scenario(name, fn) {
    try {
      await context.assertSafe?.();
      checks[name] = await fn();
      await context.assertSafe?.();
    }
    catch (error) { checks[name] = check('scenario completes', { error: sanitizeMessage(error.message) }, false); }
  }
  if (downloadUrl) await scenario('import-downloaded', async () => {
    const worker = new api.YtdlpWorker(undefined, undefined, undefined, { sessionDir: fixtureRoot, ffmpegPath: ffmpeg });
    try {
      const args = [downloadUrl, 'best', 'e2e_download', () => {}];
      const downloaded = api.validateYoutubeUrl(downloadUrl) ? await worker.download(...args) : await worker.downloadSocial(...args);
      return await importActiveScenario({ transfer, mediaPool, fixture: downloaded.filePath });
    } finally { await worker.dispose(); }
  });
  await scenario('status', async () => {
    const status = await api.createStatusProvider(workflowIntegration, PLUGIN_ID).getStatus();
    return check({ project: projectName, phase: 'ready' }, { project: status.project.name, phase: status.phase }, status.project.name === projectName && status.phase === 'ready');
  });
  await scenario('import-active', () => importActiveScenario(context));
  await scenario('import-duplicate', () => importDuplicateScenario(context));
  await scenario('import-clipdock-bin', async () => {
    const result = await transfer.importToMediaPool(fixture, 'clipdock');
    const root = await mediaPool.GetRootFolder();
    const folders = await root.GetSubFolderList();
    const names = await Promise.all(folders.map(folder => folder.GetName()));
    const folder = folders[names.indexOf('ClipDock')];
    const count = folder ? await clipCount(folder, fixture) : 0;
    return check({ kind: 'imported', folder: 'ClipDock', count: 1 }, { kind: result.kind, folder: folder ? 'ClipDock' : null, count }, result.ok === true && result.kind === 'imported' && count === 1);
  });
  await scenario('timeline-end', () => timelinePlacementScenario(context, 'end'));
  await scenario('timeline-automation', async () => {
    const chapters = [{ start: 0, end: 1, title: 'E2E chapter one' }, { start: 1, end: 3, title: 'E2E chapter two' }];
    const placement = await timelinePlacementScenario(context, 'end', { provider: 'youtube', source: 'ClipDock E2E fixture', selection: null, chapters });
    if (placement.status !== 'pass') return placement;
    if (typeof timeline.AddMarker !== 'function') return { status: 'unavailable', expected: 'AddMarker', actual: placement.actual };
    const markers = await timeline.GetMarkers();
    const names = Object.values(markers ?? {}).map(marker => marker.name);
    return check({recordFrame: placement.expected.recordFrame, markers: chapters.map(chapter => chapter.title)}, {recordFrame: placement.actual.recordFrame, markers: names}, chapters.every(chapter => names.includes(chapter.title)));
  });
  await scenario('timeline-playhead', () => timelinePlacementScenario(context, 'playhead'));
  await scenario('media-prep-fast', async () => {
    const prep = api.createMediaPrep({ ffmpegPath: ffmpeg, conversionTimeoutMs: 30000 });
    try {
      const prepared = await prep.prepare({ jobId: 'e2e_prep', inputPath: oddFixture, allowedRoot: fixtureRoot, profile: 'fast', emit: () => {} });
      const imported = await importActiveScenario({ transfer, mediaPool, fixture: prepared.filePath });
      return { ...imported, actual: { ...imported.actual, action: prepared.action } };
    } finally { await prep.dispose(); }
  });
  return checks;
}

export async function waitForProjectManager(bridge, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  const timedOut = () => new Error(`Resolve ProjectManager readiness timed out after ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ''}`);
  let timer;
  const poll = async () => {
    while (Date.now() < deadline) {
      try {
        const resolve = await bridge.workflowIntegration.GetResolve();
        if (Date.now() >= deadline) throw timedOut();
        const pm = resolve && await resolve.GetProjectManager();
        if (pm && Array.isArray(await pm.GetProjectListInCurrentFolder())) return { resolve, pm };
      } catch (error) { lastError = error; }
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    throw timedOut();
  };
  try {
    return await Promise.race([
      poll(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timedOut()), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Injectable orchestration seam: tests never spawn a Resolve binary. */
export async function runE2e(cfg, injected = {}) {
  const deps = { assertNoResolveRunning, collectProcesses, collectResidue, spawnResolve, shutdown, runProbe, createPythonBridge, validatePaths, checkPython, loadClipDock, generateFixtures, platform: process.platform, ...injected };
  const startedAt = Date.now();
  const report = { harness: 'clipdock-resolve-e2e', ok: false, platform: deps.platform, bundle: { binary: resolveBinary(cfg.bundle), scriptApi: cfg.scriptApi, python: cfg.python }, refusal: { resolveRunningBefore: null, fuscriptRunningBefore: null, resolvePids: null, fuscriptPids: null }, projectName: null, checks: null, phases: {}, residue: null, errors: [] };
  let exitCode = EXIT.OK;
  let fixtureRoot, child, bridge, pm, project, created = false, creationAttempted = false, creationResponded = false, projectClosed = false;
  const childErr = new BoundedBuffer(4096);
  const error = (code, err) => report.errors.push(sanitizeError({ code, message: err?.message ?? String(err) }));
  function assertOwned() {
    const pids = deps.collectProcesses('Resolve');
    if (!child?.pid || pids.length !== 1 || pids[0] !== child.pid) throw new Error('Resolve process ownership is unproven; refusing mutation');
  }
  try {
    const pre = deps.assertNoResolveRunning();
    report.refusal.resolveRunningBefore = pre.pids.length;
    report.refusal.fuscriptRunningBefore = (pre.fuscriptPids ?? []).length;
    report.refusal.resolvePids = pre.pids;
    report.refusal.fuscriptPids = pre.fuscriptPids ?? [];
    if (!pre.ok) { exitCode = EXIT.REFUSED; throw new Error(activeProcessMessage(pre)); }
    if (deps.platform !== 'darwin') throw new Error(`Unsupported platform: ${deps.platform}`);
    const binary = report.bundle.binary;
    const paths = deps.validatePaths({ binary, scriptApi: cfg.scriptApi, scriptLib: scriptLibForBinary(binary) });
    if (!paths.ok) throw new Error(paths.error.message);
    const python = deps.checkPython(cfg.python);
    if (!python.ok) throw new Error(python.error.message);
    const api = deps.loadClipDock();
    fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'clipdock-e2e-')));
    const ffmpeg = api.discoverFfmpeg();
    const fixtures = deps.generateFixtures(fixtureRoot, ffmpeg);
    const env = scriptEnv(binary, cfg.scriptApi, process.env);
    child = deps.spawnResolve(binary, { env });
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => childErr.push(chunk));
    const launch = await child.launch;
    if (!launch.ok) throw launch.error;
    env.RESOLVE_SMOKE_CHILD_PID = String(child.pid);
    report.phases.spawn = { ms: Date.now() - startedAt };
    bridge = deps.createPythonBridge({ python: cfg.python, env, script: path.join(DIR, 'bridge.py'), timeoutMs: Math.min(30000, cfg.timeoutMs) });
    const connected = await waitForProjectManager(bridge, cfg.timeoutMs);
    pm = connected.pm;
    report.phases.connect = { ms: Date.now() - startedAt - report.phases.spawn.ms };
    const projectName = `${PREFIX}${Date.now()}-${process.pid}`;
    report.projectName = projectName;
    assertOwned();
    const projects = await pm.GetProjectListInCurrentFolder();
    if (projects.includes(projectName)) throw new Error('Test project already exists; refusing creation/deletion');
    // Creation is the bootstrap exception: there cannot yet be a current test project.
    assertOwned();
    creationAttempted = true;
    project = await pm.CreateProject(projectName);
    creationResponded = true;
    created = !!project;
    if (!created) throw new Error('CreateProject returned no project');
    const assertSafe = async () => { assertOwned(); await assertTestProject(pm, projectName); };
    await assertSafe();
    const workflowIntegration = guardWorkflowIntegration(bridge.workflowIntegration, assertSafe);
    const guardedResolve = await workflowIntegration.GetResolve();
    const guardedPM = await guardedResolve.GetProjectManager();
    const guardedProject = await guardedPM.GetCurrentProject();
    const mediaPool = await guardedProject.GetMediaPool();
    const timeline = await mediaPool.CreateEmptyTimeline('ClipDock E2E timeline');
    if (!timeline || await guardedProject.SetCurrentTimeline(timeline) !== true) throw new Error('Could not create/set current test timeline');
    const transfer = api.createTransfer(workflowIntegration, PLUGIN_ID, { validatePath: p => api.canonicalMediaPath(p, fixtureRoot, true) });
    report.checks = await runScenarios({ api, workflowIntegration, transfer, mediaPool, timeline, fixtureRoot, projectName, ffmpeg, downloadUrl: cfg.downloadUrl, assertSafe, ...fixtures });
    if (Object.values(report.checks).some(item => !['pass', 'unavailable'].includes(item.status))) exitCode = EXIT.PROBE_FAILED;
  } catch (err) {
    if (exitCode === EXIT.OK) exitCode = EXIT.ENVIRONMENT;
    error(exitCode === EXIT.REFUSED ? 'resolve-already-running' : 'setup-failed', err);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (name, fn) => { try { await fn(); } catch (err) { cleanupErrors.push(name); error(name, err); } };
    if (creationAttempted && !creationResponded) {
      // A failed RPC may have created a project; do not pretend cleanup is proven.
      cleanupErrors.push('project-creation-unconfirmed');
      error('project-creation-unconfirmed', new Error(`Creation result unconfirmed for ${report.projectName}; verify the project list on the next live run`));
    }
    if (created) {
      await cleanup('project-close-failed', async () => {
        assertOwned();
        await assertTestProject(pm, report.projectName);
        if (await project.GetName() !== report.projectName) throw new Error('Unsafe project close');
        if (await pm.CloseProject(project) !== true) throw new Error('CloseProject returned false');
        projectClosed = true;
      });
      await cleanup('project-delete-failed', async () => {
        assertOwned();
        // Deletion is the lifecycle exception: CloseProject has removed the current project.
        if (!report.projectName.startsWith(PREFIX) || !projectClosed) throw new Error('Unsafe project deletion: project was not verified and closed');
        const current = await pm.GetCurrentProject();
        if (current && await current.GetName() === report.projectName) throw new Error('Test project remains open; refusing deletion');
        if (await pm.DeleteProject(report.projectName) !== true) throw new Error('DeleteProject returned false');
        if ((await pm.GetProjectListInCurrentFolder()).includes(report.projectName)) throw new Error('Deleted project remains in project list');
      });
    }
    if (bridge) await cleanup('bridge-close-failed', () => bridge.close());
    if (child) {
      await cleanup('resolve-shutdown-failed', async () => {
        // Reuse the smoke probe's ownership-gated Quit; never signal another process.
        if ((await child.launch).ok) await deps.runProbe({ python: cfg.python, probeScript: path.join(DIR, 'probe.py'), env: { ...scriptEnv(report.bundle.binary, cfg.scriptApi, process.env), RESOLVE_SMOKE_CHILD_PID: String(child.pid) }, timeoutMs: Math.min(10000, cfg.timeoutMs), mode: 'quit-only' });
      });
      await cleanup('resolve-cleanup-failed', async () => {
        report.phases.cleanup = await deps.shutdown(child, { graceMs: cfg.quitGraceMs, termMs: cfg.termWaitMs, killMs: cfg.killWaitMs });
        if (!['graceful', 'terminated', 'killed'].includes(report.phases.cleanup.kind)) throw new Error(`Resolve cleanup: ${report.phases.cleanup.kind}`);
      });
      await cleanup('residue-check-failed', async () => {
        await sleep(250);
        const residue = deps.collectResidue();
        report.residue = residue.residue;
        if (!residue.ok || residue.residue.resolve !== 0 || residue.residue.fuscript !== 0) throw new Error(residue.error?.message ?? 'Resolve/fuscript residue remains');
      });
    }
    if (fixtureRoot) await cleanup('fixture-cleanup-failed', () => rmSync(fixtureRoot, { recursive: true, force: true }));
    if (cleanupErrors.length) exitCode = EXIT.CLEANUP_FAILED;
  }
  report.ok = exitCode === EXIT.OK && report.checks !== null;
  report.elapsedMs = Date.now() - startedAt;
  if (report.errors.length || exitCode !== EXIT.OK) report.diagnostics = { childStderrTail: sanitizeMessage(childErr.toString(), 1500) };
  return { exitCode, report };
}

async function main() {
  let cfg;
  try { cfg = parseE2eArgs(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`${err.message}\n\n${USAGE}\n`); process.exitCode = EXIT.USAGE; return; }
  if (cfg.help) { process.stdout.write(`${USAGE}\n`); return; }
  const { exitCode, report } = await runE2e(cfg);
  process.stdout.write(renderReport(report, cfg.pretty));
  process.exitCode = exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`${sanitizeMessage(err.message)}\n`); process.exitCode = 1; });
}
