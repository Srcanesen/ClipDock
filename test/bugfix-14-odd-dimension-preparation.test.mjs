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

test('Fast MP4 prepares odd-sized video by padding to even dimensions', {skip: !ffmpeg || !ffprobe ? 'ffmpeg and ffprobe are required for this local integration check' : false}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'clipdock-odd-size-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const input = join(root, 'odd.mkv');
  const fixture = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=161x97:rate=10', '-t', '1', '-c:v', 'ffv1', input], {encoding: 'utf8'});
  assert.equal(fixture.status, 0, fixture.stderr);
  const prep = createMediaPrep({ffmpegPath: ffmpeg, ffprobePath: ffprobe});
  t.after(() => prep.dispose());
  const result = await prep.prepare({jobId: 'odd', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
  assert.equal(result.action, 'transcode');
  const checked = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.filePath], {encoding: 'utf8'});
  assert.equal(checked.status, 0, checked.stderr);
  const media = parseFfprobe(checked.stdout);
  assert.deepEqual([media.video.width, media.video.height, media.video.codec, media.video.pixFmt], [162, 98, 'h264', 'yuv420p']);
  assert.equal(media.video.cfr, true);
  assert.equal(existsSync(input), false);
  assert.equal(existsSync(result.filePath), true);
});
