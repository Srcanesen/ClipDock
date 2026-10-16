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

test('Pinterest version and path-free metadata/search normalization', async (t) => {
  const { discoverGalleryDl, galleryDlVersionSupported, parseGalleryDlJsonl, parsePinterestMetadataJsonl, parsePinterestMetadataValues, parsePinterestSearchJsonl } = await import(path.join(dist, 'gallerydl.js'));
  const galleryExpect = expect;
  galleryExpect('pinterest: gallery-dl version floor accepts 1.28.0 and rejects 1.27.9', [galleryDlVersionSupported('gallery-dl 1.28.0'), galleryDlVersionSupported('1.27.9')], [true, false]);
  galleryExpect('pinterest: JSONL [-1] is an error even with a zero process exit', (() => { try { parseGalleryDlJsonl('[-1, "private"]'); return false; } catch { return true; } })(), true);
  try {
    const pinterestMetadata = parsePinterestMetadataJsonl([JSON.stringify([2, { id: '123456789', title: 'Pin image', count: 1 }]), JSON.stringify([3, 'https://example.invalid/pin.jpg', { pin_id: '123456789', extension: 'jpg', title: 'Pin image' }])].join('\n'), { url: 'https://www.pinterest.com/pin/123456789/', pinId: '123456789' });
    galleryExpect('pinterest: metadata is path-free and image Original-only data is normalized', [pinterestMetadata.items.length, pinterestMetadata.items[0].kind, pinterestMetadata.thumbnailUrl, JSON.stringify(pinterestMetadata).includes('example.invalid')], [1, 'image', null, false]);
  } catch (error) { fail(`pinterest: metadata fixture failed: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const pinterestSearch = parsePinterestSearchJsonl([
      JSON.stringify([2, { id: '100', title: 'Search Pin', count: 1, images: { '474x': { url: 'https://i.pinimg.com/thumb.jpg' } } }]),
      JSON.stringify([3, 'https://i.pinimg.com/originals/100.jpg', { pin_id: '100', extension: 'jpg' }]),
      JSON.stringify([2, { id: '101', title: 'Range tail', count: 1 }]),
    ].join('\n'));
    galleryExpect('pinterest: search parser skips an unmatched range-tail Directory and exposes no CDN/path', [pinterestSearch.length, pinterestSearch[0].url, JSON.stringify(pinterestSearch).includes('pinimg.com')], [1, 'https://www.pinterest.com/pin/100/', false]);
  } catch (error) { fail(`pinterest: search fixture failed: ${error instanceof Error ? error.message : String(error)}`); }
});
