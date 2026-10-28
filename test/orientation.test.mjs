import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {classifyOrientation, ORIENTATION_SUPPORT} from '../dist/renderer-state/search-session.js';
import {normalizeSearchOptions} from '../dist/main-process.js';
import {PexelsClient} from '../dist/pexels.js';
import {PixabayClient, parsePixabayPage} from '../dist/pixabay.js';
import {GalleryDlWorker, parsePinterestSearchJsonl} from '../dist/gallerydl.js';
import {YtdlpWorker, narrowSearchEntry} from '../dist/ytdlp.js';
import {providerIpcFixture} from './helpers/provider-ipc.mjs';
import {createHarness} from './helpers/renderer-harness.mjs';
import {transpilePreviewAdapter} from '../scripts/lib/preview-adapter.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const temp = t => {const root = mkdtempSync(path.join(tmpdir(), 'clipdock-orientation-')); t.after(() => rmSync(root, {recursive: true, force: true})); return root;};
class Child extends EventEmitter {
  constructor() {super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter();}
  kill() {queueMicrotask(() => this.emit('close', 143)); return true;}
}
const rawYoutube = (index, mode) => {
  const id = `test${String(index).padStart(7, '0')}`;
  return {id, title: `Video ${index}`, ...(mode === 'short' ? {url: `https://www.youtube.com/shorts/${id}`} : mode === 'watch' ? {url: `https://www.youtube.com/watch?v=${id}`} : {})};
};
const hit = (id, width, height) => ({id, videos: {medium: {url: `https://cdn.pixabay.com/video/${id}.mp4`, width, height, size: 5000}}});
const response = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});

test('orientation classification uses positive finite pairs, exact equality, and no tolerance', () => {
  assert.deepEqual([[720,1280], [1920,1080], [1080,1080], [1.5,1.5], [1080,1080.01], [0,100], [-1,100], [NaN,100], [Infinity,100], [100,null], ['100',100], [undefined,100]].map(([w,h]) => classifyOrientation(w,h)),
    ['vertical','horizontal','square','square','vertical',null,null,null,null,null,null,null]);
});

test('main-owned validation defaults malformed or unsupported options to All and exports source capabilities', () => {
  assert.deepEqual([undefined, null, [], 'vertical', 1, {orientation: 'portrait'}, {orientation: 1}, {orientation: null}].map(value => normalizeSearchOptions('pinterest', value)), Array(8).fill({orientation: 'all'}));
  assert.deepEqual(normalizeSearchOptions('youtube', {orientation: 'square'}), {orientation: 'all'});
  assert.deepEqual(normalizeSearchOptions('youtube', {orientation: 'vertical'}), {orientation: 'vertical'});
  assert.deepEqual(ORIENTATION_SUPPORT, {youtube: ['all','vertical','horizontal'], pinterest: ['all','vertical','horizontal','square'], pexels: ['all','vertical','horizontal','square'], pixabay: ['all','vertical','horizontal','square']});
});

test('Pexels sends native orientation for photos and videos, omits All, and preserves server totals/navigation', async t => {
  const urls = [];
  const client = new PexelsClient(temp(t), async url => {urls.push(new URL(url)); return response({photos: [], videos: [], total_results: 123, next_page: 'next'});});
  t.after(() => client.dispose()); client.setKey('P'.repeat(20), false);
  for (const kind of ['photo','video']) for (const orientation of ['vertical','horizontal','square','all']) {
    const page = await client.search(kind, 'ocean', 2, {orientation});
    assert.deepEqual([page.totalResults, page.hasPrevious, page.hasNext, page.page], [123,true,true,2]);
  }
  assert.deepEqual(urls.map(url => [url.pathname, url.searchParams.get('orientation')]), ['/v1/search','/videos/search'].flatMap(endpoint => ['portrait','landscape','square',null].map(value => [endpoint,value])));
  await client.search('video', 'ocean', 2, {orientation: 'bad'});
  assert.equal(urls.length, 8, 'invalid options reuse the All URL cache');
});

