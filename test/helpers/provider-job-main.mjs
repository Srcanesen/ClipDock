// Exercise provider work and the real main-process terminal projection without
// running a second metadata extraction in provider-specific regression fixtures.
import {existsSync, statSync} from 'node:fs';
import {createProviderDownloadHandlers} from '../../dist/main-process.js';
export async function providerDownload(worker, {provider = 'youtube', url, jobId, emit, kind = 'image'}) {
  const forward = (_event, update) => emit(update);
  const handlers = createProviderDownloadHandlers({
    ffprobeAvailable: true, cancelMediaPreparation: () => null,
    registerSubtitle: () => {throw new Error('No subtitle expected.');},
    completion: {
      isSafeMediaFile: file => existsSync(file) && statSync(file).isFile(),
      refreshHistoryProject: async () => {}, recordHistory: () => ({record: null}), registerCard: () => 'card',
      prepareMedia: async () => {throw new Error('Original does not prepare.');},
    },
    youtube: provider === 'youtube' ? {
      worker: {metadata: async () => ({id: 'dQw4w9WgXcQ', title: 'Clip', duration: 10, chapters: []}), download: worker.download.bind(worker), cancel: worker.cancel.bind(worker)}, emit: forward,
    } : {},
    pinterest: provider === 'pinterest' ? {
      worker, emit: forward,
      snapshots: {get: () => ({pinId: url.match(/\/pin\/(\d+)/)[1], items: [{index: 1, kind, title: 'Pin'}]}), remember() {}},
    } : {},
    social: {}, pexels: {},
  });
  try {
    return provider === 'youtube'
      ? await handlers.youtube({sender: {}}, url, 'best', 'original', jobId, {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'})
      : await handlers.pinterest({sender: {}}, url, 1, 'original', jobId);
  } finally {await handlers.shutdown();}
}
