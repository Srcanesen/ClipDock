// Real main registration, preload, job orchestration and providers. Only Electron,
// executable discovery, child processes, HTTP and Resolve are replaced.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {mainFixture, deferred} from './files-main.mjs';
const require = createRequire(import.meta.url);
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const metadata = {id: 'dQw4w9WgXcQ', title: 'Clip', channel: 'Creator', duration: 10, formats: [{height: 720, vcodec: 'h264'}]};
const pin = '[2,{"id":"123","count":1,"title":"Pin"}]\n[3,"https://i.pinimg.com/pin.jpg",{"pin_id":"123","extension":"jpg"}]\n';
const pexels = {id: 7, duration: 10, video_files: [{id: 70, width: 160, height: 96, file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/7/70.mp4'}]};
export async function providerIpcFixture(t, provider = 'youtube', options = {}) {
  const modules = options.load ?? (name => require(`../../dist/${name}.js`));
  const metadataEntered = deferred(), downloadEntered = deferred(), releaseMetadata = deferred(), releaseDownload = deferred();
  const workers = {}, children = [], preparedPaths = [], requests = {metadata: 0, media: 0};
  const preparationEntered = deferred();
  let closed = false;
  class Child extends EventEmitter {
    constructor() {super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.signals = []; children.push(this);}
    kill(signal) {this.signals.push(signal); if (!options.holdTermination) queueMicrotask(() => this.emit('close', 143)); return true;}
  }
  const spawn = (binary, args) => {
    const child = new Child();
    const isMetadata = args.includes('--dump-single-json') || args.includes('--dump-json');
    queueMicrotask(async () => {
      if (isMetadata) {
        requests.metadata++; metadataEntered.resolve();
        if (options.holdMetadata) await releaseMetadata.promise;
        if (closed || child.signals.length) return;
        if (options.metadataFailure) {child.stderr.emit('data', 'metadata fixture failure'); child.emit('close', 1); return;}
        child.stdout.emit('data', args.includes('--dump-json') ? pin : JSON.stringify(metadata));
      } else if (args.includes('-show_streams')) {
        child.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96}], format: {duration: '10', format_name: 'mov,mp4'}}));
      } else {
        requests.media++; downloadEntered.resolve();
        if (options.holdDownload) await releaseDownload.promise;
        if (closed || child.signals.length) return;
        if (options.failure) {child.stderr.emit('data', 'No space left on device'); child.emit('close', 1); return;}
        if (args.includes('-D')) {
          fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'pinterest.jpg'), Buffer.concat([Buffer.from([255,216,255,224]), Buffer.alloc(20)]));
        } else {
          const output = path.join(path.dirname(args[args.indexOf('-o') + 1].replaceAll('%%', '%')), 'clip.mp4');
          fs.writeFileSync(output, 'media'); child.stdout.emit('data', `P|${output}\n`);
        }
      }
      child.emit('close', 0);
    });
    return child;
  };
  const wrapYtdlp = class extends modules('ytdlp').YtdlpWorker {
    constructor(binary, _spawn, _fetch, opts) {super(binary, spawn, async () => {throw new Error('Unexpected thumbnail');}, {...opts, killGraceMs: 1000}); workers[path.basename(opts.sessionDir)] = this;}
  };
  const wrapGallery = class extends modules('gallerydl').GalleryDlWorker {
    constructor(binary, _spawn, opts) {super(binary, spawn, {...opts, killGraceMs: 1000}); workers[path.basename(opts.sessionDir)] = this;}
  };
  const wrapPexels = class extends modules('pexels').PexelsClient {
    constructor(root) {
      super(root, async (url, init) => {
        if (String(url).includes('api.pexels.com')) {
          requests.metadata++; metadataEntered.resolve();
          if (options.holdMetadata) await releaseMetadata.promise;
          if (options.metadataFailure) return new Response('failure', {status: 500, headers: {'content-type': 'application/json'}});
          return new Response(JSON.stringify(pexels), {headers: {'content-type': 'application/json'}});
        }
        requests.media++; downloadEntered.resolve();
        if (options.holdDownload) {
          await releaseDownload.promise;
          return new Response('late media', {headers: {'content-type': 'video/mp4'}});
        }
        if (options.failure) throw new Error('Media request fixture failure');
        return new Response('media', {headers: {'content-type': 'video/mp4', 'content-length': '5'}});
      }, options.pexelsTimers);
      this.setKey('P'.repeat(20), false); workers.pexels = this;
    }
  };
  const preparationModule = options.realPreparation ? {
    './media-prep': {...modules('media-prep'), createMediaPrep(opts) {
      const service = modules('media-prep').createMediaPrep({...opts, killGraceMs: 1000, spawn: (_binary, args) => {
        const child = new Child(); child.preparation = true;
        if (args.includes('-show_streams')) queueMicrotask(() => {
          if (closed || child.signals.length) return;
          child.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 96, avg_frame_rate: '30/1', r_frame_rate: '30/1'}], format: {duration: '10', format_name: 'mov,mp4', tags: {major_brand: 'isom'}}}));
          child.emit('close', 0);
        });
        else {
          const output = args.at(-1); fs.writeFileSync(output, 'partial prepared media'); preparedPaths.push(output);
          preparationEntered.resolve();
        }
        return child;
      }});
      workers.preparation = service; return service;
    }},
  } : {};
  const f = await mainFixture(t, {
    discovery: Promise.resolve({ytdlpPath: options.ytdlpPath === undefined ? '/fixture/yt-dlp' : options.ytdlpPath, galleryDlPath: '/fixture/gallery-dl', ffmpegPath: '/fixture/ffmpeg', ffprobePath: options.ffprobePath === undefined ? '/fixture/ffprobe' : options.ffprobePath, jsRuntime: null}),
    mainProcess: modules('main-process'), mainSource: options.mainSource, onEvent: options.onEvent,
    modules: {'./ytdlp': {...modules('ytdlp'), YtdlpWorker: wrapYtdlp}, './gallerydl': {...modules('gallerydl'), GalleryDlWorker: wrapGallery}, './pexels': {...modules('pexels'), PexelsClient: wrapPexels}, ...preparationModule},
  });
  let api;
  vm.runInNewContext(options.preloadSource ?? fs.readFileSync('dist/preload.js', 'utf8'), {
    exports: {}, require: () => ({contextBridge: {exposeInMainWorld(_name, value) {api = value;}}, ipcRenderer: {invoke: (channel, ...args) => f.invokeRaw(channel, ...args), on() {}, removeListener() {}}}),
  });
  const suffix = provider[0].toUpperCase() + provider.slice(1);
  const profile = options.profile ?? 'original';
  const start = (jobId = 'job') => provider === 'youtube' ? api.downloadYoutube(youtubeUrl, 'best', profile, jobId, {mediaMode: 'video', audioFormat: 'm4a', subtitles: false, subtitleLanguage: 'en'})
    : provider === 'social' ? api.downloadSocial('https://www.instagram.com/reel/abc', 'best', profile, jobId)
    : provider === 'pinterest' ? api.downloadPinterest('https://www.pinterest.com/pin/123/', 1, profile, jobId)
    : api.downloadPexels({kind: 'video', id: 7}, '70', profile, jobId);
  const cancel = jobId => api[`cancel${suffix}`](jobId);
  const stop = async () => {
    closed = true; releaseMetadata.resolve(); releaseDownload.resolve();
    for (const child of children) if (child.signals.length) child.emit('close', 143);
    await Promise.all(Object.values(workers).map(worker => worker.dispose()));
    f.quit(); await tick();
  };
  // Call stop in finally before mainFixture removes its temporary root.
  const events = (jobId = 'job') => f.events.filter(event => event.channel === `clipdock:${provider}-event` && event.update?.jobId === jobId).map(({update}) => ({state: update.state, message: update.message, percent: update.percent}));
  return {...f, api, start, cancel, stop, events, workers, metadataEntered, downloadEntered, releaseMetadata, releaseDownload, children, preparationEntered, preparedPaths, requests};
}