test('Pixabay filters one provider page using complete pairs, excludes unknowns, and keeps provider navigation', async t => {
  const raw = {totalHits: 100, hits: [hit(1,720,1280), hit(2,1920,1080), hit(3,100,100), hit(4,null,null), {id: 5, videos: {large: {url:'https://cdn.pixabay.com/video/5-large.mp4',width:1920,height:null,size:5000}, medium: {url:'https://cdn.pixabay.com/video/5.mp4',width:720,height:1280,size:3000}}}, {id: 6, videos: {large: {url:'https://cdn.pixabay.com/video/6-large.mp4',width:720,height:null,size:5000}, medium: {url:'https://cdn.pixabay.com/video/6.mp4',width:null,height:1280,size:3000}}}]};
  const vertical = parsePixabayPage(raw, 'ocean', 2, 'vertical');
  assert.deepEqual([vertical.results.map(item => item.id), vertical.totalResults, vertical.matchingResultsOnPage, vertical.hasPrevious, vertical.hasNext], [[1,5],null,2,true,true]);
  assert.deepEqual(parsePixabayPage(raw, 'ocean', 2, 'horizontal').results.map(item => item.id), [2]);
  assert.deepEqual(parsePixabayPage(raw, 'ocean', 2, 'square').results.map(item => item.id), [3]);
  assert.deepEqual(parsePixabayPage(raw, 'ocean', 2).results.map(item => item.id), [1,2,3,4,5,6]);
  assert.deepEqual(parsePixabayPage({hits:[{...hit(7,1920,1080),width:720,height:1280}]},'ocean',1,'vertical').results.map(item => item.id),[7]);
  const empty = parsePixabayPage({totalHits:100,hits:[hit(2,1920,1080)]}, 'ocean', 2, 'vertical');
  assert.deepEqual([empty.results.length, empty.matchingResultsOnPage, empty.hasNext], [0,0,true]);
  const urls = []; const client = new PixabayClient(temp(t), async url => {urls.push(new URL(url)); return response(raw);});
  t.after(() => client.dispose()); client.setKey('P'.repeat(20), false);
  assert.deepEqual((await client.search('video','ocean',2,{orientation:'vertical'})).results.map(item => item.id), [1,5]);
  assert.deepEqual((await client.search('video','ocean',2,{orientation:'square'})).results.map(item => item.id), [3]);
  assert.equal((await client.search('video','ocean',2)).totalResults, 100);
  assert.deepEqual(urls.map(url => url.searchParams.has('orientation')), [false]);
});

test('Pinterest parses media/original pairs and classifies carousels by the first displayed item', () => {
  const items = parsePinterestSearchJsonl(readFileSync(new URL('./fixtures/pinterest-orientation-search.jsonl', import.meta.url), 'utf8'));
  assert.deepEqual(items.map(({id,width,height}) => [id,width,height]), [['701',720,1280],['702',1920,1080],['703',100,100],['704',null,null],['705',500,500],['706',1080,1920],['707',null,null],['708',1080,1920]]);
});

test('Pinterest filters cached unfiltered corpus before pagination and recomputes totals', async t => {
  const records = [];
  for (let index=0; index<30; index++) {
    const id = String(1000+index); const [width,height] = [[720,1280],[1920,1080],[100,100],[null,null]][index%4];
    records.push([2,{id,count:1}], [3,`https://i.pinimg.com/${id}.jpg`,{pin_id:id,extension:'jpg',width,height}]);
  }
  let calls = 0;
  const worker = new GalleryDlWorker('/fixture/gallery-dl', () => {calls++; const child = new Child(); queueMicrotask(() => {child.stdout.emit('data',records.map(JSON.stringify).join('\n')+'\n'); child.emit('close',0);}); return child;}, {sessionDir:temp(t)});
  t.after(() => worker.dispose());
  const square = await worker.search('ocean',1,{orientation:'square'});
  assert.deepEqual([square.results.map(item => item.id),square.totalResults,square.pageCount,square.hasNext], [['1002','1006','1010','1014','1018','1022','1026'],7,1,false]);
  const all = await worker.search('ocean',2);
  assert.deepEqual([all.results[0].id,all.totalResults,all.pageCount,all.hasNext], ['1010',30,3,true]);
  assert.equal(calls,1);
});

