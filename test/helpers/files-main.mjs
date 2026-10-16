// Evaluate the complete compiled Electron entry point with only external boundaries substituted.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { createRequire } from 'node:module';
import { DownloadHistory } from '../../dist/history.js';
import * as mainProcess from '../../dist/main-process.js';
import { IPC_CHANNELS } from '../../dist/shared.js';
const require = createRequire(import.meta.url);
export function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
export async function mainFixture(t, options={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'files-main-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'Downloads','ClipDock');fs.mkdirSync(path.dirname(root),{recursive:true});
  if(options.invalidRoot) fs.writeFileSync(root,'keep');
  const userData=path.join(dir,'data');fs.mkdirSync(userData);
  options.setup?.({root,userData});
  const registrations=[], events=[], handlers=new Map(), appHandlers=new Map(), callbacks=new Map(), workers=[], windows=[], previews=[], order=[];
  const lifecycle={quitRequests:0,completedQuits:0,cleanups:0};
  const discovery=options.discovery??Promise.resolve({ffmpegPath:null,ffprobePath:null,ytdlpPath:null,galleryDlPath:null});
  const controls={nativeInitialize:async()=>true,nativeTimeout:()=>true,nativeResolve:null,status:async()=>({project:{name:'Project'}}),dialog:async()=>({canceled:true,filePaths:[]}),transfer:async()=>({ok:true,kind:'imported'}), history:null,openExternal:async()=>{}};
  class Worker {
    constructor(_binary,_spawn,fetchOrOptions,opts) { order.push('worker');this.options=opts??fetchOrOptions;this.root=this.options.sessionDir;this.initialRoot=this.root;fs.mkdirSync(this.root,{recursive:true});workers.push(this); }
    setSessionDir(root) {fs.mkdirSync(root,{recursive:true});this.root=root;}
    isActive(){return this.active??false;} dispose(){} cancel(){return false;}
    async metadata(){return {id:'dQw4w9WgXcQ',title:'Clip',channel:'Channel',duration:10,chapters:[]};}
    async download(_url,_quality,jobId){const filePath=path.join(this.root,`${jobId}.mp4`);fs.writeFileSync(filePath,'media');return {filePath,fileName:path.basename(filePath)};}
  }
  class Pexels {constructor(){} setRoot(){} isDownloading(){return false;} dispose(){} restoreStatus(){} }
  class Credentials {async load(){return {key:null};}}
  class History extends DownloadHistory {constructor(...args){super(...args);controls.history=this;}}
  const electron={
    app:{getPath:key=>key==='userData'?userData:path.dirname(root),whenReady:()=>Promise.resolve(),on:(name,handler)=>appHandlers.set(name,handler),quit(){controls.onQuit?.();lifecycle.quitRequests++;let prevented=false;appHandlers.get('before-quit')?.({preventDefault(){prevented=true;}});if(!prevented)lifecycle.completedQuits++;},requestSingleInstanceLock:()=>options.lock??true},
    BrowserWindow:class {constructor(){order.push('window');this.children=new Set();this.contentView={addChildView:view=>this.children.add(view),removeChildView:view=>this.children.delete(view)};this.webContents={mainFrame:{url:new URL('file://'+path.resolve('dist/index.html')).href},on(){},setWindowOpenHandler(){},send(channel,update){events.push({channel,update});options.onEvent?.(channel,update);},isDestroyed:()=>false};windows.push(this);}getContentSize(){return [1000,800];}setMinimumSize(){}setMenuBarVisibility(){}setAlwaysOnTop(value){this.pinned=value;}isAlwaysOnTop(){return this.pinned??false;}on(name,handler){this.handlers??=new Map();this.handlers.set(name,handler);}loadFile(){}},
    WebContentsView:class {constructor(){this.closed=false;this.webContents={session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(){},on(){},loadURL:async()=>{},isDestroyed:()=>this.closed,close:()=>{this.closed=true;}};previews.push(this);}setBounds(bounds){this.bounds=bounds;}},
    dialog:{showOpenDialog:(...args)=>controls.dialog(...args)},ipcMain:{handle(key,handler){if(handlers.has(key))throw new Error(`Attempted to register a second handler for '${key}'`);registrations.push(key);handlers.set(key,handler);},on(){}},nativeImage:{createFromDataURL:()=>({})},clipboard:{writeText(){}},shell:{showItemInFolder(){},openPath:async()=>'',openExternal:(...args)=>controls.openExternal(...args)},safeStorage:{},
  };
  const mocks={'node:os':{...os,tmpdir:()=>dir},electron,'./WorkflowIntegration.node':{Initialize:()=>controls.nativeInitialize(),SetAPITimeout:seconds=>controls.nativeTimeout(seconds),GetResolve:()=>controls.nativeResolve,GetInfo:()=>null,RegisterCallback:(name,handler)=>callbacks.set(name,handler),CleanUp(){lifecycle.cleanups++;}},'./ytdlp':{YtdlpWorker:Worker,discoverFfmpeg:()=>{order.push('discovery');return null;}},'./gallerydl':{GalleryDlWorker:Worker},'./media-prep':{createMediaPrep:()=>({isActive:()=>false,dispose(){},cancel:()=>false}),discoverFfprobe:()=>null},'./pexels':{PexelsClient:Pexels,safePexelsExternal:require('../../dist/pexels.js').safePexelsExternal},'./pexels-credential':{MacKeychainPexelsCredentialStore:Credentials,PexelsCredentialStore:Credentials},'./history':{...require('../../dist/history.js'),DownloadHistory:History},'./status-provider':options.realStatus?require('../../dist/status-provider.js'):{createStatusProvider:()=>({getStatus:()=>controls.status(),noteResolveQuit(){}})},'./transfer':options.realTransfer?require('../../dist/transfer.js'):{createTransfer:()=>({importToMediaPool:(...args)=>controls.transfer(...args),addToTimeline:(...args)=>controls.transfer(...args),noteResolveQuit(){}})},'./main-process':{...(options.mainProcess??mainProcess),SessionTransferCards:options.SessionTransferCards??mainProcess.SessionTransferCards,discoverEnginePaths:()=>{order.push('discovery');return discovery;}}};
  Object.assign(mocks, options.modules);
  // Evaluate the extracted host and entry point in one realm, preserving Error
  // classification while substituting the same external adapters for both.
  const hostModule={exports:{}};
  const context=vm.createContext({module:hostModule,exports:hostModule.exports,require:id=>mocks[id]??(id.startsWith('.')?require(path.resolve('dist',id)):require(id)),__dirname:path.resolve('dist'),__filename:path.resolve('dist/main.js'),process,URL,Promise,console,setTimeout,clearTimeout});
  vm.runInContext('(function(module,exports,require){'+fs.readFileSync('dist/engine-host.js','utf8')+'\n})(module,exports,require);',context);
  mocks['./engine-host']=hostModule.exports;
  const module={exports:{}};
  context.module=module;context.exports=module.exports;
  vm.runInContext('(function(module,exports,require){'+(options.mainSource??fs.readFileSync('dist/main.js','utf8'))+'\n})(module,exports,require);',context);
  await new Promise(r=>setImmediate(r));
  const event={sender:windows[0]?.webContents,senderFrame:windows[0]?.webContents.mainFrame};
  return {dir,root,userData,windows,previews,order,workers,controls,lifecycle,events,handlers,registrations,registerInvoke:electron.ipcMain.handle,callbacks,event,invokeEvent:(channel,event,...args)=>handlers.get(channel)(event,...args),invokeRaw:(channel,...args)=>handlers.get(channel)(event,...args),quit:()=>electron.app.quit(),invoke:(channel,...args)=>handlers.get(IPC_CHANNELS[channel])(event,...args)};
}
export const historyInput=filePath=>({provider:'youtube',source:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',filePath,assetId:null,title:'Clip',creator:null,profile:'original',quality:'best',mediaMode:'video',selection:null,automation:{provider:'youtube',source:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',selection:null,chapters:[]}});
export const download=f=>f.invoke('downloadYoutube','https://www.youtube.com/watch?v=dQw4w9WgXcQ','best','original','job',{mediaMode:'video',audioFormat:'wav',subtitles:false,subtitleLanguage:'en'});
