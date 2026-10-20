import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createMediaPrep, discoverFfprobe, parseFfprobe} from '../dist/media-prep.js';
import {discoverFfmpeg} from '../dist/ytdlp.js';

const ffmpeg = discoverFfmpeg();
const ffprobe = discoverFfprobe(ffmpeg);

// Matroska reports timebase rates for a VFR stream, so it looks CFR and is only remuxed;
// the remuxed MP4 then reveals VFR and fails validation unless preparation re-encodes.
test('Fast MP4 prepares VFR H.264 Matroska by re-encoding a rejected remux', {skip: !ffmpeg || !ffprobe ? 'ffmpeg and ffprobe are required for this local integration check' : false}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-vfr-mkv-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const input = join(root, 'vfr.mkv');
  const fixture = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=60', '-t', '3', '-vf', 'select=not(mod(n\\,3))+lt(n\\,60)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], {encoding: 'utf8'});
  assert.equal(fixture.status, 0, fixture.stderr);
  const prep = createMediaPrep({ffmpegPath: ffmpeg, ffprobePath: ffprobe});
  t.after(() => prep.dispose());
  const result = await prep.prepare({jobId: 'vfr', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
  assert.equal(result.action, 'transcode');
  const checked = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.filePath], {encoding: 'utf8'});
  const media = parseFfprobe(checked.stdout);
  assert.deepEqual([media.video.codec, media.video.cfr, media.container], ['h264', true, 'mp4']);
  assert.equal(existsSync(input), false);
});