test('YouTube preserves Shorts/watch/unknown and explicit yt-dlp signals before canonicalization', () => {
  const entries = [rawYoutube(0,'short'),rawYoutube(1,'watch'),rawYoutube(2), {...rawYoutube(3),is_short:true}, {...rawYoutube(4),is_short:false}].map(narrowSearchEntry);
  assert.deepEqual(entries.map(item => item.isShort), [true,false,null,true,false]);
  assert.equal(narrowSearchEntry({...rawYoutube(5,'watch'), webpage_url:'https://www.youtube.com/shorts/test0000005', is_short:false}).isShort,true);
  assert.deepEqual(entries.map(item => item.url), [0,1,2,3,4].map(index => `https://www.youtube.com/watch?v=test${String(index).padStart(7,'0')}`));
});

test('YouTube early and final pages filter the same corpus while mode caches retain unfiltered entries', async t => {
  const entries = Array.from({length:30}, (_,index) => rawYoutube(index,index%2===0 ? 'short' : index%3===0 ? undefined : 'watch'));
  const expectedVertical = ['test0000000','test0000002','test0000004','test0000006','test0000008','test0000010','test0000012','test0000014','test0000016','test0000018'];
  let calls = 0; const early = [];
  const worker = new YtdlpWorker('/fixture/yt-dlp', () => {calls++; const child = new Child(); queueMicrotask(() => {for (const entry of entries) child.stdout.emit('data',JSON.stringify(entry)+'\n'); child.emit('close',0);}); return child;}, undefined, {sessionDir:temp(t)});
  t.after(() => worker.dispose());
  const first = await worker.search('ocean',1,page => early.push(page),{orientation:'vertical'});
  assert.equal(early.length,1);
  assert.deepEqual(early[0].results.map(item => item.id), expectedVertical);
  assert.deepEqual([early[0].totalResults,early[0].pageCount], [null,null]);
  assert.deepEqual(first.results.map(item => item.id), expectedVertical);
  assert.deepEqual([first.totalResults,first.pageCount,first.hasNext], [15,2,true]);
  const second = await worker.search('ocean',2,undefined,{orientation:'vertical'});
  assert.deepEqual(second.results.map(item => item.id), ['test0000020','test0000022','test0000024','test0000026','test0000028']);
  const horizontal = await worker.search('ocean',1,undefined,{orientation:'horizontal'});
  assert.deepEqual(horizontal.results.map(item => item.id), ['test0000001','test0000005','test0000007','test0000011','test0000013','test0000017','test0000019','test0000023','test0000025','test0000029']);
  assert.deepEqual([horizontal.totalResults,(await worker.search('ocean',1)).totalResults,(await worker.search('ocean',1,undefined,{orientation:'square'})).totalResults,calls], [10,30,30,2]);
  first.results[0].isShort = false;
  assert.equal((await worker.search('ocean',1,undefined,{orientation:'vertical'})).results[0].isShort,true);
});

test('main/preload/host IPC carries trailing YouTube options without displacing generation and validates bad options', async t => {
  const entries = [rawYoutube(0,'short'),rawYoutube(1,'watch'),rawYoutube(2)];
  const f = await providerIpcFixture(t,'youtube',{youtubeJsonl:entries.map(JSON.stringify).join('\n')+'\n'});
  try {
    const vertical = await f.api.searchYoutube('ocean',1,7,{orientation:'vertical'});
    assert.deepEqual(vertical.results.map(item => item.id), ['test0000000']);
    assert.equal((await f.api.searchYoutube('ocean',1,8,{orientation:'bad'})).totalResults,3);
    assert.equal((await f.api.searchYoutube('ocean',1,9,{orientation:'square'})).totalResults,3);
    await assert.rejects(f.api.searchYoutube('ocean',1,'bad',{orientation:'vertical'}),/Invalid search request/);
  } finally {await f.stop();}
});

