import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync, realpathSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('probe, profiles, collisions, rate selection, cancellation and target label', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const { createMediaPrep, discoverFfprobe, parseFfprobe } = await import(path.join(dist, 'media-prep.js'));
  const phase3Root = mkdtempSync(path.join(fixtureDir(), 'clipdock-contract-'));
  const child = () => {
    const value = new EventEmitter();
    value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
    value.kills = []; value.kill = (signal) => { value.kills.push(signal); return true; };
    return value;
  };
  const queuedSpawn = (runs, calls = []) => (_binary, args, options) => {
    if (_binary.endsWith('ffprobe') && args.includes('-show_streams') && /\[[^\]]+\]\.(?:mp4|mp3|wav|m4a)$/.test(args.at(-1))) {
      const value = child(); calls.push({args, options, child: value});
      queueMicrotask(() => { value.stdout.emit('data', Buffer.from(JSON.stringify({streams: [{codec_type: /\.(mp3|wav|m4a)$/.test(args.at(-1)) ? 'audio' : 'video', width: 160, height: 96}], format: {duration: '10', format_name: 'mov,mp4'}}))); value.emit('close', 0); });
      return value;
    }
    const value = child(); calls.push({ args, options, child: value });
    const run = runs.shift(); if (run) queueMicrotask(() => run(value, args));
    return value;
  };
  const closeWith = (stdout, code = 0, stderr = '') => (proc) => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  };
  const rejected = async (label, promise, message) => {
    try { await promise; fail(`${label} — resolved`); }
    catch (error) { expect(label, error.message, message); }
  };
  const versionFixture = (file, identity) => {
    writeFileSync(file, `#!/bin/sh\n[ "$1" = "-version" ] || exit 1\nprintf '${identity} version 99.0 fixture\\n'\n`, { mode: 0o755 });
    return file;
  };
  const probeJson = ({ codec = 'h264', pix = 'yuv420p', avg = '30/1', real = '30/1', audio = 'aac', width = 3840, height = 2160, duration = '10', container = 'mp4', rotation } = {}) => JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: codec, pix_fmt: pix, width, height, avg_frame_rate: avg, r_frame_rate: real, duration, ...(rotation === undefined ? {} : { side_data_list: [{ rotation }] }) },
      ...(audio === null ? [] : [{ codec_type: 'audio', codec_name: audio, duration }]),
    ],
    format: { format_name: container === 'other' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2', duration, tags: { major_brand: container === 'mov' ? 'qt  ' : 'isom' } },
  });
  expect('media-prep parses first video, optional audio, container, safe rate, duration, and rotation', parseFfprobe(probeJson({ rotation: -90 })), {
    video: { codec: 'h264', pixFmt: 'yuv420p', width: 3840, height: 2160, fps: 30, cfr: true, duration: 10, rotation: -90 }, audio: { codec: 'aac' }, duration: 10, container: 'mp4',
  });
  expect('media-prep parser marks missing rates unsafe', parseFfprobe(probeJson({ avg: '0/0', real: 'N/A', audio: null, container: 'mov' })), {
    video: { codec: 'h264', pixFmt: 'yuv420p', width: 3840, height: 2160, fps: null, cfr: false, duration: 10, rotation: null }, audio: null, duration: 10, container: 'mov',
  });
  expect('media-prep keeps a safe average rate for VFR-to-CFR conversion', [parseFfprobe(probeJson({ avg: '24/1', real: '30/1' })).video.fps, parseFfprobe(probeJson({ avg: '24/1', real: '30/1' })).video.cfr], [24, false]);
  const prepFile = (name, content = 'source') => { const requested = path.join(phase3Root, name); mkdirSync(requested, { recursive: true }); const dir = realpathSync(requested); const file = path.join(dir, `${name}.mkv`); writeFileSync(file, content); return { dir, file }; };
  const ffmpegRun = (chunks = ['out_time_', 'us=5000000\r\nprogress=continue\nout_time_ms=10000000\nprogress=end']) => (proc, args) => {
    writeFileSync(args.at(-1), 'prepared');
    chunks.forEach((chunk) => proc.stdout.emit('data', Buffer.from(chunk)));
    proc.emit('close', 0);
  };
  const prepWorker = (runs, calls, extra = {}) => {
    const spawn = queuedSpawn(runs, calls);
    return createMediaPrep({ ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', spawn: (...args) => {
      const value = spawn(...args);
      if (extra.platform === 'win32') value.pid = 4100; // Only the injected taskkill adapter sees a PID.
      return value;
    }, ...extra });
  };

  // Direct probes once and never invokes ffmpeg; 4K dimensions and no-audio are retained.
  {
    const { dir, file } = prepFile('prep-direct'); const calls = [], events = [];
    const worker = prepWorker([closeWith(probeJson({ audio: null }))], calls);
    const result = await worker.prepare({ jobId: 'prep-direct', inputPath: file, allowedRoot: dir, profile: 'fast', emit: (event) => events.push(event) });
    expect('media-prep direct result', [result.action, result.filePath, existsSync(file)], ['direct', file, true]);
    expect('media-prep direct only runs the decision probe', calls.map(({ args }) => args), [
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    ]);
    expect('media-prep probe spawn shell false', calls.map(({ options }) => options), [{ shell: false, detached: true }]);
    expect('media-prep emits processing before probe', events[0], { jobId: 'prep-direct', state: 'processing', percent: 0, message: 'Preparing for Resolve…' });
  }

  // Fast remux copies safe streams into MP4 with the official minimal progress argv.
  {
    const { dir, file } = prepFile('prep-remux'); const calls = [];
    const worker = prepWorker([closeWith(probeJson({ container: 'other' })), ffmpegRun(), closeWith(probeJson())], calls);
    const result = await worker.prepare({ jobId: 'prep-remux', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    const output = path.join(dir, 'prep-remux.resolve.mp4');
    expect('media-prep remux decision and cleanup', [result.action, result.filePath, existsSync(file), existsSync(output)], ['remux', output, false, true]);
    expect('media-prep remux exact argv', calls[1].args, ['-hide_banner', '-nostdin', '-n', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', calls[1].args.at(-1)]);
    assert.equal(path.dirname(path.dirname(calls[1].args.at(-1))), dir);
  }

  // Output collisions stay in the job directory, preserve the title, and never overwrite.
  {
    const { dir, file } = prepFile('prep-collision'); const calls = []; const occupied = path.join(dir, 'prep-collision.resolve.mp4'); writeFileSync(occupied, 'keep');
    const worker = prepWorker([closeWith(probeJson({ container: 'other' })), ffmpegRun(), closeWith(probeJson())], calls);
    const result = await worker.prepare({ jobId: 'prep-collision', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    expect('media-prep collision uses safe title-preserving sibling', [result.fileName, result.filePath, readFileSync(occupied, 'utf8')], ['prep-collision.resolve-2.mp4', path.join(dir, 'prep-collision.resolve-2.mp4'), 'keep']);
  }

  // Safe H.264 with incompatible audio copies video and encodes AAC only.
  {
    const { dir, file } = prepFile('prep-audio-remux'); const calls = [];
    const worker = prepWorker([closeWith(probeJson({ audio: 'opus', container: 'mov' })), ffmpegRun(), closeWith(probeJson())], calls);
    const result = await worker.prepare({ jobId: 'prep-audio-remux', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    expect('media-prep audio-remux decision', result.action, 'audio-remux');
    expect('media-prep audio-remux codec argv', calls[1].args.slice(9, 15), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']);
  }

  // Unsafe/VFR fast input fully transcodes without scaling and reports chunked progress.
  {
    const { dir, file } = prepFile('prep-fast-transcode'); const calls = [], events = [];
    const worker = prepWorker([closeWith(probeJson({ codec: 'vp9', pix: 'yuv420p10le', avg: '30000/1001', real: '24/1', audio: 'opus', container: 'other' })), ffmpegRun(), closeWith(probeJson({ avg: '30000/1001', real: '30000/1001' }))], calls);
    const result = await worker.prepare({ jobId: 'prep-fast', inputPath: file, allowedRoot: dir, profile: 'fast', emit: (event) => events.push(event) });
    const output = path.join(dir, 'prep-fast-transcode.resolve.mp4');
    expect('media-prep full fast decision', result.action, 'transcode');
    expect('media-prep fast exact argv for VFR average rate', calls[1].args, ['-hide_banner', '-nostdin', '-n', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '29.97003', '-fps_mode', 'cfr', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', calls[1].args.at(-1)]);
    assert.equal(path.dirname(path.dirname(calls[1].args.at(-1))), dir);
    expect('media-prep fast has no scale/vf', calls[1].args.some((arg) => arg === '-vf' || arg.startsWith('scale=')), false);
    expect('media-prep chunked progress clamps and ends at 100', events.filter((event) => event.percent !== null).map((event) => event.percent), [0, 50, 99.9, 100]);
  }

  // A codec-unsafe but CFR-safe Fast source carries its validated source rate into x264.
  {
    const { dir, file } = prepFile('prep-fast-cfr'); const calls = [];
    const worker = prepWorker([closeWith(probeJson({ codec: 'hevc', pix: 'yuv420p10le' })), ffmpegRun(), closeWith(probeJson())], calls);
    await worker.prepare({ jobId: 'prep-fast-cfr', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    expect('media-prep fast CFR exact argv', calls[1].args, ['-hide_banner', '-nostdin', '-n', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-fps_mode', 'cfr', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', calls[1].args.at(-1)]);
    assert.equal(path.dirname(path.dirname(calls[1].args.at(-1))), dir);
  }

  // Editing always transcodes to ProRes LT/PCM; safe CFR adds -r and keeps 4K.
  {
    const { dir, file } = prepFile('prep-editing'); const calls = [];
    const worker = prepWorker([closeWith(probeJson({ audio: null, container: 'mp4' })), ffmpegRun(), closeWith(probeJson({ codec: 'prores', pix: 'yuv422p10le', audio: null, container: 'mov' }))], calls);
    const result = await worker.prepare({ jobId: 'prep-editing', inputPath: file, allowedRoot: dir, profile: 'editing', emit: () => undefined });
    const output = path.join(dir, 'prep-editing.resolve.mov');
    expect('media-prep editing decision/output', [result.action, result.filePath], ['transcode', output]);
    expect('media-prep editing exact argv', calls[1].args, ['-hide_banner', '-nostdin', '-n', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le', '-r', '30', '-fps_mode', 'cfr', '-c:a', 'pcm_s16le', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', calls[1].args.at(-1)]);
    assert.equal(path.dirname(path.dirname(calls[1].args.at(-1))), dir);
    expect('media-prep editing has no scale/vf', calls[1].args.some((arg) => arg === '-vf' || arg.startsWith('scale=')), false);
  }

  // Unknown/out-of-range rates omit -r; VFR uses its safe average rate for CFR conversion.
  for (const [label, avg, real, targetRate] of [['unknown', '0/0', '0/0', null], ['out-of-range', '300/1', '300/1', null], ['vfr', '24/1', '30/1', '24']]) {
    const { dir, file } = prepFile(`prep-rate-${label}`); const calls = [];
    const outputProbe = targetRate ? probeJson({ avg: `${targetRate}/1`, real: `${targetRate}/1` }) : probeJson();
    const worker = prepWorker([closeWith(probeJson({ avg, real })), ffmpegRun(), closeWith(outputProbe)], calls);
    expect(`media-prep ${label} rate transcodes`, (await worker.prepare({ jobId: `rate-${label}`, inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined })).action, 'transcode');
    const rateIndex = calls[1].args.indexOf('-r');
    expect(`media-prep ${label} CFR target rate`, rateIndex < 0 ? null : calls[1].args[rateIndex + 1], targetRate);
  }
  for (const [label, outputProbe] of [
    ['codec', probeJson({ codec: 'hevc' })], ['pix-fmt', probeJson({ pix: 'yuv422p' })], ['dimensions', probeJson({ width: 1920 })],
    ['fps', probeJson({ avg: '24/1', real: '24/1' })], ['duration', probeJson({ duration: '8' })], ['audio', probeJson({ audio: 'opus' })], ['container', probeJson({ container: 'mov' })],
  ]) {
    const { dir, file } = prepFile(`prep-validation-${label}`); const calls = [];
    const worker = prepWorker([closeWith(probeJson({ codec: 'vp9', container: 'other' })), ffmpegRun(), closeWith(outputProbe)], calls);
    await rejected(`media-prep validation rejects ${label}`, worker.prepare({ jobId: `validation-${label}`, inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined }), 'Prepared media failed validation.');
    expect(`media-prep validation ${label} deletes partial output`, existsSync(path.join(dir, `prep-validation-${label}.resolve.mp4`)), false);
    expect(`media-prep validation ${label} retains input`, existsSync(file), true);
  }

  // Binary/path limits fail before spawn, including symlink escape and oversized probe JSON.
  {
    const { dir, file } = prepFile('prep-missing-bin'); const calls = [];
    await rejected('media-prep missing ffmpeg before spawn', createMediaPrep({ ffmpegPath: null, ffprobePath: '/fake/ffprobe', spawn: queuedSpawn([], calls) }).prepare({ jobId: 'missing-ffmpeg', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined }), 'ffmpeg was not found. Install ffmpeg or set CLIPDOCK_FFMPEG_PATH to an absolute executable path.');
    await rejected('media-prep missing ffprobe before spawn', createMediaPrep({ ffmpegPath: '/fake/ffmpeg', ffprobePath: null, spawn: queuedSpawn([], calls) }).prepare({ jobId: 'missing-ffprobe', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined }), 'ffprobe was not found. Install ffprobe or set CLIPDOCK_FFPROBE_PATH to an absolute executable path.');
    expect('media-prep missing binaries never spawn', calls.length, 0);
  }
  {
    const rootDir = path.join(phase3Root, 'prep-containment'); mkdirSync(rootDir); const outside = path.join(phase3Root, 'outside-input.mp4'); writeFileSync(outside, 'outside'); const link = path.join(rootDir, 'link.mp4'); symlinkSync(outside, link); const calls = [];
    await rejected('media-prep rejects symlink escape before spawn', prepWorker([], calls).prepare({ jobId: 'symlink-escape', inputPath: link, allowedRoot: rootDir, profile: 'fast', emit: () => undefined }), 'Media file failed the safety check.');
    expect('media-prep symlink escape never spawns or cleans outside', [calls.length, existsSync(outside)], [0, true]);
  }
  {
    const { dir, file } = prepFile('prep-oversized-probe'); const worker = prepWorker([closeWith('x'.repeat(2 * 1024 * 1024 + 1))], []);
    await rejected('media-prep bounds ffprobe JSON', worker.prepare({ jobId: 'oversized-probe', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined }), 'Media preparation failed: ffprobe output exceeded the 2 MB limit.');
  }
  const ffprobeDiscoveryFixture = versionFixture(path.join(phase3Root, 'ffprobe-version-fixture'), 'ffprobe');
  expect('ffprobe discovery accepts executable env path', discoverFfprobe(null, { CLIPDOCK_FFPROBE_PATH: ffprobeDiscoveryFixture, PATH: '' }, process.platform), ffprobeDiscoveryFixture);
  {
    const bin = path.join(phase3Root, 'discovery-bin'); mkdirSync(bin);
    const ffmpeg = versionFixture(path.join(bin, 'ffmpeg'), 'ffmpeg');
    const ffprobe = versionFixture(path.join(bin, 'ffprobe'), 'ffprobe');
    expect('ffprobe discovery prefers ffmpeg executable sibling', discoverFfprobe(ffmpeg, { PATH: '' }, process.platform), ffprobe);
  }

  // Prep is single-job, job-scoped cancellable, and lifecycle cleanup matches yt-dlp.
  {
    const { dir, file } = prepFile('prep-cancel-unix'); const calls = [], events = [];
    const worker = prepWorker([null], calls, { platform: 'darwin', killGraceMs: 5 });
    const pending = worker.prepare({ jobId: 'prep-unix', inputPath: file, allowedRoot: dir, profile: 'fast', emit: (event) => events.push(event) });
    expect('media-prep cancel matching job true', worker.cancel('prep-unix') instanceof Promise, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect('media-prep cancel Unix TERM then KILL', calls[0].child.kills, ['SIGTERM', 'SIGKILL']);
    calls[0].child.emit('close', null); await rejected('media-prep Unix cancel controlled', pending, 'Media preparation cancelled.');
  }
  {
    const { dir, file } = prepFile('prep-cancel-win'); const calls = [], treeCalls = [];
    const processSpawn = (binary, args, options) => { treeCalls.push({ binary, args, options }); return child(); };
    const worker = prepWorker([null], calls, { platform: 'win32', processSpawn });
    const pending = worker.prepare({ jobId: 'prep-win', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    calls[0].child.pid = 4100;
    worker.cancel('prep-win');
    expect('media-prep cancel Windows process tree', treeCalls.map(({ binary, args, options }) => [binary, args, options]), [['taskkill', ['/PID', String(calls[0].child.pid), '/T', '/F'], { shell: false }]]);
    calls[0].child.emit('close', null); await rejected('media-prep Windows cancel controlled', pending, 'Media preparation cancelled.');
  }
  {
    const { dir, file } = prepFile('prep-dispose'); const calls = [];
    const worker = prepWorker([null], calls, { platform: 'darwin' });
    const pending = worker.prepare({ jobId: 'prep-dispose', inputPath: file, allowedRoot: dir, profile: 'fast', emit: () => undefined });
    worker.dispose(); expect('media-prep dispose kills active child', calls[0].child.kills, ['SIGTERM']);
    calls[0].child.emit('close', null); await rejected('media-prep dispose leaves no orphan', pending, 'Media preparation cancelled.');
  }

  // Media preparation always reports Resolve as its target.
  {
    const { dir, file } = prepFile('prep-target-default'); const calls = [], events = [];
    const worker = prepWorker([closeWith(probeJson()), closeWith(probeJson())], calls);
    await worker.prepare({ jobId: 'prep-target-default', inputPath: file, allowedRoot: dir, profile: 'fast', emit: (event) => events.push(event) });
    expect('media-prep reports the Resolve label', events.map((event) => event.message), ['Preparing for Resolve…']);
  }
});
