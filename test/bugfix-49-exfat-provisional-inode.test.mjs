// macOS exFAT reports a negative placeholder inode for an empty file and its start
// cluster after the first write. Files ClipDock creates must survive that change,
// and a volume whose identities change otherwise is refused at folder choice.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {ManagedRoot} from '../dist/managed-root.js';
import {AnchoredDir, appendOwned, openExclusive, publishNoReplace, writeExclusive, writeOwned} from '../dist/safe-fs.js';
import {createMediaPrep, discoverFfprobe} from '../dist/media-prep.js';
import {discoverFfmpeg} from '../dist/ytdlp.js';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipdock-exfat-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
/** Report file inodes under `dir` through `rewrite(info)`, as a filesystem driver would. */
function inodes(t, dir, rewrite) {
  const {lstatSync, fstatSync} = fs;
  const fake = info => info && typeof info.ino === 'bigint' && info.isFile() ? Object.create(info, {ino: {value: rewrite(info)}}) : info;
  fs.lstatSync = function (file, options) { const info = lstatSync.call(this, file, options); return String(file).startsWith(dir) ? fake(info) : info; };
  fs.fstatSync = function (fd, options) { return fake(fstatSync.call(this, fd, options)); };
  t.after(() => { fs.lstatSync = lstatSync; fs.fstatSync = fstatSync; });
}
const placeholder = info => info.size === 0n ? -info.ino - 1n : info.ino;

test('created files keep their identity across the exFAT placeholder-inode change', t => {
  const dir = fixture(t);
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const youtube = AnchoredDir.capture(root.providerPath('youtube'), root);
  inodes(t, dir, placeholder);
  assert.equal(fs.readFileSync(writeExclusive(youtube, 'source.info.json', '{"id":"x"}').path, 'utf8'), '{"id":"x"}');
  const log = openExclusive(youtube, 'clipdock.log'); fs.closeSync(log.fd);
  appendOwned(log.file, 'one\n', 1024); appendOwned(log.file, 'two\n', 1024);
  assert.equal(fs.readFileSync(log.file.path, 'utf8'), 'one\ntwo\n');
  // exFAT has no hard links, so publication copies into a newly created file.
  const {linkSync} = fs;
  fs.linkSync = () => { throw Object.assign(new Error('not supported'), {code: 'ENOTSUP'}); };
  t.after(() => { fs.linkSync = linkSync; });
  const temp = writeExclusive(youtube, 'clip.part', 'media');
  const published = publishNoReplace(temp, youtube, 'clip.mp4');
  assert.deepEqual([fs.readFileSync(published.path, 'utf8'), fs.existsSync(temp.path)], ['media', false]);
});

test('a volume whose file identity changes on write is refused at folder choice', t => {
  const dir = fixture(t);
  inodes(t, dir, info => info.size === 0n ? info.ino : info.ino + 1_000_000n);
  assert.throws(() => ManagedRoot.prepare(path.join(dir, 'managed')), /Managed root failed the safety check/);
});

test('a placeholder identity is not adopted across a replaced file', t => {
  const dir = fixture(t);
  const root = ManagedRoot.prepare(path.join(dir, 'managed'));
  const youtube = AnchoredDir.capture(root.providerPath('youtube'), root);
  inodes(t, dir, placeholder);
  const opened = openExclusive(youtube, 'clip.json'); fs.closeSync(opened.fd);
  fs.rmSync(opened.file.path);
  fs.writeFileSync(opened.file.path, 'other');
  assert.throws(() => writeOwned(opened.file, 'x'), /replaced/);
});

// Real volume: hdiutil create -size 64m -fs ExFAT -volname CDXFAT x.dmg; hdiutil attach -nobrowse -nomount x.dmg; diskutil mount /dev/diskNs1
const volume = process.env.CLIPDOCK_EXFAT_VOLUME;
const ffmpeg = discoverFfmpeg(), ffprobe = discoverFfprobe(ffmpeg);
test('fast preparation succeeds on a real exFAT volume', {skip: !volume || !ffmpeg || !ffprobe ? 'set CLIPDOCK_EXFAT_VOLUME to a mounted exFAT volume (needs ffmpeg)' : false}, async t => {
  const folder = path.join(volume, `clipdock-test-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const root = ManagedRoot.prepare(folder);
  const input = path.join(root.providerPath('youtube'), 'clip.mkv');
  const fixture = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], {encoding: 'utf8'});
  assert.equal(fixture.status, 0, fixture.stderr);
  const prep = createMediaPrep({ffmpegPath: ffmpeg, ffprobePath: ffprobe});
  t.after(() => prep.dispose());
  const result = await prep.prepare({jobId: 'exfat', inputPath: input, allowedRoot: root, profile: 'fast', emit: () => {}});
  assert.deepEqual([path.basename(result.filePath), fs.existsSync(input)], ['clip.resolve.mp4', false]);
  assert.ok(fs.statSync(result.filePath).size > 65_536);
});