test('Pinterest main/preload/host forwards options and filters parsed dimensions', async t => {
  const pinterestJsonl = readFileSync(new URL('./fixtures/pinterest-orientation-search.jsonl', import.meta.url), 'utf8');
  const f = await providerIpcFixture(t,'pinterest',{pinterestJsonl});
  try {
    const page = await f.api.searchPinterest('ocean',1,{orientation:'square'});
    assert.deepEqual(page.results.map(item => item.id),['703','705']);
    assert.deepEqual([page.totalResults,page.pageCount,page.hasNext],[2,1,false]);
    assert.equal((await f.api.searchPinterest('ocean',1,{orientation:'bad'})).totalResults,8);
    assert.equal(f.requests.metadata,1);
  } finally {await f.stop();}
});

test('renderer setter resets paging/generation, rejects stale replies, and remembers per-source/kind values', async () => {
  const f = createHarness();
  const calls = []; let early;
  f.api.onYoutubeSearchPage = callback => {early=callback; return () => {};};
  await f.fireReady();
  f.api.searchYoutube = (query,page,generation,options) => new Promise(resolve => calls.push({query,page,generation,options,resolve}));
  f.elements.get('youtube-search-input').value = 'ocean';
  f.test.submitSourceSearch(); await f.flush();
  f.test.setOrientation('vertical'); await f.flush();
  assert.deepEqual(calls.map(({page,options}) => [page,options.orientation]), [[1,'all'],[1,'vertical']]);
  assert.equal(calls[1].generation > calls[0].generation,true);
  const page = id => ({query:'ocean',page:1,pageSize:10,results:[{id,title:id,url:`https://www.youtube.com/watch?v=${id}`,isShort:true,channel:null,duration:1,thumbnailUrl:null,viewCount:null,publishedAt:null,channelVerified:false}],hasPrevious:false,hasNext:true,totalResults:12,pageCount:2});
  calls[1].resolve(page('test0000002')); await f.flush();
  early({generation:calls[0].generation,page:{...page('test0000000'),totalResults:null,pageCount:null}});
  calls[0].resolve(page('test0000000')); await f.flush();
  assert.equal(f.elements.get('youtube-search-results').children[0].dataset.resultKey,'youtube:test0000002');
  f.test.searchPageRelative(1); await f.flush();
  assert.deepEqual([calls[2].page,calls[2].options.orientation], [2,'vertical']);
  calls[2].resolve({...page('test0000004'),page:2}); await f.flush();
  let releaseMetadata;
  f.api.loadYoutube = () => new Promise(resolve => {releaseMetadata=resolve;});
  f.elements.get('youtube-url').value = 'https://www.youtube.com/watch?v=test0000004';
  f.elements.get('load-youtube-btn').click(); await f.flush();
  f.test.setOrientation('horizontal'); await f.flush();
  assert.deepEqual([calls[3].page,calls[3].options.orientation],[1,'horizontal']);
  releaseMetadata({id:'test0000004',title:'Stale detail',duration:1,channel:null,thumbnailUrl:null,heights:[],formatSummary:[],chapters:[]});
  calls[3].resolve(page('test0000005')); await f.flush();
  assert.equal(f.elements.get('youtube-search-results').children[0].dataset.resultKey,'youtube:test0000005');
  f.test.setProvider('pinterest');
  f.test.setOrientation('square');
  f.test.setProvider('youtube'); assert.equal(f.test.orientation(),'horizontal');
  f.test.setProvider('pinterest'); assert.equal(f.test.orientation(),'square');
  f.test.setProvider('pexels'); f.test.setOrientation('horizontal');
  f.test.setPexelsKind('photo'); assert.equal(f.test.orientation(),'all'); f.test.setOrientation('square');
  f.test.setPexelsKind('video'); assert.equal(f.test.orientation(),'horizontal');
  f.test.setProvider('pixabay'); assert.equal(f.test.orientation(),'all');
});

