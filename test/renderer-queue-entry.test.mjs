import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/renderer-harness.mjs';

const defaults = { profile: 'original', quality: 'best', mediaMode: 'video', audioFormat: 'mp3', intent: 'download', targetBin: 'active', subtitles: false, subtitleLanguage: 'en', selection: null };
function selection(provider, id, kind) {
  return { key: `${provider}:${provider === 'pexels' ? `${kind}:` : ''}${id}`, provider, resultId: id, source: provider === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : `https://www.pexels.com/photo/${id}/`, title: id, channel: null, thumbnailDataUrl: null, ...(kind ? { pexelsKind: kind } : {}), snapshot: { ...defaults }, overrides: {} };
}
async function enqueue(h, stage, path) {
  if (path === 'card') await h.test.enqueueResultCard(stage.key, stage, 'tail');
  else await h.test.enqueueSelected();
  await h.flush();
}

for (const path of ['card', 'bulk']) {
  for (const completed of [false, true]) {
    test(`Pexels ${path}: another photo's Small preference cannot change Best output${completed ? ' or bypass completed duplicate detection' : ''}`, async () => {
      const h = createHarness(); await h.fireReady();
      const stage = selection('pexels', '2', 'photo');
      const metadata = { id: 2, kind: 'photo', title: 'Photo B', creator: null, creatorUrl: null, sourceUrl: stage.source, duration: null, width: 4000, height: 3000, thumbnailUrl: null, previewUrl: null, files: [
        { id: 'small', url: 'https://example.com/small.jpg', width: 800, height: 600, label: 'Small', mime: 'image/jpeg', size: 10 },
        { id: 'original', url: 'https://example.com/original.jpg', width: 4000, height: 3000, label: 'Original', mime: 'image/jpeg', size: 100 },
      ] };
      const downloads = [];
      h.api.loadPexels = async () => metadata;
      h.api.downloadPexels = async (asset, fileId) => { downloads.push([asset.id, fileId]); return { cardId: 'photo-b', fileName: 'b.jpg' }; };
      if (completed) {
        assert.equal(h.test.enqueueStagedSelection(stage, metadata), 1);
        await h.flush();
        assert.equal(h.test.queue()[0].status, 'completed');
        assert.deepEqual(downloads, [[2, 'original']]);
      }
      h.test.stage(stage);
      h.test.commitCardOutput('pexels:photo:1', { quality: 'small' });
      assert.equal(h.test.cardEffectiveOutput('pexels:photo:1').quality, 'small');
      assert.equal(h.test.cardEffectiveOutput(stage.key).quality, 'original', 'Photo B still presents Original');
      await enqueue(h, stage, path);
      assert.deepEqual(downloads, [[2, 'original']], 'download matches Photo B output and deduplicates its completed original');
      assert.deepEqual(Array.from(h.test.queue(), item => [item.videoId, item.pexelsFileId]), [['2', 'original']]);
    });
  }
}

for (const path of ['card', 'bulk']) {
  test(`YouTube ${path}: unavailable staged quality falls back to the supported current preference`, async () => {
    const h = createHarness(); await h.fireReady();
    const stage = { ...selection('youtube', 'aaaaaaaaaaa'), overrides: { quality: '720p' } };
    h.test.stage(stage);
    h.test.commitCardOutput('youtube:bbbbbbbbbbb', { quality: '1080p' });
    assert.equal(h.test.cardEffectiveOutput(stage.key).quality, '720p', 'the staged request remains frozen');
    h.api.loadYoutube = async () => ({ id: 'aaaaaaaaaaa', title: 'A', channel: null, duration: 60, heights: [2160, 1080], thumbnailUrl: null, formatSummary: [], chapters: [] });
    await enqueue(h, stage, path);
    assert.deepEqual(h.downloads.map(call => call.quality), ['1080p'], 'supported preference wins before the generic 2160p fallback');
    assert.deepEqual(Array.from(h.test.queue(), item => [item.videoId, item.quality]), [['aaaaaaaaaaa', '1080p']]);
  });
}

for (const outcome of ['completed', 'failed', 'cancelled']) {
  test(`settled ${outcome} download clears footer percentage, speed and ETA`, async () => {
    const h = createHarness(); let event;
    h.api.onYoutubeEvent = callback => { event = callback; return () => {}; };
    await h.fireReady();
    const stage = selection('youtube', 'aaaaaaaaaaa');
    await enqueue(h, stage, 'card');
    const jobId = h.downloads[0].jobId;
    event({ jobId, state: 'processing', percent: null, message: 'Preparing' });
    event({ jobId, state: 'downloading', percent: 44, message: 'Downloading…', speedBytesPerSecond: 2000000, etaSeconds: 3 });
    assert.equal(h.elements.get('youtube-status').textContent, 'Downloading… 44.0% · 2.0 MB/s · 3s');
    if (outcome === 'completed') h.downloads[0].resolve({ cardId: 'card', fileName: 'clip.mp4' });
    else {
      if (outcome === 'cancelled') event({ jobId, state: 'cancelled', percent: 44, message: 'Download cancelled.' });
      h.downloads[0].reject(new Error('Network failed'));
    }
    await h.flush();
    assert.equal(h.test.queue()[0].status, outcome);
    assert.equal(h.elements.get('youtube-status').textContent, outcome === 'completed' ? 'Download complete.' : outcome === 'failed' ? 'Failed: Network failed' : 'Cancelled.');
    assert.equal(h.elements.get('youtube-progress').value, 0);
  });
}

function findButton(node, label) {
  for (const child of node.children) {
    if (child.tagName === 'BUTTON' && child.textContent === label) return child;
    const found = findButton(child, label);
    if (found) return found;
  }
}
test('retry-specific duplicate status remains Already in downloads.', async () => {
  const h = createHarness(); await h.fireReady();
  await enqueue(h, selection('youtube', 'aaaaaaaaaaa'), 'card');
  h.downloads[0].reject(new Error('Network failed')); await h.flush();
  const failedId = h.test.queue()[0].queueId;
  const failedRow = () => h.elements.get('youtube-download-queue').children.find(row => row.dataset.queueId === failedId);
  findButton(failedRow(), 'Retry').click();
  assert.equal(h.downloads.length, 2);
  findButton(failedRow(), 'Retry').click();
  assert.equal(h.elements.get('youtube-status').textContent, 'Already in downloads.');
  assert.deepEqual([h.downloads.length, h.test.queue().length], [2, 2]);
});
