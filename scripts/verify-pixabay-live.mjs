// Live Pixabay check through ClipDock's own client: two API requests and one CDN download.
// Usage: node scripts/verify-pixabay-live.mjs <file containing the API key>
// The key is read at runtime only and never printed.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PixabayClient} from '../dist/pixabay.js';

const keyFile = process.argv[2];
if (!keyFile) throw new Error('Pass the path of a file containing a Pixabay API key.');
const key = readFileSync(keyFile, 'utf8').trim();
const root = mkdtempSync(path.join(tmpdir(), 'clipdock-pixabay-live-'));
const client = new PixabayClient(path.join(root, 'pixabay'));
try {
  client.setKey(key, false);
  const page = await client.search('video', 'ocean', 1);
  assert.ok(page.results.length > 0, 'search returned no results');
  const asset = await client.load('video', page.results[0].id);
  const medium = asset.files.find(file => file.id === 'medium');
  assert.ok(medium, 'no medium rendition');
  const {filePath} = await client.download('live-check', medium, () => {});
  const probe = JSON.parse(execFileSync(process.env.CLIPDOCK_FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', filePath], {encoding: 'utf8'}));
  const stream = probe.streams?.[0];
  assert.ok(stream?.codec_name && stream.width > 0 && stream.height > 0, 'ffprobe found no video stream');
  console.log(JSON.stringify({results: page.results.length, totalResults: page.totalResults, asset: asset.id, renditions: asset.files.map(file => file.label), downloaded: medium.label, codec: stream.codec_name, width: stream.width, height: stream.height, duration: Number(probe.format?.duration)}));
  console.log('Pixabay live search, load and download: PASS');
} finally {
  await client.dispose();
  rmSync(root, {recursive: true, force: true});
}