test('renderer forwards orientation on Pinterest and both stock pagers, including empty provider pages', async () => {
  const f = createHarness();
  f.api.pexelsKeyStatus = f.api.pixabayKeyStatus = async () => ({connected:true,persisted:false,message:'Connected'});
  const calls = [];
  const page = (query,number) => ({query,page:number,pageSize:15,results:[],hasPrevious:number>1,hasNext:true,totalResults:null,matchingResultsOnPage:0});
  f.api.searchPinterest = async (query,number,options) => {calls.push(['pinterest',number,options.orientation]); return {...page(query,number),totalResults:0,pageCount:1};};
  f.api.searchPexels = async (kind,query,number,options) => {calls.push(['pexels',kind,number,options.orientation]); return page(query,number);};
  f.api.searchPixabay = async (kind,query,number,options) => {calls.push(['pixabay',kind,number,options.orientation]); return page(query,number);};
  await f.fireReady();
  for (const source of ['pinterest','pexels','pixabay']) {
    f.test.setProvider(source); f.elements.get('youtube-search-input').value = 'ocean';
    f.test.setOrientation('square'); await f.flush();
    f.test.searchPageRelative(1); await f.flush();
  }
  assert.deepEqual(calls,[['pinterest',1,'square'],['pinterest',2,'square'],['pexels','video',1,'square'],['pexels','video',2,'square'],['pixabay','video',1,'square'],['pixabay','video',2,'square']]);
  assert.equal(f.elements.get('youtube-search-status').textContent,'0 matches on page 2');
  assert.equal(f.elements.get('youtube-search-next').disabled,false);
});

test('preview search mocks honor YouTube/Pinterest/stock orientation and expose deterministic dimensions', async () => {
  const window = {location:{search:'?preview=ready'},addEventListener(){}};
  runInNewContext(transpilePreviewAdapter(process.cwd()),{window,URLSearchParams,setTimeout,document:{getElementById:()=>null}});
  const api = window.clipdockAPI;
  const youtube = await api.searchYoutube('ocean',1,1,{orientation:'vertical'});
  assert.deepEqual(plain(youtube.results.map(item => item.isShort)),Array(8).fill(true));
  assert.deepEqual([youtube.totalResults,youtube.pageCount], [8,1]);
  const square = await api.searchPinterest('ocean',1,{orientation:'square'});
  assert.deepEqual(plain(square.results.map(item => [item.width,item.height])), Array(6).fill([1080,1080]));
  assert.deepEqual([square.totalResults,square.pageCount], [6,1]);
  assert.deepEqual(plain((await api.searchPexels('photo','ocean',1,{orientation:'vertical'})).results.map(item => item.id)),[102]);
  assert.deepEqual(plain((await api.searchPixabay('video','ocean',1,{orientation:'square'})).results.map(item => item.id)),[203]);
});

// Shape captured from yt-dlp 2026.08.19's one live cooking search, sanitized.
// The Shorts counterpart uses the /shorts/ URL emitted by its tab extractor.
test('YouTube Vertical uses the live Shorts type filter', async t => {
  const watch = JSON.parse(readFileSync(new URL('./fixtures/youtube-flat-search-real.json', import.meta.url), 'utf8'));
  const short = {...watch, id:'short000001', title:'Sanitized Short', duration:null};
  for (const key of ['url','webpage_url','original_url']) short[key]='https://www.youtube.com/shorts/short000001';
  assert.equal(narrowSearchEntry(watch).isShort,false);
  assert.equal(narrowSearchEntry({...watch,ie_key:'YoutubeTab'}),null);
  assert.equal(narrowSearchEntry(short).isShort,true);
  let args;
  const worker = new YtdlpWorker('/fixture/yt-dlp', (_binary, command) => {
    args = command;
    const child = new Child();
    queueMicrotask(() => {
      const entries = command.at(-1).startsWith('ytsearch') ? [watch] : [watch,short,{...watch,ie_key:'YoutubeTab'}];
      child.stdout.emit('data',entries.map(JSON.stringify).join('\n')+'\n');child.emit('close',0);
    });
    return child;
  }, undefined, {sessionDir:temp(t)});
  t.after(() => worker.dispose());
  const vertical=await worker.search('cooking',1,undefined,{orientation:'vertical'});
  assert.deepEqual(vertical.results.map(item => [item.id,item.isShort]),[['short000001',true]]);
  assert.equal(args.at(-1),'https://www.youtube.com/results?search_query=cooking&sp=EgIQCQ%3D%3D');
  assert.deepEqual([args[args.indexOf('--playlist-end')+1],vertical.totalResults],['30',1]);
});

test('orientation icon control delegates clicks, shows source capabilities, and restores active source/kind state', async () => {
  const f=createHarness(); const calls=[];
  f.api.searchYoutube=async (query,page,generation,options)=>{calls.push([query,page,options.orientation]);return {query,page,pageSize:10,results:[],hasPrevious:false,hasNext:false,totalResults:0,pageCount:1};};
  await f.fireReady();
  const button=value=>f.elements.get(`orientation-${value}`);
  const pressed=()=>['all','vertical','horizontal','square'].map(value=>button(value).getAttribute('aria-pressed'));
  const click=value=>f.elements.get('orientation-filter').listeners.click({target:{closest:()=>button(value)}});
  assert.deepEqual(pressed(),['true','false','false','false']);
  assert.equal(button('square').hidden,true);
  f.elements.get('youtube-search-input').value='cooking';click('vertical');await f.flush();
  assert.deepEqual(calls,[['cooking',1,'vertical']]);
  assert.deepEqual(pressed(),['false','true','false','false']);
  f.test.setProvider('pinterest');assert.equal(button('square').hidden,false);click('square');
  assert.deepEqual(pressed(),['false','false','false','true']);
  f.test.setProvider('social');assert.equal(f.elements.get('orientation-filter').hidden,true);
  f.test.setProvider('youtube');assert.equal(f.elements.get('orientation-filter').hidden,false);
  assert.equal(button('square').hidden,true);assert.deepEqual(pressed(),['false','true','false','false']);
  f.test.setProvider('pinterest');assert.deepEqual(pressed(),['false','false','false','true']);
  f.test.setProvider('pexels');click('horizontal');assert.deepEqual(pressed(),['false','false','true','false']);
  f.test.setPexelsKind('photo');assert.deepEqual(pressed(),['true','false','false','false']);click('square');
  f.test.setPexelsKind('video');assert.deepEqual(pressed(),['false','false','true','false']);
  f.test.setProvider('pixabay');assert.deepEqual(pressed(),['true','false','false','false']);click('vertical');
  f.test.setProvider('pexels');assert.deepEqual(pressed(),['false','false','true','false']);
  f.test.setProvider('pixabay');assert.deepEqual(pressed(),['false','true','false','false']);
});

test('orientation buttons follow provider collection busy state and YouTube stays interruptible', async () => {
  const f=createHarness();await f.fireReady();
  const buttons=()=>['all','vertical','horizontal','square'].map(value=>f.elements.get(`orientation-${value}`).disabled);
  let finish;
  const pending=(query,page)=>new Promise(resolve=>{finish=()=>resolve({query,page,pageSize:10,results:[],hasPrevious:false,hasNext:false,totalResults:0,pageCount:1});});
  f.api.searchPinterest=pending;f.test.setProvider('pinterest');f.elements.get('youtube-search-input').value='interior design';
  f.test.setOrientation('square');assert.deepEqual(buttons(),[true,true,true,true]);
  finish();await f.flush();assert.deepEqual(buttons(),[false,false,false,false]);
  f.api.searchYoutube=pending;f.test.setProvider('youtube');f.elements.get('youtube-search-input').value='cooking';
  f.test.setOrientation('vertical');assert.deepEqual(buttons(),[false,false,false,false]);finish();await f.flush();
});

// Captured from YouTube's live Search filter menu on 2026-10-28; tracking removed.
test('YouTube maps modes to the original videos search or verified Shorts filter, separating caches', async t => {
  const filter=JSON.parse(readFileSync(new URL('./fixtures/youtube-shorts-filter.json',import.meta.url),'utf8'));
  assert.equal(filter.label.simpleText,'Shorts');
  assert.equal(decodeURIComponent(filter.navigationEndpoint.searchEndpoint.params),'EgIQCQ==');
  const videos=Array.from({length:30},(_,index)=>rawYoutube(index,index===27?'short':index>=28?undefined:'watch'));
  const shorts=Array.from({length:30},(_,index)=>rawYoutube(index+100,index<24?'short':index<28?'watch':undefined));
  const calls=[];const early=[];
  const worker=new YtdlpWorker('/fixture/yt-dlp',(_binary,args)=>{
    calls.push(args);const child=new Child();
    queueMicrotask(()=>{const rows=args.at(-1).startsWith('ytsearch')?videos:shorts;child.stdout.emit('data',rows.map(JSON.stringify).join('\n')+'\n');child.emit('close',0);});
    return child;
  },undefined,{sessionDir:temp(t)});
  t.after(()=>worker.dispose());
  const all=await worker.search('cooking & tips',1,page=>early.push(page));
  assert.deepEqual([all.totalResults,all.pageCount,all.results[0].id],[30,3,'test0000000']);
  assert.equal(calls[0].at(-1),'ytsearch30:cooking & tips');
  assert.deepEqual([early.length,early[0].results.length,early[0].totalResults],[1,10,null]);
  const horizontal=await worker.search('COOKING & TIPS',3,undefined,{orientation:'horizontal'});
  assert.deepEqual(horizontal.results.map(item=>item.id),['test0000020','test0000021','test0000022','test0000023','test0000024','test0000025','test0000026']);
  assert.deepEqual([horizontal.totalResults,horizontal.pageCount,calls.length],[27,3,1]);
  const vertical=await worker.search('cooking & tips',1,page=>early.push(page),{orientation:'vertical'});
  assert.deepEqual([vertical.totalResults,vertical.pageCount,vertical.results[0].id],[24,3,'test0000100']);
  assert.deepEqual(vertical.results.map(item=>item.isShort),Array(10).fill(true));
  assert.equal(calls[1].at(-1),'https://www.youtube.com/results?search_query=cooking%20%26%20tips&sp=EgIQCQ%3D%3D');
  assert.deepEqual(calls.map(args=>args[args.indexOf('--playlist-end')+1]),['30','30']);
  assert.deepEqual([early.length,early[1].results.length,early[1].totalResults],[2,10,null]);
  assert.equal(worker.searchCache.get('["cooking & tips","videos"]').results.length,30);
  assert.equal(worker.searchCache.get('["cooking & tips","shorts"]').results.length,30);
  assert.equal((await worker.search('cooking & tips',3,undefined,{orientation:'vertical'})).results[0].id,'test0000120');
  assert.equal((await worker.search('cooking & tips',1,undefined,{orientation:'square'})).totalResults,30);
  assert.equal((await worker.search('cooking & tips',1,undefined,{orientation:'bad'})).results[0].id,'test0000000');
  assert.equal(calls.length,2);
});

test('YouTube Horizontal on a cold videos corpus filters hints before its early page and excludes unknowns', async t => {
  const rows=Array.from({length:30},(_,index)=>rawYoutube(index,index<5?'short':index<8?undefined:'watch'));
  let command;const early=[];
  const worker=new YtdlpWorker('/fixture/yt-dlp',(_binary,args)=>{command=args;const child=new Child();queueMicrotask(()=>{child.stdout.emit('data',rows.map(JSON.stringify).join('\n')+'\n');child.emit('close',0);});return child;},undefined,{sessionDir:temp(t)});
  t.after(()=>worker.dispose());
  const result=await worker.search('cooking',1,page=>early.push(page),{orientation:'horizontal'});
  assert.equal(command.at(-1),'ytsearch30:cooking');
  assert.deepEqual([result.totalResults,result.results[0].id,early.length,early[0].results.length],[22,'test0000008',1,10]);
  assert.deepEqual(early[0].results.map(item=>item.isShort),Array(10).fill(false));
  assert.deepEqual(result.results.map(item=>item.id),early[0].results.map(item=>item.id));
  assert.equal((await worker.search('cooking',1)).totalResults,30);
});
